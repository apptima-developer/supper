import { PageHeader } from "@/components/page-header";
import { ReportManager } from "@/components/report-manager";
import { requireSession } from "@/lib/auth";
import { customerRepository, reportRepository, ticketRepository } from "@/lib/repositories";
export const dynamic = "force-dynamic";
export default async function ReportsPage() { const [session, customers, tickets, jobs] = await Promise.all([requireSession(), customerRepository.list(), ticketRepository.list(), reportRepository.list()]); return <><PageHeader title="Monthly reports" description="Preview customer service performance and generate a presentation-ready PPTX." /><ReportManager customers={customers} tickets={tickets} jobs={jobs} role={session.role} /></>; }
