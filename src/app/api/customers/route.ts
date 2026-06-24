import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { customerKey, manualContractStatus } from "@/lib/domain";
import { assertCan } from "@/lib/rbac";
import { customerRepository } from "@/lib/repositories";
import { customerSchema } from "@/lib/types";

export async function GET() { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); return NextResponse.json(await customerRepository.list()); }
export async function POST(request: Request) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "customers:manage"); const raw = await request.json(); const mdPurchased = Number(raw.mdPurchased || 0); const carryForward = Number(raw.carryForward || 0); const input = customerSchema.omit({ id: true, createdAt: true, updatedAt: true }).parse({ ...raw, key: customerKey(raw.projectCode, raw.customerName), contractStatus: manualContractStatus(raw.contractStatus), mdUsed: 0, mdRemaining: mdPurchased + carryForward, carryForward, burnRate: 0, mdStatus: "Healthy" }); return NextResponse.json(await customerRepository.create(input, session.username), { status: 201 }); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid customer" }, { status: 400 }); } }
