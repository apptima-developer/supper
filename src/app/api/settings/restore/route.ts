import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { restoreBackup } from "@/lib/json-store";
import { assertCan } from "@/lib/rbac";
import { writeAudit } from "@/lib/repositories";
export async function POST(request: Request) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "settings:manage"); const { backup } = await request.json(); const target = await restoreBackup(String(backup)); await writeAudit({ action: "restore", entity: "backup", entityId: target, actor: session.username, details: { backup } }); return NextResponse.json({ target }); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Restore failed" }, { status: 400 }); } }
