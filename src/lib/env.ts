import { z } from "zod";

const localDevelopmentSessionSecret = "local-development-session-secret-do-not-use-in-production";
const dataBackendSchema = z.enum(["local-json", "supabase", "supabase-relational"]);

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
