import { getSession } from "@/lib/auth";
import { handleServiceNowOperationsGet } from "@/lib/integrations/servicenow/operations/api-handlers";

export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleServiceNowOperationsGet(request, { getSession }); }
