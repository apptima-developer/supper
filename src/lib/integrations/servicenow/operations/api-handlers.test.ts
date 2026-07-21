import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Session } from "../../../auth";
import { handleServiceNowCustomerMappingsGet, handleServiceNowCustomerMappingsPost, handleServiceNowRunsGet } from "./api-handlers";
import type { ServiceNowOperationsRepository } from "./repository";

const admin: Session = { userId: "admin-id", username: "admin", name: "Admin", role: "admin", authVersion: 1 };
const support: Session = { userId: "support-id", username: "support", name: "Support", role: "support", authVersion: 1 };

describe("ServiceNow operations API security", () => {
  it("rejects unauthenticated and unauthorized users", async () => {
    const repository = {} as ServiceNowOperationsRepository;
    const unauthenticated = await handleServiceNowRunsGet(new Request("https://app.test/api/integrations/servicenow/runs"), { getSession: async () => null, repository });
    const unauthorized = await handleServiceNowRunsGet(new Request("https://app.test/api/integrations/servicenow/runs"), { getSession: async () => support, repository });
    expect(unauthenticated.status).toBe(401);
    expect(unauthorized.status).toBe(403);
  });

  it("enforces bounded run pagination and rejects unknown query controls", async () => {
    const listRuns = vi.fn(async () => ({ items: [], total: 0, page: 1, limit: 100 }));
    const repository = { listRuns } as unknown as ServiceNowOperationsRepository;
    const bounded = await handleServiceNowRunsGet(new Request("https://app.test/api/integrations/servicenow/runs?limit=100&page=1&status=succeeded"), { getSession: async () => admin, repository });
    const oversized = await handleServiceNowRunsGet(new Request("https://app.test/api/integrations/servicenow/runs?limit=101"), { getSession: async () => admin, repository });
    const arbitrary = await handleServiceNowRunsGet(new Request("https://app.test/api/integrations/servicenow/runs?sysparm_query=secret"), { getSession: async () => admin, repository });
    expect(bounded.status).toBe(200);
    expect(listRuns).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, status: "succeeded" }));
    expect(oversized.status).toBe(400);
    expect(arbitrary.status).toBe(400);
  });

  it("returns only bounded mapping candidates", async () => {
    const listMappingCandidates = vi.fn(async () => ({ items: [{ externalCustomerKey: "servicenow-unmapped:unknown", externalCustomerName: "Unknown", mappable: false }], total: 1, page: 1, limit: 25 }));
    const repository = { listMappingCandidates } as unknown as ServiceNowOperationsRepository;
    const response = await handleServiceNowCustomerMappingsGet(new Request("https://app.test/api/integrations/servicenow/customer-mappings?status=unmapped&limit=25"), { getSession: async () => admin, repository });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.items[0]).not.toHaveProperty("data");
    expect(JSON.stringify(body)).not.toContain("SERVICENOW_PASSWORD");
  });

  it("rejects unknown body fields and never trusts browser customer names or providers", async () => {
    const apply = vi.fn();
    const request = new Request("https://app.test/api/integrations/servicenow/customer-mappings", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ externalCustomerKey: `servicenow-unmapped:${"a".repeat(32)}`, customerKey: "customer-a", customerName: "Browser name", provider: "other" }),
    });
    const response = await handleServiceNowCustomerMappingsPost(request, { getSession: async () => admin, repository: {} as ServiceNowOperationsRepository, apply });
    expect(response.status).toBe(400);
    expect(apply).not.toHaveBeenCalled();
  });

  it("returns the bounded unknown-company error code", async () => {
    const request = new Request("https://app.test/api/integrations/servicenow/customer-mappings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ externalCustomerKey: "servicenow-unmapped:unknown", customerKey: "customer-a" }) });
    const response = await handleServiceNowCustomerMappingsPost(request, { getSession: async () => admin, repository: {} as ServiceNowOperationsRepository });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "SERVICENOW_UNKNOWN_CUSTOMER_NOT_MAPPABLE" });
  });
});
