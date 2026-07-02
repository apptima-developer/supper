import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { mapKanbanStatus, ticketEffortFields, ticketSeverityLabel } from "@/lib/domain";
import { assertCan } from "@/lib/rbac";
import { customerRepository, masterRepositories, ticketRepository } from "@/lib/repositories";
import { ticketSlaState } from "@/lib/sla";
import { normalizeDateTime } from "@/lib/utils";
import type { Ticket, TicketLog } from "@/lib/types";

function makeTicketLog(raw: unknown, actor: string): TicketLog | null {
  const message = typeof raw === "string" ? raw.trim() : "";
  return message ? { id: crypto.randomUUID(), message, actor, createdAt: new Date().toISOString() } : null;
}

async function applyComputedDates(current: Ticket, patch: Partial<Ticket>) {
  const shouldCompute =
    "startDate" in patch ||
    "dueDate" in patch ||
    "closeDate" in patch ||
    "severity" in patch ||
    "customerKey" in patch ||
    "customerName" in patch;
  if (!shouldCompute) return patch;

  const next = { ...current, ...patch };
  const startDate = "startDate" in patch ? normalizeDateTime(String(patch.startDate || "")) : next.startDate;
  const closeDate = "closeDate" in patch ? normalizeDateTime(String(patch.closeDate || ""), 17) : next.closeDate;
  const fallbackDueDate = "dueDate" in patch ? normalizeDateTime(String(patch.dueDate || ""), 17) : next.dueDate;
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
    if (!current) throw new Error("Ticket not found");

    const raw = await request.json() as Record<string, unknown>;
    const { logEntry: _logEntry, ticketLogs: _ticketLogs, ...rawPatch } = raw;
    void _logEntry;
    void _ticketLogs;
    let patch = rawPatch as Partial<Ticket>;
    const log = makeTicketLog(raw.logEntry, session.username);
    if (log) patch.ticketLogs = [...(current.ticketLogs || []), log];
    if ("severity" in patch) patch.severity = ticketSeverityLabel(String(patch.severity || ""));
    if ("ownerEfforts" in patch || "mdUsed" in patch || "owner" in patch) Object.assign(patch, ticketEffortFields(patch, current));
    if (patch.status) patch.kanbanStatus = mapKanbanStatus(patch.status);
    if (patch.customerKey) {
      const customer = await customerRepository.get(patch.customerKey);
      if (!customer) throw new Error("Customer not found");
      patch.customerKey = customer.key;
      patch.customerName = customer.customerName;
    }
    patch = await applyComputedDates(current, patch);

    return NextResponse.json(await ticketRepository.update(id, patch, session.username));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid update" }, { status: 400 });
  }
}
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "tickets:manage"); const { id } = await params; await ticketRepository.delete(id, session.username); return NextResponse.json({ ok: true }); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Delete failed" }, { status: 400 }); } }
