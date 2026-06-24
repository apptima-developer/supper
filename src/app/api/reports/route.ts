import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { assertCan } from "@/lib/rbac";
import { generateMonthlyReport } from "@/lib/report-generator";
import { customerRepository, reportRepository, ticketRepository, writeAudit } from "@/lib/repositories";
import type { ReportJob } from "@/lib/types";
export const runtime = "nodejs";
export async function POST(request: Request) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "reports:manage"); const { customerKey, month } = await request.json(); if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("Choose a valid report month"); const customer = await customerRepository.get(customerKey); if (!customer) throw new Error("Customer not found"); const result = await generateMonthlyReport(customer, await ticketRepository.list(), month); const job: ReportJob = { id: crypto.randomUUID(), customerKey: customer.key, customerName: customer.customerName, month, status: "generated", outputPath: result.outputPath, actor: session.username, createdAt: new Date().toISOString() }; await reportRepository.add(job); await writeAudit({ action: "report", entity: "report-job", entityId: job.id, actor: session.username, details: { customer: customer.customerName, month, ...result.summary } }); return NextResponse.json({ ...job, summary: result.summary }); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Report generation failed" }, { status: 400 }); } }
