import { backupTarget } from "../backup-restore-policy";
import { sha256, type SnapshotStore, type SnapshotMetadata } from "./store";

export type LegacySnapshot = { backupPath: string; json: string; sourceVersion: string; relatedImportBatchIds: string[]; category?: SnapshotMetadata["category"] };
// Caller supplies a read-only, paginated source; there is intentionally no delete callback.
export async function migrateSnapshot(source: LegacySnapshot, destination: SnapshotStore) {
  const metadata = await destination.saveSnapshot({ ...source,
    createdAt: new Date(backupTarget(source.backupPath).timestamp).toISOString(),
    category: source.category ?? (source.relatedImportBatchIds.length ? "import" : "automatic"),
  });
  const restored = await destination.getSnapshot(source.backupPath);
  if (restored.json !== source.json || restored.metadata.checksum !== sha256(source.json)) throw new Error("Migration payload verification failed");
  return metadata;
}

export async function migrateSnapshotSamples(source: AsyncIterable<LegacySnapshot>, destination: SnapshotStore, limit: number) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Explicit sample limit must be between 1 and 100");
  const progress: Array<{ backupPath: string; status: "verified" | "failed" }> = [];
  for await (const snapshot of source) {
    try { await migrateSnapshot(snapshot, destination); progress.push({ backupPath: snapshot.backupPath, status: "verified" }); }
    catch { progress.push({ backupPath: snapshot.backupPath, status: "failed" }); }
    if (progress.length >= limit) break;
  }
  return progress;
}
