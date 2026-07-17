import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { assertCan } from "@/lib/rbac";
import { commitImport, importPreview, parseWorkbook } from "@/lib/excel-import";
import { getRequestLimits } from "@/lib/env";
import { validateSpreadsheetUpload } from "@/lib/request-limits";
import { assertContentLength, HttpError, safeErrorResponse } from "@/lib/request-security";
export const runtime = "nodejs";
export async function POST(request: Request) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "imports:manage"); const limits = getRequestLimits(); assertContentLength(request, limits.maxImportFileBytes + 1024 * 1024); const form = await request.formData(); const file = form.get("file"); if (!(file instanceof File)) throw new HttpError(400, "FILE_REQUIRED", "Choose an Excel file"); if (file.size > limits.maxImportFileBytes) throw new HttpError(413, "FILE_TOO_LARGE", "Spreadsheet exceeds the configured upload limit"); const kind = form.get("kind") === "snow" ? "snow" : "supportdesk"; const mode = form.get("mode") === "commit" ? "commit" : "preview"; const buffer = Buffer.from(await file.arrayBuffer()); validateSpreadsheetUpload({ fileName: file.name, contentType: file.type, buffer, maxBytes: limits.maxImportFileBytes }); const parsed = await parseWorkbook(buffer, kind); if (mode === "preview") return NextResponse.json(importPreview(parsed)); return NextResponse.json(await commitImport(parsed, file.name, kind, session.username)); } catch (error) { return safeErrorResponse(error, "Could not import workbook", request, 400); } }
