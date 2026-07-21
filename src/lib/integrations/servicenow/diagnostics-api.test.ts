import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../auth";
import { getSafeServiceNowRuntimeDiagnostics } from "./diagnostics";
import { handleServiceNowDiagnosticsGet } from "./diagnostics-api";

vi.mock("server-only", () => ({}));

const admin: Session = { userId: "admin-id", username: "admin", name: "Admin", role: "admin", authVersion: 1 };
const support: Session = { ...admin, userId: "support-id", username: "support", role: "support" };
const safeEnv = {
  APP_ENV: " AI-DEVELOPMENT ",
  VERCEL_ENV: "preview",
  VERCEL_GIT_COMMIT_REF: "ai_development",
  VERCEL_GIT_COMMIT_SHA: "abcdef1234567890abcdef1234567890abcdef12",
  VERCEL_URL: "supper-ai-development.example.test/private/path?not=returned",
  SERVICENOW_ENABLED: " TRUE ",
  SERVICENOW_INSTANCE_URL: " https://dev12345.service-now.com ",
  SERVICENOW_AUTH_MODE: " BASIC ",
  SERVICENOW_USERNAME: " machine-user ",
  SERVICENOW_PASSWORD: "diagnostic-password-secret",
  SERVICENOW_CLIENT_ID: "unused-client-id",
  SERVICENOW_CLIENT_SECRET: "diagnostic-client-secret",
  SERVICENOW_TIMEOUT_MS: " 15000 ",
  SERVICENOW_PAGE_SIZE: " 100 ",
  SERVICENOW_INCIDENT_TABLE: " incident ",
  SERVICENOW_SYNC_ENABLED: " TRUE ",
  SUPABASE_SERVICE_ROLE_KEY: "diagnostic-supabase-secret",
  SESSION_SECRET: "diagnostic-session-secret",
  UNRELATED_PRIVATE_VALUE: "diagnostic-unrelated-secret",
};

function request() {
  return new Request("https://supper-ai-development.example.test/api/integrations/servicenow/diagnostics", {
    headers: { "X-Request-ID": "request-diagnostics-1234" },
  });
}

function dependencies(session: Session | null, env = safeEnv) {
  return { env, getSession: vi.fn(async () => session) };
}

describe("safe ServiceNow runtime diagnostics", () => {
  it.each([
    ["no session", null, safeEnv],
    ["non-admin", support, safeEnv],
    ["other application environment", admin, { ...safeEnv, APP_ENV: "staging" }],
    ["production Vercel environment", admin, { ...safeEnv, VERCEL_ENV: " PRODUCTION " }],
  ])("returns a generic 404 for %s", async (_label, session, env) => {
    const response = await handleServiceNowDiagnosticsGet(request(), dependencies(session, env));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: "Not found", code: "NOT_FOUND" });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("returns bounded presence and validation state to an admin in Preview", async () => {
    const response = await handleServiceNowDiagnosticsGet(request(), dependencies(admin));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({
      requestId: "request-diagnostics-1234",
      diagnostics: {
        deployment: { appEnvironment: "ai-development", vercelEnvironment: "preview", gitBranch: "ai_development", commitSha: "abcdef123456", deploymentHost: "supper-ai-development.example.test" },
        serviceNow: { enabledNormalized: true, instanceHostname: "dev12345.service-now.com", authModeNormalized: "basic", usernamePresent: true, passwordPresent: true, passwordNonEmpty: true, configurationValid: true, validationIssues: [] },
        synchronization: { enabledNormalized: true, configurationValid: true, validationIssues: [] },
      },
    });
  });

  it("returns sanitized issue paths without serializing any secret or raw environment", () => {
    const diagnostics = getSafeServiceNowRuntimeDiagnostics({
      ...safeEnv,
      SERVICENOW_ENABLED: "yes",
      SERVICENOW_SYNC_ENABLED: "1",
    });
    expect(diagnostics.serviceNow).toMatchObject({ enabledNormalized: null, configurationValid: false });
    expect(diagnostics.serviceNow.validationIssues).toContainEqual(expect.objectContaining({ path: "enabled", message: "Expected true or false" }));
    expect(diagnostics.synchronization.validationIssues).toContainEqual(expect.objectContaining({ path: "enabled", message: "Expected true or false" }));

    const serialized = JSON.stringify(diagnostics);
    for (const forbidden of [
      safeEnv.SERVICENOW_PASSWORD,
      safeEnv.SERVICENOW_CLIENT_SECRET,
      safeEnv.SUPABASE_SERVICE_ROLE_KEY,
      safeEnv.SESSION_SECRET,
      safeEnv.UNRELATED_PRIVATE_VALUE,
      "/private/path",
      "not=returned",
    ]) expect(serialized).not.toContain(forbidden);
    expect(serialized).not.toMatch(/passwordLength|clientSecretLength|processEnv/i);
  });

  it("identifies a missing credential by application path without credential detail", () => {
    const diagnostics = getSafeServiceNowRuntimeDiagnostics({ ...safeEnv, SERVICENOW_PASSWORD: "" });
    expect(diagnostics.serviceNow).toMatchObject({ passwordPresent: true, passwordNonEmpty: false, configurationValid: false });
    expect(diagnostics.serviceNow.validationIssues).toContainEqual({
      path: "password",
      code: "too_small",
      message: "Basic authentication credential is missing or invalid",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("diagnostic-password-secret");
  });
});
