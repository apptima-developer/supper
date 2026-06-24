import { promises as fs } from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";

const DATA_ROOT = path.join(process.cwd(), "data");
const locks = new Map<string, Promise<unknown>>();
const supabaseEnabled = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
const strictSupabase = process.env.DATA_BACKEND === "supabase" || process.env.NODE_ENV === "production";

type StoreModule = typeof import("./store");

async function store(): Promise<StoreModule> {
  return import("./store");
}

function supabaseRequiredError(action: string, relativePath = "data") {
  return new Error(
    `Supabase storage is required to ${action} ${relativePath}. ` +
    "Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, run scripts/supabase-app-store.sql, then run npm run supabase:seed.",
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
  if (supabaseEnabled) {
    try {
      const value = await (await store()).getStore<T>(relativePath);
      if (value !== undefined) return schema.parse(value);
    } catch (error) {
      if (strictSupabase) throw error;
      console.warn(`Supabase read failed for ${relativePath}; falling back to local data/.`);
    }
  }
  if (strictSupabase) throw supabaseRequiredError("read", relativePath);
  return readFileJson(relativePath, schema);
}

export async function writeJsonAtomic<T>(relativePath: string, value: T, schema: ZodType<T>) {
  const parsed = schema.parse(value);
  const suffix = `${Date.now()}-${crypto.randomUUID()}`;

  if (supabaseEnabled) {
    try {
      const current = await (await store()).getStore<T>(relativePath);
      if (current !== undefined) {
        const backupName = `backups/${path.dirname(relativePath)}/${path.basename(relativePath, ".json")}-${suffix}.json`;
        await (await store()).setStore(backupName, current);
      }
      await (await store()).setStore(relativePath, parsed);
      return parsed;
    } catch (error) {
      if (strictSupabase) throw error;
      console.warn(`Supabase write failed for ${relativePath}; falling back to local data/.`);
    }
  }
  if (strictSupabase) throw supabaseRequiredError("write", relativePath);

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
  const previous = locks.get(relativePath) ?? Promise.resolve();
  const operation = previous.then(async () => {
    const current = await readJson(relativePath, schema);
    return writeJsonAtomic(relativePath, await updater(current), schema);
  });
  locks.set(relativePath, operation.catch(() => undefined));
  return operation;
}

export async function listBackups() {
  if (supabaseEnabled) {
    try {
      const keys = await (await store()).listStoreKeys("backups/");
      return keys.filter((key) => key.endsWith(".json")).sort().reverse();
    } catch (error) {
      if (strictSupabase) throw error;
      console.warn("Supabase backup listing failed; falling back to local data/backups.");
    }
  }
  if (strictSupabase) throw supabaseRequiredError("list backups from", "backups/");

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
  return results.sort().reverse();
}

function backupTarget(relativeBackupPath: string) {
  if (!relativeBackupPath.startsWith("backups/")) throw new Error("Invalid backup path");
  const relative = relativeBackupPath.slice("backups/".length);
  const directory = path.dirname(relative);
  const match = path.basename(relative).match(/^(.*)-(\d{13})-[0-9a-f-]+\.json$/i);
  if (!match) throw new Error("Unrecognized backup name");
  return { target: path.join(directory, `${match[1]}.json`), timestamp: Number(match[2]) };
}

export async function restoreBackup(relativeBackupPath: string) {
  const { target } = backupTarget(relativeBackupPath);

  if (supabaseEnabled) {
    try {
      const raw = await (await store()).getStore<unknown>(relativeBackupPath);
      if (raw === undefined) throw new Error("Backup not found");
      const current = await (await store()).getStore<unknown>(target);
      if (current !== undefined) {
        const suffix = `${Date.now()}-${crypto.randomUUID()}`;
        const preRestoreBackup = `backups/${path.dirname(target)}/${path.basename(target, ".json")}-${suffix}.json`;
        await (await store()).setStore(preRestoreBackup, current);
      }
      await (await store()).setStore(target, raw);
      return target;
    } catch (error) {
      if (strictSupabase) throw error;
      console.warn(`Supabase restore failed for ${relativeBackupPath}; falling back to local data/backups.`);
    }
  }
  if (strictSupabase) throw supabaseRequiredError("restore backup", relativeBackupPath);

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
  const restored: string[] = [];
  for (const { path: backup } of earliest.values()) restored.push(await restoreBackup(backup));
  return restored;
}
