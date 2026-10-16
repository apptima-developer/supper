import { expect, it } from "vitest";
import { metadataSchema, sha256, snapshotId, type SnapshotMetadata } from "./store";
import { parseFrozenHistoricalManifest } from "./remote-migration";
import { planSnapshotRetention, snapshotStorageBytes } from "./retention";
function metadata(n: number): SnapshotMetadata {
  const backupPath = `backups/core/tickets-${1700000000000 + n}-aabbccdd.json`;
  return metadataSchema.parse({ metadataVersion: 1, schemaVersion: 1, snapshotId: snapshotId(backupPath), originalKey: "core/tickets.json", backupPath, createdAt: new Date(1700000000000 + n).toISOString(), sourceVersion: "synthetic", checksum: sha256("[]"), compressedChecksum: sha256("synthetic"), compressedBytes: 22, uncompressedBytes: 2, compression: "gzip", storageLocation: `synthetic/${n}`, state: "externally_verified", category: "automatic", relatedImportBatchIds: [] });
}
it("accepts only the frozen 6085 unique historical identifiers, excluding extra test objects", () => {
  const frozen = Array.from({ length: 6085 }, (_, n) => metadata(n));
  expect(parseFrozenHistoricalManifest(JSON.stringify(frozen))).toHaveLength(6085);
  expect(() => parseFrozenHistoricalManifest(JSON.stringify([...frozen, metadata(6085)]))).toThrow();
  expect(() => parseFrozenHistoricalManifest(JSON.stringify([...frozen.slice(1), frozen[1]]))).toThrow("Invalid frozen");
});
it("enforces global count and encrypted bytes while all protected history survives zero budgets", () => {
  const objects = Array.from({ length: 5 }, (_, n) => ({ ...metadata(n), storedBytes: 1200 }));
  const limited = planSnapshotRetention(objects, { maxHotCount: 1, maxAutomaticPerDataset: 5, maxHotBytes: 10000 });
  expect(limited.retained).toHaveLength(1);
  expect(snapshotStorageBytes(objects[0])).toBeGreaterThan(1200);
  const manual = { ...metadata(8), category: "manual" as const }, tombstone = { ...metadata(9), category: "tombstone" as const };
  const imported = { ...metadata(10), relatedImportBatchIds: ["synthetic-batch"] };
  const all = [...objects, manual, tombstone, imported];
  const protectedPlan = planSnapshotRetention(all, { maxHotCount: 0, maxHotBytes: 0, protectedPaths: new Set(objects.map(m => m.backupPath)) });
  expect(protectedPlan.retained).toHaveLength(all.length);
  expect(protectedPlan.cold).toEqual([]);
  expect(protectedPlan.protectedOverBudget).toBe(true);
  expect(protectedPlan.deletionEnabled).toBe(false);
});
