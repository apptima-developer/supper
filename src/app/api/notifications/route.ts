import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { isTicketOwner, ticketOwnerLabel } from "@/lib/domain";
import { loadTicketManagerData } from "@/lib/repositories";
import { ticketSlaState } from "@/lib/sla";
import { formatDate } from "@/lib/utils";
import type { Ticket } from "@/lib/types";

const closedStatuses = new Set(["closed", "cancelled", "resolved"]);

function dueTime(ticket: Ticket) {
  if (!ticket.dueDate) return Number.MAX_SAFE_INTEGER;
  const time = new Date(ticket.dueDate).getTime();
  return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
}

export async function GET() {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const data = await loadTicketManagerData();
    const assignedTickets = data.tickets
      .filter((ticket) => !closedStatuses.has(ticket.kanbanStatus))
      .filter((ticket) => isTicketOwner(ticket, [session.username, session.name]));

    const notifications = assignedTickets
      .map((ticket) => {
        const sla = ticketSlaState(ticket, data.sla, data.holidays);
        const slaAlert = sla.tone === "rose" || sla.tone === "amber" || sla.overdue;
        return {
          id: `${slaAlert ? "sla" : "assigned"}:${ticket.id}`,
          ticketId: ticket.id,
          issueId: ticket.issueId,
          title: slaAlert ? `SLA ${sla.overdue ? "overdue" : sla.tone === "rose" ? "critical" : "warning"}` : "Assigned ticket",
          message: slaAlert
            ? `${ticket.issueId} · ${ticket.customerName} is at ${sla.label}${sla.dueDate ? `, due ${formatDate(sla.dueDate.toISOString())}` : ""}.`
            : `${ticket.issueId} · ${ticket.customerName} is assigned to ${ticketOwnerLabel(ticket) || session.name}.`,
          href: `/tickets/${ticket.id}`,
          tone: slaAlert ? sla.tone : "blue",
          kind: slaAlert ? "sla" : "assigned",
          priority: sla.overdue ? 0 : sla.tone === "rose" ? 1 : sla.tone === "amber" ? 2 : 3,
          dueAt: dueTime(ticket),
          updatedAt: ticket.updatedAt,
        };
      })
      .sort((a, b) => a.priority - b.priority || a.dueAt - b.dueAt || b.updatedAt.localeCompare(a.updatedAt));

    return NextResponse.json({
      count: notifications.length,
      assigned: assignedTickets.length,
      slaAlerts: notifications.filter((item) => item.kind === "sla").length,
      items: notifications.slice(0, 20),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Notification load failed" }, { status: 400 });
  }
}
