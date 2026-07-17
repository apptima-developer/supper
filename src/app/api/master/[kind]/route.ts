import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { assertCan } from "@/lib/rbac";
import { masterRepositories } from "@/lib/repositories";
import { categoryMutationListSchema, holidayMutationListSchema, namedMasterMutationListSchema, slaMutationListSchema, statusMutationListSchema } from "@/lib/mutation-schemas";
import { HttpError, readJsonBody, safeErrorResponse } from "@/lib/request-security";
import type { ZodType } from "zod";
const allowed = ["statuses", "sla", "holidays", "teams", "priorities", "issueTypes", "contractTypes", "categories"] as const;
type Kind = typeof allowed[number];
function repo(kind: Kind) { return masterRepositories[kind]; }
export async function GET(_: Request, { params }: { params: Promise<{ kind: string }> }) { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); const { kind } = await params; if (!allowed.includes(kind as Kind)) return NextResponse.json({ error: "Unknown master type" }, { status: 404 }); return NextResponse.json(await repo(kind as Kind).list()); }
export async function PUT(request: Request, { params }: { params: Promise<{ kind: string }> }) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "master:manage"); const { kind } = await params; if (!allowed.includes(kind as Kind)) throw new HttpError(404, "UNKNOWN_MASTER_TYPE", "Unknown master type"); const schema = kind === "statuses" ? statusMutationListSchema : kind === "sla" ? slaMutationListSchema : kind === "holidays" ? holidayMutationListSchema : kind === "categories" ? categoryMutationListSchema : namedMasterMutationListSchema; const items = await readJsonBody(request, schema as ZodType<unknown>); await (repo(kind as Kind).save as (items: never, actor: string) => Promise<void>)(items as never, session.username); return NextResponse.json({ ok: true }); } catch (error) { return safeErrorResponse(error, "Could not save master data", request, 400); } }
