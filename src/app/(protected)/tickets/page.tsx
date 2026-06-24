import { PageHeader } from "@/components/page-header";
import { TicketManager } from "@/components/ticket-manager";
import { requireSession } from "@/lib/auth";
import { customerRepository, masterRepositories, ticketRepository } from "@/lib/repositories";
export const dynamic = "force-dynamic";
export default async function TicketsPage() { const [session, tickets, customers, statuses, slaRules, holidays, issueTypes, teams] = await Promise.all([requireSession(), ticketRepository.list(), customerRepository.list(), masterRepositories.statuses.list(), masterRepositories.sla.list(), masterRepositories.holidays.list(), masterRepositories.issueTypes.list(), masterRepositories.teams.list()]); return <><PageHeader title="Ticket operations" description="Track ownership, service priority, status, effort, and customer impact." /><TicketManager tickets={tickets} customers={customers} statuses={statuses} slaRules={slaRules} holidays={holidays} issueTypes={issueTypes} teams={teams} role={session.role} userName={session.name} username={session.username} /></>; }
