import { redirect } from "next/navigation";
import { PageHeader } from "@/components/page-header";
import { ImportCenter } from "@/components/import-center";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { importRepository } from "@/lib/repositories";
export const dynamic = "force-dynamic";
export default async function ImportsPage() { const session = await requireSession(); if (!can(session.role, "imports:manage")) redirect("/dashboard"); return <><PageHeader title="Import center" description="Preview and incrementally apply SupportDesk or Snow Excel updates." /><ImportCenter batches={await importRepository.list()} /></>; }
