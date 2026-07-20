import { getSession } from "@/lib/auth";
import { handleServiceNowIncidentDetail } from "@/lib/integrations/servicenow/api-handlers";
import { getServiceNowAdapter } from "@/lib/integrations/servicenow/runtime";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ sysId: string }> }) {
  const { sysId } = await params;
  return handleServiceNowIncidentDetail(request, sysId, { getSession, getAdapter: getServiceNowAdapter });
}
