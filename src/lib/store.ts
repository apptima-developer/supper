import "server-only";
import { supabaseAdmin } from "@/lib/supabaseAdmin";

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
