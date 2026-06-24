import { PageHeader } from "@/components/page-header";
import { ReportManager } from "@/components/report-manager";
import { requireSession } from "@/lib/auth";
import { loadReportPageData } from "@/lib/repositories";
export const dynamic = "force-dynamic";
export default async function ReportsPage() { const [session, data] = await Promise.all([requireSession(), loadReportPageData()]); return <><PageHeader title="Monthly reports" description="Preview customer service performance and generate a presentation-ready PPTX." /><ReportManager customers={data.customers} tickets={data.tickets} jobs={data.jobs} role={session.role} /></>; }
