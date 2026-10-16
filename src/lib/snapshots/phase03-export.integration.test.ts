import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { sha256 } from "./store";
import { migrateSnapshot } from "./migration";
import { LocalFilesystemSnapshotStore } from "./filesystem";


const enabled = process.env.SUPPER_PHASE03_INTEGRATION === "1";
const database = process.env.SUPPER_PHASE03_DATABASE || "";
const root = process.env.SUPPER_PHASE03_ARCHIVE_ROOT || "";
const literal = (value: string) => "'" + value.replaceAll("'", "''") + "'";
function execute(sql: string, db = database): string {
  if (!/^supper_phase03_[a-z0-9_]+$/.test(database)) throw new Error("Integration requires an isolated Phase 03 database");
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
  it("preserves recovery and exports all 6085 snapshots with exact read-back verification", async () => {
    expect(root.startsWith("/Volumes/Vault/storage/supper/snapshot-archives/")).toBe(true);
    expect(query<{ name: string }>("SELECT current_database() AS name")[0].name).toBe(database);
    const original = fingerprints("supper_restore"), baseline = fingerprints(database);

    const originals = query<{ key: string; value: unknown; version: string }>("SELECT key,value,updated_at::text AS version FROM public.app_store WHERE key NOT LIKE 'backups/%'");
    const imports = originals.find(row => row.key === "imports/import-batches.json")!.value as Array<{ id: string; status: string; backupPaths: string[] }>;
    const references = new Map<string, string[]>();
    for (const batch of imports) for (const backup of batch.backupPaths) references.set(backup, [...(references.get(backup) || []), batch.id]);
    expect(references.size).toBe(67);
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const archive = new LocalFilesystemSnapshotStore(root);
    const samples = new Set(query<{ key: string }>("SELECT key FROM public.app_store WHERE key LIKE 'backups/%' ORDER BY key").map(r => r.key));
    for (const prefix of ["backups/core/tickets-", "backups/core/ticket-history-", "backups/audit/audit-log-", "backups/auth/users-"]) {
      const rows = query<{ key: string }>(`SELECT key FROM public.app_store WHERE key LIKE ${literal(prefix + "%")} ORDER BY pg_column_size(value) DESC LIMIT 1`);
      samples.add(rows[0].key);
    }
    expect(samples.size).toBe(6085);
    let exported = 0;
    for (const backupPath of samples) {
      const [source] = query<{ json: string; sourceVersion: string }>(`SELECT value::text AS json,updated_at::text AS "sourceVersion" FROM public.app_store WHERE key=${literal(backupPath)}`);
      const input = { ...source, backupPath, relatedImportBatchIds: references.get(backupPath) || [] };
      await migrateSnapshot(input, archive);
      exported++;
      if (exported % 100 === 0) { console.log(`Verified ${exported}/6085`); await fs.writeFile(path.join(root, "progress.json"), JSON.stringify({ exported, failed: 0 }), { mode: 0o600 }); }
      expect(sha256((await archive.getSnapshot(backupPath)).json)).toBe(sha256(source.json));
    }
    const copied = await archive.listSnapshots();
    expect(copied).toHaveLength(6085);
    const manifest = [];
    for (const metadata of copied) {
      const verified = await archive.verifySnapshot(metadata.backupPath);
      expect(verified.checksum).toBe(metadata.checksum);
      manifest.push(metadata);
    }
    for (const ref of references.keys()) await archive.verifySnapshot(ref);
    await fs.writeFile(path.join(root, "full-manifest.json"), JSON.stringify(manifest), { mode: 0o600 });
    await fs.writeFile(path.join(root, "progress.json"), JSON.stringify({ exported, verified: manifest.length, failed: 0, importReferences: references.size, compressedBytes: manifest.reduce((n, m) => n + m.compressedBytes, 0) }), { mode: 0o600 });
    expect(fingerprints("supper_restore")).toEqual(original);
    expect(fingerprints(database)).toEqual(baseline);
  }, 3600000);
  it("retries already migrated objects idempotently after database cleanup", async () => {
    expect(query<{ n: number }>("SELECT count(*)::int n FROM public.app_store WHERE key LIKE 'backups/%'")[0].n).toBe(0);
    const archive = new LocalFilesystemSnapshotStore(root);
    const manifest = JSON.parse(await fs.readFile(path.join(root, "full-manifest.json"), "utf8")) as Array<{ backupPath: string; relatedImportBatchIds: string[] }>;
    expect(manifest).toHaveLength(6085);
    const count = (await archive.listSnapshots()).length;
    for (const metadata of [manifest[0], manifest[3042], manifest[6084]]) {
      const [source] = query<{ json: string; sourceVersion: string }>(`SELECT value::text AS json,updated_at::text AS "sourceVersion" FROM public.app_store WHERE key=${literal(metadata.backupPath)}`, "supper_restore");
      const input = { ...source, backupPath: metadata.backupPath, relatedImportBatchIds: metadata.relatedImportBatchIds };
      await migrateSnapshot(input, archive);
      await migrateSnapshot(input, archive);
      expect((await archive.getSnapshot(metadata.backupPath)).json).toBe(source.json);
    }
    expect((await archive.listSnapshots()).length).toBe(count);
  }, 180000);

});
