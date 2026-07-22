import { getSession } from "@/lib/auth";
import { handleIntakeEventsGet } from "@/lib/intake-core/api-handlers";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleIntakeEventsGet(request, { getSession }); }
