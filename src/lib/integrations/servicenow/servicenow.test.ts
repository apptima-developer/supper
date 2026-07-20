import { describe, expect, it, vi, beforeEach } from "vitest";
import { correlationIdSchema } from "../schemas";
import { isIntegrationBoundaryError } from "../errors";
import { redactSensitive } from "../../server-logging";
import { buildServiceNowBasicAuthorization, clearServiceNowOAuthTokenCache, getServiceNowAuthorization } from "./auth";
import { ServiceNowReadOnlyAdapter } from "./adapter";
import { parseServiceNowConfig } from "./config";
import { serviceNowIncidentFields } from "./field-mapping";

const correlationId = correlationIdSchema.parse("request-servicenow-1234");
const sysId = "a".repeat(32);
const basicEnv = {
  SERVICENOW_ENABLED: "true",
  SERVICENOW_INSTANCE_URL: "https://dev12345.service-now.com",
  SERVICENOW_AUTH_MODE: "basic",
  SERVICENOW_USERNAME: "machine-user",
  SERVICENOW_PASSWORD: "machine-password",
  SERVICENOW_TIMEOUT_MS: "1000",
  SERVICENOW_PAGE_SIZE: "2",
  SERVICENOW_INCIDENT_TABLE: "incident",
};

function record(overrides: Record<string, unknown> = {}) {
  return {
    sys_id: sysId,
    number: "INC0010001",
    short_description: "Test API integration",
    description: "Diagnostic record",
    state: { value: "2", display_value: "In Progress", link: "https://example.invalid/state" },
    priority: "3",
    assignment_group: { value: "group-id", display_value: "Service Desk", link: "https://example.invalid/group" },
    opened_at: "2026-07-20 01:02:03",
    sys_created_on: "2026-07-20 01:00:00",
    sys_updated_on: "2026-07-20 02:00:00",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("ServiceNow configuration", () => {
  it("supports a disabled configuration without credentials", () => {
    expect(parseServiceNowConfig({ SERVICENOW_ENABLED: "false" })).toEqual({ enabled: false });
  });

  it("validates Basic and OAuth configurations", () => {
    expect(parseServiceNowConfig(basicEnv)).toMatchObject({ enabled: true, authMode: "basic", pageSize: 2 });
    expect(parseServiceNowConfig({
      ...basicEnv,
      SERVICENOW_AUTH_MODE: "oauth_client_credentials",
      SERVICENOW_CLIENT_ID: "client-id",
      SERVICENOW_CLIENT_SECRET: "client-secret",
    })).toMatchObject({ enabled: true, authMode: "oauth_client_credentials", clientId: "client-id" });
  });

  it("rejects missing credentials, invalid URLs, and unsafe table names", () => {
    expect(() => parseServiceNowConfig({ ...basicEnv, SERVICENOW_PASSWORD: "" })).toThrow();
    expect(() => parseServiceNowConfig({ ...basicEnv, SERVICENOW_INSTANCE_URL: "http://service-now.example.com" })).toThrow(/HTTPS/);
    expect(() => parseServiceNowConfig({ ...basicEnv, SERVICENOW_INCIDENT_TABLE: "incident^DELETE" })).toThrow();
    expect(parseServiceNowConfig({ ...basicEnv, SERVICENOW_INSTANCE_URL: "http://localhost:3001" })).toMatchObject({ enabled: true });
  });
});

describe("ServiceNow authentication", () => {
  beforeEach(clearServiceNowOAuthTokenCache);

  it("constructs Basic authorization immediately and redacts secret-bearing fields", () => {
    expect(buildServiceNowBasicAuthorization("user", "pass")).toBe(`Basic ${Buffer.from("user:pass").toString("base64")}`);
    expect(redactSensitive({ authorization: "Basic hidden", password: "pass", shortDescription: "private incident text", caller: "person", safe: "value" })).toEqual({ authorization: "[redacted]", password: "[redacted]", shortDescription: "[redacted]", caller: "[redacted]", safe: "value" });
  });

  it("validates and caches OAuth tokens, then refreshes before expiry", async () => {
    const config = parseServiceNowConfig({ ...basicEnv, SERVICENOW_AUTH_MODE: "oauth_client_credentials", SERVICENOW_CLIENT_ID: "client", SERVICENOW_CLIENT_SECRET: "secret" });
    if (!config.enabled) throw new Error("expected enabled config");
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: `token-${fetchMock.mock.calls.length}`, token_type: "Bearer", expires_in: 60 }));
    const first = await getServiceNowAuthorization(config, { correlationId, operation: "provider.test" }, { fetch: fetchMock as typeof fetch, now: () => 1_000 });
    const cached = await getServiceNowAuthorization(config, { correlationId, operation: "provider.test" }, { fetch: fetchMock as typeof fetch, now: () => 10_000 });
    const refreshed = await getServiceNowAuthorization(config, { correlationId, operation: "provider.test" }, { fetch: fetchMock as typeof fetch, now: () => 32_000 });
    expect(first).toBe(cached);
    expect(refreshed).not.toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed OAuth responses", async () => {
    const config = parseServiceNowConfig({ ...basicEnv, SERVICENOW_AUTH_MODE: "oauth_client_credentials", SERVICENOW_CLIENT_ID: "client", SERVICENOW_CLIENT_SECRET: "secret" });
    if (!config.enabled) throw new Error("expected enabled config");
    await expect(getServiceNowAuthorization(config, { correlationId, operation: "provider.test" }, { fetch: vi.fn(async () => jsonResponse({ nope: true })) as typeof fetch })).rejects.toMatchObject({ category: "malformed_response" });
  });
});

describe("ServiceNow read-only adapter", () => {
  it("tests connection and lists normalized primitive/reference values", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => jsonResponse({ result: [record()] }));
    const adapter = new ServiceNowReadOnlyAdapter(parseServiceNowConfig(basicEnv), { fetch: fetchMock as typeof fetch, now: () => 100 });
    await expect(adapter.testConnection(correlationId)).resolves.toMatchObject({ provider: "servicenow", connected: true, resultCount: 1 });
    const result = await adapter.listIncidents({ limit: 1, offset: 0 }, correlationId);
    expect(result.incidents[0]).toMatchObject({
      provider: "servicenow",
      externalSysId: sysId,
      number: "INC0010001",
      title: "Test API integration",
      state: "In Progress",
      priority: "3",
      assignmentGroupReference: "Service Desk",
      openedAt: "2026-07-20T01:02:03.000Z",
    });
    expect(result.incidents[0].externalUrl).toMatch(/^https:\/\//);
  });

  it("loads detail by sys_id without exposing a raw provider record", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => jsonResponse({ result: record({ caller_id: { value: "caller-id", display_value: "Caller" } }) }));
    const adapter = new ServiceNowReadOnlyAdapter(parseServiceNowConfig(basicEnv), { fetch: fetchMock as typeof fetch });
    const incident = await adapter.getIncidentBySysId(sysId, correlationId);
    expect(incident.callerReference).toBe("Caller");
    expect(incident).not.toHaveProperty("raw");
    expect(String(fetchMock.mock.calls[0][0])).toContain(`/${sysId}?`);
  });

  it("uses only the field allowlist and bounded query inputs", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => jsonResponse({ result: [record()] }));
    const adapter = new ServiceNowReadOnlyAdapter(parseServiceNowConfig(basicEnv), { fetch: fetchMock as typeof fetch });
    await adapter.listIncidents({ limit: 1, offset: 5, number: "INC0010001", updatedAfter: "2026-07-20T00:00:00.000Z" }, correlationId);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("sysparm_fields")?.split(",")).toEqual([...serviceNowIncidentFields]);
    expect(url.searchParams.get("sysparm_query")).toBe("number=INC0010001^sys_updated_on>=2026-07-20 00:00:00");
    expect(url.searchParams.get("sysparm_offset")).toBe("5");
    expect(url.searchParams.get("sysparm_display_value")).toBe("all");
    const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
    expect(headers.get("X-Correlation-ID")).toBe(correlationId);
    expect(headers.get("Authorization")).toMatch(/^Basic /);
  });

  it("builds a fixed-window keyset query without offset paging", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => jsonResponse({ result: [record()] }));
    const config = parseServiceNowConfig(basicEnv);
    if (!config.enabled) throw new Error("expected enabled config");
    const client = new (await import("./client")).ServiceNowReadClient(config, { fetch: fetchMock as typeof fetch });
    const page = await client.listIncidentRecordsPage({
      limit: 1,
      windowStart: "2026-07-20T00:00:00.000Z",
      windowEnd: "2026-07-20T12:00:00.000Z",
      cursor: { updatedAt: "2026-07-20T03:00:00.000Z", sysId },
    }, correlationId);
    expect(page).toHaveLength(1);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("sysparm_query")).toBe(`sys_updated_on>=2026-07-20 00:00:00^sys_updated_on<=2026-07-20 12:00:00^sys_updated_on>2026-07-20 03:00:00^NQsys_updated_on>=2026-07-20 00:00:00^sys_updated_on<=2026-07-20 12:00:00^sys_updated_on=2026-07-20 03:00:00^sys_id>${sysId}^ORDERBYsys_updated_on^ORDERBYsys_id`);
    expect(url.searchParams.has("sysparm_offset")).toBe(false);
    expect(url.searchParams.get("sysparm_fields")?.split(",")).toEqual([...serviceNowIncidentFields]);
  });

  it("uses an inclusive lower bound on the first fixed-window page", async () => {
    const fetchMock = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(async () => jsonResponse({ result: [] }));
    const config = parseServiceNowConfig(basicEnv);
    if (!config.enabled) throw new Error("expected enabled config");
    const client = new (await import("./client")).ServiceNowReadClient(config, { fetch: fetchMock as typeof fetch });
    await client.listIncidentRecordsPage({ limit: 10, windowStart: "2026-07-20T00:00:00.000Z", windowEnd: "2026-07-20T12:00:00.000Z" }, correlationId);
    const url = new URL(String(fetchMock.mock.calls[0][0]));
    expect(url.searchParams.get("sysparm_query")).toBe("sys_updated_on>=2026-07-20 00:00:00^sys_updated_on<=2026-07-20 12:00:00^ORDERBYsys_updated_on^ORDERBYsys_id");
    expect(url.searchParams.has("sysparm_offset")).toBe(false);
  });

  it("rejects an invalid Incident timestamp instead of substituting the current time", async () => {
    const adapter = new ServiceNowReadOnlyAdapter(parseServiceNowConfig(basicEnv), { fetch: vi.fn(async () => jsonResponse({ result: [record({ sys_updated_on: "not-a-date" })] })) as typeof fetch });
    await expect(adapter.listIncidents({ limit: 1, offset: 0 }, correlationId)).rejects.toMatchObject({ code: "SERVICENOW_INVALID_INCIDENT" });
  });

  it("rejects a provider page that exceeds the requested synchronization bound", async () => {
    const config = parseServiceNowConfig(basicEnv);
    if (!config.enabled) throw new Error("expected enabled config");
    const client = new (await import("./client")).ServiceNowReadClient(config, { fetch: vi.fn(async () => jsonResponse({ result: [record(), record({ sys_id: "b".repeat(32) })] })) as typeof fetch });
    await expect(client.listIncidentRecordsPage({ limit: 1, windowStart: "2026-07-20T00:00:00.000Z", windowEnd: "2026-07-20T12:00:00.000Z" }, correlationId)).rejects.toMatchObject({ code: "SERVICENOW_PAGE_LIMIT_EXCEEDED" });
  });

  it("paginates and enforces the maximum-page guard", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ result: [record({ sys_id: "b".repeat(32) })] }));
    const config = parseServiceNowConfig({ ...basicEnv, SERVICENOW_PAGE_SIZE: "1" });
    const adapter = new ServiceNowReadOnlyAdapter(config, { fetch: fetchMock as typeof fetch, maxPages: 2 });
    await expect(adapter.listIncidents({ limit: 3, offset: 0 }, correlationId)).rejects.toMatchObject({ code: "SERVICENOW_MAX_PAGES" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    [400, "validation"], [401, "authentication"], [403, "authorization"], [404, "validation"], [409, "conflict"], [429, "rate_limit"], [503, "unavailable"],
  ] as const)("maps HTTP %s to %s", async (status, category) => {
    const adapter = new ServiceNowReadOnlyAdapter(parseServiceNowConfig(basicEnv), { fetch: vi.fn(async () => jsonResponse({ providerSecret: "not-read" }, status)) as typeof fetch });
    await expect(adapter.listIncidents({ limit: 1, offset: 0 }, correlationId)).rejects.toMatchObject({ category });
  });

  it("handles malformed JSON and unexpected valid JSON", async () => {
    const malformed = new ServiceNowReadOnlyAdapter(parseServiceNowConfig(basicEnv), { fetch: vi.fn(async () => new Response("not-json")) as typeof fetch });
    await expect(malformed.listIncidents({ limit: 1, offset: 0 }, correlationId)).rejects.toMatchObject({ code: "SERVICENOW_MALFORMED_JSON" });
    const unexpected = new ServiceNowReadOnlyAdapter(parseServiceNowConfig(basicEnv), { fetch: vi.fn(async () => jsonResponse({ result: "wrong" })) as typeof fetch });
    await expect(unexpected.listIncidents({ limit: 1, offset: 0 }, correlationId)).rejects.toMatchObject({ code: "SERVICENOW_UNEXPECTED_RESPONSE" });
  });

  it("maps network failures to a retryable unavailable error", async () => {
    const adapter = new ServiceNowReadOnlyAdapter(parseServiceNowConfig(basicEnv), { fetch: vi.fn(async () => { throw new TypeError("network detail must remain private"); }) as typeof fetch });
    await expect(adapter.listIncidents({ limit: 1, offset: 0 }, correlationId)).rejects.toMatchObject({ category: "unavailable", retryable: true, code: "SERVICENOW_NETWORK_UNAVAILABLE" });
  });

  it("maps timeout and caller abort separately", async () => {
    const hangingFetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }));
    const timeoutConfig = parseServiceNowConfig({ ...basicEnv, SERVICENOW_TIMEOUT_MS: "1000" });
    vi.useFakeTimers();
    try {
      const timed = new ServiceNowReadOnlyAdapter(timeoutConfig, { fetch: hangingFetch as typeof fetch });
      const pending = timed.listIncidents({ limit: 1, offset: 0 }, correlationId);
      const assertion = expect(pending).rejects.toMatchObject({ category: "timeout" });
      await vi.advanceTimersByTimeAsync(1_001);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
    const controller = new AbortController();
    controller.abort();
    const aborted = new ServiceNowReadOnlyAdapter(timeoutConfig, { fetch: hangingFetch as typeof fetch });
    await expect(aborted.listIncidents({ limit: 1, offset: 0 }, correlationId, controller.signal)).rejects.toMatchObject({ code: "SERVICENOW_REQUEST_ABORTED" });
  });

  it("has no provider write methods", async () => {
    const adapter = new ServiceNowReadOnlyAdapter({ enabled: false }, { fetch: vi.fn() as unknown as typeof fetch });
    expect(adapter).not.toHaveProperty("createIncident");
    expect(adapter).not.toHaveProperty("updateIncident");
    expect(adapter).not.toHaveProperty("deleteIncident");
    await expect(adapter.testConnection(correlationId)).rejects.toSatisfy(isIntegrationBoundaryError);
  });
});
