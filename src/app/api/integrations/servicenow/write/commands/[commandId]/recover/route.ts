import { getSession } from "@/lib/auth";
import { handleServiceNowWriteAttemptRecoveryPost } from "@/lib/integrations/servicenow/write/api-handlers";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ commandId: string }> },
) {
  const { commandId } = await context.params;
  return handleServiceNowWriteAttemptRecoveryPost(request, commandId, { getSession });
}
