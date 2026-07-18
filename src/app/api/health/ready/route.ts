import { getBuildMetadata, runtimeEnvironmentCategory } from "@/lib/build-metadata";
import { validateRuntimeEnvironment } from "@/lib/env";
import { sanitizedReadinessChecks } from "@/lib/health-diagnostics";
import { jsonResponseWithRequestId } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export function GET(request?: Request) {
  const readiness = validateRuntimeEnvironment();
  const build = getBuildMetadata();
  return jsonResponseWithRequestId(
    {
      application: "SUPPER Support Control System",
      status: readiness.ok ? "ready" : "not_ready",
      backend: readiness.backend,
      checks: sanitizedReadinessChecks(readiness),
      environment: runtimeEnvironmentCategory(),
      timestamp: new Date().toISOString(),
      ...(build.commitSha || build.deploymentEnvironment || build.buildTimestamp ? { build } : {}),
    },
    request,
    { status: readiness.ok ? 200 : 503 },
  );
}
