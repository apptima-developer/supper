import type { Session } from "../../auth";
import { can } from "../../rbac";
import { jsonResponseWithRequestId, requestId } from "../../request-security";
import { getSafeServiceNowRuntimeDiagnostics, isServiceNowDiagnosticsAllowed } from "./diagnostics";
import type { SafeServiceNowRuntimeDiagnostics } from "./diagnostics-types";

type Environment = Record<string, string | undefined>;

export type ServiceNowDiagnosticsApiDependencies = {
  getSession: () => Promise<Session | null>;
  env?: Environment;
  diagnose?: (env: Environment) => SafeServiceNowRuntimeDiagnostics;
};

function notFound(request: Request, correlationId: string) {
  return jsonResponseWithRequestId(
    { error: "Not found", code: "NOT_FOUND" },
    request,
    { status: 404, headers: { "Cache-Control": "no-store" } },
    correlationId,
  );
}

export async function handleServiceNowDiagnosticsGet(request: Request, dependencies: ServiceNowDiagnosticsApiDependencies) {
  const correlationId = requestId(request);
  const env = dependencies.env ?? process.env;
  if (!isServiceNowDiagnosticsAllowed(env)) return notFound(request, correlationId);

  const session = await dependencies.getSession();
  if (!session || !can(session.role, "settings:manage")) return notFound(request, correlationId);

  const diagnostics = (dependencies.diagnose ?? getSafeServiceNowRuntimeDiagnostics)(env);
  return jsonResponseWithRequestId(
    { diagnostics },
    request,
    { headers: { "Cache-Control": "no-store" } },
    correlationId,
  );
}
