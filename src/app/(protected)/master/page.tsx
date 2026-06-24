import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { MasterDataManager } from "@/components/master-data-manager";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { loadMasterData } from "@/lib/repositories";
export const dynamic = "force-dynamic";
export default async function MasterPage() { const session = await requireSession(); if (!can(session.role, "master:manage")) redirect("/dashboard"); const data = await loadMasterData(); return <><PageHeader title="Master data" description="Maintain service rules, calendars, ownership, status mappings, and contract taxonomy." /><MasterDataManager initial={data} /></>; }
