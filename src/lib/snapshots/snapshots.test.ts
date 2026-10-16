import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalFilesystemSnapshotStore } from "./filesystem";
import { serializeSnapshot, sha256, type SnapshotInput } from "./store";
import { planSnapshotRetention, snapshotStorageBytes } from "./retention";
import { migrateSnapshot, migrateSnapshotSamples } from "./migration";
import { externalSnapshotStore } from "./runtime";

let root: string, store: LocalFilesystemSnapshotStore;
const input = (n = 0): SnapshotInput => ({ backupPath: `backups/core/tickets-${1700000000000 + n}-aabbccdd.json`, json: serializeSnapshot([{ id: "ticket", text: "ไทย English", amount: 0.125 }]), createdAt: new Date(1700000000000 + n).toISOString(), sourceVersion: "legacy-v1", category: "automatic", relatedImportBatchIds: [] });
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), "supper-snapshot-")); store = new LocalFilesystemSnapshotStore(root); });
afterEach(async () => { vi.restoreAllMocks(); await fs.rm(root, { recursive: true, force: true }); });

it("preserves sorted JSON, Thai text and decimals with versioned verified metadata", async () => {
  expect(serializeSnapshot({ b: 2, a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1},"b":2}');
  expect(() => serializeSnapshot({ x: undefined })).toThrow();
  const metadata = await store.saveSnapshot(input());
  expect(metadata.checksum).toBe(sha256(input().json));
  expect(metadata.state).toBe("externally_verified");
  expect((await store.getSnapshot(input().backupPath)).json).toBe(input().json);
  expect(await store.verifySnapshot(input().backupPath)).toEqual(metadata);
  expect(await store.getSnapshotMetadata(input().backupPath)).toEqual(metadata);
  expect(await store.listSnapshots()).toEqual([metadata]);
});

it("publishes atomically: readers cannot see a staged object", async () => {
  const rename = fs.rename.bind(fs);
  let release!: () => void, started!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const reached = new Promise<void>(resolve => { started = resolve; });
  vi.spyOn(fs, "rename").mockImplementationOnce(async (from, to) => { started(); await blocked; return rename(from, to); });
  const writing = store.saveSnapshot(input());
  await reached;
  expect(await store.listSnapshots()).toEqual([]);
  release(); await writing;
  expect(await store.listSnapshots()).toHaveLength(1);
});

it("fails an interrupted publication without exposing a snapshot, then retries", async () => {
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("interrupted"));
  await expect(store.saveSnapshot(input())).rejects.toThrow("interrupted");
  expect(await store.listSnapshots()).toEqual([]);
  await store.saveSnapshot(input());
  expect(await store.listSnapshots()).toHaveLength(1);
});

it("deduplicates concurrent retries and rejects conflicting immutable content", async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => store.saveSnapshot(input())));
  expect(new Set(results.map(s => s.snapshotId)).size).toBe(1);
  expect(await store.listSnapshots()).toHaveLength(1);
  await expect(store.saveSnapshot({ ...input(), json: "[]" })).rejects.toThrow("Immutable snapshot conflict");
  expect((await store.getSnapshot(input().backupPath)).json).toBe(input().json);
});

it("does not create phantom snapshots for missing IDs and rejects traversal", async () => {
  await expect(store.getSnapshot(input().backupPath)).rejects.toThrow("not found");
  expect(await store.listSnapshots()).toEqual([]);
  await expect(store.getSnapshot("backups/../../auth/users-1700000000000-aabbccdd.json")).rejects.toThrow();
});

it("rejects corrupt compressed bytes without trusting a readable manifest", async () => {
  const m = await store.saveSnapshot(input());
  await fs.writeFile(path.join(root, m.storageLocation), "broken gzip");
  await expect(store.getSnapshot(input().backupPath)).rejects.toThrow("compressed checksum");
});

it("checks gzip integrity even if the compressed checksum was updated", async () => {
  const m = await store.saveSnapshot(input());
  const file = path.join(root, m.storageLocation), data = await fs.readFile(file);
  data[data.length - 8] ^= 1;
  await fs.writeFile(file, data);
  await fs.writeFile(path.join(path.dirname(file), "manifest.json"), JSON.stringify({ ...m, compressedChecksum: sha256(data) }));
  await expect(store.getSnapshot(input().backupPath)).rejects.toThrow();
});

it("verifies the uncompressed SHA-256 and metadata identity", async () => {
  const m = await store.saveSnapshot(input());
  const file = path.join(root, path.dirname(m.storageLocation), "manifest.json");
  await fs.writeFile(file, JSON.stringify({ ...m, checksum: "0".repeat(64) }));
  await expect(store.verifySnapshot(input().backupPath)).rejects.toThrow("content checksum");
  await fs.writeFile(file, JSON.stringify({ ...m, originalKey: "auth/users.json" }));
  await expect(store.verifySnapshot(input().backupPath)).rejects.toThrow("identity");
});

it("bounds decompression and rejects symlinked objects", async () => {
  const m = await store.saveSnapshot(input());
  await expect(new LocalFilesystemSnapshotStore(root, 10).getSnapshot(input().backupPath)).rejects.toThrow("size limit");
  const file = path.join(root, m.storageLocation);
  await fs.rename(file, file + ".original"); await fs.symlink(file + ".original", file);
  await expect(store.getSnapshot(input().backupPath)).rejects.toThrow("Unsafe snapshot");
});

it("serializes dataset operations across independent adapter instances", async () => {
  let value = 0;
  await Promise.all(Array.from({ length: 12 }, () => new LocalFilesystemSnapshotStore(root).withDatasetLock("core/tickets.json", async () => {
    const old = value; await new Promise(resolve => setTimeout(resolve, 2)); value = old + 1;
  })));
  expect(value).toBe(12);
});

it("disables deletion for every category", async () => {
  await store.saveSnapshot(input());
  await expect(store.deleteSnapshot(input().backupPath)).rejects.toThrow("disabled");
  expect(await store.listSnapshots()).toHaveLength(1);
});

it("plans latest-two count and byte limits without deleting historical objects", async () => {
  const snapshots = await Promise.all([0, 1, 2, 3].map(n => store.saveSnapshot(input(n))));
  const result = planSnapshotRetention(snapshots, { maxAutomaticPerDataset: 2, maxHotBytes: snapshotStorageBytes(snapshots[0]) * 2 });
  expect(result.retained.map(s => s.backupPath).sort()).toEqual([input(2).backupPath, input(3).backupPath]);
  expect(result.cold).toHaveLength(2);
  expect(result.hotBytes).toBeLessThanOrEqual(snapshotStorageBytes(snapshots[0]) * 2);
  expect(await store.listSnapshots()).toHaveLength(4);
});

it("preserves manual, import and tombstone references and reports protected overflow", async () => {
  const snapshots = await Promise.all([
    store.saveSnapshot({ ...input(0), category: "manual" }),
    store.saveSnapshot({ ...input(1), relatedImportBatchIds: ["batch"] }),
    store.saveSnapshot({ ...input(2), category: "tombstone" }),
    store.saveSnapshot(input(3)),
  ]);
  const result = planSnapshotRetention(snapshots, { maxHotBytes: 1, referencedPaths: new Set([input(3).backupPath, input(4).backupPath]) });
  expect(result.retained).toHaveLength(4);
  expect(result.protectedOverBudget).toBe(true);
  expect(result.missingReferences).toEqual([input(4).backupPath]);
  expect(result.cold).toEqual([]);
});

it("migrates exact JSON text, resumes idempotently, and recovers manifests without a DB index", async () => {
  const source = { backupPath: input().backupPath, json: '{"large":9007199254740993,"precise":0.1234567890123456789}', sourceVersion: "legacy", relatedImportBatchIds: ["batch"] };
  await migrateSnapshot(source, store); await migrateSnapshot(source, store);
  const recovered = new LocalFilesystemSnapshotStore(root);
  expect(await recovered.listSnapshots()).toHaveLength(1);
  expect((await recovered.getSnapshot(source.backupPath)).json).toBe(source.json);
  expect((await recovered.getSnapshotMetadata(source.backupPath)).category).toBe("import");
});

it("tracks sample failures and retries without touching a source row", async () => {
  async function* source() { for (let n = 0; n < 3; n++) yield { ...input(n), json: n === 0 ? "bad JSON" : "[]" }; }
  const result = await migrateSnapshotSamples(source(), store, 2);
  expect(result.map(r => r.status)).toEqual(["failed", "verified"]);
  await migrateSnapshot({ ...input(0), json: "[]" }, store);
  expect(await store.listSnapshots()).toHaveLength(2);
});

it("keeps activation off by default and refuses production/Vercel/remote endpoints", () => {
  expect(externalSnapshotStore({})).toBeNull();
  const env = { SUPPER_EXTERNAL_SNAPSHOTS: "1", SUPPER_SNAPSHOT_ROOT: root, NODE_ENV: "test", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" };
  expect(externalSnapshotStore(env)).toBeInstanceOf(LocalFilesystemSnapshotStore);
  expect(() => externalSnapshotStore({ ...env, NODE_ENV: "production" })).toThrow("restricted");
  expect(() => externalSnapshotStore({ ...env, VERCEL: "1" })).toThrow("restricted");
  expect(() => externalSnapshotStore({ ...env, NEXT_PUBLIC_SUPABASE_URL: "https://production.invalid" })).toThrow("localhost");
  expect(() => externalSnapshotStore({ ...env, SUPPER_SNAPSHOT_ROOT: process.cwd() })).toThrow("outside");
});
