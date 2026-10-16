import { promises as fs } from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";
import { getDataBackend } from "./env";
import { resolveStorageRouting } from "./storage-routing";
import { assertActiveBackupTarget, isActiveBackupTarget, backupTarget } from "./backup-restore-policy";

import { externalSnapshotStore, externalWrite, readBackup, saveCurrentSnapshot, validateSnapshotPayload, withSnapshotWrite } from "./snapshots/runtime";
export { backupTarget } from "./backup-restore-policy";

const DATA_ROOT = path.join(process.cwd(), "data");
const locks = new Map<string, Promise<unknown>>();
const dataBackend = getDataBackend();
const auxiliaryJsonStorage = resolveStorageRouting(dataBackend).auxiliaryJson;
const usesSupabaseAppStore = auxiliaryJsonStorage === "supabase-app-store";

type StoreModule = typeof import("./store");
type JsonBatchSpec = Record<string, { path: string; schema: ZodType }>;
type JsonBatchResult<T extends JsonBatchSpec> = {
  [K in keyof T]: T[K] extends { schema: ZodType<infer Output> } ? Output : never;
};

async function store(): Promise<StoreModule> {
  return import("./store");
}

export class JsonStoreRecordNotFoundError extends Error {
  readonly code = "JSON_STORE_RECORD_NOT_FOUND";

  constructor(readonly relativePath: string) {
    super(`Supabase app_store record not found: ${relativePath}`);
    this.name = "JsonStoreRecordNotFoundError";
  }
}

export function isJsonStoreRecordNotFoundError(error: unknown): error is JsonStoreRecordNotFoundError {
  return error instanceof JsonStoreRecordNotFoundError || (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "JSON_STORE_RECORD_NOT_FOUND"
  );
}

export function dataPath(relativePath: string) {
  const resolved = path.resolve(DATA_ROOT, relativePath);
  if (!resolved.startsWith(DATA_ROOT + path.sep)) throw new Error("Invalid data path");
  return resolved;
}

async function readFileJson<T>(relativePath: string, schema: ZodType<T>): Promise<T> {
  const raw = await fs.readFile(dataPath(relativePath), "utf8");
  return schema.parse(JSON.parse(raw));
}

export async function readJson<T>(relativePath: string, schema: ZodType<T>): Promise<T> {
  if (usesSupabaseAppStore) {
    const value = await (await store()).getStore<T>(relativePath);
    if (value === undefined) throw new JsonStoreRecordNotFoundError(relativePath);
    return schema.parse(value);
  }
  return readFileJson(relativePath, schema);
}

export async function readJsonBatch<T extends JsonBatchSpec>(specs: T): Promise<JsonBatchResult<T>> {
  const entries = Object.entries(specs) as Array<[keyof T & string, T[keyof T]]>;
  const paths = entries.map(([, spec]) => spec.path);

  if (usesSupabaseAppStore) {
    const values = await (await store()).getStores(paths);
    const result: Partial<JsonBatchResult<T>> = {};
    for (const [name, spec] of entries) {
      const value = values[spec.path];
      if (value === undefined) throw new JsonStoreRecordNotFoundError(spec.path);
      result[name] = spec.schema.parse(value) as JsonBatchResult<T>[keyof T];
    }
    return result as JsonBatchResult<T>;
  }

  const pairs = await Promise.all(entries.map(async ([name, spec]) => [
    name,
    await readFileJson(spec.path, spec.schema),
  ] as const));
  return Object.fromEntries(pairs) as JsonBatchResult<T>;
}

export async function writeJsonAtomic<T>(relativePath: string, value: T, schema: ZodType<T>) {
  const parsed = schema.parse(value);
  const archive = externalSnapshotStore();
  if (archive) {
    if (!usesSupabaseAppStore) throw new Error("External snapshot writer requires app_store");
    return withSnapshotWrite(archive, relativePath, async () => {
      await externalWrite(relativePath, parsed, await store(), archive);
      return parsed;
    });
  }
  const suffix = `${Date.now()}-${crypto.randomUUID()}`;

  if (usesSupabaseAppStore) {
    const current = await (await store()).getStore<T>(relativePath);
    if (current !== undefined) {
      const backupName = `backups/${path.dirname(relativePath)}/${path.basename(relativePath, ".json")}-${suffix}.json`;
      await (await store()).setStore(backupName, current);
    }
    await (await store()).setStore(relativePath, parsed);
    return parsed;
  }

  const target = dataPath(relativePath);
  const directory = path.dirname(target);
  const backupDirectory = path.join(DATA_ROOT, "backups", path.dirname(relativePath));
  await fs.mkdir(directory, { recursive: true });
  await fs.mkdir(backupDirectory, { recursive: true });

  const tempPath = `${target}.${suffix}.tmp`;
  try {
    await fs.access(target);
    const backupName = `${path.basename(relativePath, ".json")}-${suffix}.json`;
    await fs.copyFile(target, path.join(backupDirectory, backupName));
  } catch {
    // First write has no prior file to back up.
  }

  await fs.writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tempPath, target);
  return parsed;
}

export function updateJson<T>(relativePath: string, schema: ZodType<T>, updater: (current: T) => T | Promise<T>) {
  const archive = externalSnapshotStore();
  if (archive) {
    if (!usesSupabaseAppStore) throw new Error("External snapshot writer requires app_store");
    return withSnapshotWrite(archive, relativePath, async () => {
      const database = await store();
      const current = await database.getVersionedStore(relativePath);
      if (!current) throw new JsonStoreRecordNotFoundError(relativePath);
      const next = schema.parse(await updater(schema.parse(current.value)));
      await saveCurrentSnapshot(relativePath, current, archive);
      await database.setStoreIfUnchanged(relativePath, next, current.updatedAt);
      return next;
    });
  }
  const previous = locks.get(relativePath) ?? Promise.resolve();
  const operation = previous.then(async () => {
    const current = await readJson(relativePath, schema);
    return writeJsonAtomic(relativePath, await updater(current), schema);
  });
  locks.set(relativePath, operation.catch(() => undefined));
  return operation;
}

export async function listBackups() {
  if (usesSupabaseAppStore) {
    const keys = await (await store()).listStoreKeys("backups/");
    const archive = externalSnapshotStore();
    const external = archive ? (await archive.listSnapshots()).map(s => s.backupPath) : [];
    return [...new Set([...keys, ...external])].filter(isActiveBackupPath).sort().reverse();
  }

  const root = path.join(DATA_ROOT, "backups");
  const results: string[] = [];
  async function walk(directory: string) {
    try {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".json")) results.push(path.relative(DATA_ROOT, full));
      }
    } catch {
      return;
    }
  }
  await walk(root);
  return results.filter(isActiveBackupPath).sort().reverse();
}

function isActiveBackupPath(relativeBackupPath: string) {
  try {
    return isActiveBackupTarget(dataBackend, backupTarget(relativeBackupPath).target);
  } catch {
    return false;
  }
}

export async function restoreBackup(relativeBackupPath: string) {
  const { target } = backupTarget(relativeBackupPath);
  assertActiveBackupTarget(dataBackend, target);
  const archive = externalSnapshotStore();
  if (archive) {
    if (!usesSupabaseAppStore) throw new Error("External snapshot restore requires app_store");
    return withSnapshotWrite(archive, target, async () => {
      const database = await store();
      const raw = await validateSnapshotPayload(relativeBackupPath, await readBackup(relativeBackupPath, database, archive));
      await externalWrite(target, raw, database, archive);
      return target;
    });
  }

  if (usesSupabaseAppStore) {
    const raw = await (await store()).getStore<unknown>(relativeBackupPath);
    if (raw === undefined) throw new JsonStoreRecordNotFoundError(relativeBackupPath);
    const current = await (await store()).getStore<unknown>(target);
    if (current !== undefined) {
      const suffix = `${Date.now()}-${crypto.randomUUID()}`;
      const preRestoreBackup = `backups/${path.dirname(target)}/${path.basename(target, ".json")}-${suffix}.json`;
      await (await store()).setStore(preRestoreBackup, current);
    }
    await (await store()).setStore(target, raw);
    return target;
  }

  const source = dataPath(relativeBackupPath);
  const raw = JSON.parse(await fs.readFile(source, "utf8"));
  const targetPath = dataPath(target);
  const temporary = `${targetPath}.${crypto.randomUUID()}.restore.tmp`;
  await fs.copyFile(targetPath, `${targetPath}.${Date.now()}-${crypto.randomUUID()}.pre-restore.bak`);
  await fs.writeFile(temporary, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(temporary, targetPath);
  return target;
}

export async function restoreBackupSet(paths: string[]) {
  const earliest = new Map<string, { path: string; timestamp: number }>();
  for (const backup of paths) {
    const parsed = backupTarget(backup);
    const current = earliest.get(parsed.target);
    if (!current || parsed.timestamp < current.timestamp) earliest.set(parsed.target, { path: backup, timestamp: parsed.timestamp });
  }
  const archive = externalSnapshotStore();
  if (archive) {
    const database = await store();
    // Validate the entire selected rollback set before changing its first dataset.
    for (const { path: backup } of earliest.values()) {
      assertActiveBackupTarget(dataBackend, backupTarget(backup).target);
      await validateSnapshotPayload(backup, await readBackup(backup, database, archive));
    }
  }
  const restored: string[] = [];
  for (const { path: backup } of earliest.values()) restored.push(await restoreBackup(backup));
  return restored;
}

export async function captureExternalImportBackups(batchId: string) {
  const archive = externalSnapshotStore();
  if (!archive || dataBackend !== "supabase") return [];
  const database = await store();
  const backups: string[] = [];
  for (const target of ["core/tickets.json", "core/ticket-history.json", "audit/audit-log.json"]) {
    await withSnapshotWrite(archive, target, async () => {
      const current = await database.getVersionedStore(target);
      if (current) backups.push((await saveCurrentSnapshot(target, current, archive, batchId)).backupPath);
    });
  }
  return backups;
}
