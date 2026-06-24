import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { mapKanbanStatus, ticketEffortFields } from "@/lib/domain";
import { assertCan } from "@/lib/rbac";
import { customerRepository, ticketRepository } from "@/lib/repositories";
import { ticketSchema, type TicketLog } from "@/lib/types";

function makeTicketLog(raw: unknown, actor: string): TicketLog | null {
  const message = typeof raw === "string" ? raw.trim() : "";
  return message ? { id: crypto.randomUUID(), message, actor, createdAt: new Date().toISOString() } : null;
}

export async function GET() { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); return NextResponse.json(await ticketRepository.list()); }
export async function POST(request: Request) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "tickets:manage"); const raw = await request.json(); const customer = await customerRepository.get(raw.customerKey); if (!customer) throw new Error("Customer not found"); const effort = ticketEffortFields(raw); const log = makeTicketLog(raw.logEntry, session.username); const input = ticketSchema.omit({ id: true, createdAt: true, updatedAt: true }).parse({ ...raw, ...effort, remark: String(raw.remark ?? ""), ticketLogs: log ? [log] : [], customerKey: customer.key, customerName: customer.customerName, kanbanStatus: mapKanbanStatus(raw.status) }); return NextResponse.json(await ticketRepository.create(input, session.username), { status: 201 }); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid ticket" }, { status: 400 }); } }
