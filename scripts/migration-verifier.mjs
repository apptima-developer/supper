export const migrationNamePattern = /^(\d{12})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

export function verifyMigrationEntries(entries) {
  if (!entries.length) throw new Error("No SQL migrations found in supabase/migrations.");
  const invalid = entries.filter((entry) => !migrationNamePattern.test(entry.name));
  if (invalid.length) throw new Error(`Invalid migration name(s): ${invalid.map((entry) => entry.name).join(", ")}. Expected YYYYMMDDNNNN_description.sql.`);
  const ordered = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  const versions = ordered.map((entry) => entry.name.match(migrationNamePattern)[1]);
  const duplicates = versions.filter((version, index) => versions.indexOf(version) !== index);
  if (duplicates.length) throw new Error(`Duplicate migration version(s): ${[...new Set(duplicates)].join(", ")}.`);
  const empty = ordered.find((entry) => !entry.sql.trim());
  if (empty) throw new Error(`Migration is empty: ${empty.name}.`);
  return ordered.map((entry) => entry.name);
}
