import { getSession } from "@/lib/auth";
import { handleServiceNowRunDetailGet } from "@/lib/integrations/servicenow/operations/api-handlers";

export const dynamic = "force-dynamic";
export async function GET(request: Request, context: RouteContext<"/api/integrations/servicenow/runs/[runId]">) {
  const { runId } = await context.params;
  return handleServiceNowRunDetailGet(request, runId, { getSession });
}
