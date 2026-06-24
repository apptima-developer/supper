import fs from "node:fs/promises";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing Supabase env. Check .env.local");
}

const normalizedSupabaseUrl = new URL(supabaseUrl).origin;

const supabase = createClient(normalizedSupabaseUrl, serviceRoleKey, {
  auth: {
    persistSession: false,
  },
});

const dataDir = path.join(process.cwd(), "data");

async function jsonFiles(directory) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...await jsonFiles(fullPath));
    } else if (entry.name.endsWith(".json")) {
      files.push(fullPath);
    }
  }
  return files;
}

const files = await jsonFiles(dataDir);
let seeded = 0;

for (const fullPath of files) {
  const key = path.relative(dataDir, fullPath).split(path.sep).join("/");
  const raw = await fs.readFile(fullPath, "utf8");
  const value = JSON.parse(raw);

  const { error } = await supabase.from("app_store").upsert(
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
    if (/permission denied/i.test(error.message)) {
      throw new Error(`Failed to seed ${key}: ${error.message}. Run scripts/supabase-app-store.sql in the Supabase SQL Editor, then retry.`);
    }
    throw new Error(`Failed to seed ${key}: ${error.message}`);
  }

  seeded += 1;
  console.log(`Seeded data/${key} -> app_store.${key}`);
}

console.log(`Seed complete: ${seeded} JSON files`);
