import { getSession } from "@/lib/auth";
import { handleServiceNowIncidentList } from "@/lib/integrations/servicenow/api-handlers";
import { getServiceNowAdapter } from "@/lib/integrations/servicenow/runtime";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleServiceNowIncidentList(request, { getSession, getAdapter: getServiceNowAdapter });
}
