import { getSession } from "@/lib/auth";
import { getDataBackend } from "@/lib/env";
import { handleIntakeDiagnosticPost } from "@/lib/intake-core/diagnostic-api";
import { createRelationalIntakeCoreRepository } from "@/lib/intake-core/relational-repository";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
  return handleIntakeDiagnosticPost(request, { getSession, getBackend: getDataBackend, repository: createRelationalIntakeCoreRepository() });
}
