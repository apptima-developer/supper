import type { validateRuntimeEnvironment } from "./env";

type RuntimeReadiness = ReturnType<typeof validateRuntimeEnvironment>;

const failedCheckMessages: Record<string, string> = {
  DATA_BACKEND: "Invalid data backend configuration.",
  SESSION_SECRET: "Session configuration is invalid.",
  RATE_LIMIT_PEPPER: "Rate-limit configuration is invalid.",
  APP_ORIGIN: "Application origin configuration is invalid.",
  REQUEST_LIMITS: "Request limit configuration is invalid.",
  SUPABASE: "Supabase configuration is invalid.",
};

export function sanitizedReadinessChecks(readiness: RuntimeReadiness) {
  return readiness.checks.map((check) => {
    if (!check.ok) {
      return {
        name: check.name,
        ok: false,
        message: failedCheckMessages[check.name] || "Configuration is invalid.",
      };
    }

    if (check.name === "DATA_BACKEND") return { name: check.name, ok: true, message: readiness.backend };
    if (check.name === "SUPABASE") {
      return {
        name: check.name,
        ok: true,
        message: readiness.backend === "local-json" ? "not required for selected backend" : "configured",
      };
    }
    if (check.name === "APP_ORIGIN") {
      return {
        name: check.name,
        ok: true,
        message: check.message === "derived from local request origin" ? check.message : "configured",
      };
    }
    return { name: check.name, ok: true, message: "configured" };
  });
}
