import { getSession } from "@/lib/auth";
import { handleIntakeIdentitiesGet } from "@/lib/intake-core/api-handlers";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleIntakeIdentitiesGet(request, { getSession }); }
