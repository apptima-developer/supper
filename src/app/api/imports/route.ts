import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { assertCan } from "@/lib/rbac";
import { commitImport, importPreview, parseWorkbook } from "@/lib/excel-import";
export const runtime = "nodejs";
export async function POST(request: Request) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "imports:manage"); const form = await request.formData(); const file = form.get("file"); if (!(file instanceof File)) throw new Error("Choose an Excel file"); const kind = form.get("kind") === "snow" ? "snow" : "supportdesk"; const mode = form.get("mode") === "commit" ? "commit" : "preview"; const parsed = await parseWorkbook(Buffer.from(await file.arrayBuffer()), kind); if (mode === "preview") return NextResponse.json(importPreview(parsed)); return NextResponse.json(await commitImport(parsed, file.name, kind, session.username)); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Import failed" }, { status: 400 }); } }
