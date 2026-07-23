import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { ServiceNowWriteControls } from "@/components/servicenow-write-controls";
import { Button } from "@/components/ui/button";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export default async function ServiceNowWriteControlsPage() {
  const session = await requireSession();
  if (!can(session.role, "settings:manage")) redirect("/dashboard");
  return <>
    <PageHeader
      title="ServiceNow write controls"
      description="Validate, dry-run, execute, and audit bounded ServiceNow Incident commands."
      actions={<Button asChild variant="outline" size="sm"><Link href="/settings/integrations/servicenow"><ArrowLeft size={13} />Read operations</Link></Button>}
    />
    <ServiceNowWriteControls />
  </>;
}
