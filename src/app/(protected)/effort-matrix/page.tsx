import { EffortMatrixReport } from "@/components/effort-matrix-report";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { customerRepository, masterRepositories, ticketRepository } from "@/lib/repositories";

export const dynamic = "force-dynamic";

export default async function EffortMatrixPage() {
  await requireSession();
  const [tickets, customers, teams] = await Promise.all([
    ticketRepository.list(),
    customerRepository.list(),
    masterRepositories.teams.list(),
  ]);

  return (
    <>
      <PageHeader
        title="Effort matrix"
        description="Summarize support effort by team member and customer for the selected period."
      />
      <EffortMatrixReport tickets={tickets} customers={customers} teams={teams} />
    </>
  );
}
