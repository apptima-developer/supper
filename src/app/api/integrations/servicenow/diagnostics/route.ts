import { getSession } from "@/lib/auth";
import { handleServiceNowDiagnosticsGet } from "@/lib/integrations/servicenow/diagnostics-api";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleServiceNowDiagnosticsGet(request, { getSession });
}
