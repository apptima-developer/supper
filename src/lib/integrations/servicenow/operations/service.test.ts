import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import type { Session } from "../../../auth";
import { applyServiceNowCustomerMapping, deactivateServiceNowCustomerMapping } from "./service";
import type { ServiceNowOperationsRepository } from "./repository";

const session: Session = { userId: "admin-id", username: "admin", name: "Admin", role: "admin", authVersion: 1 };
const source = { externalCustomerKey: `servicenow-unmapped:${"a".repeat(32)}`, externalCustomerId: "a".repeat(32), externalCustomerName: "Company A", mappable: true, mapped: false, activeMapping: false, ticketCount: 2, openTicketCount: 1, exampleIncidents: ["INC1"] };

describe("ServiceNow mapping service", () => {
  it("resolves source metadata on the server and writes a bounded secondary audit", async () => {
    const applyMapping = vi.fn(async () => ({ mappingId: "mapping-id-00000001", action: "created" as const, customerKey: "customer-a", customerName: "Customer A", affectedTicketCount: 2, active: true }));
    const audit = vi.fn(async () => undefined);
    const repository = { getMappingSource: vi.fn(async () => source), applyMapping } as unknown as ServiceNowOperationsRepository;
    const result = await applyServiceNowCustomerMapping({ externalCustomerKey: source.externalCustomerKey, customerKey: "customer-a", session, requestId: "request-0001", correlationId: "request-0001" }, { repository, audit, now: () => new Date("2026-07-21T00:00:00.000Z"), createId: () => "generated-id-00000001" });
    expect(result).toMatchObject({ action: "created", affectedTicketCount: 2 });
    expect(applyMapping).toHaveBeenCalledWith(expect.objectContaining({ provider: "servicenow", externalCustomerName: "Company A", actorUserId: "admin-id", targetCustomerKey: "customer-a" }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ actor: "admin", details: expect.objectContaining({ externalCustomerKey: source.externalCustomerKey, affectedTicketCount: 2 }) }));
  });

  it("does not roll back an authoritative mapping when secondary audit fails", async () => {
    const repository = { getMappingSource: async () => source, applyMapping: async () => ({ mappingId: "mapping-id-00000001", action: "changed" as const, customerKey: "customer-b", customerName: "Customer B", affectedTicketCount: 2, active: true }) } as unknown as ServiceNowOperationsRepository;
    const result = await applyServiceNowCustomerMapping({ externalCustomerKey: source.externalCustomerKey, customerKey: "customer-b", session, requestId: "request-0001", correlationId: "request-0001" }, { repository, audit: async () => { throw new Error("audit unavailable"); }, createId: () => "generated-id-00000001" });
    expect(result.auditWarning).toBe("secondary_audit_write_failed");
  });

  it("rejects the global unknown key before storage", async () => {
    await expect(applyServiceNowCustomerMapping({ externalCustomerKey: "servicenow-unmapped:unknown", customerKey: "customer-a", session, requestId: "request-0001", correlationId: "request-0001" })).rejects.toMatchObject({ code: "SERVICENOW_UNKNOWN_CUSTOMER_NOT_MAPPABLE", status: 409 });
  });

  it("deactivates without requesting ticket reassignment", async () => {
    const deactivateMapping = vi.fn(async () => ({ mappingId: "mapping-id-00000001", action: "deactivated" as const, customerKey: "customer-a", affectedTicketCount: 0, active: false }));
    const repository = { getMapping: async () => ({ id: "mapping-id-00000001", external_customer_key: source.externalCustomerKey, customer_key: "customer-a", active: true }), deactivateMapping } as unknown as ServiceNowOperationsRepository;
    const result = await deactivateServiceNowCustomerMapping({ mappingId: "mapping-id-00000001", session, requestId: "request-0001", correlationId: "request-0001" }, { repository, audit: async () => undefined, createId: () => "generated-id-00000001" });
    expect(result).toMatchObject({ action: "deactivated", active: false, affectedTicketCount: 0 });
    expect(deactivateMapping).toHaveBeenCalledWith(expect.not.objectContaining({ ticketIds: expect.anything() }));
  });
});
