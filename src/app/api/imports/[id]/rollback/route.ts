import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { restoreBackupSet } from "@/lib/json-store";
import { assertCan } from "@/lib/rbac";
import { importRepository, writeAudit } from "@/lib/repositories";
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "imports:manage"); const { id } = await params; const batch = (await importRepository.list()).find((item) => item.id === id); if (!batch) throw new Error("Import batch not found"); if (batch.status !== "completed") throw new Error("Only completed imports can be rolled back"); const restored = await restoreBackupSet(batch.backupPaths); await importRepository.update(id, { status: "rolled_back" }); await writeAudit({ action: "restore", entity: "import-batch", entityId: id, actor: session.username, details: { restored } }); return NextResponse.json({ restored }); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Rollback failed" }, { status: 400 }); } }
