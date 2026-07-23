import { getSession } from "@/lib/auth";
import { handleServiceNowWriteOperationsGet } from "@/lib/integrations/servicenow/write/api-handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleServiceNowWriteOperationsGet(request, { getSession });
}
