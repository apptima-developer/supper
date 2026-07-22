import { getSession } from "@/lib/auth";
import { handleIntakeConversationsGet } from "@/lib/intake-core/api-handlers";
export const dynamic = "force-dynamic";
export function GET(request: Request) { return handleIntakeConversationsGet(request, { getSession }); }
