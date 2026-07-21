import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { aggregateServiceNowCustomerMappings } from "./repository";

const mappedKey = "servicenow-unmapped:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

describe("ServiceNow mapping candidate aggregation", () => {
  const tickets = [
    { issue_id: "INC1", customer_key: mappedKey, customer_name: "Company A", kanban_status: "open", updated_at: "2026-07-21T02:00:00.000Z", data: { createdAt: "2026-07-20T00:00:00.000Z", serviceNow: { provider: "servicenow", externalCustomerKey: mappedKey, externalCustomerId: "a".repeat(32), externalCustomerName: "Company A" } } },
    { issue_id: "INC2", customer_key: mappedKey, customer_name: "Company A", kanban_status: "closed", updated_at: "2026-07-21T03:00:00.000Z", data: { createdAt: "2026-07-19T00:00:00.000Z", serviceNow: { provider: "servicenow", companyExternalId: "a".repeat(32), companyReference: "Company A renamed" } } },
    { issue_id: "OTHER", customer_key: "other", customer_name: "Other", kanban_status: "open", data: { serviceNow: { provider: "jira" } } },
  ];

  it("aggregates one stable source with bounded examples and open counts", () => {
    const result = aggregateServiceNowCustomerMappings(tickets, [], new Map(), { page: 1, limit: 25, status: "all", search: "" });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({ externalCustomerKey: mappedKey, ticketCount: 2, openTicketCount: 1, firstSeenAt: "2026-07-19T00:00:00.000Z", lastSeenAt: "2026-07-21T03:00:00.000Z" });
    expect(result.items[0].exampleIncidents).toEqual(["INC1", "INC2"]);
    expect(result.matchingTicketCount).toBe(2);
  });

  it("joins active and inactive mappings and applies search/status filters", () => {
    const mappings = [{ id: "mapping-id", external_customer_key: mappedKey, external_customer_name: "Company A", customer_key: "customer-a", active: false }];
    const result = aggregateServiceNowCustomerMappings(tickets, mappings, new Map([["customer-a", "Customer A"]]), { page: 1, limit: 25, status: "inactive", search: "company" });
    expect(result.items[0]).toMatchObject({ mappingId: "mapping-id", mapped: true, activeMapping: false, mappedCustomerName: "Customer A" });
  });

  it("keeps the unknown identity visible but non-mappable", () => {
    const result = aggregateServiceNowCustomerMappings([{ issue_id: "INC3", customer_key: "servicenow-unmapped:unknown", customer_name: "Unknown", kanban_status: "open", data: { serviceNow: { provider: "servicenow" } } }], [], new Map(), { page: 1, limit: 25, status: "all", search: "" });
    expect(result.items[0]).toMatchObject({ externalCustomerKey: "servicenow-unmapped:unknown", mappable: false });
  });
});
