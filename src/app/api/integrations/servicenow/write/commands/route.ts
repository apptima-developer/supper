import { getSession } from "@/lib/auth";
import {
  handleServiceNowWriteCommandsGet,
  handleServiceNowWriteCommandsPost,
} from "@/lib/integrations/servicenow/write/api-handlers";

export const dynamic = "force-dynamic";

export function GET(request: Request) {
  return handleServiceNowWriteCommandsGet(request, { getSession });
}

export function POST(request: Request) {
  return handleServiceNowWriteCommandsPost(request, { getSession });
}
