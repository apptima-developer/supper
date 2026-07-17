import { NextResponse } from "next/server";
import { safeErrorResponse } from "@/lib/request-security";
import { getSession } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { readMonthlyReportExportFile } from "@/lib/monthly-report-factory";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!can(session.role, "reports:view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const params = new URL(request.url).searchParams;
    const period = params.get("period") || "";
    const exportId = params.get("exportId") || "";
    const kind = params.get("kind");
    if (!period || !exportId || !["manday", "workbook", "pdf"].includes(kind || "")) throw new Error("Invalid export download request");
    const report = await readMonthlyReportExportFile(period, exportId, kind as "manday" | "workbook" | "pdf");
    return new NextResponse(new Uint8Array(report.bytes), {
      headers: {
        "Content-Type": report.contentType,
        "Content-Disposition": `attachment; filename="${report.fileName}"`,
      },
    });
  } catch (error) {
    return safeErrorResponse(error, "Could not download report file", request, 404);
  }
}
