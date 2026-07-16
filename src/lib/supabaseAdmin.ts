import "server-only";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseConfig } from "./env";

const config = getSupabaseConfig();

if (!config) {
  throw new Error("Supabase admin client requested while DATA_BACKEND is not a Supabase backend.");
}

export const supabaseAdmin = createClient(config.url, config.serviceRoleKey, {
  auth: {
    persistSession: false,
  },
});
