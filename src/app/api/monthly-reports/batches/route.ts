import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { assertCan, can } from "@/lib/rbac";
import { createMonthlyReportBatch, getMonthlyReportPreview, listMonthlyReportBatches } from "@/lib/monthly-report-factory";
import type { MonthlySourceFileType } from "@/lib/monthly-report-types";

export const runtime = "nodejs";

const fileFields: Record<MonthlySourceFileType, string> = {
  monthly_review: "monthlyReview",
  cr: "cr",
  inc: "inc",
  sr: "sr",
};

export async function GET(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!can(session.role, "reports:view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const url = new URL(request.url);
    const period = url.searchParams.get("period");
    if (period) return NextResponse.json(await getMonthlyReportPreview(period, url.searchParams.get("projectCode") || undefined));
    return NextResponse.json({ batches: await listMonthlyReportBatches() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Could not load monthly report batches" }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertCan(session.role, "reports:manage");
    const formData = await request.formData();
    const year = Number(formData.get("year"));
    const month = Number(formData.get("month"));
    const files = {} as Record<MonthlySourceFileType, { originalFileName: string; buffer: Buffer }>;
    for (const [type, field] of Object.entries(fileFields) as Array<[MonthlySourceFileType, string]>) {
      const file = formData.get(field);
      if (!(file instanceof File)) throw new Error(`Missing ${field} workbook`);
      files[type] = {
        originalFileName: file.name,
        buffer: Buffer.from(await file.arrayBuffer()),
      };
    }
    const batch = await createMonthlyReportBatch({ year, month, files, actor: session.username });
    return NextResponse.json(await getMonthlyReportPreview(`${year}-${String(month).padStart(2, "0")}`, batch.projectSummaries[0]?.projectCode));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "Monthly batch validation failed" }, { status: 400 });
  }
}
