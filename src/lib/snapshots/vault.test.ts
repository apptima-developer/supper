import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { VaultAuthority, VAULT_ROOT } from "./vault";
import { sha256, type SnapshotInput } from "./store";
let root: string, vault: VaultAuthority, mounted: boolean;
const input = (n: number): SnapshotInput => ({ backupPath: `backups/core/tickets-${1700000000000+n}-aabbccdd.json`, json: JSON.stringify([{ id: `synthetic-${n}` }]), createdAt: new Date(1700000000000+n).toISOString(), sourceVersion: "synthetic-v1", category: "automatic", relatedImportBatchIds: [] });
const request = () => ({ before: "2025-01-01T00:00:00.000Z", keepLatest: 1, referenceInventory: { version: 1 as const, complete: true as const, capturedAt: new Date().toISOString(), sourceVersion: "synthetic-v1", referencedPaths: [] as string[] } });
const mount = async () => { if (!mounted) throw new Error("unmounted"); };
const baseline = { sha: sha256("[]"), count: 0 };
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "vault-synthetic-"))); mounted = true;
  await fs.mkdir(path.join(root,"snapshot-archives"),{ mode:0o700 });
  await fs.mkdir(path.join(root,"snapshot-archives/phase03"),{ mode:0o700 });
  await fs.writeFile(path.join(root,"snapshot-archives/phase03/full-manifest.json"),"[]",{mode:0o600});
  vault = new VaultAuthority(root,mount,baseline); await vault.initialize();
});
afterEach(async () => { vi.unstubAllEnvs(); await fs.rm(root,{recursive:true,force:true}); });
it("resolves canonical production paths and rejects Vercel without writing",async()=>{
  await expect(new VaultAuthority().prune(request(),"approved-digest")).rejects.toThrow("Real-data prune disabled");
  expect(new VaultAuthority().activeRoot).toBe(VAULT_ROOT+"/snapshot-archives/local-vault");
  vi.stubEnv("VERCEL","1"); await expect(vault.readiness()).rejects.toThrow("local process");
});
it("starts mounted, writes/verifies, rejects changed duplicates and recovers after restart",async()=>{
  expect((await vault.readiness()).state).toBe("VAULT_READY");
  const m=await vault.save(input(0)); expect(m.checksum).toBe(sha256(input(0).json));
  expect((await vault.active.getSnapshot(input(0).backupPath)).json).toBe(input(0).json);
  await expect(vault.save({...input(0),json:"[]"})).rejects.toThrow("Immutable snapshot conflict");
  const restarted=new VaultAuthority(root,mount,baseline); expect((await restarted.readiness()).activeCount).toBe(1);
  expect(await restarted.active.verifySnapshot(input(0).backupPath)).toEqual(m);
  const exported = await restarted.export(input(0).backupPath,"synthetic.json");
  expect(sha256(await fs.readFile(exported.file))).toBe(m.checksum);
  await expect(restarted.export(input(0).backupPath,"synthetic.json")).rejects.toThrow();
  await expect(restarted.export(input(0).backupPath,"../unsafe.json")).rejects.toThrow();
});
it("fails reads/writes/init/list when Vault disappears, never recreates missing root",async()=>{
  mounted=false;
  await expect(vault.initialize()).rejects.toThrow("VAULT_UNAVAILABLE");
  await expect(vault.save(input(0))).rejects.toThrow("VAULT_UNAVAILABLE");
  await expect(vault.active.getSnapshot(input(0).backupPath)).rejects.toThrow("VAULT_UNAVAILABLE");
  await expect(vault.active.listSnapshots()).rejects.toThrow("VAULT_UNAVAILABLE");
  await fs.rm(vault.activeRoot,{recursive:true}); mounted=true;
  await expect(vault.active.saveSnapshot(input(0))).rejects.toThrow("VAULT_UNAVAILABLE");
  await expect(fs.stat(vault.activeRoot)).rejects.toMatchObject({code:"ENOENT"});
});
it("protects catalog/reference/manual/import/latest entries and records only approved synthetic prune",async()=>{
  for(let n=0;n<6;n++) await vault.save(input(n));
  await vault.save({...input(6),category:"manual"});
  await vault.save({...input(7),relatedImportBatchIds:["synthetic-import"]});
  await vault.catalog("protected",[input(0).backupPath]);
  const r=request();r.referenceInventory.referencedPaths=[input(1).backupPath];
  const plan=await vault.prune(r);expect(plan).toMatchObject({dryRun:true});
  expect("candidates" in plan && plan.candidates.map(s=>s.backupPath)).toEqual([2,3,4,5].map(n=>input(n).backupPath));
  expect(await vault.active.listSnapshots()).toHaveLength(8);
  await expect(vault.prune(r,"wrong")).rejects.toThrow("plan changed");
  if(!("digest" in plan))throw new Error("missing dry-run digest");
  const result=await vault.prune(r,plan.digest);expect(result).toMatchObject({dryRun:false,removed:[2,3,4,5].map(n=>input(n).backupPath)});
  expect((await new VaultAuthority(root,mount,baseline).readiness()).activeCount).toBe(4);
  expect((await fs.readdir(path.join(vault.activeRoot,"operations"))).filter(n=>n.endsWith(".result.json"))).toHaveLength(1);
});
it("rejects stale/missing references, changed historical baseline and catalog corruption",async()=>{
  const r=request();r.referenceInventory.capturedAt="2020-01-01T00:00:00.000Z";
  await expect(vault.prune(r)).rejects.toThrow("Fresh complete");
  const missing=request();missing.referenceInventory.referencedPaths=[input(99).backupPath];await expect(vault.prune(missing)).rejects.toThrow();
  await vault.save(input(0)); await vault.catalog("protected",[input(0).backupPath]);
  await fs.writeFile(path.join(vault.activeRoot,"catalogs/protected.json"),"[{}]"); await expect(vault.prune(request())).rejects.toThrow();
  await fs.writeFile(path.join(vault.historicalRoot,"full-manifest.json"),"[ ]");await expect(vault.readiness()).rejects.toThrow("manifest changed");
});
it("blocks readiness after interrupted prune and refuses symlinked archives",async()=>{
  await fs.writeFile(path.join(vault.activeRoot,"operations/synthetic.intent.json"),"{}",{mode:0o600});
  await expect(vault.readiness()).rejects.toThrow("PRUNE_RECOVERY_REQUIRED");
  await fs.rm(path.join(vault.activeRoot,"operations/synthetic.intent.json"));
  await fs.rename(vault.activeRoot,vault.activeRoot+"-original");await fs.symlink(vault.activeRoot+"-original",vault.activeRoot);
  await expect(vault.readiness()).rejects.toThrow("UNSAFE");
});
