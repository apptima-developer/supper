import { getSession } from "@/lib/auth";
import { handleServiceNowWriteReadinessPost } from "@/lib/integrations/servicenow/write/api-handlers";

export const dynamic = "force-dynamic";

export function POST(request: Request) {
  return handleServiceNowWriteReadinessPost(request, { getSession });
}
