import { describe, expect, it } from "vitest";
import { contractLifecycle, customerKey, isKanbanArchiveCandidate, manualContractStatus, mapKanbanStatus, recalculateCustomer, ticketAgeDays, ticketSeverityCode, ticketSeverityLabel } from "./domain";
import { can } from "./rbac";
import type { Customer, Ticket } from "./types";

const now = "2026-06-22T00:00:00.000Z";
const customer: Customer = { id: "c1", key: customerKey("PRJ-1", "Acme"), year: 2026, projectCode: "PRJ-1", customerName: "Acme", contractType: "Annual", contractStatus: "Active", mdPurchased: 10, mdUsed: 0, mdRemaining: 10, mdRate: 1, carryForward: 0, startPeriod: "2026-01-01", endPeriod: "2026-12-31", burnRate: 0, mdStatus: "Healthy", renewalAlert: "", aeUpdate: "", active: true, createdAt: now, updatedAt: now };
function ticket(id: string, mdUsed: number, chargeable: boolean): Ticket { return { id, issueId: id, date: "2026-06-01", customerKey: customer.key, customerName: "Acme", issueTitle: "Issue", issueType: "Incident", severity: "P3", owner: "Agent", ownerEfforts: [{ owner: "Agent", hours: mdUsed * 8 }], status: "00 - Open", kanbanStatus: "open", startDate: "", dueDate: "", closeDate: "", mdUsed, chargeable, remark: "", createdAt: now, updatedAt: now }; }

describe("status mapping", () => {
  it.each([["00 - Open", "open"], ["09 - Re-Open", "open"], ["03 - Dev Inprogress", "in_progress"], ["4 - Dev Inprogress", "in_progress"], ["07 - Waiting user", "waiting"], ["05 - Monitor", "monitor"], ["08 - Resolved", "resolved"], ["02 - Closed", "closed"], ["01 - Cancel", "cancelled"]] as const)("maps %s", (raw, mapped) => expect(mapKanbanStatus(raw)).toBe(mapped));
});

describe("ticket severity", () => {
  it.each([
    ["P1", "P1", "Critical"],
    ["P2 - High", "P2", "High"],
    ["Medium", "P3", "Medium"],
    ["low", "P4", "Low"],
  ] as const)("normalizes %s", (raw, code, label) => {
    expect(ticketSeverityCode(raw)).toBe(code);
    expect(ticketSeverityLabel(raw)).toBe(label);
  });
});

describe("MD calculation", () => { it("uses chargeable ticket effort only", () => { const result = recalculateCustomer(customer, [ticket("1", 3.25, true), ticket("2", 9, false), ticket("3", 5, true)]); expect(result.mdUsed).toBe(8.25); expect(result.mdRemaining).toBe(1.75); expect(result.burnRate).toBe(82.5); expect(result.mdStatus).toBe("Warning"); }); });
describe("carry forward", () => { it("adds carried MD to remaining capacity", () => { const result = recalculateCustomer({ ...customer, carryForward: 2.5 }, [ticket("1", 8, true)]); expect(result.mdRemaining).toBe(4.5); expect(result.burnRate).toBe(64); expect(result.mdStatus).toBe("OK"); }); });
describe("contract lifecycle", () => {
  const today = new Date("2026-06-23T12:00:00+07:00");

  it("normalizes lifecycle-like statuses out of manual contract status", () => {
    expect(manualContractStatus("Expired")).toBe("Active");
    expect(manualContractStatus("Expiring")).toBe("Active");
    expect(manualContractStatus("Pre-sales")).toBe("Pre-sales");
    expect(manualContractStatus("Suspended")).toBe("Suspended");
    expect(manualContractStatus("Done")).toBe("Done");
  });

  it("computes expired and expiring from end period", () => {
    expect(contractLifecycle({ endPeriod: "2026-06-22" }, today)).toBe("Expired");
    expect(contractLifecycle({ endPeriod: "2026-09-23" }, today)).toBe("Expiring");
    expect(contractLifecycle({ endPeriod: "2026-09-24" }, today)).toBeNull();
  });
});
describe("kanban archive candidates", () => {
  const today = new Date("2026-06-23T12:00:00+07:00");

  it("archives stale tickets that are older than 90 days and still not closed or cancelled", () => {
    expect(isKanbanArchiveCandidate({ ...ticket("old-open", 0, false), date: "2026-03-23" }, today)).toBe(true);
    expect(ticketAgeDays({ ...ticket("old-open", 0, false), date: "2026-03-23" }, today)).toBe(92);
  });

  it("uses opened date before start date when calculating ticket age", () => {
    expect(isKanbanArchiveCandidate({ ...ticket("opened-old", 0, false), date: "2026-03-23", startDate: "2026-06-01" }, today)).toBe(true);
  });

  it("keeps tickets at 90 days or less on the board", () => {
    expect(isKanbanArchiveCandidate({ ...ticket("ninety", 0, false), date: "2026-03-25" }, today)).toBe(false);
    expect(isKanbanArchiveCandidate({ ...ticket("fresh", 0, false), date: "2026-06-01" }, today)).toBe(false);
  });

  it("does not archive closed or cancelled tickets", () => {
    expect(isKanbanArchiveCandidate({ ...ticket("closed", 0, false), date: "2026-01-01", kanbanStatus: "closed" }, today)).toBe(false);
    expect(isKanbanArchiveCandidate({ ...ticket("cancelled", 0, false), date: "2026-01-01", kanbanStatus: "cancelled" }, today)).toBe(false);
  });
});
describe("role guard", () => { it("keeps sales on AE notes and support on assigned tickets", () => { expect(can("sales", "customers:ae")).toBe(true); expect(can("sales", "customers:manage")).toBe(false); expect(can("support", "tickets:assigned")).toBe(true); expect(can("support", "imports:manage")).toBe(false); expect(can("admin", "settings:manage")).toBe(true); }); });
