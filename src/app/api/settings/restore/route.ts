import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { restoreBackup } from "@/lib/json-store";
import { writeAudit } from "@/lib/repositories";
import { backupRestoreSchema } from "@/lib/mutation-schemas";
import { readJsonBody, requestId, safeErrorResponse } from "@/lib/request-security";
import { restoreBackupAsAdmin } from "@/lib/backup-service";
export async function POST(request: Request) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); const { backup } = await readJsonBody(request, backupRestoreSchema); return NextResponse.json(await restoreBackupAsAdmin(session, backup, { restore: restoreBackup, audit: writeAudit, operationId: requestId(request) })); } catch (error) { return safeErrorResponse(error, "Could not restore backup", request, 400); } }
