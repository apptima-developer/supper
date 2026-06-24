import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { readGeneratedReport } from "@/lib/report-storage";
import { reportRepository } from "@/lib/repositories";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); const { id } = await params; const job = (await reportRepository.list()).find((item) => item.id === id); if (!job) return NextResponse.json({ error: "Report not found" }, { status: 404 }); const report = await readGeneratedReport(job.outputPath); return new NextResponse(report.bytes, { headers: { "Content-Type": report.contentType, "Content-Disposition": `attachment; filename="${report.fileName}"` } }); }
