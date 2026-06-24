import { PageHeader } from "@/components/page-header";
import { TicketManager } from "@/components/ticket-manager";
import { requireSession } from "@/lib/auth";
import { loadTicketManagerData } from "@/lib/repositories";
export const dynamic = "force-dynamic";
export default async function TicketsPage() { const [session, data] = await Promise.all([requireSession(), loadTicketManagerData()]); return <><PageHeader title="Ticket operations" description="Track ownership, service priority, status, effort, and customer impact." /><TicketManager tickets={data.tickets} customers={data.customers} statuses={data.statuses} slaRules={data.sla} holidays={data.holidays} issueTypes={data.issueTypes} teams={data.teams} role={session.role} userName={session.name} username={session.username} /></>; }
