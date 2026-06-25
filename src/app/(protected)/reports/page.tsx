import { PageHeader } from "@/components/page-header";
import { MonthlyReportFactory } from "@/components/monthly-report-factory";
import { ReportManager } from "@/components/report-manager";
import { requireSession } from "@/lib/auth";
import { listMonthlyReportBatches } from "@/lib/monthly-report-factory";
import { loadReportPageData } from "@/lib/repositories";

export const dynamic = "force-dynamic";

export default async function ReportsPage() {
  const [session, data, monthlyBatches] = await Promise.all([
    requireSession(),
    loadReportPageData(),
    listMonthlyReportBatches(),
  ]);

  return (
    <>
      <PageHeader
        title="Monthly Report Factory"
        description="Validate four monthly Excel sources, preview by project code, and generate Manday/PDF outputs."
      />
      <MonthlyReportFactory initialBatches={monthlyBatches} role={session.role} />
      <section className="mt-6">
        <PageHeader
          title="Presentation report"
          description="Existing customer service performance preview and PPTX export."
        />
        <ReportManager customers={data.customers} tickets={data.tickets} jobs={data.jobs} role={session.role} />
      </section>
    </>
  );
}
