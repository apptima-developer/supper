import { createHash } from "node:crypto";
import { z } from "zod";
import { backupTarget } from "../backup-restore-policy";

export const metadataSchema = z.object({
  metadataVersion: z.literal(1), schemaVersion: z.literal(1),
  snapshotId: z.string().regex(/^[a-f0-9]{64}$/), originalKey: z.string(), backupPath: z.string(),
  createdAt: z.string().datetime(), sourceVersion: z.string().min(1),
  checksum: z.string().regex(/^[a-f0-9]{64}$/), compressedChecksum: z.string().regex(/^[a-f0-9]{64}$/),
  compressedBytes: z.number().int().positive(), uncompressedBytes: z.number().int().positive(),
  storedBytes: z.number().int().positive().optional(),
  compression: z.literal("gzip"), storageLocation: z.string(), state: z.literal("externally_verified"),
  category: z.enum(["automatic", "manual", "import", "tombstone"]),
  relatedImportBatchIds: z.array(z.string().min(1)),
}).strict();
export type SnapshotMetadata = z.infer<typeof metadataSchema>;
export type SnapshotInput = Pick<SnapshotMetadata, "backupPath" | "createdAt" | "sourceVersion" | "category" | "relatedImportBatchIds"> & { json: string };
export interface SnapshotStore {
  saveSnapshot(input: SnapshotInput): Promise<SnapshotMetadata>;
  getSnapshot(backupPath: string): Promise<{ metadata: SnapshotMetadata; json: string }>;
  listSnapshots(): Promise<SnapshotMetadata[]>;
  verifySnapshot(backupPath: string): Promise<SnapshotMetadata>;
  getSnapshotMetadata(backupPath: string): Promise<SnapshotMetadata>;
  deleteSnapshot(backupPath: string): Promise<never>;
}
// Remote adapters preserve the same verified restore contract.
export interface S3CompatibleSnapshotStore extends SnapshotStore { readonly provider: "s3-compatible" }
export const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
export const snapshotId = (backupPath: string) => { backupTarget(backupPath); return sha256(backupPath); };

export function serializeSnapshot(value: unknown): string {
  function sorted(v: unknown): unknown {
    if (v === null || typeof v === "string" || typeof v === "boolean") return v;
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (Array.isArray(v)) return v.map(sorted);
    if (typeof v === "object" && v && [Object.prototype, null].includes(Object.getPrototypeOf(v))) {
      return Object.fromEntries(Object.keys(v).sort().map(k => [k, sorted((v as Record<string, unknown>)[k])]));
    }
    throw new Error("Snapshot must contain JSON values only");
  }
  return JSON.stringify(sorted(value));
}

export class SnapshotNotFoundError extends Error { constructor() { super("Snapshot object not found"); } }
