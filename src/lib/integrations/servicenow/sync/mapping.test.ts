import { describe, expect, it } from "vitest";
import type { Ticket } from "../../../types";
import type { NormalizedServiceNowIncident } from "../schemas";
import { hashServiceNowIncident } from "./hash";
import { mapServiceNowIncidentToTicket, mapServiceNowPriority, mapServiceNowState, mergeServiceNowIncidentIntoTicket } from "./mapping";
import { normalizeServiceNowIncident, normalizeServiceNowField, parseServiceNowTimestamp } from "../normalization";
import { parseServiceNowConfig } from "../config";

const configValue = parseServiceNowConfig({
  SERVICENOW_ENABLED: "true", SERVICENOW_INSTANCE_URL: "https://dev.example.service-now.com",
  SERVICENOW_AUTH_MODE: "basic", SERVICENOW_USERNAME: "user", SERVICENOW_PASSWORD: "pass",
  SERVICENOW_TIMEOUT_MS: "1000", SERVICENOW_PAGE_SIZE: "100", SERVICENOW_INCIDENT_TABLE: "incident",
});
if (!configValue.enabled) throw new Error("Expected enabled test configuration");
const config = configValue;

function incident(overrides: Partial<NormalizedServiceNowIncident> = {}): NormalizedServiceNowIncident {
  return {
    provider: "servicenow", externalSysId: "a".repeat(32), number: "INC0010001",
    externalUrl: "https://dev.example.service-now.com/incident", title: "External title",
    state: "In Progress", stateValue: "2", priority: "3 - Moderate", priorityValue: "3",
    customerReference: "Customer A", customerExternalId: "b".repeat(32),
    openedAt: "2026-07-19T23:30:00.000Z", createdAt: "2026-07-19T23:00:00.000Z",
    lastUpdatedAt: "2026-07-20T01:00:00.000Z", providerMetadata: { table: "incident" },
    ...overrides,
  };
}

function mapped(overrides: Partial<NormalizedServiceNowIncident> = {}) {
  return mapServiceNowIncidentToTicket(incident(overrides), { ticketId: "ticket-1", now: "2026-07-20T02:00:00.000Z" });
}

describe("ServiceNow Incident mapping", () => {
  it("maps every Incident to the canonical SUPPER Incident type", () => {
    expect(mapped().ticket).toMatchObject({ issueType: "Incident", severity: "Medium", status: "04 - Func Inprogress", kanbanStatus: "in_progress" });
  });

  it.each([
    ["1", "Critical"], ["2", "High"], ["3", "Medium"], ["4", "Low"], ["5", "Low"],
  ])("maps priority %s to %s", (value, severity) => expect(mapServiceNowPriority(value).severity).toBe(severity));

  it("falls back safely for missing and unknown priorities", () => {
    expect(mapServiceNowPriority()).toEqual({ severity: "Medium", warning: "MISSING_PRIORITY" });
    expect(mapServiceNowPriority("99")).toEqual({ severity: "Medium", warning: "UNKNOWN_PRIORITY" });
  });

  it.each([
    ["1", "00 - Open", "open"], ["2", "04 - Func Inprogress", "in_progress"],
    ["3", "07 - Waiting user", "waiting"], ["6", "08 - Resolved", "resolved"],
    ["7", "02 - Closed", "closed"], ["8", "01 - Cancel", "cancelled"],
  ])("maps state %s", (value, status, kanbanStatus) => expect(mapServiceNowState(value)).toMatchObject({ status, kanbanStatus }));

  it("uses the existing open state for an unknown future state and records a warning", () => {
    expect(mapServiceNowState("42")).toEqual({ status: "00 - Open", kanbanStatus: "open", warning: "UNKNOWN_STATE" });
  });

  it("creates a stable unmapped customer key without creating customer data", () => {
    expect(mapped().ticket).toMatchObject({ customerKey: `servicenow-unmapped:${"b".repeat(32)}`, customerName: "Customer A", requiresCustomerMapping: true });
    expect(mapped({ customerReference: undefined, customerExternalId: undefined }).ticket.customerKey).toBe("servicenow-unmapped:unknown");
    expect(mapped({ customerExternalId: "Customer A" }).ticket.customerKey).toMatch(/^servicenow-unmapped:ref-[a-f0-9]{24}$/);
  });

  it("normalizes primitive and object reference fields separately", () => {
    expect(normalizeServiceNowField("Customer primitive", true)).toBe("Customer primitive");
    expect(normalizeServiceNowField({ value: "company-id", display_value: "Customer object" })).toBe("company-id");
    expect(normalizeServiceNowField({ value: "company-id", display_value: "Customer object" }, true)).toBe("Customer object");
    const normalized = normalizeServiceNowIncident({ sys_id: "a".repeat(32), number: "INC1", short_description: "Title", company: { value: "company-id", display_value: "Customer object" }, sys_updated_on: "2026-07-20 01:00:00" }, config);
    expect(normalized).toMatchObject({ customerExternalId: "company-id", customerReference: "Customer object" });
  });

  it("rejects invalid timestamps and parses provider timestamps as UTC without date drift", () => {
    expect(() => parseServiceNowTimestamp("not-a-date")).toThrow(/timestamp/);
    expect(parseServiceNowTimestamp("2026-07-20 01:02:03")).toBe("2026-07-20T01:02:03.000Z");
    expect(mapped().ticket.date).toBe("2026-07-19T23:00:00.000Z");
  });

  it("hashes only stable normalized source fields", () => {
    expect(hashServiceNowIncident(incident())).toBe(hashServiceNowIncident({ ...incident(), providerMetadata: { table: "different-nonsource-value" } }));
    expect(hashServiceNowIncident(incident())).toBe(hashServiceNowIncident(incident({ lastUpdatedAt: "2026-07-21T09:30:00.000Z" })));
    expect(hashServiceNowIncident(incident({ title: "Changed" }))).not.toBe(hashServiceNowIncident(incident()));
    expect(hashServiceNowIncident(incident({ stateValue: "6", state: "Resolved" }))).not.toBe(hashServiceNowIncident(incident()));
  });

  it("bounds a long external description and records a mapping warning", () => {
    const result = mapped({ description: "x".repeat(5_000) });
    expect(result.ticket.serviceNow?.description).toHaveLength(4_000);
    expect(result.linkMetadata.mappingWarnings).toContain("DESCRIPTION_TRUNCATED");
  });
});

describe("ServiceNow ownership merge policy", () => {
  const incoming = mapped({ title: "New external title", lastUpdatedAt: "2026-07-20T03:00:00.000Z" });
  const existing = {
    ...incoming.ticket,
    customerKey: "confirmed-project-key", customerName: "Confirmed Customer", issueTitle: "Old title",
    owner: "support-agent", ownerEfforts: [{ owner: "support-agent", hours: 2.5 }], mdUsed: 0.3125,
    chargeable: true, remark: "Manual resolution note", ticketLogs: [{ id: "log-1", message: "Manual log", actor: "admin", createdAt: "2026-07-20T00:00:00.000Z", attachments: [] }],
    aiClassification: "manual-ai-value", aiConfidence: 0.93, billingNotes: "Keep this",
    nonChargeReason: "Manual decision", projectMapping: "project-legacy", unknownOperationalValue: { preserve: true },
  } as Ticket & Record<string, unknown>;

  it("updates ServiceNow-owned fields and preserves SUPPER billing, effort, notes, customer mapping, and AI annotations", () => {
    const result = mergeServiceNowIncidentIntoTicket(existing, incoming, { externalUpdatedAt: "2026-07-20T01:00:00.000Z", sourceHash: "0".repeat(64) });
    expect(result.outcome).toBe("updated");
    expect(result.ticket).toMatchObject({
      issueTitle: "New external title", customerKey: "confirmed-project-key", owner: "support-agent",
      ownerEfforts: [{ hours: 2.5 }], mdUsed: 0.3125, chargeable: true, remark: "Manual resolution note",
      aiClassification: "manual-ai-value", aiConfidence: 0.93, billingNotes: "Keep this", requiresCustomerMapping: false,
      nonChargeReason: "Manual decision", projectMapping: "project-legacy", unknownOperationalValue: { preserve: true },
    });
    expect(result.ticket.ticketLogs).toHaveLength(1);
    expect(result.ticket.id).toBe(existing.id);
    expect(result.ticket.createdAt).toBe(existing.createdAt);
  });

  it("ignores stale and identical source data", () => {
    expect(mergeServiceNowIncidentIntoTicket(existing, incoming, { externalUpdatedAt: "2026-07-21T00:00:00.000Z", sourceHash: "0".repeat(64) }).outcome).toBe("stale");
    expect(mergeServiceNowIncidentIntoTicket(existing, incoming, { externalUpdatedAt: incoming.externalUpdatedAt, sourceHash: incoming.sourceHash }).outcome).toBe("unchanged");
  });

  it("updates equal-timestamp changed content with a bounded warning", () => {
    expect(mergeServiceNowIncidentIntoTicket(existing, incoming, { externalUpdatedAt: incoming.externalUpdatedAt, sourceHash: "0".repeat(64) })).toMatchObject({ outcome: "updated", warningCode: "SAME_TIMESTAMP_CHANGED" });
  });

  it("treats a timestamp-only provider touch as unchanged without rewriting ticket business data", () => {
    const timestampOnly = mapped({ lastUpdatedAt: "2026-07-21T04:00:00.000Z" });
    expect(timestampOnly.sourceHash).toBe(mapped().sourceHash);
    const result = mergeServiceNowIncidentIntoTicket(existing, timestampOnly, { externalUpdatedAt: "2026-07-20T01:00:00.000Z", sourceHash: timestampOnly.sourceHash });
    expect(result).toEqual({ outcome: "unchanged", ticket: existing });
    expect(result.ticket.id).toBe(existing.id);
    expect(result.ticket.serviceNow?.externalUpdatedAt).toBe(existing.serviceNow?.externalUpdatedAt);
  });
});
