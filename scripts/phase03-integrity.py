"""Read-only evidence: all tables, current JSON, nested data and source preservation."""
import subprocess,json,pathlib,hashlib
import os
os.umask(0o077)
ROOT=pathlib.Path('/Volumes/Vault/storage/supper/phase03-20261015')
BASE=['docker','exec','-i','supper-recovery-pg17','psql','-X','-qAt','-U','supper_recovery_admin','-v','ON_ERROR_STOP=1']
def sql(db,q):return subprocess.check_output(BASE+['-d',db],input=('BEGIN READ ONLY; '+q+' ROLLBACK;').encode()).decode().strip()
def query(db,q):return json.loads(sql(db,"SELECT coalesce(json_agg(q),'[]') FROM ("+q+") q;"))
def inspect(db):
 tables=query(db,"SELECT schemaname,tablename FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2")
 for t in tables:
  name='"'+t['schemaname']+'"."'+t['tablename']+'"'
  t['count']=int(sql(db,'SELECT count(*) FROM '+name+';'))
 keys=query(db,"SELECT key,encode(extensions.digest(value::text,'sha256'),'hex') hash,jsonb_typeof(value) kind,CASE WHEN jsonb_typeof(value)='array' THEN jsonb_array_length(value) END rows FROM public.app_store WHERE key NOT LIKE 'backups/%' ORDER BY key")
 objects=query(db,"SELECT n.nspname,c.relname,c.relkind,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%' ORDER BY 1,2")
 functions=query(db,"SELECT n.nspname,p.proname,pg_get_function_identity_arguments(p.oid) args,md5(p.prosrc) body_hash FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,3")
 constraints=query(db,"SELECT n.nspname,c.conname,c.contype,c.convalidated,pg_get_constraintdef(c.oid) definition FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY 1,2,5")
 triggers=query(db,"SELECT tgname,pg_get_triggerdef(oid) definition FROM pg_trigger WHERE NOT tgisinternal ORDER BY 1,2")
 events=query(db,"SELECT evtname,evtevent,evtenabled,evttags FROM pg_event_trigger ORDER BY 1")
 schemas=query(db,"SELECT nspname FROM pg_namespace WHERE nspname !~ '^pg_' AND nspname<>'information_schema' ORDER BY 1")
 return {'schemas':schemas,'tables':tables,'current':keys,'objects':objects,'functions':functions,'constraints':constraints,'triggers':triggers,'events':events}
source=inspect('supper_restore');clone=inspect('supper_phase03_20261015')
assert source['current']==clone['current']
for category in ['schemas','objects','functions','constraints','triggers','events']:assert source[category]==clone[category],category
assert len(source['tables'])==42
for a,b in zip(source['tables'],clone['tables']):
 assert a['schemaname']==b['schemaname'] and a['tablename']==b['tablename']
 if a['tablename']!='app_store':assert a['count']==b['count']
assert next(t['count'] for t in clone['tables'] if t['tablename']=='app_store')==17
assert next(t['count'] for t in source['tables'] if t['tablename']=='app_store')==6102
source_catalog=query('supper_restore',"SELECT key,encode(extensions.digest(value::text,'sha256'),'hex') hash,octet_length(value::text) bytes,updated_at::text version FROM public.app_store ORDER BY key")
assert source_catalog==json.loads((ROOT/'source-catalog.json').read_text())
(ROOT/'final-integrity.json').write_text(json.dumps({'source':source,'optimized':clone,'all_current_hashes_equal':True,'all_source_rows_and_versions_unchanged':True,'service_schema_objects_unchanged':True},indent=2))
print('INTEGRITY_PASS current17 source6102 tables42 serviceObjectsEqual')
