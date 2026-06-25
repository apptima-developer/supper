import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { can } from "@/lib/rbac";
import { readMonthlyReportFile } from "@/lib/monthly-report-factory";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!can(session.role, "reports:view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const file = new URL(request.url).searchParams.get("file");
    if (!file) throw new Error("Missing file path");
    const report = await readMonthlyReportFile(file);
    return new NextResponse(new Uint8Array(report.bytes), {
      headers: {
        "Content-Type": report.contentType,
        "Content-Disposition": `attachment; filename="${report.fileName}"`,
      },
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not download report file" }, { status: 404 });
  }
}
