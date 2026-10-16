import type { SnapshotMetadata } from "./store";

// Remote accounting includes a conservative maximum AES-GCM index envelope overhead.
export const snapshotStorageBytes = (s: SnapshotMetadata) => s.storedBytes !== undefined ? s.storedBytes + Buffer.byteLength(JSON.stringify(s), "utf8") + 192 : s.compressedBytes + Buffer.byteLength(JSON.stringify(s), "utf8");

export function planSnapshotRetention(
  snapshots: SnapshotMetadata[],
  { maxAutomaticPerDataset = 2, maxHotCount = 100, maxHotBytes = 50 * 1024 * 1024, referencedPaths = new Set<string>(), protectedPaths = new Set<string>() } = {},
) {
  if (!Number.isSafeInteger(maxHotCount) || maxHotCount < 0 || !Number.isSafeInteger(maxAutomaticPerDataset) || maxAutomaticPerDataset < 0 || !Number.isSafeInteger(maxHotBytes) || maxHotBytes < 0) throw new Error("Invalid retention policy");
  const missingReferences = [...new Set([...referencedPaths, ...protectedPaths])].filter(p => !snapshots.some(s => s.backupPath === p));
  const protectedSnapshots = snapshots.filter(s => s.category !== "automatic" || s.relatedImportBatchIds.length > 0 || referencedPaths.has(s.backupPath) || protectedPaths.has(s.backupPath));
  const retained = [...protectedSnapshots], counts = new Map<string, number>();
  let hotBytes = retained.reduce((sum, s) => sum + snapshotStorageBytes(s), 0);
  const protectedBytes = hotBytes;
  for (const s of [...snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.snapshotId.localeCompare(a.snapshotId))) {
    if (protectedSnapshots.includes(s)) continue;
    const count = counts.get(s.originalKey) || 0;
    if (retained.length < maxHotCount && count < maxAutomaticPerDataset && hotBytes + snapshotStorageBytes(s) <= maxHotBytes) {
      retained.push(s); hotBytes += snapshotStorageBytes(s); counts.set(s.originalKey, count + 1);
    }
  }
  return { retained, cold: snapshots.filter(s => !retained.includes(s)), hotBytes, protectedBytes,
    protectedOverBudget: protectedBytes > maxHotBytes || protectedSnapshots.length > maxHotCount, missingReferences, deletionEnabled: false as const };
}
