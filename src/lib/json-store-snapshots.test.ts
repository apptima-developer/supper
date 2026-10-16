import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { LocalFilesystemSnapshotStore } from "./snapshots/filesystem";
import { restoreBackupAsAdmin } from "./backup-service";
import type { Session } from "./auth";

let root: string, archive: LocalFilesystemSnapshotStore;
let rows: Map<string, { value: unknown; updatedAt: string }>;
let failWrite: boolean;
const mapping = (n: number) => ({ snow: { count: String(n) }, supportdesk: { customerAliases: {} } });
const schema = z.object({ snow: z.object({ count: z.string() }), supportdesk: z.object({ customerAliases: z.record(z.string(), z.string()) }) });
const key = "imports/mappings.json";
const backup = "backups/imports/mappings-1700000000000-aabbccdd.json";
const second = "backups/core/tickets-1700000000000-aabbccdd.json";
let jsonStore: typeof import("./json-store");
const setStore = vi.fn();
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "supper-writer-"));
  rows = new Map([[key, { value: mapping(0), updatedAt: "2026-01-01T00:00:00.000Z" }], ["core/tickets.json", { value: [], updatedAt: "2026-01-01T00:00:00.000Z" }]]);
  failWrite = false; setStore.mockClear();
  vi.resetModules();
  vi.stubEnv("DATA_BACKEND", "supabase"); vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("SUPPER_EXTERNAL_SNAPSHOTS", "1"); vi.stubEnv("SUPPER_SNAPSHOT_ROOT", root);
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.doMock("./store", () => ({
    getStore: async (target: string) => structuredClone(rows.get(target)?.value),
    getVersionedStore: async (target: string) => structuredClone(rows.get(target)),
    setStoreIfUnchanged: async (target: string, value: unknown, version: string | undefined) => {
      if (failWrite) throw new Error("database unavailable");
      if (rows.get(target)?.updatedAt !== version) throw new Error("concurrent change");
      rows.set(target, { value: structuredClone(value), updatedAt: new Date(Math.max(Date.now(), Date.parse(version || "1970-01-01") + 1)).toISOString() });
    },
    listStoreKeys: async () => [...rows.keys()].filter(k => k.startsWith("backups/")), setStore,
  }));
  jsonStore = await import("./json-store");
  // Use the runtime module's class identity, as jsonStore was freshly imported.
  archive = new (await import("./snapshots/filesystem")).LocalFilesystemSnapshotStore(root);
});
afterEach(async () => { vi.unstubAllEnvs(); vi.doUnmock("./store"); vi.restoreAllMocks(); await fs.rm(root, { force: true, recursive: true }); });

it("stores snapshots externally while persisting unchanged business JSON contracts", async () => {
  expect(await jsonStore.writeJsonAtomic(key, mapping(1), schema)).toEqual(mapping(1));
  expect(await jsonStore.readJson(key, schema)).toEqual(mapping(1));
  const list = await jsonStore.listBackups(); expect(list).toHaveLength(1);
  expect(JSON.parse((await archive.getSnapshot(list[0])).json)).toEqual(mapping(0));
  expect(setStore).not.toHaveBeenCalled();
  expect([...rows.keys()].filter(k => k.startsWith("backups/"))).toEqual([]);
});

it("deduplicates retries after database failure and fails closed on snapshot unavailability", async () => {
  failWrite = true;
  await expect(jsonStore.writeJsonAtomic(key, mapping(1), schema)).rejects.toThrow("database unavailable");
  await expect(jsonStore.writeJsonAtomic(key, mapping(1), schema)).rejects.toThrow("database unavailable");
  expect(await archive.listSnapshots()).toHaveLength(1);
  expect(rows.get(key)?.value).toEqual(mapping(0));
  failWrite = false;
  vi.stubEnv("SUPPER_SNAPSHOT_ROOT", path.join(root, "not-a-directory"));
  await fs.writeFile(path.join(root, "not-a-directory"), "unavailable");
  await expect(jsonStore.writeJsonAtomic(key, mapping(1), schema)).rejects.toThrow();
  expect(rows.get(key)?.value).toEqual(mapping(0));
});

it("serializes concurrent read-modify-write operations without losing updates", async () => {
  await Promise.all(Array.from({ length: 10 }, () => jsonStore.updateJson(key, schema, old => mapping(Number(old.snow.count) + 1))));
  expect(rows.get(key)?.value).toEqual(mapping(10));
  expect(await archive.listSnapshots()).toHaveLength(10);
});

it("keeps Settings identifiers, authorization, pre-restore backup and audit", async () => {
  await jsonStore.writeJsonAtomic(key, mapping(1), schema);
  const [id] = await jsonStore.listBackups();
  const audit = vi.fn();
  const session: Session = { userId: "admin", username: "admin", name: "Admin", role: "admin", authVersion: 1 };
  await expect(restoreBackupAsAdmin({ ...session, role: "support" }, id, { restore: jsonStore.restoreBackup, audit })).rejects.toMatchObject({ status: 403 });
  expect(rows.get(key)?.value).toEqual(mapping(1));
  await restoreBackupAsAdmin(session, id, { restore: jsonStore.restoreBackup, audit });
  expect(rows.get(key)?.value).toEqual(mapping(0)); expect(audit).toHaveBeenCalledOnce();
  expect(await archive.listSnapshots()).toHaveLength(2);
  expect(rows.get("core/tickets.json")?.value).toEqual([]);
});

it("merges legacy and external listing and restores legacy backups", async () => {
  rows.set(backup, { value: mapping(8), updatedAt: "2026-01-01T00:00:00.000Z" });
  await jsonStore.writeJsonAtomic(key, mapping(1), schema);
  expect(await jsonStore.listBackups()).toHaveLength(2);
  await jsonStore.restoreBackup(backup);
  expect(rows.get(key)?.value).toEqual(mapping(8));
  expect(rows.get(backup)?.value).toEqual(mapping(8));
});

it("validates a complete import rollback set before the first mutation", async () => {
  rows.set(backup, { value: mapping(8), updatedAt: "2026-01-01T00:00:00.000Z" });
  await expect(jsonStore.restoreBackupSet([backup, second])).rejects.toThrow("not found");
  expect(rows.get(key)?.value).toEqual(mapping(0));
  expect(await archive.listSnapshots()).toHaveLength(0);
  rows.set(second, { value: [], updatedAt: "2026-01-01T00:00:00.000Z" });
  expect(await jsonStore.restoreBackupSet([backup, second])).toEqual([key, "core/tickets.json"]);
  expect(rows.get(key)?.value).toEqual(mapping(8));
});

it("rejects corrupt external objects even when a legacy fallback exists", async () => {
  await archive.saveSnapshot({ backupPath: backup, json: JSON.stringify(mapping(8)), createdAt: "2023-11-14T22:13:20.000Z", sourceVersion: "legacy", category: "import", relatedImportBatchIds: ["batch"] });
  const m = await archive.getSnapshotMetadata(backup);
  rows.set(backup, { value: mapping(9), updatedAt: "2026-01-01T00:00:00.000Z" });
  await fs.writeFile(path.join(root, m.storageLocation), "corrupt");
  await expect(jsonStore.restoreBackup(backup)).rejects.toThrow("checksum");
  expect(rows.get(key)?.value).toEqual(mapping(0));
});

it("rejects wrong target schemas and inactive relational snapshots without mutation", async () => {
  rows.set(backup, { value: [], updatedAt: "2026-01-01T00:00:00.000Z" });
  await expect(jsonStore.restoreBackup(backup)).rejects.toThrow();
  expect(rows.get(key)?.value).toEqual(mapping(0));
  vi.stubEnv("DATA_BACKEND", "supabase-relational"); vi.resetModules();
  const relational = await import("./json-store");
  await expect(relational.restoreBackup(second)).rejects.toMatchObject({ code: "INACTIVE_BACKUP_TARGET" });
});

it("captures explicit protected import baselines even when automatic retry IDs already exist", async () => {
  for (const key of ["core/customers.json", "core/ticket-history.json", "audit/audit-log.json"]) rows.set(key, { value: [], updatedAt: "2026-01-01T00:00:00.000Z" });
  await jsonStore.writeJsonAtomic("core/tickets.json", [], z.array(z.unknown()));
  const paths = await jsonStore.captureExternalImportBackups("batch-1");
  expect(paths).toHaveLength(3);
  for (const id of paths) {
    const metadata = await archive.getSnapshotMetadata(id);
    expect(metadata.category).toBe("import"); expect(metadata.relatedImportBatchIds).toEqual(["batch-1"]);
  }
  expect(await jsonStore.restoreBackupSet(paths)).toHaveLength(3);
});

it("fails closed if a published gzip disappears, without reading a legacy fallback", async () => {
  const m = await archive.saveSnapshot({ backupPath: backup, json: JSON.stringify(mapping(8)), createdAt: "2023-11-14T22:13:20.000Z", sourceVersion: "legacy", category: "import", relatedImportBatchIds: ["batch"] });
  rows.set(backup, { value: mapping(9), updatedAt: "2026-01-01T00:00:00.000Z" });
  await fs.unlink(path.join(root, m.storageLocation));
  await expect(jsonStore.restoreBackup(backup)).rejects.toThrow("incomplete");
  expect(rows.get(key)?.value).toEqual(mapping(0));
});

it("preserves asynchronous updater semantics", async () => {
  await jsonStore.updateJson(key, schema, async old => mapping(Number(old.snow.count) + 1));
  expect(rows.get(key)?.value).toEqual(mapping(1));
});
