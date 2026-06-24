import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { assertCan } from "@/lib/rbac";
import { masterRepositories } from "@/lib/repositories";
import { holidayListSchema, namedMasterListSchema, slaListSchema, statusListSchema } from "@/lib/types";
const allowed = ["statuses", "sla", "holidays", "teams", "priorities", "issueTypes", "contractTypes"] as const;
type Kind = typeof allowed[number];
function repo(kind: Kind) { return masterRepositories[kind]; }
export async function GET(_: Request, { params }: { params: Promise<{ kind: string }> }) { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); const { kind } = await params; if (!allowed.includes(kind as Kind)) return NextResponse.json({ error: "Unknown master type" }, { status: 404 }); return NextResponse.json(await repo(kind as Kind).list()); }
export async function PUT(request: Request, { params }: { params: Promise<{ kind: string }> }) { try { const session = await getSession(); if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 }); assertCan(session.role, "master:manage"); const { kind } = await params; if (!allowed.includes(kind as Kind)) throw new Error("Unknown master type"); const raw = await request.json(); const schema = kind === "statuses" ? statusListSchema : kind === "sla" ? slaListSchema : kind === "holidays" ? holidayListSchema : namedMasterListSchema; const items = schema.parse(raw); await (repo(kind as Kind).save as (items: never, actor: string) => Promise<void>)(items as never, session.username); return NextResponse.json({ ok: true }); } catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : "Invalid master data" }, { status: 400 }); } }
