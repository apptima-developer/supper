import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { assertCan } from "@/lib/rbac";
import { generateMonthlyReportOutputs } from "@/lib/monthly-report-factory";
import { writeAudit } from "@/lib/repositories";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertCan(session.role, "reports:manage");
    const { period, projectCode, force } = await request.json();
    if (!period || !projectCode) throw new Error("Choose a month and project code before export");
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
      details: { period, projectCode, mandaySummaryPath: result.mandaySummaryPath, monthlyReportPdfPath: result.monthlyReportPdfPath },
    });
    return NextResponse.json(result);
  } catch (error) {
    const detail = error as Error & { code?: string; existing?: unknown };
    if (detail.code === "EXPORT_EXISTS") {
      return NextResponse.json({ error: detail.message, existing: detail.existing }, { status: 409 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Monthly report export failed" }, { status: 400 });
  }
}
