import { getSession } from "@/lib/auth";
import { handleIntakeOperationsGet } from "@/lib/intake-core/api-handlers";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleIntakeOperationsGet(request, { getSession }); }
