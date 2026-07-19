import "server-only";
import { supabaseAdmin } from "../supabaseAdmin";
import type { EmailIntakeRelationalStore } from "./relational-repository";
import type { EmailIntakeRecord } from "./schemas";

const kindPrefix = "email-intake:";

function kind(record: EmailIntakeRecord) {
  return `${kindPrefix}${record.idempotencyKey}`;
}

function storageError(action: string, cause: unknown) {
  return new Error(`Failed to ${action} email intake`, { cause });
}

export function createSupabaseRelationalEmailIntakeStore(): EmailIntakeRelationalStore {
  const store: EmailIntakeRelationalStore = {
    async list() {
      const records: unknown[] = [];
      const pageSize = 1_000;
      for (let from = 0; ; from += pageSize) {
        const { data, error } = await supabaseAdmin
          .from("support_master_data")
          .select("data")
          .like("kind", `${kindPrefix}%`)
          .order("kind", { ascending: true })
          .range(from, from + pageSize - 1);
        if (error) throw storageError("list", error);
        records.push(...(data ?? []).map((row) => row.data));
        if (!data || data.length < pageSize) break;
      }
      return records;
    },
    async insert(record) {
      const { error } = await supabaseAdmin.from("support_master_data").insert({
        kind: kind(record),
        data: record,
        updated_at: record.updatedAt,
      });
      if (!error) return true;
      if (error.code === "23505") return false;
      throw storageError("create", error);
    },
    async replace(record) {
      const { data, error } = await supabaseAdmin
        .from("support_master_data")
        .update({ data: record, updated_at: record.updatedAt })
        .eq("kind", kind(record))
        .select("kind");
      if (error) throw storageError("update", error);
      return Boolean(data?.length);
    },
    async remove(record) {
      const { error } = await supabaseAdmin
        .from("support_master_data")
        .delete()
        .eq("kind", kind(record));
      if (error) throw storageError("delete", error);
      return true;
    },
  };
  return Object.freeze(store);
}
