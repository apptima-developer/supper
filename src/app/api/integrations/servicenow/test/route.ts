import { getSession } from "@/lib/auth";
import { handleServiceNowTest } from "@/lib/integrations/servicenow/api-handlers";
import { getServiceNowAdapter } from "@/lib/integrations/servicenow/runtime";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleServiceNowTest(request, { getSession, getAdapter: getServiceNowAdapter });
}
