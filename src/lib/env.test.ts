import { describe, expect, it } from "vitest";
import { getDataBackend, getSessionSecret, isSupabaseBackend, validateRuntimeEnvironment } from "./env";

describe("server environment validation", () => {
  it("allows the local-json backend without Supabase variables", () => {
    const env = { NODE_ENV: "development", DATA_BACKEND: "local-json" };
    const readiness = validateRuntimeEnvironment(env);

    expect(getDataBackend(env)).toBe("local-json");
    expect(readiness.ok).toBe(true);
    expect(readiness.checks.find((check) => check.name === "SUPABASE")?.message).toBe("not required for selected backend");
  });

  it("requires a strong session secret in production", () => {
    expect(() => getSessionSecret({ NODE_ENV: "production" })).toThrow(/SESSION_SECRET is required/);
    expect(() => getSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "short" })).toThrow(/at least 32/);
    expect(getSessionSecret({ NODE_ENV: "production", SESSION_SECRET: "0123456789abcdef0123456789abcdef" })).toHaveLength(32);
  });

  it("requires Supabase credentials only when a Supabase backend is selected", () => {
    expect(validateRuntimeEnvironment({
      NODE_ENV: "production",
      DATA_BACKEND: "supabase",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    }).ok).toBe(false);

    expect(validateRuntimeEnvironment({
      NODE_ENV: "production",
      DATA_BACKEND: "local-json",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
      RATE_LIMIT_PEPPER: "abcdef0123456789abcdef0123456789",
      APP_ORIGIN: "https://app.example.test",
    }).ok).toBe(true);

    expect(isSupabaseBackend({ DATA_BACKEND: "supabase" })).toBe(true);
    expect(isSupabaseBackend({ DATA_BACKEND: "supabase-relational" })).toBe(true);
    expect(isSupabaseBackend({ DATA_BACKEND: "local-json" })).toBe(false);
  });

  it("requires a rate-limit pepper and HTTPS application origin in production", () => {
    const base = {
      NODE_ENV: "production",
      DATA_BACKEND: "local-json",
      SESSION_SECRET: "0123456789abcdef0123456789abcdef",
    };
    expect(validateRuntimeEnvironment(base).ok).toBe(false);
    expect(validateRuntimeEnvironment({ ...base, RATE_LIMIT_PEPPER: "abcdef0123456789abcdef0123456789", APP_ORIGIN: "http://app.example.test" }).ok).toBe(false);
    expect(validateRuntimeEnvironment({ ...base, RATE_LIMIT_PEPPER: "abcdef0123456789abcdef0123456789", APP_ORIGIN: "https://app.example.test" }).ok).toBe(true);
  });
});
