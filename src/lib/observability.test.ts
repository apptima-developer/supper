import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getLive } from "@/app/api/health/live/route";
import { GET as getReady } from "@/app/api/health/ready/route";
import { getBuildMetadata, runtimeEnvironmentCategory } from "./build-metadata";
import { isValidRequestId, REQUEST_ID_HEADER, resolveRequestId } from "./request-id";
import { HttpError, jsonResponseWithRequestId, safeErrorResponse } from "./request-security";
import { logServerError, redactSensitive } from "./server-logging";

const validProductionEnv = {
  NODE_ENV: "production",
  DATA_BACKEND: "local-json",
  SESSION_SECRET: "0123456789abcdef0123456789abcdef",
  RATE_LIMIT_PEPPER: "abcdef0123456789abcdef0123456789",
  APP_ORIGIN: "https://app.example.test",
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("request correlation IDs", () => {
  it("accepts only bounded safe incoming IDs", () => {
    expect(resolveRequestId("request_123456", () => "generated-id")).toBe("request_123456");
    expect(resolveRequestId("short", () => "generated-id")).toBe("generated-id");
    expect(resolveRequestId("a".repeat(101), () => "generated-id")).toBe("generated-id");
    expect(resolveRequestId("request/id", () => "generated-id")).toBe("generated-id");
  });

  it("generates a UUID fallback", () => {
    const generated = resolveRequestId(null);
    expect(generated).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(isValidRequestId(generated)).toBe(true);
  });

  it("propagates IDs through JSON and safe error responses", async () => {
    const request = new Request("https://app.example.test/api/example", { headers: { [REQUEST_ID_HEADER]: "request_123456" } });
    const response = jsonResponseWithRequestId({ status: "ok" }, request);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("request_123456");
    await expect(response.json()).resolves.toMatchObject({ requestId: "request_123456" });

    const errorResponse = safeErrorResponse(new HttpError(400, "INVALID_TEST", "Invalid request"), "Fallback", request, 500);
    expect(errorResponse.headers.get(REQUEST_ID_HEADER)).toBe("request_123456");
    await expect(errorResponse.json()).resolves.toMatchObject({ code: "INVALID_TEST", requestId: "request_123456" });
  });
});

describe("safe build metadata", () => {
  it("normalizes valid optional metadata", () => {
    expect(getBuildMetadata({
      APP_BUILD_SHA: "ABCDEF0123456789",
      APP_BUILD_TIMESTAMP: "2026-07-18T08:30:00+07:00",
      VERCEL_ENV: "preview_1",
    })).toMatchObject({
      commitSha: "abcdef012345",
      buildTimestamp: "2026-07-18T01:30:00.000Z",
      deploymentEnvironment: "preview_1",
    });
  });

  it("omits invalid, overly long, and missing optional values", () => {
    const metadata = getBuildMetadata({
      APP_BUILD_SHA: "not-a-sha",
      VERCEL_GIT_COMMIT_SHA: "still-not-a-sha",
      APP_BUILD_TIMESTAMP: "x".repeat(65),
      VERCEL_ENV: "x".repeat(33),
    });
    expect(metadata.version).toBeTruthy();
    expect(metadata).not.toHaveProperty("commitSha");
    expect(metadata).not.toHaveProperty("buildTimestamp");
    expect(metadata).not.toHaveProperty("deploymentEnvironment");
    expect(getBuildMetadata({})).toEqual({ version: metadata.version });
    expect(runtimeEnvironmentCategory({ NODE_ENV: "test" })).toBe("test");
  });
});

describe("health diagnostics", () => {
  it("keeps liveness public, lightweight, and correlated", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_ORIGIN", "");
    vi.stubEnv("SESSION_SECRET", "");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "do-not-expose");
    const request = new Request("https://app.example.test/api/health/live", { headers: { [REQUEST_ID_HEADER]: "health_live_123" } });
    const response = getLive(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("health_live_123");
    expect(body).toMatchObject({
      application: "SUPPER Support Control System",
      status: "live",
      requestId: "health_live_123",
      environment: "production",
    });
    expect(body.version).toBeTruthy();
    expect(Date.parse(body.timestamp)).not.toBeNaN();
    expect(JSON.stringify(body)).not.toContain("do-not-expose");
    expect(Object.keys(body)).not.toContain("hostname");
  });

  it("returns ready with sanitized checks and request ID", async () => {
    for (const [name, value] of Object.entries(validProductionEnv)) vi.stubEnv(name, value);
    vi.stubEnv("APP_BUILD_SHA", "abcdef0123456789");
    const response = getReady(new Request("https://app.example.test/api/health/ready", { headers: { [REQUEST_ID_HEADER]: "health_ready_123" } }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("health_ready_123");
    expect(body.status).toBe("ready");
    expect(body.backend).toBe("local-json");
    expect(body.requestId).toBe("health_ready_123");
    expect(body.checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
    expect(JSON.stringify(body)).not.toContain(validProductionEnv.SESSION_SECRET);
    expect(JSON.stringify(body)).not.toContain(validProductionEnv.RATE_LIMIT_PEPPER);
    expect(JSON.stringify(body)).not.toContain(validProductionEnv.APP_ORIGIN);
  });

  it("returns 503 with sanitized failures and no secret values", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATA_BACKEND", "supabase");
    vi.stubEnv("SESSION_SECRET", "exposed-short-secret");
    vi.stubEnv("RATE_LIMIT_PEPPER", "exposed-short-pepper");
    vi.stubEnv("APP_ORIGIN", "https://user:password@app.example.test/private");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "exposed-service-role");
    const response = getReady(new Request("https://app.example.test/api/health/ready"));
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(503);
    expect(serialized).toContain("not_ready");
    expect(serialized).not.toContain("exposed-short-secret");
    expect(serialized).not.toContain("exposed-short-pepper");
    expect(serialized).not.toContain("exposed-service-role");
    expect(serialized).not.toContain("user:password");
  });
});

describe("structured server logging", () => {
  it("redacts nested values, arrays, errors, circular values, BigInt, and long strings", () => {
    const circular: Record<string, unknown> = { count: BigInt(12), invalidDate: new Date(Number.NaN) };
    circular.self = circular;
    const redacted = redactSensitive({
      password: "plain-password",
      nested: [{ serviceRole: "role-secret", authorization: "Bearer secret", username: "private-user", email: "private@example.test" }],
      circular,
      long: "x".repeat(700),
      error: Object.assign(new Error("sensitive path /private/example"), { stack: "sensitive stack" }),
    });
    const serialized = JSON.stringify(redacted);

    expect(serialized).not.toContain("plain-password");
    expect(serialized).not.toContain("role-secret");
    expect(serialized).not.toContain("Bearer secret");
    expect(serialized).not.toContain("private-user");
    expect(serialized).not.toContain("private@example.test");
    expect(serialized).not.toContain("sensitive path");
    expect(serialized).not.toContain("sensitive stack");
    expect(serialized).toContain("[circular]");
    expect(serialized).toContain("12n");
    expect(serialized).toContain("[invalid-date]");
    expect(serialized).toContain("[truncated]");
  });

  it("emits safe operational fields and never throws when logging fails", () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => logServerError("diagnostic_event", new Error("hidden"), {
      requestId: "request_123456",
      route: "/api/health/ready",
      operation: "readiness",
      apiKey: "hidden-key",
    })).not.toThrow();
    const entry = JSON.parse(String(output.mock.calls[0][0]));
    expect(entry).toMatchObject({
      level: "error",
      event: "diagnostic_event",
      requestId: "request_123456",
      route: "/api/health/ready",
      operation: "readiness",
      error: { type: "Error" },
    });
    expect(JSON.stringify(entry)).not.toContain("hidden-key");

    output.mockImplementation(() => { throw new Error("console unavailable"); });
    expect(() => logServerError("diagnostic_event", { value: BigInt(1) })).not.toThrow();
  });
});
