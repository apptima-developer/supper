import { getSession } from "@/lib/auth";
import { handleServiceNowCustomerMappingsGet, handleServiceNowCustomerMappingsPost } from "@/lib/integrations/servicenow/operations/api-handlers";

export const dynamic = "force-dynamic";
const dependencies = { getSession };
export function GET(request: Request) { return handleServiceNowCustomerMappingsGet(request, dependencies); }
export function POST(request: Request) { return handleServiceNowCustomerMappingsPost(request, dependencies); }
