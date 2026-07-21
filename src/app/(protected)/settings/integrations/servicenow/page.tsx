import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { ServiceNowOperations } from "@/components/servicenow-operations";
import { requireSession } from "@/lib/auth";
import { isServiceNowDiagnosticsAllowed } from "@/lib/integrations/servicenow/diagnostics";
import { can } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export default async function ServiceNowOperationsPage() {
  const session = await requireSession();
  if (!can(session.role, "settings:manage")) redirect("/dashboard");
  return <>
    <PageHeader title="ServiceNow operations" description="Inspect synchronization health, run history, and stable customer mappings without writing to ServiceNow." />
    <ServiceNowOperations diagnosticsAvailable={isServiceNowDiagnosticsAllowed()} />
  </>;
}
