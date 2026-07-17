import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { mapKanbanStatus, ticketEffortFields, ticketSeverityLabel, transitionSlaPauses } from "@/lib/domain";
import { assertCan } from "@/lib/rbac";
import { customerRepository, masterRepositories, ticketRepository } from "@/lib/repositories";
import { ticketSlaState } from "@/lib/sla";
import { normalizeDateTime } from "@/lib/utils";
import type { Ticket } from "@/lib/types";
import { ticketUserUpdateSchema } from "@/lib/mutation-schemas";
import { HttpError, readJsonBody, safeErrorResponse } from "@/lib/request-security";
import { makeTicketLog } from "@/lib/ticket-log-security";
import { ticketMutationBodyLimit } from "@/lib/request-limits";

async function applyComputedDates(current: Ticket, patch: Partial<Ticket>) {
  const shouldCompute =
    "startDate" in patch ||
    "closeDate" in patch ||
    "severity" in patch ||
    "customerKey" in patch ||
    "customerName" in patch ||
    "kanbanStatus" in patch ||
    "status" in patch ||
    "slaPauses" in patch;
  if (!shouldCompute) return patch;

  const next = { ...current, ...patch };
  const startDate = "startDate" in patch ? normalizeDateTime(String(patch.startDate || "")) : next.startDate;
  const closeDate = "closeDate" in patch ? normalizeDateTime(String(patch.closeDate || ""), 17) : next.closeDate;
  const fallbackDueDate = next.dueDate;
  if (!startDate || !next.customerName || !next.severity) return { ...patch, startDate, dueDate: fallbackDueDate, closeDate };

  const [sla, holidays] = await Promise.all([
    masterRepositories.sla.list(),
    masterRepositories.holidays.list(),
  ]);
  const computedDueDate = ticketSlaState({ ...next, startDate, dueDate: fallbackDueDate, closeDate }, sla, holidays).dueDate?.toISOString();
  return { ...patch, startDate, dueDate: computedDueDate || fallbackDueDate, closeDate };
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertCan(session.role, "tickets:manage");

    const { id } = await params;
    const current = await ticketRepository.get(id);
    if (!current) throw new HttpError(404, "TICKET_NOT_FOUND", "Ticket not found");

    const input = await readJsonBody(request, ticketUserUpdateSchema, ticketMutationBodyLimit());
    const { logEntry, ...mutableInput } = input;
    let patch: Partial<Ticket> = mutableInput;
    const log = makeTicketLog(logEntry, session.username);
    if (log) patch.ticketLogs = [...(current.ticketLogs || []), log];
    if ("category" in patch) patch.category = String(patch.category || "");
    if ("severity" in patch) patch.severity = ticketSeverityLabel(String(patch.severity || ""));
    if ("ownerEfforts" in patch) Object.assign(patch, ticketEffortFields({ ownerEfforts: patch.ownerEfforts }, current));
    if (patch.status) patch.kanbanStatus = mapKanbanStatus(patch.status);
    if (patch.customerKey) {
      const customer = await customerRepository.get(patch.customerKey);
      if (!customer) throw new HttpError(400, "CUSTOMER_NOT_FOUND", "Customer not found");
      patch.customerKey = customer.key;
      patch.customerName = customer.customerName;
    }
    if (patch.kanbanStatus && patch.kanbanStatus !== current.kanbanStatus) {
      patch.slaPauses = transitionSlaPauses(current.slaPauses, current.kanbanStatus, patch.kanbanStatus, session.username);
    }
    patch = await applyComputedDates(current, patch);

    return NextResponse.json(await ticketRepository.update(id, patch, session.username));
  } catch (error) {
    return safeErrorResponse(error, "Could not update ticket", request, 400);
  }
}
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "tickets:manage"); const { id } = await params; await ticketRepository.delete(id, session.username); return NextResponse.json({ ok: true }); } catch (error) { return safeErrorResponse(error, "Could not delete ticket", request, 400); } }
