import { describe, expect, it } from "vitest";
import { ticketSchema, ticketServiceNowSchema } from "../../../types";

function persistedTicket(customerMappingAppliedAt: string, updatedAt: string) {
  return {
    id: "ticket-id",
    issueId: "INC0010001",
    date: "2026-07-21T01:00:00.000Z",
    customerKey: "customer-a",
    customerName: "Customer A",
    issueTitle: "Mapped Incident",
    issueType: "Incident",
    category: "software",
    severity: "High",
    owner: "",
    ownerEfforts: [],
    status: "00 - Open",
    kanbanStatus: "open" as const,
    startDate: "2026-07-21T01:00:00.000Z",
    dueDate: "",
    closeDate: "",
    mdUsed: 0,
    chargeable: false,
    remark: "",
    ticketLogs: [],
    slaPauses: [],
    requiresCustomerMapping: false,
    createdAt: "2026-07-21T01:00:00.000Z",
    updatedAt,
    serviceNow: {
      provider: "servicenow" as const,
      externalSysId: "a".repeat(32),
      externalNumber: "INC0010001",
      externalUrl: "https://example.service-now.com/incident.do?sys_id=fixture",
      externalCustomerKey: `servicenow-unmapped:${"b".repeat(32)}`,
      externalCustomerId: "b".repeat(32),
      externalCustomerName: "Example Company",
      customerMappingId: "mapping-id-00000001",
      customerMappingAppliedAt,
      externalUpdatedAt: "2026-07-21T01:00:00.000Z",
      sourceHash: "c".repeat(64),
      mappingWarnings: [],
    },
  };
}

describe("ServiceNow mapped Ticket persistence schema", () => {
  it.each([
    ["mapping creation", "2026-07-21T02:03:04.005Z", "2026-07-21T02:03:04.005Z"],
    ["mapping change", "2026-07-21T03:04:05.006Z", "2026-07-21T03:04:05.006Z"],
    ["mapping reactivation", "2026-07-21T04:05:06.007Z", "2026-07-21T04:05:06.007Z"],
    ["automatic mapping", "2026-07-21T02:03:04.005Z", "2026-07-21T05:06:07.008Z"],
  ])("accepts canonical timestamps after %s", (_operation, appliedAt, updatedAt) => {
    const ticket = persistedTicket(appliedAt, updatedAt);
    expect(ticketSchema.parse(ticket)).toEqual(ticket);
    expect(ticketServiceNowSchema.parse(ticket.serviceNow)).toEqual(ticket.serviceNow);
    for (const value of [ticket.updatedAt, ticket.serviceNow.customerMappingAppliedAt]) {
      expect(value).toMatch(/\.[0-9]{3}Z$/);
      expect(value).not.toContain("+00:00");
      expect(value).not.toMatch(/[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:/);
    }
  });
});
