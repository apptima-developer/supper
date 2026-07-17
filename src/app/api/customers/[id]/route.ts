import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { customerKey, manualContractStatus } from "@/lib/domain";
import { assertCan } from "@/lib/rbac";
import { customerRepository } from "@/lib/repositories";
import { customerAeUpdateSchema, customerUpdateSchema } from "@/lib/mutation-schemas";
import { HttpError, readJsonBody, safeErrorResponse } from "@/lib/request-security";
import type { Customer } from "@/lib/types";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); const patch: Partial<Customer> = session.role === "sales" ? await readJsonBody(request, customerAeUpdateSchema) : await readJsonBody(request, customerUpdateSchema); if (session.role === "sales") assertCan(session.role, "customers:ae"); else assertCan(session.role, "customers:manage"); const { id } = await params; const current = await customerRepository.get(id); if (!current) throw new HttpError(404, "CUSTOMER_NOT_FOUND", "Customer not found"); const next = { ...patch, ...(patch.contractStatus ? { contractStatus: manualContractStatus(patch.contractStatus) } : {}), ...((patch.projectCode || patch.customerName) ? { key: customerKey(patch.projectCode || current.projectCode, patch.customerName || current.customerName) } : {}) }; return NextResponse.json(await customerRepository.update(id, next, session.username)); } catch (error) { return safeErrorResponse(error, "Could not update customer", request, 400); } }
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "customers:manage"); const { id } = await params; await customerRepository.delete(id, session.username); return NextResponse.json({ ok: true }); } catch (error) { return safeErrorResponse(error, "Could not delete customer", request, 400); } }
