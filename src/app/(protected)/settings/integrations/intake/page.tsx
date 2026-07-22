import { redirect } from "next/navigation";
import { IntakeOperations } from "@/components/intake-operations";
import { PageHeader } from "@/components/page-header";
import { requireSession } from "@/lib/auth";
import { getDataBackend } from "@/lib/env";
import { intakeDiagnosticAllowed } from "@/lib/intake-core/diagnostic-api";
import { can } from "@/lib/rbac";

export const dynamic = "force-dynamic";

export default async function IntakeOperationsPage() {
  const session = await requireSession();
  if (!can(session.role, "settings:manage")) redirect("/dashboard");
  return <>
    <PageHeader title="Intake operations" description="Inspect provider-neutral channels, identities, conversations, events, sessions, attachment metadata, and outbound intent." />
    <IntakeOperations diagnosticsAvailable={intakeDiagnosticAllowed(process.env, getDataBackend())} />
  </>;
}
