import { describe, expect, it, vi } from "vitest";
import { bootstrapAiDevAdmin, resolveAiDevBootstrapConfig } from "./ai-dev-bootstrap-helpers.mjs";

const baseEnv = {
  APP_ENV: "ai-development",
  ALLOW_INSECURE_DEV_BOOTSTRAP: "true",
  DATA_BACKEND: "supabase-relational",
  NEXT_PUBLIC_SUPABASE_URL: "https://abcdefghijklmnopqrst.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "server-secret",
  DEV_BOOTSTRAP_TARGET_PROJECT_REF: "abcdefghijklmnopqrst",
  DEV_BOOTSTRAP_ADMIN_USERNAME: "admin",
  DEV_BOOTSTRAP_ADMIN_PASSWORD: "dev-password",
  DEV_BOOTSTRAP_ADMIN_EMAIL: "admin@supper-ai-dev.test",
};

type TestUser = { id: string; username: string; email: string; authVersion: number; name?: string; role?: string; active?: boolean; passwordHash?: string };

describe("AI development bootstrap guards", () => {
  it.each([
    ["APP_ENV", "other", /APP_ENV/],
    ["ALLOW_INSECURE_DEV_BOOTSTRAP", "false", /ALLOW/],
    ["DATA_BACKEND", "supabase", /DATA_BACKEND/],
    ["VERCEL_ENV", "production", /production/],
    ["DEV_BOOTSTRAP_TARGET_PROJECT_REF", "bbbbbbbbbbbbbbbbbbbb", /does not match/],
  ] as const)("rejects unsafe %s", (key, value, pattern) => {
    expect(() => resolveAiDevBootstrapConfig({ ...baseEnv, [key]: value }, { knownProductionRefs: [] })).toThrow(pattern);
  });

  it("rejects known production and invalid Supabase targets", () => {
    expect(() => resolveAiDevBootstrapConfig(baseEnv, { knownProductionRefs: ["abcdefghijklmnopqrst"] })).toThrow(/production/);
    expect(() => resolveAiDevBootstrapConfig({ ...baseEnv, NEXT_PUBLIC_SUPABASE_URL: "https://example.com" }, { knownProductionRefs: [] })).toThrow(/Supabase project URL/);
  });
});

describe("AI development admin bootstrap", () => {
  function dependencies(existing?: TestUser) {
    const users: TestUser[] = existing ? [existing] : [];
    const logs: unknown[] = [];
    return {
      users,
      logs,
      deps: {
        findByUsername: vi.fn(async () => users.find((user) => user.username === "admin")),
        findByEmail: vi.fn(async () => users.find((user) => user.email === baseEnv.DEV_BOOTSTRAP_ADMIN_EMAIL)),
        hashPassword: vi.fn(async () => "opaque-hash"),
        createId: vi.fn(() => "new-id"),
        createUser: vi.fn(async (user: TestUser) => { users.push(user); }),
        updateUser: vi.fn(async (user: TestUser) => { users[users.findIndex((item) => item.id === user.id)] = user; }),
        log: vi.fn((event: unknown) => { logs.push(event); }),
      },
    };
  }

  it("creates the compatible user payload without logging secrets", async () => {
    const config = resolveAiDevBootstrapConfig(baseEnv, { knownProductionRefs: [] });
    const state = dependencies();
    const result = await bootstrapAiDevAdmin(config, state.deps);
    expect(state.users).toEqual([{ id: "new-id", username: "admin", name: "AI Development Admin", email: "admin@supper-ai-dev.test", passwordHash: "opaque-hash", role: "admin", active: true, authVersion: 1 }]);
    expect(state.deps.hashPassword).toHaveBeenCalledWith("dev-password", 10);
    expect(JSON.stringify(state.logs)).not.toContain("dev-password");
    expect(JSON.stringify(state.logs)).not.toContain("opaque-hash");
    expect(result.action).toBe("created");
  });

  it("keeps the ID, invalidates old sessions, and touches no other user", async () => {
    const existing: TestUser = { id: "existing-id", username: "admin", email: "admin@supper-ai-dev.test", authVersion: 4, name: "Old", role: "admin", active: true, passwordHash: "old" };
    const other: TestUser = { id: "other-id", username: "support", email: "support@example.test", authVersion: 1 };
    const state = dependencies(existing);
    state.users.push(other);
    const untouched = structuredClone(other);
    const config = resolveAiDevBootstrapConfig(baseEnv, { knownProductionRefs: [] });
    const result = await bootstrapAiDevAdmin(config, state.deps);
    expect(result).toMatchObject({ action: "updated", id: "existing-id", authVersion: 5 });
    expect(state.users.find((user) => user.id === "other-id")).toEqual(untouched);
    expect(state.deps.createUser).not.toHaveBeenCalled();
    expect(state.deps.updateUser).toHaveBeenCalledOnce();
  });
});
