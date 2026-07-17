import { redirect } from "next/navigation";
import { KeyRound, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { BackupManager } from "@/components/backup-manager";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { requireSession } from "@/lib/auth";
import { settingsStorageDescription } from "@/lib/backup-restore-policy";
import { getDataBackend } from "@/lib/env";
import { listBackups } from "@/lib/json-store";
import { can } from "@/lib/rbac";
export const dynamic = "force-dynamic";
export default async function SettingsPage() {
  const session = await requireSession();
  if (!can(session.role, "settings:manage")) redirect("/dashboard");
  const backend = getDataBackend();
  const storage = settingsStorageDescription(backend);
  const backups = await listBackups();

  return <>
    <PageHeader title="System settings" description="Control backend-aware data resilience, export, and production-readiness settings." />
    <div className="grid gap-4 xl:grid-cols-[1.2fr_.8fr]">
      <BackupManager backups={backups} description={storage.restore} />
      <div className="space-y-4">
        <Card>
          <CardHeader><CardTitle>Security checklist</CardTitle><ShieldCheck size={16} className="text-emerald-600" /></CardHeader>
          <CardContent className="space-y-3 text-[11px]"><div className="rounded-md bg-amber-50 p-3 text-amber-800"><p className="font-medium">Before production deployment</p><p className="mt-1 leading-5">Set a strong SESSION_SECRET environment variable and replace every seeded password.</p></div><div className="flex items-start gap-2"><KeyRound size={14} className="mt-0.5 text-slate-400" /><p className="leading-5 text-slate-500">Passwords are stored as bcrypt hashes. Sessions use signed, HTTP-only, same-site cookies with a 12-hour lifetime.</p></div></CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Storage engine</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-[11px] text-slate-500">
            <p>Backend: <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px]">{backend}</code></p>
            <p>Root: {storage.root}</p><p>Writes: {storage.writes}</p><p>Retention: {storage.retention}</p><p>Restore: {storage.restore}</p>
            <p>Import policy: incremental upsert, no deletion of absent rows</p>
          </CardContent>
        </Card>
      </div>
    </div>
  </>;
}
