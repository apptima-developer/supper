import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { assertCan, can } from "@/lib/rbac";
import { createMonthlyReportBatch, getMonthlyReportPreview, listMonthlyReportBatches } from "@/lib/monthly-report-factory";
import type { MonthlySourceFileType } from "@/lib/monthly-report-types";
import { getRequestLimits } from "@/lib/env";
import { validateSpreadsheetUpload } from "@/lib/request-limits";
import { assertContentLength, HttpError, safeErrorResponse } from "@/lib/request-security";

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
    return safeErrorResponse(error, "Could not load monthly report batches", request, 500);
  }
}

export async function POST(request: Request) {
  try {
    const session = await getSession();
    if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    assertCan(session.role, "reports:manage");
    const limits = getRequestLimits();
    assertContentLength(request, limits.maxImportFileBytes * 4 + 1024 * 1024);
    const formData = await request.formData();
    const year = Number(formData.get("year"));
    const month = Number(formData.get("month"));
    const files = {} as Record<MonthlySourceFileType, { originalFileName: string; buffer: Buffer }>;
    for (const [type, field] of Object.entries(fileFields) as Array<[MonthlySourceFileType, string]>) {
      const file = formData.get(field);
      if (!(file instanceof File)) throw new Error(`Missing ${field} workbook`);
      if (file.size > limits.maxImportFileBytes) throw new HttpError(413, "FILE_TOO_LARGE", "Spreadsheet exceeds the configured upload limit");
      const buffer = Buffer.from(await file.arrayBuffer());
      validateSpreadsheetUpload({ fileName: file.name, contentType: file.type, buffer, maxBytes: limits.maxImportFileBytes });
      files[type] = {
        originalFileName: file.name,
        buffer,
      };
    }
    const batch = await createMonthlyReportBatch({ year, month, files, actor: session.username });
    return NextResponse.json(await getMonthlyReportPreview(`${year}-${String(month).padStart(2, "0")}`, batch.projectSummaries[0]?.projectCode));
  } catch (error) {
    return safeErrorResponse(error, "Could not validate monthly report batch", request, 400);
  }
}
