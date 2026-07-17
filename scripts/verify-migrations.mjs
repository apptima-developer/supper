import { promises as fs } from "node:fs";
import path from "node:path";
import { verifyMigrationEntries } from "./migration-verifier.mjs";

const migrationDirectory = path.join(process.cwd(), "supabase", "migrations");

async function main() {
  let names;
  try {
    names = (await fs.readdir(migrationDirectory)).filter((name) => name.endsWith(".sql"));
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      throw new Error("Missing supabase/migrations directory.");
    }
    throw error;
  }

  const ordered = verifyMigrationEntries(await Promise.all(names.map(async (name) => ({
    name,
    sql: await fs.readFile(path.join(migrationDirectory, name), "utf8"),
  }))));

  console.log("Migration verification");
  console.log("======================");
  for (const name of ordered) console.log(`OK       ${name}`);
  console.log(`\n${ordered.length} migration(s) are valid, ordered, and uniquely versioned.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : "Migration verification failed.");
  process.exitCode = 1;
});
