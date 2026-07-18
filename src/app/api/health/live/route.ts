import { getBuildMetadata, runtimeEnvironmentCategory } from "@/lib/build-metadata";
import { jsonResponseWithRequestId } from "@/lib/request-security";

export const dynamic = "force-dynamic";

export function GET(request?: Request) {
  const build = getBuildMetadata();
  return jsonResponseWithRequestId({
    application: "SUPPER Support Control System",
    status: "live",
    version: build.version,
    environment: runtimeEnvironmentCategory(),
    timestamp: new Date().toISOString(),
    ...(build.commitSha || build.deploymentEnvironment || build.buildTimestamp ? { build } : {}),
  }, request);
}
