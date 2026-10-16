import path from "node:path";
import { backupTarget, isKnownBackupTarget } from "../backup-restore-policy";
import { LocalFilesystemSnapshotStore, SnapshotNotFoundError } from "./filesystem";
import { serializeSnapshot, sha256 } from "./store";
import { createS3SnapshotStore } from "./s3-config";
import type { SnapshotStore } from "./store";
import type { ZodType } from "zod";

let remoteSnapshot: { signature: string; store: ReturnType<typeof createS3SnapshotStore> } | undefined;

export function externalSnapshotStore(env: Record<string, string | undefined> = process.env) {
  if (!env.SUPPER_EXTERNAL_SNAPSHOTS || env.SUPPER_EXTERNAL_SNAPSHOTS === "0") return null;
  if (env.SUPPER_EXTERNAL_SNAPSHOTS !== "1" || env.NODE_ENV !== "test" || env.VERCEL) throw new Error("External snapshots are restricted to isolated local tests; production activation remains blocked");
  const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL || "http://invalid");
  if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) throw new Error("Snapshot tests require a localhost data endpoint");
  if (env.SUPPER_SNAPSHOT_PROVIDER === "s3") {
    const endpoint = new URL(env.SUPPER_S3_ENDPOINT || "http://invalid");
    if (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname)) throw new Error("Phase 04A activation permits synthetic localhost S3 tests only");
    const signature = sha256(JSON.stringify(Object.entries(env).filter(([key]) => key.startsWith("SUPPER_S3_") || key.startsWith("SUPPER_SNAPSHOT_")).sort(([a], [b]) => a.localeCompare(b))));
    if (!remoteSnapshot || remoteSnapshot.signature !== signature) {
      const store = createS3SnapshotStore(env);
      remoteSnapshot?.store.options.client.destroy();
      remoteSnapshot = { signature, store };
    }
    return remoteSnapshot.store;
  }
  if (env.SUPPER_SNAPSHOT_PROVIDER && env.SUPPER_SNAPSHOT_PROVIDER !== "filesystem") throw new Error("Invalid snapshot provider");
  const root = env.SUPPER_SNAPSHOT_ROOT;
  if (!root || !path.isAbsolute(root) || path.resolve(root).startsWith(process.cwd() + path.sep) || path.resolve(root) === process.cwd()) throw new Error("Snapshot root must be absolute and outside the repository");
  return new LocalFilesystemSnapshotStore(root);
}

export type SnapshotDatabase = {
  getVersionedStore: (target: string) => Promise<{ value: unknown; updatedAt: string } | undefined>;
  setStoreIfUnchanged: (target: string, value: unknown, version: string | undefined) => Promise<void>;
  getStore: <T>(target: string) => Promise<T | undefined>;
};

export async function saveCurrentSnapshot(target: string, current: { value: unknown; updatedAt: string }, archive: SnapshotStore, importBatchId?: string) {
  if (!isKnownBackupTarget(target)) throw new Error("Unknown backup target");
  const json = serializeSnapshot(current.value), timestamp = Date.parse(current.updatedAt);
  if (!Number.isFinite(timestamp) || String(timestamp).length !== 13) throw new Error("Invalid current dataset version");
  // Retries of the same persisted revision reuse the same legacy-compatible identifier.
  const suffix = sha256(`${target}\0${current.updatedAt}\0${sha256(json)}${importBatchId ? "\0" + importBatchId : ""}`);
  const backupPath = `backups/${target.slice(0, -5)}-${timestamp}-${suffix}.json`;
  return archive.saveSnapshot({ backupPath, json, createdAt: new Date(timestamp).toISOString(), sourceVersion: current.updatedAt, category: importBatchId ? "import" : "automatic", relatedImportBatchIds: importBatchId ? [importBatchId] : [] });
}

export async function externalWrite(target: string, value: unknown, database: SnapshotDatabase, archive: SnapshotStore) {
  if (!isKnownBackupTarget(target)) throw new Error("Unknown backup target");
  const current = await database.getVersionedStore(target);
  if (current) await saveCurrentSnapshot(target, current, archive);
  await database.setStoreIfUnchanged(target, value, current?.updatedAt);
}

export async function readBackup(backupPath: string, database: SnapshotDatabase, archive: SnapshotStore) {
  try { return JSON.parse((await archive.getSnapshot(backupPath)).json) as unknown; }
  catch (error) {
    if (!(error instanceof SnapshotNotFoundError)) throw error;
    const raw = await database.getStore<unknown>(backupPath);
    if (raw === undefined) throw new SnapshotNotFoundError();
    return raw;
  }
}

export async function validateSnapshotPayload(backupPath: string, value: unknown) {
  const { target } = backupTarget(backupPath);
  const types = await import("../types");
  const schemas: Record<string, ZodType> = {
    "core/customers.json": types.customerListSchema, "core/tickets.json": types.ticketListSchema,
    "core/ticket-history.json": types.historyListSchema, "audit/audit-log.json": types.auditListSchema,
    "auth/users.json": types.userListSchema, "master/statuses.json": types.statusListSchema,
    "master/sla.json": types.slaListSchema, "master/holidays.json": types.holidayListSchema,
    "master/categories.json": types.categoryListSchema, "master/teams.json": types.namedMasterListSchema,
    "master/issue-types.json": types.namedMasterListSchema, "master/contract-types.json": types.namedMasterListSchema,
    "master/priorities.json": types.namedMasterListSchema, "imports/import-batches.json": types.importBatchListSchema,
    "reports/report-jobs.json": types.reportJobListSchema,
  };
  const schema = target === "imports/mappings.json" ? (await import("../import-mappings")).importMappingsSchema : schemas[target];
  if (!schema) throw new Error("Missing restore validation schema");
  schema.parse(value);
  // Validate without applying schema defaults or stripping original fields.
  return value;
}

export function withSnapshotWrite<T>(archive: SnapshotStore, target: string, action: () => Promise<T>) {
  // Remote instances coordinate through database CAS, never a process-local or filesystem lock.
  return archive instanceof LocalFilesystemSnapshotStore ? archive.withDatasetLock(target, action) : action();
}
