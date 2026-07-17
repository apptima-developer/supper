import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { assertCan } from "@/lib/rbac";
import { generateMonthlyReportOutputs } from "@/lib/monthly-report-factory";
import { writeAudit } from "@/lib/repositories";
import { monthlyExportSchema } from "@/lib/mutation-schemas";
import { readJsonBody, safeErrorResponse } from "@/lib/request-security";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertCan(session.role, "reports:manage");
    const { period, projectCode, force } = await readJsonBody(request, monthlyExportSchema);
    const result = await generateMonthlyReportOutputs({
      period: String(period),
      projectCode: String(projectCode),
      actor: session.username,
      force: Boolean(force),
    });
    await writeAudit({
      action: "report",
      entity: "monthly-report-factory",
      entityId: result.id,
      actor: session.username,
      details: { period, projectCode, status: result.status },
    });
    return NextResponse.json({ id: result.id, status: result.status });
  } catch (error) {
    const detail = error as Error & { code?: string; existing?: unknown };
    if (detail.code === "EXPORT_EXISTS") {
      return NextResponse.json({ error: "A successful export already exists", code: "EXPORT_EXISTS" }, { status: 409 });
    }
    return safeErrorResponse(error, "Could not export monthly report", request, 500);
  }
}
