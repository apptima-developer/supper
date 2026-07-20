import { getSession } from "@/lib/auth";
import { handleServiceNowSyncGet, handleServiceNowSyncPost } from "@/lib/integrations/servicenow/sync/api-handlers";
import { getServiceNowSyncStatus, syncServiceNowIncidents } from "@/lib/integrations/servicenow/sync/service";

export const dynamic = "force-dynamic";

const dependencies = { getSession, startSync: syncServiceNowIncidents, getStatus: getServiceNowSyncStatus };

export function GET(request: Request) {
  return handleServiceNowSyncGet(request, dependencies);
}

export function POST(request: Request) {
  return handleServiceNowSyncPost(request, dependencies);
}
