import subprocess,json,hashlib,pathlib
import os
os.umask(0o077)
root=pathlib.Path('/Volumes/Vault/storage/supper/phase03-20261015');root.mkdir(mode=0o700,exist_ok=True)
# Original backup files are never opened for writing.
base=['docker','exec','-i','supper-recovery-pg17']
def sql(db,q):
 return subprocess.check_output(base+['psql','-X','-qAt','-U','supper_recovery_admin','-d',db,'-v','ON_ERROR_STOP=1'],input=q.encode()).decode().strip()
def catalog(db):
 return json.loads(sql(db,"BEGIN READ ONLY; SELECT json_agg(q) FROM (SELECT key,encode(extensions.digest(value::text,'sha256'),'hex') hash,octet_length(value::text) bytes,updated_at::text version FROM public.app_store ORDER BY key) q; ROLLBACK;"))
source=catalog('supper_restore');assert len(source)==6102
(root/'source-catalog.json').write_text(json.dumps(source))
backup=root/'supper_restore.dump'
with backup.open('xb') as f: subprocess.run(base+['pg_dump','-U','supper_recovery_admin','-d','supper_restore','-Fc'],stdout=f,check=True)
h=hashlib.sha256()
with backup.open('rb') as f:
 for chunk in iter(lambda:f.read(8*1024*1024),b''):h.update(chunk)
(root/'backup-sha256.txt').write_text(h.hexdigest())
subprocess.run(base+['createdb','-U','supper_recovery_admin','supper_phase03_20261015'],check=True)
with backup.open('rb') as f: subprocess.run(base+['pg_restore','-U','supper_recovery_admin','-d','supper_phase03_20261015','--exit-on-error'],stdin=f,check=True)
assert catalog('supper_phase03_20261015')==source
assert sql('supper_phase03_20261015',"SELECT count(*) FROM pg_tables WHERE schemaname NOT IN ('pg_catalog','information_schema')")== '42'
(root/'clone-verification.json').write_text(json.dumps({'rows':6102,'snapshots':6085,'current':17,'allHashesMatch':True,'tables':42,'backupBytes':backup.stat().st_size}))
print('CLONE_VERIFIED',backup.stat().st_size)
