import { getSession } from "@/lib/auth";
import { handleServiceNowCustomerTargetsGet } from "@/lib/integrations/servicenow/operations/api-handlers";

export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleServiceNowCustomerTargetsGet(request, { getSession }); }
