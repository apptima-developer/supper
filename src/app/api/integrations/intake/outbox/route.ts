import { getSession } from "@/lib/auth";
import { handleIntakeOutboxGet } from "@/lib/intake-core/api-handlers";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleIntakeOutboxGet(request, { getSession }); }
