import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { assertCan } from "@/lib/rbac";
import { importRepository, restoreImportedCoreDataBackup, writeAudit } from "@/lib/repositories";
import { HttpError, safeErrorResponse } from "@/lib/request-security";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertCan(session.role, "imports:manage");

    const { id } = await params;
    const batch = (await importRepository.list()).find((item) => item.id === id);
    if (!batch) throw new HttpError(404, "IMPORT_NOT_FOUND", "Import batch not found");
    if (batch.status !== "completed") throw new HttpError(409, "IMPORT_NOT_ROLLBACKABLE", "Only completed imports can be rolled back");

    const restored = await restoreImportedCoreDataBackup(batch.backupPaths);
    await importRepository.update(id, { status: "rolled_back" });
    await writeAudit({ action: "restore", entity: "import-batch", entityId: id, actor: session.username, details: { restored } });
    return NextResponse.json({ restored });
  } catch (error) {
    return safeErrorResponse(error, "Could not roll back import", request, 400);
  }
}
