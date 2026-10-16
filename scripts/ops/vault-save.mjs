// Run only after the local supervisor's mounted-Vault guard. Payload stays in memory.
import { createServer } from 'vite';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
const server=await createServer({configFile:false,server:{middlewareMode:true},appType:'custom'});
try {
  const {VaultAuthority}=await server.ssrLoadModule('/src/lib/snapshots/vault.ts');
  const {serializeSnapshot,sha256}=await server.ssrLoadModule('/src/lib/snapshots/store.ts');
  const vault=new VaultAuthority();await vault.guard();
  let input='';for await(const part of process.stdin)input+=part;
  const payload=JSON.parse(input);assert(payload.project==='gpzmmxckiywkdqxqlkct');
  const json=serializeSnapshot(payload),now=new Date(),id=randomUUID();
  const backupPath=`backups/recovery/business-state-${now.getTime()}-${id}.json`;
  const metadata=await vault.save({backupPath,json,createdAt:now.toISOString(),sourceVersion:`supper-production/business-state/${sha256(json)}`,category:'manual',relatedImportBatchIds:[]});
  const read=await vault.read(backupPath);assert.equal(read.json,json);assert.equal(sha256(read.json),metadata.checksum);
  await vault.catalog(`production-business-${id}`,[backupPath]);
  console.log(JSON.stringify({backupPath,file:`${vault.activeRoot}/${metadata.storageLocation}`,checksum:metadata.checksum,compressedBytes:metadata.compressedBytes,uncompressedBytes:metadata.uncompressedBytes,integrity:'PASS',catalog:`production-business-${id}`}));
} catch (e) { console.error('VAULT_CAPTURE_OR_INTEGRITY_FAILED',e.name,e.code||'',String(e.stack||'').split('\n').find(line=>line.trim().startsWith('at '))||'');process.exitCode=1; }
finally {await server.close();}
