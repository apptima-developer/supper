import { describe, expect, it, vi } from "vitest";
import type { Session } from "../../auth";
import { serviceNowError } from "./errors";
import { correlationIdSchema } from "../schemas";
import { handleServiceNowIncidentDetail, handleServiceNowIncidentList, handleServiceNowTest, type ServiceNowApiDependencies } from "./api-handlers";

const admin: Session = { userId: "admin-id", username: "admin", name: "Admin", role: "admin", authVersion: 1 };
const support: Session = { ...admin, userId: "support-id", username: "support", role: "support" };
const incident = { provider: "servicenow" as const, externalSysId: "a".repeat(32), number: "INC0010001", externalUrl: "https://example.service-now.com/incident", title: "Test API integration", providerMetadata: { table: "incident" } };

function dependencies(session: Session | null): ServiceNowApiDependencies & { adapter: Record<string, ReturnType<typeof vi.fn>> } {
  const adapter = {
    testConnection: vi.fn(async () => ({ provider: "servicenow" as const, connected: true, resultCount: 1, durationMs: 10 })),
    listIncidents: vi.fn(async () => ({ incidents: [incident], pageCount: 1 })),
    getIncidentBySysId: vi.fn(async () => incident),
  };
  return { getSession: vi.fn(async () => session), getAdapter: () => adapter, adapter };
}

describe("ServiceNow diagnostic API handlers", () => {
  it("requires a session and Settings permission", async () => {
    const unauthorized = await handleServiceNowTest(new Request("https://app.example.com/api/integrations/servicenow/test", { method: "POST" }), dependencies(null));
    expect(unauthorized.status).toBe(401);
    const forbidden = await handleServiceNowIncidentList(new Request("https://app.example.com/api/integrations/servicenow/incidents"), dependencies(support));
    expect(forbidden.status).toBe(403);
  });

  it("allows an administrator to test the provider without exposing configuration", async () => {
    const response = await handleServiceNowTest(new Request("https://app.example.com/api/integrations/servicenow/test", { method: "POST" }), dependencies(admin));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ provider: "servicenow", connected: true, resultCount: 1 });
    expect(JSON.stringify(body)).not.toMatch(/password|authorization|token/i);
  });

  it("validates bounded list parameters and rejects arbitrary provider query controls", async () => {
    const deps = dependencies(admin);
    const valid = await handleServiceNowIncidentList(new Request("https://app.example.com/api/integrations/servicenow/incidents?limit=5&offset=2&number=INC0010001"), deps);
    expect(valid.status).toBe(200);
    expect(deps.adapter.listIncidents).toHaveBeenCalledWith({ limit: 5, offset: 2, number: "INC0010001" }, expect.any(String), expect.any(AbortSignal));
    const tooLarge = await handleServiceNowIncidentList(new Request("https://app.example.com/api/integrations/servicenow/incidents?limit=101"), dependencies(admin));
    expect(tooLarge.status).toBe(400);
    const arbitrary = await handleServiceNowIncidentList(new Request("https://app.example.com/api/integrations/servicenow/incidents?sysparm_query=active=true"), dependencies(admin));
    expect(arbitrary.status).toBe(400);
  });

  it("validates sys_id and returns a normalized detail only", async () => {
    const deps = dependencies(admin);
    const response = await handleServiceNowIncidentDetail(new Request("https://app.example.com/api/integrations/servicenow/incidents/id"), "a".repeat(32), deps);
    expect(response.status).toBe(200);
    expect((await response.json()).item).toMatchObject({ number: "INC0010001" });
    const invalid = await handleServiceNowIncidentDetail(new Request("https://app.example.com/api/integrations/servicenow/incidents/bad"), "bad", dependencies(admin));
    expect(invalid.status).toBe(400);
  });

  it("maps safe provider errors without raw causes", async () => {
    const deps = dependencies(admin);
    deps.adapter.listIncidents.mockRejectedValue(serviceNowError({ category: "authentication", code: "SERVICENOW_AUTHENTICATION_FAILED", safeMessage: "ServiceNow authentication failed", retryable: false, operation: "ticket.list", correlationId: correlationIdSchema.parse("request-provider-error") }));
    const response = await handleServiceNowIncidentList(new Request("https://app.example.com/api/integrations/servicenow/incidents"), deps);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ code: "SERVICENOW_AUTHENTICATION_FAILED", category: "authentication" });
  });

  it("has no persistence dependency or write operation", () => {
    const source = `${handleServiceNowTest}${handleServiceNowIncidentList}${handleServiceNowIncidentDetail}`;
    expect(source).not.toMatch(/support_tickets|supabase|persist|\.insert\(|\.update\(|\.delete\(/i);
  });
});
