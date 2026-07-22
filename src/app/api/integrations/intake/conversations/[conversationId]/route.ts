import { getSession } from "@/lib/auth";
import { handleIntakeConversationDetailGet } from "@/lib/intake-core/api-handlers";
export const dynamic = "force-dynamic";
export async function GET(request: Request, context: { params: Promise<{ conversationId: string }> }) {
  const { conversationId } = await context.params;
  return handleIntakeConversationDetailGet(request, conversationId, { getSession });
}
