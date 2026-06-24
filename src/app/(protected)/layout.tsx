import { AppShell } from "@/components/app-shell";
import { requireSession } from "@/lib/auth";
export default async function ProtectedLayout({ children }: { children: React.ReactNode }) { const session = await requireSession(); return <AppShell session={session}>{children}</AppShell>; }
