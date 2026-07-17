import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { customerKey, manualContractStatus } from "@/lib/domain";
import { assertCan } from "@/lib/rbac";
import { customerRepository } from "@/lib/repositories";
import { customerSchema } from "@/lib/types";
import { customerCreateSchema } from "@/lib/mutation-schemas";
import { readJsonBody, safeErrorResponse } from "@/lib/request-security";

export async function GET() { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); return NextResponse.json(await customerRepository.list()); }
export async function POST(request: Request) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "customers:manage"); const raw = await readJsonBody(request, customerCreateSchema); const input = customerSchema.omit({ id: true, createdAt: true, updatedAt: true }).parse({ ...raw, key: customerKey(raw.projectCode, raw.customerName), contractStatus: manualContractStatus(raw.contractStatus), mdUsed: 0, mdRemaining: raw.mdPurchased + raw.carryForward, burnRate: 0, mdStatus: "Healthy" }); return NextResponse.json(await customerRepository.create(input, session.username), { status: 201 }); } catch (error) { return safeErrorResponse(error, "Could not create customer", request, 400); } }
