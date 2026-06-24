import { PageHeader } from "@/components/page-header";
import { KanbanBoard } from "@/components/kanban-board";
import { requireSession } from "@/lib/auth";
import { ticketRepository } from "@/lib/repositories";
export const dynamic = "force-dynamic";
export default async function KanbanPage() { const [session, tickets] = await Promise.all([requireSession(), ticketRepository.list()]); return <><PageHeader title="Ticket Kanban" description="Move tickets through the working lifecycle. Closed, cancelled, and open tickets older than 90 days stay hidden from the board." /><KanbanBoard initialTickets={tickets} role={session.role} userName={session.name} username={session.username} /></>; }
