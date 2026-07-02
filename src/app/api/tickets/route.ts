import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { mapKanbanStatus, ticketEffortFields, ticketSeverityLabel } from "@/lib/domain";
import { assertCan } from "@/lib/rbac";
import { customerRepository, masterRepositories, ticketRepository } from "@/lib/repositories";
import { ticketSlaState } from "@/lib/sla";
import { normalizeDateTime } from "@/lib/utils";
import { ticketSchema, type Ticket, type TicketLog } from "@/lib/types";

function makeTicketLog(raw: unknown, actor: string): TicketLog | null {
  const message = typeof raw === "string" ? raw.trim() : "";
  return message ? { id: crypto.randomUUID(), message, actor, createdAt: new Date().toISOString() } : null;
}

export async function GET() { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); return NextResponse.json(await ticketRepository.list()); }

async function normalizeTicketDates(raw: Record<string, unknown>, ticket: Partial<Ticket>) {
  const startDate = normalizeDateTime(String(raw.startDate || ""));
  const closeDate = normalizeDateTime(String(raw.closeDate || ""), 17);
  const fallbackDueDate = normalizeDateTime(String(raw.dueDate || ""), 17);
  if (!startDate || !ticket.customerName || !ticket.severity || !ticket.kanbanStatus) {
    return { startDate, dueDate: fallbackDueDate, closeDate };
  }

  const [sla, holidays] = await Promise.all([
    masterRepositories.sla.list(),
    masterRepositories.holidays.list(),
  ]);
  const slaTicket = {
    ...ticket,
    id: "",
    issueId: String(raw.issueId || ""),
    date: String(raw.date || ""),
    startDate,
    dueDate: fallbackDueDate,
    closeDate,
    createdAt: "",
    updatedAt: "",
  } as Ticket;
  const computedDueDate = ticketSlaState(slaTicket, sla, holidays).dueDate?.toISOString();
  return { startDate, dueDate: computedDueDate || fallbackDueDate, closeDate };
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertCan(session.role, "tickets:manage");

    const raw = await request.json() as Record<string, unknown>;
    const customer = await customerRepository.get(String(raw.customerKey || ""));
    if (!customer) throw new Error("Customer not found");

    const severity = ticketSeverityLabel(String(raw.severity || ""));
    const kanbanStatus = mapKanbanStatus(String(raw.status || ""));
    const effort = ticketEffortFields(raw);
    const log = makeTicketLog(raw.logEntry, session.username);
    const dates = await normalizeTicketDates(raw, {
      customerName: customer.customerName,
      customerKey: customer.key,
      severity,
      status: String(raw.status || ""),
      kanbanStatus,
    });
    const input = ticketSchema.omit({ id: true, createdAt: true, updatedAt: true }).parse({
      ...raw,
      ...effort,
      ...dates,
      severity,
      remark: String(raw.remark ?? ""),
      ticketLogs: log ? [log] : [],
      customerKey: customer.key,
      customerName: customer.customerName,
      kanbanStatus,
    });

    return NextResponse.json(await ticketRepository.create(input, session.username), { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid ticket" }, { status: 400 });
  }
}
