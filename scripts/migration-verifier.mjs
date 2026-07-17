export const migrationNamePattern = /^(\d{12})_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/;

function withoutComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--.*$/gm, " ");
}

function normalizeWhitespace(value) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function argumentTypes(argumentsSql) {
  return argumentsSql.split(",").map((argument) => {
    const declaration = normalizeWhitespace(argument).replace(/\s+default\s+[\s\S]*$/, "");
    const tokens = declaration.split(" ");
    const offset = ["in", "out", "inout", "variadic"].includes(tokens[0]) ? 2 : 1;
    return tokens.slice(offset).join(" ");
  }).filter(Boolean);
}

function escaped(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function verifySecurityDefinerPublicRevokes(entries) {
  const sql = normalizeWhitespace(withoutComments(entries.map((entry) => entry.sql).join("\n")));
  const functionPattern = /create\s+(?:or\s+replace\s+)?function\s+([a-z0-9_."]+)\s*\(([\s\S]*?)\)\s*returns\b/gi;
  const declarations = [...sql.matchAll(functionPattern)];

  for (let index = 0; index < declarations.length; index += 1) {
    const declaration = declarations[index];
    const blockEnd = declarations[index + 1]?.index ?? sql.length;
    const block = sql.slice(declaration.index, blockEnd);
    if (!/\bsecurity\s+definer\b/i.test(block)) continue;

    const name = normalizeWhitespace(declaration[1]);
    const types = argumentTypes(declaration[2]);
    const signature = `${name}(${types.join(", ")})`;
    const argumentsPattern = types.map(escaped).join("\\s*,\\s*");
    const revokePattern = new RegExp(
      `revoke\\s+(?:all(?:\\s+privileges)?|execute)\\s+on\\s+function\\s+${escaped(name)}\\s*\\(\\s*${argumentsPattern}\\s*\\)\\s+from\\s+public\\s*;`,
      "i",
    );
    if (!revokePattern.test(sql)) {
      throw new Error(`SECURITY DEFINER function lacks an explicit PUBLIC revoke: ${signature}.`);
    }
  }
}

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
  verifySecurityDefinerPublicRevokes(ordered);
  return ordered.map((entry) => entry.name);
}
