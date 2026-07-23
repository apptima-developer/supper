import { getSession } from "@/lib/auth";
import { handleServiceNowWriteCommandDetailGet } from "@/lib/integrations/servicenow/write/api-handlers";

export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ commandId: string }> }) {
  const { commandId } = await context.params;
  return handleServiceNowWriteCommandDetailGet(request, commandId, { getSession });
}
