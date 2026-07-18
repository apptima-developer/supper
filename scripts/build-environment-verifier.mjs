import fs from "node:fs";
import path from "node:path";
import { verifyMigrationEntries } from "./migration-verifier.mjs";
import { inspectRuntimeAssets } from "./runtime-asset-inventory.mjs";

const backends = new Set(["local-json", "supabase", "supabase-relational"]);

function check(name, status, explanation) {
  return { name, status, explanation };
}

function selectedBackend(env) {
  if (env.DATA_BACKEND) return env.DATA_BACKEND;
  if (env.SUPABASE_DATA_MODEL === "relational") return "supabase-relational";
  return env.NODE_ENV === "production" ? "supabase" : "local-json";
}

function validOrigin(value, production) {
  try {
    const url = new URL(value);
    return !url.username
      && !url.password
      && url.pathname === "/"
      && !url.search
      && !url.hash
      && (url.protocol === "https:" || (!production && url.protocol === "http:"));
  } catch {
    return false;
  }
}

function optionalMetadataChecks(env) {
  const commit = env.APP_BUILD_SHA || env.VERCEL_GIT_COMMIT_SHA;
  const timestamp = env.APP_BUILD_TIMESTAMP;
  const deployment = env.VERCEL_ENV;
  return [
    !commit
      ? check("Build commit metadata", "OPTIONAL", "not configured")
      : /^[a-f0-9]{7,64}$/i.test(commit.trim())
        ? check("Build commit metadata", "PASS", "safe commit identifier configured")
        : check("Build commit metadata", "OPTIONAL", "invalid optional value will be omitted"),
    !timestamp
      ? check("Build timestamp metadata", "OPTIONAL", "not configured")
      : timestamp.trim().length <= 64 && Number.isFinite(Date.parse(timestamp.trim()))
        ? check("Build timestamp metadata", "PASS", "safe timestamp configured")
        : check("Build timestamp metadata", "OPTIONAL", "invalid optional value will be omitted"),
    !deployment
      ? check("Deployment label metadata", "OPTIONAL", "not configured")
      : deployment.trim().length <= 32 && /^[A-Za-z0-9._-]+$/.test(deployment.trim())
        ? check("Deployment label metadata", "PASS", "safe deployment label configured")
        : check("Deployment label metadata", "OPTIONAL", "invalid optional value will be omitted"),
  ];
}

export function validateBuildEnvironment(env = process.env) {
  const production = env.NODE_ENV === "production";
  const backend = selectedBackend(env);
  const checks = [
    backends.has(backend)
      ? check("DATA_BACKEND", "PASS", "supported backend selected")
      : check("DATA_BACKEND", "FAIL", "unsupported backend"),
  ];

  for (const [name, value, localFallback] of [
    ["SESSION_SECRET", env.SESSION_SECRET, true],
    ["RATE_LIMIT_PEPPER", env.RATE_LIMIT_PEPPER, true],
  ]) {
    if (!value && !production && localFallback) checks.push(check(name, "PASS", "development fallback available"));
    else if (typeof value === "string" && value.length >= 32) checks.push(check(name, "PASS", "configured with required length"));
    else checks.push(check(name, "FAIL", "required value is missing or too short"));
  }

  if (!env.APP_ORIGIN && !production) checks.push(check("APP_ORIGIN", "PASS", "derived from local request origin"));
  else if (env.APP_ORIGIN && validOrigin(env.APP_ORIGIN, production)) checks.push(check("APP_ORIGIN", "PASS", "valid application origin configured"));
  else checks.push(check("APP_ORIGIN", "FAIL", "required origin is missing or malformed"));

  for (const name of ["MAX_JSON_BODY_KB", "MAX_IMPORT_FILE_MB", "MAX_INLINE_IMAGE_MB"]) {
    const value = env[name];
    checks.push(!value || (/^\d+$/.test(value) && Number(value) > 0)
      ? check(name, "PASS", value ? "positive limit configured" : "safe default will be used")
      : check(name, "FAIL", "limit must be a positive integer"));
  }

  if (backend === "supabase" || backend === "supabase-relational") {
    let validUrl = false;
    try {
      validUrl = Boolean(env.NEXT_PUBLIC_SUPABASE_URL && new URL(env.NEXT_PUBLIC_SUPABASE_URL));
    } catch {
      validUrl = false;
    }
    checks.push(validUrl
      ? check("NEXT_PUBLIC_SUPABASE_URL", "PASS", "valid Supabase URL configured")
      : check("NEXT_PUBLIC_SUPABASE_URL", "FAIL", "required Supabase URL is missing or malformed"));
    checks.push(env.SUPABASE_SERVICE_ROLE_KEY
      ? check("SUPABASE_SERVICE_ROLE_KEY", "PASS", "server credential configured")
      : check("SUPABASE_SERVICE_ROLE_KEY", "FAIL", "required server credential is missing"));
  } else {
    checks.push(check("Supabase configuration", "PASS", "not required for selected backend"));
  }

  return [...checks, ...optionalMetadataChecks(env)];
}

async function readMigrationEntries(root) {
  const directory = path.join(root, "supabase", "migrations");
  const names = (await fs.promises.readdir(directory)).filter((name) => name.endsWith(".sql"));
  return Promise.all(names.map(async (name) => ({
    name,
    sql: await fs.promises.readFile(path.join(directory, name), "utf8"),
  })));
}

export async function collectBuildEnvironmentChecks({
  env = process.env,
  root = process.cwd(),
  exists,
  migrationEntries,
} = {}) {
  const checks = validateBuildEnvironment(env);
  for (const asset of inspectRuntimeAssets(root, exists)) {
    checks.push(asset.exists
      ? check(asset.label, "PASS", asset.required ? "required runtime asset is present" : "optional runtime asset is present")
      : asset.required
        ? check(asset.label, "FAIL", "required runtime asset is missing")
        : check(asset.label, "OPTIONAL", "optional runtime asset is absent"));
  }

  try {
    const verified = verifyMigrationEntries(migrationEntries || await readMigrationEntries(root));
    checks.push(check("Migration inventory", "PASS", `${verified.length} ordered migration files verified`));
  } catch {
    checks.push(check("Migration inventory", "FAIL", "migration filenames or contents are invalid"));
  }

  return checks;
}
