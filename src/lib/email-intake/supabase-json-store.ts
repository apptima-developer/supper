import "server-only";
import { supabaseAdmin } from "../supabaseAdmin";
import { getStores, listStoreKeys, setStore } from "../store";
import { emailIntakeRecordListSchema, type EmailIntakeRecord } from "./schemas";
import type { EmailIntakeJsonStore } from "./json-repository";

const keyPrefix = "integrations/email-intakes/";

function key(record: EmailIntakeRecord) {
  return `${keyPrefix}${record.idempotencyKey}.json`;
}

function storageError(action: string, cause: unknown) {
  return new Error(`Failed to ${action} email intake app_store record`, { cause });
}

export function createSupabaseEmailIntakeJsonStore(): EmailIntakeJsonStore {
  const store: EmailIntakeJsonStore = {
    async read() {
      const keys = await listStoreKeys(keyPrefix);
      const records: unknown[] = [];
      for (let offset = 0; offset < keys.length; offset += 200) {
        const batch = keys.slice(offset, offset + 200);
        const values = await getStores(batch);
        records.push(...batch.map((item) => values[item]).filter((item) => item !== undefined));
      }
      return records;
    },
    async write(records: readonly EmailIntakeRecord[]) {
      for (const record of emailIntakeRecordListSchema.parse(records)) await setStore(key(record), record);
    },
    async insertIfAbsent(record) {
      const { error } = await supabaseAdmin.from("app_store").insert({
        key: key(record),
        value: record,
        updated_at: record.updatedAt,
      });
      if (!error) return true;
      if (error.code === "23505") return false;
      throw storageError("create", error);
    },
    async replaceOne(record) {
      const { data, error } = await supabaseAdmin
        .from("app_store")
        .update({ value: record, updated_at: record.updatedAt })
        .eq("key", key(record))
        .select("key");
      if (error) throw storageError("update", error);
      return Boolean(data?.length);
    },
    async removeOne(record) {
      const { error } = await supabaseAdmin.from("app_store").delete().eq("key", key(record));
      if (error) throw storageError("delete", error);
      return true;
    },
  };
  return Object.freeze(store);
}
