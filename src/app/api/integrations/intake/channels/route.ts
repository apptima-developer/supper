import { getSession } from "@/lib/auth";
import { handleIntakeChannelsGet } from "@/lib/intake-core/api-handlers";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleIntakeChannelsGet(request, { getSession }); }
