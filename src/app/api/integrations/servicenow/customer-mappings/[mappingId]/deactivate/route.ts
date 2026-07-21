import { getSession } from "@/lib/auth";
import { handleServiceNowMappingDeactivatePost } from "@/lib/integrations/servicenow/operations/api-handlers";

export const dynamic = "force-dynamic";
export async function POST(request: Request, context: RouteContext<"/api/integrations/servicenow/customer-mappings/[mappingId]/deactivate">) {
  const { mappingId } = await context.params;
  return handleServiceNowMappingDeactivatePost(request, mappingId, { getSession });
}
