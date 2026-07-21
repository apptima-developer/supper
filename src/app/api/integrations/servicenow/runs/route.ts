import { getSession } from "@/lib/auth";
import { handleServiceNowRunsGet } from "@/lib/integrations/servicenow/operations/api-handlers";

export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleServiceNowRunsGet(request, { getSession }); }
