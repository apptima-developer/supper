import { describe, expect, it } from "vitest";
import { transitionSlaPauses } from "./domain";
import { ticketResponseSlaState, ticketSlaState } from "./sla";
import type { Sla, Ticket } from "./types";

const slaRules: Sla[] = [
  { id: "sla-1", customerName: "ACME", p1: 1, p2: 4, p3: 2, p4: 16 },
];
const longSlaRules: Sla[] = [
  { id: "sla-1", customerName: "ACME", p1: 1, p2: 4, p3: 4, p4: 16 },
];

function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "ticket-1",
    issueId: "INC001",
    date: "2026-06-01",
    customerKey: "acme",
    customerName: "ACME",
    issueTitle: "Issue",
    issueType: "Incident",
    category: "",
    severity: "Medium",
    owner: "Agent",
    ownerEfforts: [],
    status: "00 - Open",
    kanbanStatus: "open",
    startDate: "2026-06-01T09:00:00+07:00",
    dueDate: "",
    closeDate: "",
    mdUsed: 0,
    chargeable: false,
    remark: "",
    ticketLogs: [],
    slaPauses: [],
    createdAt: "2026-06-01T09:00:00+07:00",
    updatedAt: "2026-06-01T09:00:00+07:00",
    ...overrides,
  };
}

describe("SLA pauses", () => {
  it("checks response SLA from create ticket date to start date", () => {
    const withinTarget = ticketResponseSlaState(ticket({
      date: "2026-06-01T08:45:00+07:00",
      startDate: "2026-06-01T09:10:00+07:00",
    }));
    expect(withinTarget).toMatchObject({ label: "25m", overdue: false, tone: "emerald" });

    const breached = ticketResponseSlaState(ticket({
      date: "2026-06-01T08:45:00+07:00",
      startDate: "2026-06-01T09:16:00+07:00",
    }));
    expect(breached).toMatchObject({ label: "31m", overdue: true, tone: "rose" });
  });

  it("opens and closes a waiting pause on status transitions", () => {
    const opened = transitionSlaPauses([], "open", "waiting", "admin", new Date("2026-06-01T10:00:00+07:00"));
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ startAt: "2026-06-01T03:00:00.000Z", endAt: "", reason: "waiting", actor: "admin" });

    const closed = transitionSlaPauses(opened, "waiting", "in_progress", "admin", new Date("2026-06-01T12:00:00+07:00"));
    expect(closed[0].endAt).toBe("2026-06-01T05:00:00.000Z");
  });

  it("freezes P2 calendar-hour SLA while a ticket is waiting", () => {
    const state = ticketSlaState(
      ticket({
        severity: "High",
        kanbanStatus: "waiting",
        slaPauses: [{ id: "pause-1", startAt: "2026-06-01T10:00:00+07:00", endAt: "", reason: "waiting", actor: "admin" }],
      }),
      slaRules,
      [],
      new Date("2026-06-01T11:00:00+07:00"),
    );

    expect(state.clockMode).toBe("calendar");
    expect(state.label).toBe("Paused");
    expect(state.overdue).toBe(false);
    expect(state.dueDate?.toISOString()).toBe("2026-06-01T07:00:00.000Z");
  });

  it.each([
    ["inside business hours", "2026-06-01T16:00:00+07:00", [], "2026-06-02T03:00:00.000Z"],
    ["before business hours", "2026-06-01T08:00:00+07:00", [], "2026-06-01T04:00:00.000Z"],
    ["after business hours", "2026-06-01T18:00:00+07:00", [], "2026-06-02T04:00:00.000Z"],
    ["weekend", "2026-06-06T10:00:00+07:00", [], "2026-06-08T04:00:00.000Z"],
    ["configured holiday", "2026-06-03T10:00:00+07:00", [{ id: "h1", date: "2026-06-03", name: "Holiday" }], "2026-06-04T04:00:00.000Z"],
  ])("uses Bangkok business hours for P3 SLA: %s", (_, startDate, holidays, expectedIso) => {
    const state = ticketSlaState(
      ticket({ startDate, severity: "Medium" }),
      slaRules,
      holidays,
      new Date("2026-06-01T16:30:00+07:00"),
    );

    expect(state.clockMode).toBe("business");
    expect(state.dueDate?.toISOString()).toBe(expectedIso);
  });

  it("is deterministic when the server process timezone is UTC", () => {
    const previousTimezone = process.env.TZ;
    process.env.TZ = "UTC";
    try {
      const state = ticketSlaState(
        ticket({ startDate: "2026-06-01T16:00:00+07:00", severity: "Medium" }),
        slaRules,
        [],
        new Date("2026-06-01T16:30:00+07:00"),
      );

      expect(state.clockMode).toBe("business");
      expect(state.dueDate?.toISOString()).toBe("2026-06-02T03:00:00.000Z");
    } finally {
      process.env.TZ = previousTimezone;
    }
  });

  it("extends a business-hour SLA when a waiting pause crosses business days", () => {
    const state = ticketSlaState(
      ticket({
        startDate: "2026-06-01T16:00:00+07:00",
        severity: "Medium",
        slaPauses: [{
          id: "pause-1",
          startAt: "2026-06-01T16:30:00+07:00",
          endAt: "2026-06-02T09:30:00+07:00",
          reason: "waiting",
          actor: "admin",
        }],
      }),
      longSlaRules,
      [],
      new Date("2026-06-02T10:00:00+07:00"),
    );

    expect(state.dueDate?.toISOString()).toBe("2026-06-02T06:00:00.000Z");
    expect(state.pausedHours).toBe(1);
  });
});
