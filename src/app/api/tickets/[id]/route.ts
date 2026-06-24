import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { mapKanbanStatus, ticketEffortFields } from "@/lib/domain";
import { assertCan } from "@/lib/rbac";
import { customerRepository, ticketRepository } from "@/lib/repositories";
import type { TicketLog } from "@/lib/types";

function makeTicketLog(raw: unknown, actor: string): TicketLog | null {
  const message = typeof raw === "string" ? raw.trim() : "";
  return message ? { id: crypto.randomUUID(), message, actor, createdAt: new Date().toISOString() } : null;
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "tickets:manage"); const { id } = await params; const current = await ticketRepository.get(id); if (!current) throw new Error("Ticket not found"); const raw = await request.json(); const { logEntry: _logEntry, ticketLogs: _ticketLogs, ...patch } = raw; void _logEntry; void _ticketLogs; const log = makeTicketLog(raw.logEntry, session.username); if (log) patch.ticketLogs = [...(current.ticketLogs || []), log]; if ("ownerEfforts" in patch || "mdUsed" in patch || "owner" in patch) Object.assign(patch, ticketEffortFields(patch, current)); if (patch.status) patch.kanbanStatus = mapKanbanStatus(patch.status); if (patch.customerKey) { const customer = await customerRepository.get(patch.customerKey); if (!customer) throw new Error("Customer not found"); patch.customerKey = customer.key; patch.customerName = customer.customerName; } return NextResponse.json(await ticketRepository.update(id, patch, session.username)); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid update" }, { status: 400 }); } }
export async function DELETE(_: Request, { params }: { params: Promise<{ id: string }> }) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "tickets:manage"); const { id } = await params; await ticketRepository.delete(id, session.username); return NextResponse.json({ ok: true }); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Delete failed" }, { status: 400 }); } }
