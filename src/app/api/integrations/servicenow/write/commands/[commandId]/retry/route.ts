import { getSession } from "@/lib/auth";
import { handleServiceNowWriteCommandRetryPost } from "@/lib/integrations/servicenow/write/api-handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ commandId: string }> }) {
  const { commandId } = await context.params;
  return handleServiceNowWriteCommandRetryPost(request, commandId, { getSession });
}
