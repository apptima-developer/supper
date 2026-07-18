import packageJson from "../../package.json";

type EnvInput = Record<string, string | undefined>;

export type BuildMetadata = {
  version: string;
  commitSha?: string;
  deploymentEnvironment?: string;
  buildTimestamp?: string;
};

function normalizedCommitSha(value?: string) {
  const candidate = value?.trim();
  return candidate && /^[a-f0-9]{7,64}$/i.test(candidate) ? candidate.toLowerCase().slice(0, 12) : undefined;
}

function normalizedDeploymentEnvironment(value?: string) {
  const candidate = value?.trim();
  return candidate && candidate.length <= 32 && /^[A-Za-z0-9._-]+$/.test(candidate) ? candidate : undefined;
}

function normalizedBuildTimestamp(value?: string) {
  const candidate = value?.trim();
  if (!candidate || candidate.length > 64) return undefined;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export function getBuildMetadata(env: EnvInput = process.env): BuildMetadata {
  const commitSha = normalizedCommitSha(env.APP_BUILD_SHA) || normalizedCommitSha(env.VERCEL_GIT_COMMIT_SHA);
  const deploymentEnvironment = normalizedDeploymentEnvironment(env.VERCEL_ENV);
  const buildTimestamp = normalizedBuildTimestamp(env.APP_BUILD_TIMESTAMP);
  return {
    version: packageJson.version,
    ...(commitSha ? { commitSha } : {}),
    ...(deploymentEnvironment ? { deploymentEnvironment } : {}),
    ...(buildTimestamp ? { buildTimestamp } : {}),
  };
}

export function runtimeEnvironmentCategory(env: EnvInput = process.env) {
  if (env.NODE_ENV === "production") return "production";
  if (env.NODE_ENV === "test") return "test";
  return "development";
}
