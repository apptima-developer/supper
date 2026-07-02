import { PageHeader } from "@/components/page-header";
import { TicketManager, type InitialTicketFilters } from "@/components/ticket-manager";
import { requireSession } from "@/lib/auth";
import { loadTicketManagerData } from "@/lib/repositories";

export const dynamic = "force-dynamic";

type TicketSearchParams = Record<string, string | string[] | undefined>;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function splitValues(value: string | string[] | undefined) {
  const raw = Array.isArray(value) ? value.join(",") : value || "";
  return raw.split(",").map((item) => item.trim()).filter(Boolean);
}

function ticketFilters(searchParams: TicketSearchParams): InitialTicketFilters {
  return {
    query: firstValue(searchParams.q),
    owner: firstValue(searchParams.owner),
    issue: firstValue(searchParams.issue),
    customer: firstValue(searchParams.customer),
    statuses: splitValues(searchParams.status),
    types: splitValues(searchParams.type),
    chargeable: splitValues(searchParams.charge),
    startDateFrom: firstValue(searchParams.startFrom),
    startDateTo: firstValue(searchParams.startTo),
    editTicketId: firstValue(searchParams.edit),
  };
}

export default async function TicketsPage({ searchParams }: { searchParams: Promise<TicketSearchParams> }) {
  const [session, data, params] = await Promise.all([requireSession(), loadTicketManagerData(), searchParams]);
  const filters = ticketFilters(params);
  return (
    <>
      <PageHeader title="Ticket operations" description="Track ownership, service priority, status, effort, and customer impact." />
      <TicketManager
        key={JSON.stringify(filters)}
        tickets={data.tickets}
        customers={data.customers}
        statuses={data.statuses}
        slaRules={data.sla}
        holidays={data.holidays}
        issueTypes={data.issueTypes}
        teams={data.teams}
        role={session.role}
        userName={session.name}
        username={session.username}
        initialFilters={filters}
      />
    </>
  );
}
