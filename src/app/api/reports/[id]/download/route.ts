import { promises as fs } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { reportRepository } from "@/lib/repositories";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); const { id } = await params; const job = (await reportRepository.list()).find((item) => item.id === id); if (!job) return NextResponse.json({ error: "Report not found" }, { status: 404 }); const fileName = path.basename(job.outputPath); if (!fileName.endsWith(".pptx")) return NextResponse.json({ error: "Invalid report path" }, { status: 400 }); const file = path.join(process.cwd(), "data", "reports", "generated", fileName); const bytes = await fs.readFile(file); return new NextResponse(bytes, { headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.presentationml.presentation", "Content-Disposition": `attachment; filename="${fileName}"` } }); }
