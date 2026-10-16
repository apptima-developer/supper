"""Authorized disposable clone only. Requires all 6,085 archives verified before DELETE."""
import gzip,hashlib,json,pathlib,subprocess
import os
os.umask(0o077)
DB='supper_phase03_20261015'
ROOT=pathlib.Path('/Volumes/Vault/storage/supper/phase03-20261015')
ARCHIVE=pathlib.Path('/Volumes/Vault/storage/supper/snapshot-archives/phase03')
BASE=['docker','exec','-i','supper-recovery-pg17','psql','-X','-qAt','-U','supper_recovery_admin','-d',DB,'-v','ON_ERROR_STOP=1']
def sql(q):
 return subprocess.check_output(BASE,input=q.encode()).decode().strip()
def read(q):return json.loads(sql('BEGIN READ ONLY; SELECT row_to_json(q) FROM ('+q+') q; ROLLBACK;'))
def sizes():
 return read("SELECT pg_database_size(current_database()) database_bytes,pg_total_relation_size('public.app_store') app_store_bytes,pg_relation_size('public.app_store') heap_bytes,pg_indexes_size('public.app_store') index_bytes,(SELECT pg_total_relation_size(reltoastrelid) FROM pg_class WHERE oid='public.app_store'::regclass) toast_bytes,(SELECT coalesce(sum(pg_column_size(value)),0) FROM public.app_store WHERE key NOT LIKE 'backups/%') current_stored_bytes,(SELECT coalesce(sum(pg_column_size(value)),0) FROM public.app_store WHERE key LIKE 'backups/%') snapshot_stored_bytes,(SELECT count(*) FROM public.app_store WHERE key LIKE 'backups/%') snapshots")
def catalog():
 return json.loads(sql("BEGIN READ ONLY; SELECT json_agg(q) FROM (SELECT key,encode(extensions.digest(value::text,'sha256'),'hex') hash,octet_length(value::text) bytes,updated_at::text version FROM public.app_store ORDER BY key) q; ROLLBACK;"))
assert sql('SELECT current_database()')==DB
baseline=json.loads((ROOT/'source-catalog.json').read_text())
assert catalog()==baseline,'Clone changed; cleanup refused'
manifest=json.loads((ARCHIVE/'full-manifest.json').read_text())
expected={r['key']:r for r in baseline if r['key'].startswith('backups/')}
assert len(expected)==len(manifest)==6085
assert {m['backupPath'] for m in manifest}==set(expected)
record_counts=[]
for i,m in enumerate(manifest):
 p=ARCHIVE/m['storageLocation'];assert p.is_relative_to(ARCHIVE) and '..' not in p.parts
 raw=p.read_bytes();assert hashlib.sha256(raw).hexdigest()==m['compressedChecksum']
 body=gzip.decompress(raw);assert len(body)==m['uncompressedBytes']
 assert hashlib.sha256(body).hexdigest()==m['checksum']==expected[m['backupPath']]['hash']
 assert len(body)==expected[m['backupPath']]['bytes']
 payload=json.loads(body)
 record_counts.append({'backupPath':m['backupPath'],'records':len(payload) if isinstance(payload,list) else None,'hash':m['checksum']})
 if (i+1)%1000==0:print('Independent verified',i+1,flush=True)
(ROOT/'snapshot-record-counts.json').write_text(json.dumps(record_counts))
measurements={'before':sizes(),'external_objects':len(manifest),'external_compressed_bytes':sum(m['compressedBytes'] for m in manifest),'external_manifest_bytes':sum(len((ARCHIVE/m['storageLocation']).with_name('manifest.json').read_bytes()) for m in manifest)}
values=','.join("('%s','%s')"%(m['backupPath'].replace("'","''"),m['checksum']) for m in manifest)
# Constant database name, exact 6085 key/hash pairs, transactional count assertions; no unverified row can match.
statement="BEGIN; DO $$ BEGIN IF current_database()<>'supper_phase03_20261015' THEN RAISE EXCEPTION 'wrong clone'; END IF; END $$; CREATE TEMP TABLE verified(key text PRIMARY KEY,hash text) ON COMMIT DROP; INSERT INTO verified VALUES "+values+"; DO $$ DECLARE n integer; BEGIN DELETE FROM public.app_store a USING verified v WHERE a.key=v.key AND a.key LIKE 'backups/%' AND encode(extensions.digest(a.value::text,'sha256'),'hex')=v.hash; GET DIAGNOSTICS n=ROW_COUNT; IF n<>6085 OR (SELECT count(*) FROM public.app_store)<>17 THEN RAISE EXCEPTION 'cleanup cardinality mismatch'; END IF; END $$; COMMIT;"
sql(statement)
measurements['after_logical']=sizes()
(ROOT/'measurements.json').write_text(json.dumps(measurements,indent=2))
assert catalog()==[r for r in baseline if not r['key'].startswith('backups/')]
# ACCESS EXCLUSIVE lock and temporary rewrite space are confined to the verified disposable clone.
sql('VACUUM (FULL, ANALYZE) public.app_store;')
measurements['after_physical']=sizes()
assert catalog()==[r for r in baseline if not r['key'].startswith('backups/')]
measurements['current_hashes_unchanged']=True
(ROOT/'measurements.json').write_text(json.dumps(measurements,indent=2))
print(json.dumps(measurements,indent=2))
