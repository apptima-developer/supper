import { backupTarget } from "../backup-restore-policy";
import { z } from "zod";
import { metadataSchema, sha256, snapshotId, serializeSnapshot, type SnapshotStore, type SnapshotMetadata } from "./store";

export function parseFrozenHistoricalManifest(json: string) {
  const manifest = z.array(metadataSchema).length(6085).parse(JSON.parse(json));
  if (new Set(manifest.map(m => m.backupPath)).size !== 6085 || manifest.some(m => snapshotId(m.backupPath) !== m.snapshotId || backupTarget(m.backupPath).target !== m.originalKey)) throw new Error("Invalid frozen historical migration set");
  return manifest;
}
// The caller supplies the frozen set, never listSnapshots(): test-generated objects are excluded.
export async function migrateManifest(manifest: readonly SnapshotMetadata[], source: SnapshotStore, destination: SnapshotStore, checkpoint: (progress: { verified: number; backupPath: string; checksum: string }) => Promise<void>) {
  if (new Set(manifest.map(m => m.backupPath)).size !== manifest.length) throw new Error("Duplicate migration identifier");
  const logical = (m: SnapshotMetadata) => Object.fromEntries((["snapshotId", "backupPath", "originalKey", "createdAt", "sourceVersion", "checksum", "compressedChecksum", "compressedBytes", "uncompressedBytes", "compression", "category", "relatedImportBatchIds"] as const).map(k => [k, m[k]]));
  let verified = 0;
  for (const expected of manifest) {
    metadataSchema.parse(expected);
    const restored = await source.getSnapshot(expected.backupPath);
    if (sha256(restored.json) !== expected.checksum || serializeSnapshot(logical(restored.metadata)) !== serializeSnapshot(logical(expected))) throw new Error("Frozen source snapshot mismatch; migration stopped");
    await destination.saveSnapshot({ ...expected, json: restored.json });
    if (sha256((await destination.getSnapshot(expected.backupPath)).json) !== expected.checksum) throw new Error("Remote migration verification failed");
    await checkpoint({ verified: ++verified, backupPath: expected.backupPath, checksum: expected.checksum });
  }
  return { verified, failed: 0 };
}
