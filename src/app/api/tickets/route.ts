import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { mapKanbanStatus, ticketEffortFields, ticketSeverityLabel, transitionSlaPauses } from "@/lib/domain";
import { assertCan } from "@/lib/rbac";
import { customerRepository, masterRepositories, ticketRepository } from "@/lib/repositories";
import { ticketSlaState } from "@/lib/sla";
import { normalizeDateTime } from "@/lib/utils";
import { ticketSchema, type Ticket } from "@/lib/types";
import { ticketCreateSchema } from "@/lib/mutation-schemas";
import { readJsonBody, safeErrorResponse, HttpError } from "@/lib/request-security";
import { makeTicketLog } from "@/lib/ticket-log-security";
import { ticketMutationBodyLimit } from "@/lib/request-limits";

export async function GET() { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); return NextResponse.json(await ticketRepository.list()); }

async function normalizeTicketDates(issueId: string, ticketCreateDate: string, ticket: Partial<Ticket>) {
  const startDate = normalizeDateTime(String(ticket.startDate || ""));
  const closeDate = normalizeDateTime(String(ticket.closeDate || ""), 17);
  if (!startDate || !ticket.customerName || !ticket.severity || !ticket.kanbanStatus) {
    return { startDate, dueDate: "", closeDate };
  }

  const [sla, holidays] = await Promise.all([
    masterRepositories.sla.list(),
    masterRepositories.holidays.list(),
  ]);
  const slaTicket = {
    ...ticket,
    id: "",
    issueId,
    date: ticketCreateDate,
    startDate,
    dueDate: "",
    closeDate,
    createdAt: "",
    updatedAt: "",
    slaPauses: ticket.slaPauses || [],
  } as Ticket;
  const computedDueDate = ticketSlaState(slaTicket, sla, holidays).dueDate?.toISOString();
  return { startDate, dueDate: computedDueDate || "", closeDate };
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertCan(session.role, "tickets:manage");

    const input = await readJsonBody(request, ticketCreateSchema, ticketMutationBodyLimit());
    const customer = await customerRepository.get(input.customerKey);
    if (!customer) throw new HttpError(400, "CUSTOMER_NOT_FOUND", "Customer not found");

    const severity = ticketSeverityLabel(input.severity);
    const kanbanStatus = mapKanbanStatus(input.status);
    const slaPauses = transitionSlaPauses([], "open", kanbanStatus, session.username);
    const effort = ticketEffortFields({ ownerEfforts: input.ownerEfforts });
    const log = makeTicketLog(input.logEntry, session.username);
    const ticketCreateDate = new Date().toISOString();
    const dates = await normalizeTicketDates(input.issueId, ticketCreateDate, {
      ...input,
      customerName: customer.customerName,
      customerKey: customer.key,
      severity,
      kanbanStatus,
      slaPauses,
    });
    const ticket = ticketSchema.omit({ id: true, createdAt: true, updatedAt: true }).parse({
      ...input,
      ...effort,
      ...dates,
      date: ticketCreateDate,
      severity,
      remark: input.remark || "",
      ticketLogs: log ? [log] : [],
      customerKey: customer.key,
      customerName: customer.customerName,
      kanbanStatus,
      slaPauses,
    });

    return NextResponse.json(await ticketRepository.create(ticket, session.username), { status: 201 });
  } catch (error) {
    return safeErrorResponse(error, "Could not create ticket", request, 400);
  }
}
