import { describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "./store";
import { migrateSnapshot } from "./migration";
import { LocalFilesystemSnapshotStore } from "./filesystem";
import { planSnapshotRetention } from "./retention";

const enabled = process.env.SUPPER_PHASE02_INTEGRATION === "1";
const database = process.env.SUPPER_PHASE02_DATABASE || "";
const root = process.env.SUPPER_PHASE02_ARCHIVE_ROOT || "";
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
function execute(sql: string, db = database): string {
  if (!/^supper_phase02_[a-z0-9_]+$/.test(database)) throw new Error("Integration requires an isolated Phase 02 database");
  if (db !== database && db !== "supper_restore") throw new Error("Unexpected database");
  if (db === "supper_restore" && !sql.startsWith("BEGIN READ ONLY;")) throw new Error("Recovery database is read-only");
  try { return execFileSync("docker", ["exec", "-i", "supper-recovery-pg17", "psql", "-X", "-qAt", "-U", "supper_recovery_admin", "-d", db, "-v", "ON_ERROR_STOP=1"], { input: sql, encoding: "utf8", maxBuffer: 128 * 1024 * 1024 }); }
  catch { throw new Error("Isolated database integration command failed; payload withheld"); }
}
function query<T>(sql: string, db = database): T[] {
  return JSON.parse(execute(`BEGIN READ ONLY; SELECT coalesce(json_agg(q),'[]') FROM (${sql}) q; ROLLBACK;`, db));
}
function fingerprints(db: string) {
  return query<{ key: string; hash: string }>("SELECT key,md5(value::text) AS hash FROM public.app_store WHERE key NOT LIKE 'backups/%' ORDER BY key", db);
}

describe.skipIf(!enabled)("isolated local PostgreSQL snapshot integration", () => {
  it("preserves recovery, verifies 67 import refs, migrates samples, restores and rolls back only the clone", async () => {
    expect(root.startsWith("/Volumes/Vault/storage/supper/snapshot-archives/")).toBe(true);
    expect(query<{ name: string }>("SELECT current_database() AS name")[0].name).toBe(database);
    const original = fingerprints("supper_restore"), baseline = fingerprints(database);
    const originalCounts = query("SELECT count(*) AS rows,count(*) FILTER(WHERE key LIKE 'backups/%') AS snapshots FROM public.app_store", "supper_restore");
    const originals = query<{ key: string; value: unknown; version: string }>("SELECT key,value,updated_at::text AS version FROM public.app_store WHERE key NOT LIKE 'backups/%'");
    const imports = originals.find(row => row.key === "imports/import-batches.json")!.value as Array<{ id: string; status: string; backupPaths: string[] }>;
    const references = new Map<string, string[]>();
    for (const batch of imports) for (const backup of batch.backupPaths) references.set(backup, [...(references.get(backup) || []), batch.id]);
    expect(references.size).toBe(67);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const archive = new LocalFilesystemSnapshotStore(root);
    const samples = new Set(references.keys());
    for (const prefix of ["backups/core/tickets-", "backups/core/ticket-history-", "backups/audit/audit-log-", "backups/auth/users-"]) {
      const rows = query<{ key: string }>(`SELECT key FROM public.app_store WHERE key LIKE ${literal(prefix + "%")} ORDER BY pg_column_size(value) DESC LIMIT 1`);
      samples.add(rows[0].key);
    }
    expect(samples.size).toBeLessThanOrEqual(71);
    for (const backupPath of samples) {
      const [source] = query<{ json: string; sourceVersion: string }>(`SELECT value::text AS json,updated_at::text AS "sourceVersion" FROM public.app_store WHERE key=${literal(backupPath)}`);
      const input = { ...source, backupPath, relatedImportBatchIds: references.get(backupPath) || [] };
      await migrateSnapshot(input, archive); await migrateSnapshot(input, archive);
      expect(sha256((await archive.getSnapshot(backupPath)).json)).toBe(sha256(source.json));
    }
    const copied = await archive.listSnapshots();
    const retention = planSnapshotRetention(copied, { referencedPaths: new Set(references.keys()), maxHotBytes: 50 * 1024 * 1024 });
    expect(retention.missingReferences).toEqual([]);
    expect(retention.retained.filter(s => references.has(s.backupPath))).toHaveLength(67);

    const shim = {
      getStore: async <T,>(target: string) => query<{ value: T }>(`SELECT value FROM public.app_store WHERE key=${literal(target)}`)[0]?.value,
      getVersionedStore: async (target: string) => query<{ value: unknown; updatedAt: string }>(`SELECT value,updated_at::text AS "updatedAt" FROM public.app_store WHERE key=${literal(target)}`)[0],
      setStoreIfUnchanged: async (target: string, value: unknown, version: string | undefined) => {
        const json = `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString("hex")}','hex'),'UTF8')::jsonb`;
        const stamp = `greatest(clock_timestamp(),${version ? literal(version) + "::timestamptz + interval '1 millisecond'" : "clock_timestamp()"})`;
        const mutation = version
          ? `UPDATE public.app_store SET value=${json},updated_at=${stamp} WHERE key=${literal(target)} AND updated_at=${literal(version)}::timestamptz RETURNING key`
          : `INSERT INTO public.app_store(key,value,updated_at) VALUES(${literal(target)},${json},${stamp}) RETURNING key`;
        const changed = JSON.parse(execute(`WITH changed AS (${mutation}) SELECT coalesce(json_agg(key),'[]') FROM changed;`));
        if (changed.length !== 1) throw new Error("Concurrent dataset change");
      },
      listStoreKeys: async (prefix: string) => query<{ key: string }>(`SELECT key FROM public.app_store WHERE key LIKE ${literal(prefix + "%")}`).map(r => r.key),
    };
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "test"); vi.stubEnv("DATA_BACKEND", "supabase");
    vi.stubEnv("SUPPER_EXTERNAL_SNAPSHOTS", "1"); vi.stubEnv("SUPPER_SNAPSHOT_ROOT", root);
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
    vi.doMock("../store", () => shim);
    const jsonStore = await import("../json-store");
    const { importMappingsSchema } = await import("../import-mappings");
    const mappings = await shim.getStore<Record<string, unknown>>("imports/mappings.json");
    const importBaselines = await jsonStore.captureExternalImportBackups("phase02-integration-import");
    expect(importBaselines).toHaveLength(3);
    for (const backup of importBaselines) expect((await archive.getSnapshotMetadata(backup)).relatedImportBatchIds).toEqual(["phase02-integration-import"]);
    const before = new Set(await jsonStore.listBackups());
    await jsonStore.writeJsonAtomic("imports/mappings.json", mappings, importMappingsSchema);
    const added = (await jsonStore.listBackups()).filter(p => !before.has(p));
    expect(added).toHaveLength(1);
    await jsonStore.restoreBackup(added[0]);
    for (const batch of imports.filter(b => b.status === "completed" && b.backupPaths.length > 0)) await jsonStore.restoreBackupSet(batch.backupPaths);
    await jsonStore.restoreBackupSet(importBaselines);
    // Return clone business payloads to its baseline without deleting any source snapshot.
    for (const row of originals) {
      const current = await shim.getVersionedStore(row.key);
      if (sha256(JSON.stringify(current.value)) !== sha256(JSON.stringify(row.value))) await shim.setStoreIfUnchanged(row.key, row.value, current.updatedAt);
    }
    expect(fingerprints(database)).toEqual(baseline);
    expect(fingerprints("supper_restore")).toEqual(original);
    expect(query("SELECT count(*) AS rows,count(*) FILTER(WHERE key LIKE 'backups/%') AS snapshots FROM public.app_store", "supper_restore")).toEqual(originalCounts);
    expect(query("SELECT count(*) AS rows,count(*) FILTER(WHERE key LIKE 'backups/%') AS snapshots FROM public.app_store")).toEqual(originalCounts);
    await fs.writeFile(path.join(root, "..", "phase02-test-evidence.json"), JSON.stringify({
      database, source: "supper_restore (read-only guards)", samplesVerified: samples.size, importPathsVerified: references.size,
      completedBatchRollbacksTested: imports.filter(b => b.status === "completed" && b.backupPaths.length > 0).length,
      newImportBaselinesVerified: importBaselines.length,
      duplicateRetryPassed: true, originalPayloadFingerprintsUnchanged: true, workingPayloadFingerprintsUnchanged: true,
      originalSnapshots: 6085, sourceDeletionEnabled: false, fullMigrationRun: false,
      snapshotCount: (await archive.listSnapshots()).length, protectedOverBudget: retention.protectedOverBudget,
      shim: "PostgreSQL app_store adapter; no Supabase HTTP service started",
    }, null, 2), { mode: 0o600 });
    vi.unstubAllEnvs(); vi.doUnmock("../store");
  }, 180000);
});
