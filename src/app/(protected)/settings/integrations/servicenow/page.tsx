import Link from "next/link";
import { redirect } from "next/navigation";
import { PenLine } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ServiceNowOperations } from "@/components/servicenow-operations";
import { Button } from "@/components/ui/button";
import { requireSession } from "@/lib/auth";
import { isServiceNowDiagnosticsAllowed } from "@/lib/integrations/servicenow/diagnostics";
import { can } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export default async function ServiceNowOperationsPage() {
  const session = await requireSession();
  if (!can(session.role, "settings:manage")) redirect("/dashboard");
  return <>
    <PageHeader
      title="ServiceNow operations"
      description="Inspect synchronization health, run history, and stable customer mappings without writing to ServiceNow."
      actions={<Button asChild size="sm"><Link href="/settings/integrations/servicenow/write"><PenLine size={13} />Write controls</Link></Button>}
    />
    <ServiceNowOperations diagnosticsAvailable={isServiceNowDiagnosticsAllowed()} />
  </>;
}
