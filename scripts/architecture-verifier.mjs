import fs from "node:fs";
import path from "node:path";

const expectedMigrations = Object.freeze([
  "202607170001_security_foundation.sql",
  "202607170002_security_foundation_corrections.sql",
  "202607180001_fix_login_rate_limit_rpc_conflict.sql",
  "202607180002_fix_login_rate_limit_rpc_variable_conflict.sql",
  "202607200001_servicenow_incremental_sync.sql",
  "202607200002_servicenow_sync_reliability_corrections.sql",
  "202607210001_servicenow_customer_mapping_operations.sql",
  "202607220001_unified_intake_core.sql",
]);

const domainFiles = Object.freeze([
  "src/lib/integrations/contracts.ts",
  "src/lib/integrations/errors.ts",
  "src/lib/integrations/idempotency.ts",
  "src/lib/integrations/normalization.ts",
  "src/lib/integrations/schemas.ts",
  "src/lib/integrations/validation.ts",
  "src/lib/integrations/sync/contracts.ts",
  "src/lib/integrations/sync/lock-policy.ts",
  "src/lib/email-intake/aggregate.ts",
  "src/lib/email-intake/errors.ts",
  "src/lib/email-intake/events.ts",
  "src/lib/email-intake/repository.ts",
  "src/lib/email-intake/schemas.ts",
  "src/lib/intake-core/contracts.ts",
  "src/lib/intake-core/conversation.ts",
  "src/lib/intake-core/email-compatibility.ts",
  "src/lib/intake-core/errors.ts",
  "src/lib/intake-core/identity.ts",
  "src/lib/intake-core/presentation.ts",
  "src/lib/intake-core/schemas.ts",
  "src/lib/intake-core/session.ts",
]);

const forbiddenDomainImports = [
  /^next(?:\/|$)/,
  /^react(?:\/|$)/,
  /^@supabase\//,
  /^(?:node:)?fs(?:\/promises)?$/,
  /^(?:node:)?(?:http|https|net|tls|dns)$/,
  /^server-only$/,
  /(?:^|\/)app(?:\/|$)/,
  /(?:^|\/)components(?:\/|$)/,
  /(?:^|\/)repository-factory$/,
  /(?:^|\/)(?:local-json-store|supabase-json-store|supabase-relational-store)$/,
  /(?:^|\/)supabase(?:-[a-z0-9-]+)?$/,
  /(?:^|\/)env$/,
];

const providerDependencyPattern = /(?:imap|imapflow|nodemailer|mailparser|microsoft-graph|msgraph|openai|n8n|servicenow)/i;
const sourceExtensions = [".ts", ".tsx", ".mjs", ".js"];

function readIfPresent(root, relative) {
  const absolute = path.join(root, relative);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute, "utf8") : undefined;
}

function importsFrom(source) {
  const imports = [];
  const pattern = /(?:\bfrom\s*|\bimport\s*(?:\(\s*)?)["']([^"']+)["']/g;
  for (const match of source.matchAll(pattern)) imports.push(match[1]);
  return imports;
}

function walkSourceFiles(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkSourceFiles(absolute);
    return sourceExtensions.includes(path.extname(entry.name)) ? [absolute] : [];
  });
}

function resolveRelativeImport(importer, specifier, candidates) {
  if (!specifier.startsWith(".")) return undefined;
  const base = path.resolve(path.dirname(importer), specifier);
  for (const candidate of [base, ...sourceExtensions.map((extension) => `${base}${extension}`), ...sourceExtensions.map((extension) => path.join(base, `index${extension}`))]) {
    if (candidates.has(candidate)) return candidate;
  }
  return undefined;
}

function circularDependencies(files) {
  const fileSet = new Set(files);
  const graph = new Map(files.map((file) => [file, importsFrom(fs.readFileSync(file, "utf8"))
    .map((specifier) => resolveRelativeImport(file, specifier, fileSet))
    .filter(Boolean)]));
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  const cycles = [];

  function visit(file) {
    if (visiting.has(file)) {
      const start = stack.indexOf(file);
      cycles.push([...stack.slice(start), file]);
      return;
    }
    if (visited.has(file)) return;
    visiting.add(file);
    stack.push(file);
    for (const dependency of graph.get(file) ?? []) visit(dependency);
    stack.pop();
    visiting.delete(file);
    visited.add(file);
  }
  for (const file of files) visit(file);
  return cycles;
}

export function verifyArchitecture(root) {
  const failures = [];
  const checks = [];
  const check = (name, valid, detail) => {
    checks.push({ name, valid, detail });
    if (!valid) failures.push(`${name}: ${detail}`);
  };

  const requiredFiles = [...domainFiles, "src/lib/integrations/index.ts", "src/lib/email-intake/index.ts", "src/lib/repositories.ts"];
  const missing = requiredFiles.filter((relative) => !fs.existsSync(path.join(root, relative)));
  check("required architecture files", missing.length === 0, missing.length ? `missing ${missing.join(", ")}` : "present");

  const boundaryViolations = [];
  for (const relative of domainFiles) {
    const source = readIfPresent(root, relative);
    if (source === undefined) continue;
    if (/\bprocess\.env\b|\bfetch\s*\(|\bnew\s+WebSocket\b/.test(source)) {
      boundaryViolations.push(`${relative} -> runtime environment or network primitive`);
    }
    for (const specifier of importsFrom(source)) {
      if (forbiddenDomainImports.some((pattern) => pattern.test(specifier))) {
        boundaryViolations.push(`${relative} -> ${specifier}`);
      }
    }
  }
  check("domain dependency direction", boundaryViolations.length === 0, boundaryViolations.join(", ") || "pure domain boundaries");

  const sourceFiles = [
    ...walkSourceFiles(path.join(root, "src/lib/integrations")),
    ...walkSourceFiles(path.join(root, "src/lib/email-intake")),
    ...walkSourceFiles(path.join(root, "src/lib/intake-core")),
  ];
  const cycles = circularDependencies(sourceFiles);
  check("circular dependencies", cycles.length === 0, cycles.length ? `${cycles.length} cycle(s) detected` : "none detected");

  const integrationIndex = readIfPresent(root, "src/lib/integrations/index.ts") ?? "";
  const integrationLeaks = ["InMemoryIntegrationConnector", "cloneBoundedJsonObject"]
    .filter((name) => integrationIndex.includes(name));
  check("integration public surface", integrationLeaks.length === 0, integrationLeaks.join(", ") || "test and internal helpers are private");

  const emailIndex = readIfPresent(root, "src/lib/email-intake/index.ts") ?? "";
  const emailLeaks = ["./json-repository", "./relational-repository", "./repository-factory", "EmailIntakePersistence"]
    .filter((name) => emailIndex.includes(name));
  check("email-intake public surface", emailLeaks.length === 0, emailLeaks.join(", ") || "domain API only");

  const packageSource = readIfPresent(root, "package.json");
  let providerDependencies = [];
  if (packageSource) {
    const packageJson = JSON.parse(packageSource);
    providerDependencies = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })
      .filter((name) => providerDependencyPattern.test(name));
  }
  check("provider SDK boundary", providerDependencies.length === 0, providerDependencies.join(", ") || "no provider SDK dependencies");

  const migrationDirectory = path.join(root, "supabase/migrations");
  const migrations = fs.existsSync(migrationDirectory)
    ? fs.readdirSync(migrationDirectory).filter((name) => name.endsWith(".sql")).sort()
    : [];
  check("immutable migration inventory", JSON.stringify(migrations) === JSON.stringify(expectedMigrations), migrations.join(", ") || "missing");

  return Object.freeze({ checks: Object.freeze(checks), failures: Object.freeze(failures) });
}
