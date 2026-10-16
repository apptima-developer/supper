import "server-only";
import { HttpError } from "./request-security";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

export async function getVersionedStore(target: string) {
  const { data, error } = await supabaseAdmin.from("app_store").select("value,updated_at").eq("key", target).maybeSingle();
  if (error) throw new Error("Failed to read versioned app_store data");
  return data ? { value: data.value as unknown, updatedAt: data.updated_at as string } : undefined;
}

export async function setStoreIfUnchanged(target: string, value: unknown, version: string | undefined) {
  const updated_at = new Date(Math.max(Date.now(), version ? Date.parse(version) + 1 : 0)).toISOString();
  const table = supabaseAdmin.from("app_store");
  const { data, error } = version
    ? await table.update({ value, updated_at }).eq("key", target).eq("updated_at", version).select("key")
    : await table.insert({ key: target, value, updated_at }).select("key");
  if (error && error.code !== "23505") throw new Error("Dataset write failed; no successful update confirmed");
  if (error || data?.length !== 1) throw new HttpError(409, "DATASET_CONFLICT", "Dataset changed concurrently; retry from current data");
}

export async function getStore<T>(key: string): Promise<T | undefined> {
  const { data, error } = await supabaseAdmin
    .from("app_store")
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error) {
    throw new Error(`Failed to read app_store.${key}: ${error.message}`);
  }

  if (!data) return undefined;

  return data.value as T;
}

export async function getStores(keys: readonly string[]): Promise<Record<string, unknown | undefined>> {
  const uniqueKeys = [...new Set(keys)];
  if (!uniqueKeys.length) return {};

  const { data, error } = await supabaseAdmin
    .from("app_store")
    .select("key,value")
    .in("key", uniqueKeys);

  if (error) {
    throw new Error(`Failed to read app_store batch: ${error.message}`);
  }

  const rows = new Map((data || []).map((row) => [row.key, row.value as unknown]));
  return Object.fromEntries(uniqueKeys.map((key) => [key, rows.get(key)]));
}

export async function setStore<T>(key: string, value: T): Promise<void> {
  const { error } = await supabaseAdmin
    .from("app_store")
    .upsert(
      {
        key,
        value,
        updated_at: new Date().toISOString(),
      },
      {
        onConflict: "key",
      }
    );

  if (error) {
    throw new Error(`Failed to write app_store.${key}: ${error.message}`);
  }
}

export async function listStoreKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabaseAdmin
      .from("app_store")
      .select("key")
      .like("key", `${prefix}%`)
      .order("key", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) {
      throw new Error(`Failed to list app_store keys for ${prefix}: ${error.message}`);
    }

    keys.push(...(data || []).map((row) => row.key));
    if (!data || data.length < pageSize) break;
  }
  return keys;
}
