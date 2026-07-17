export function resolveRelationalImportSnapshotMarker(paths: string[]) {
  const marker = paths.find((path) => path.startsWith("relational:"));
  if (!marker) throw new Error("Relational import snapshot not found for this batch");
  return { marker, snapshotId: marker.slice("relational:".length) };
}
