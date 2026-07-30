import { getSession } from "@/lib/auth";
import { handleServiceNowWriteManualOperationPost } from "@/lib/integrations/servicenow/write/api-handlers";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleServiceNowWriteManualOperationPost(request, { getSession });
}
