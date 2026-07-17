import { z } from "zod";

const localDevelopmentSessionSecret = "local-development-session-secret-do-not-use-in-production";
const localDevelopmentRateLimitPepper = "local-development-rate-limit-pepper-do-not-use-in-production";
const dataBackendSchema = z.enum(["local-json", "supabase", "supabase-relational"]);
const positiveInteger = z.coerce.number().int().positive();

export type DataBackend = z.infer<typeof dataBackendSchema>;

type EnvInput = Record<string, string | undefined>;

function isProduction(env: EnvInput) {
  return env.NODE_ENV === "production";
}

export function getDataBackend(env: EnvInput = process.env): DataBackend {
  if (env.DATA_BACKEND) return dataBackendSchema.parse(env.DATA_BACKEND);
  if (env.SUPABASE_DATA_MODEL === "relational") return "supabase-relational";
  return isProduction(env) ? "supabase" : "local-json";
}

export function isSupabaseBackend(env: EnvInput = process.env) {
  const backend = getDataBackend(env);
  return backend === "supabase" || backend === "supabase-relational";
}

export function getSessionSecret(env: EnvInput = process.env) {
  const secret = env.SESSION_SECRET;
  if (!secret) {
    if (isProduction(env)) {
      throw new Error("SESSION_SECRET is required in production and must be at least 32 characters.");
    }
    return localDevelopmentSessionSecret;
  }
  if (secret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters.");
  }
  return secret;
}

export function getRateLimitPepper(env: EnvInput = process.env) {
  const pepper = env.RATE_LIMIT_PEPPER;
  if (!pepper) {
    if (isProduction(env)) {
      throw new Error("RATE_LIMIT_PEPPER is required in production and must be at least 32 characters.");
    }
    return localDevelopmentRateLimitPepper;
  }
  if (pepper.length < 32) throw new Error("RATE_LIMIT_PEPPER must be at least 32 characters.");
  return pepper;
}

export function getAppOrigin(env: EnvInput = process.env) {
  const value = env.APP_ORIGIN;
  if (!value) {
    if (isProduction(env)) throw new Error("APP_ORIGIN is required in production and must be an HTTPS origin.");
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("APP_ORIGIN must be a valid absolute URL.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("APP_ORIGIN must contain only scheme, host, and optional port.");
  }
  if (isProduction(env) && url.protocol !== "https:") {
    throw new Error("APP_ORIGIN must use HTTPS in production.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("APP_ORIGIN must use HTTP or HTTPS.");
  }
  return url.origin;
}

export function getRequestLimits(env: EnvInput = process.env) {
  const parsed = z.object({
    MAX_JSON_BODY_KB: positiveInteger.default(512),
    MAX_IMPORT_FILE_MB: positiveInteger.default(20),
    MAX_INLINE_IMAGE_MB: positiveInteger.default(2),
  }).parse({
    MAX_JSON_BODY_KB: env.MAX_JSON_BODY_KB,
    MAX_IMPORT_FILE_MB: env.MAX_IMPORT_FILE_MB,
    MAX_INLINE_IMAGE_MB: env.MAX_INLINE_IMAGE_MB,
  });
  return {
    maxJsonBodyBytes: parsed.MAX_JSON_BODY_KB * 1024,
    maxImportFileBytes: parsed.MAX_IMPORT_FILE_MB * 1024 * 1024,
    maxInlineImageBytes: parsed.MAX_INLINE_IMAGE_MB * 1024 * 1024,
  };
}

export function getSupabaseConfig(env: EnvInput = process.env) {
  if (!isSupabaseBackend(env)) return null;
  const parsed = z.object({
    NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
    SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  }).safeParse(env);
  if (!parsed.success) {
    throw new Error("Supabase backend requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
  }
  return {
    url: new URL(parsed.data.NEXT_PUBLIC_SUPABASE_URL).origin,
    serviceRoleKey: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
  };
}

export function validateRuntimeEnvironment(env: EnvInput = process.env) {
  const checks: Array<{ name: string; ok: boolean; message: string }> = [];
  let backend: DataBackend = "local-json";

  try {
    backend = getDataBackend(env);
    checks.push({ name: "DATA_BACKEND", ok: true, message: backend });
  } catch (error) {
    checks.push({ name: "DATA_BACKEND", ok: false, message: error instanceof Error ? error.message : "Invalid data backend." });
  }

  try {
    getSessionSecret(env);
    checks.push({ name: "SESSION_SECRET", ok: true, message: "configured" });
  } catch (error) {
    checks.push({ name: "SESSION_SECRET", ok: false, message: error instanceof Error ? error.message : "Invalid session secret." });
  }

  try {
    getRateLimitPepper(env);
    checks.push({ name: "RATE_LIMIT_PEPPER", ok: true, message: "configured" });
  } catch (error) {
    checks.push({ name: "RATE_LIMIT_PEPPER", ok: false, message: error instanceof Error ? error.message : "Invalid rate-limit pepper." });
  }

  try {
    const origin = getAppOrigin(env);
    checks.push({ name: "APP_ORIGIN", ok: true, message: origin || "derived from local request origin" });
  } catch (error) {
    checks.push({ name: "APP_ORIGIN", ok: false, message: error instanceof Error ? error.message : "Invalid application origin." });
  }

  try {
    getRequestLimits(env);
    checks.push({ name: "REQUEST_LIMITS", ok: true, message: "configured" });
  } catch (error) {
    checks.push({ name: "REQUEST_LIMITS", ok: false, message: error instanceof Error ? error.message : "Invalid request limits." });
  }

  try {
    const config = getSupabaseConfig(env);
    checks.push({
      name: "SUPABASE",
      ok: true,
      message: config ? `${backend} configured` : "not required for selected backend",
    });
  } catch (error) {
    checks.push({ name: "SUPABASE", ok: false, message: error instanceof Error ? error.message : "Invalid Supabase configuration." });
  }

  return {
    ok: checks.every((check) => check.ok),
    backend,
    checks,
  };
}
