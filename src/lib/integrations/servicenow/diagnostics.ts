import "server-only";
import { z } from "zod";
import {
  parseServiceNowConfig,
  serviceNowAuthModeSchema,
  serviceNowIncidentTableSchema,
  serviceNowInstanceUrlSchema,
  serviceNowPageSizeSchema,
  serviceNowTimeoutSchema,
} from "./config";
import type { SafeServiceNowRuntimeDiagnostics, SafeServiceNowValidationIssue } from "./diagnostics-types";
import {
  disabledByDefaultBooleanSchema,
  environmentValueOrDefault,
  normalizeLowerEnvironmentValue,
  trimAsciiEnvironmentValue,
} from "./env-normalization";
import { parseServiceNowSyncConfig } from "./sync/config";

type Environment = Record<string, string | undefined>;

const safeIssueMessages: Record<string, string> = {
  enabled: "Expected true or false",
  authMode: "Unsupported authentication mode",
  instanceUrl: "Instance URL is missing or invalid",
  username: "Basic authentication username is missing or invalid",
  password: "Basic authentication credential is missing or invalid",
  clientId: "OAuth client ID is missing or invalid",
  clientSecret: "OAuth client credential is missing or invalid",
  timeoutMs: "Timeout is outside the supported range",
  pageSize: "Page size is outside the supported range",
  incidentTable: "Incident table name is invalid",
  initialLookbackDays: "Initial lookback is outside the supported range",
  overlapSeconds: "Overlap is outside the supported range",
  maxRecords: "Maximum records is outside the supported range",
  maxPages: "Maximum pages is outside the supported range",
  lockTtlSeconds: "Lock lifetime is outside the supported range",
};

function present(value: string | undefined) {
  return value !== undefined;
}

function secretState(value: string | undefined) {
  return { present: present(value), nonEmpty: typeof value === "string" && value.length > 0 };
}

function safeValidationIssues(error: unknown): SafeServiceNowValidationIssue[] {
  if (!(error instanceof z.ZodError)) return [{ path: "configuration", code: "invalid_configuration", message: "Configuration is invalid" }];
  return error.issues.slice(0, 20).map((issue) => {
    const candidate = issue.path.filter((part): part is string | number => typeof part === "string" || typeof part === "number").join(".");
    const path = candidate && /^[A-Za-z0-9_.-]{1,80}$/.test(candidate) ? candidate : "configuration";
    const code = /^[a-z_]{1,40}$/.test(issue.code) ? issue.code : "invalid_value";
    return { path, code, message: safeIssueMessages[path] || "Configuration value is invalid" };
  });
}

function attempt<T>(operation: () => T) {
  try {
    return { success: true as const, data: operation(), issues: [] as SafeServiceNowValidationIssue[] };
  } catch (error) {
    return { success: false as const, issues: safeValidationIssues(error) };
  }
}

function safeDeploymentValue(value: string | undefined) {
  const normalized = normalizeLowerEnvironmentValue(value);
  return normalized && /^[a-z0-9._-]{1,64}$/.test(normalized) ? normalized : undefined;
}

function safeBranch(value: string | undefined) {
  const normalized = trimAsciiEnvironmentValue(value);
  return normalized && /^[A-Za-z0-9._/-]{1,200}$/.test(normalized) ? normalized : undefined;
}

function safeCommit(value: string | undefined) {
  const normalized = trimAsciiEnvironmentValue(value);
  return normalized && /^[a-f0-9]{7,64}$/i.test(normalized) ? normalized.toLowerCase().slice(0, 12) : undefined;
}

function safeDeploymentHostname(value: string | undefined) {
  const normalized = trimAsciiEnvironmentValue(value);
  if (!normalized || normalized.length > 2_048) return undefined;
  try {
    const url = new URL(normalized.includes("://") ? normalized : `https://${normalized}`);
    return /^[A-Za-z0-9.-]{1,253}$/.test(url.hostname) ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

export function isServiceNowDiagnosticsAllowed(env: Environment = process.env) {
  return normalizeLowerEnvironmentValue(env.APP_ENV) === "ai-development"
    && normalizeLowerEnvironmentValue(env.VERCEL_ENV) !== "production";
}

export function getSafeServiceNowRuntimeDiagnostics(env: Environment = process.env): SafeServiceNowRuntimeDiagnostics {
  const enabledResult = disabledByDefaultBooleanSchema.safeParse(env.SERVICENOW_ENABLED);
  const authModeResult = serviceNowAuthModeSchema.safeParse(normalizeLowerEnvironmentValue(env.SERVICENOW_AUTH_MODE) || "basic");
  const instanceResult = serviceNowInstanceUrlSchema.safeParse(trimAsciiEnvironmentValue(env.SERVICENOW_INSTANCE_URL));
  const configResult = attempt(() => parseServiceNowConfig(env));
  const syncEnabledResult = disabledByDefaultBooleanSchema.safeParse(env.SERVICENOW_SYNC_ENABLED);
  const syncResult = attempt(() => parseServiceNowSyncConfig(env));
  const password = secretState(env.SERVICENOW_PASSWORD);
  const clientSecret = secretState(env.SERVICENOW_CLIENT_SECRET);
  const username = trimAsciiEnvironmentValue(env.SERVICENOW_USERNAME);
  const clientId = trimAsciiEnvironmentValue(env.SERVICENOW_CLIENT_ID);

  return {
    deployment: {
      ...(safeDeploymentValue(env.APP_ENV) ? { appEnvironment: safeDeploymentValue(env.APP_ENV) } : {}),
      ...(safeDeploymentValue(env.VERCEL_ENV) ? { vercelEnvironment: safeDeploymentValue(env.VERCEL_ENV) } : {}),
      ...(safeBranch(env.VERCEL_GIT_COMMIT_REF) ? { gitBranch: safeBranch(env.VERCEL_GIT_COMMIT_REF) } : {}),
      ...(safeCommit(env.VERCEL_GIT_COMMIT_SHA) ? { commitSha: safeCommit(env.VERCEL_GIT_COMMIT_SHA) } : {}),
      ...(safeDeploymentHostname(env.VERCEL_URL) ? { deploymentHost: safeDeploymentHostname(env.VERCEL_URL) } : {}),
    },
    serviceNow: {
      enabledVariablePresent: present(env.SERVICENOW_ENABLED),
      enabledNormalized: enabledResult.success ? enabledResult.data : null,
      instanceUrlPresent: present(env.SERVICENOW_INSTANCE_URL),
      ...(instanceResult.success ? { instanceHostname: new URL(instanceResult.data).hostname } : {}),
      instanceUrlValid: instanceResult.success,
      authModePresent: present(env.SERVICENOW_AUTH_MODE),
      authModeNormalized: authModeResult.success ? authModeResult.data : null,
      usernamePresent: present(env.SERVICENOW_USERNAME),
      usernameNonEmptyAfterTrim: Boolean(username),
      passwordPresent: password.present,
      passwordNonEmpty: password.nonEmpty,
      clientIdPresent: present(env.SERVICENOW_CLIENT_ID),
      clientIdNonEmptyAfterTrim: Boolean(clientId),
      clientSecretPresent: clientSecret.present,
      clientSecretNonEmpty: clientSecret.nonEmpty,
      timeoutPresent: present(env.SERVICENOW_TIMEOUT_MS),
      timeoutValid: serviceNowTimeoutSchema.safeParse(environmentValueOrDefault(env.SERVICENOW_TIMEOUT_MS, 15_000)).success,
      pageSizePresent: present(env.SERVICENOW_PAGE_SIZE),
      pageSizeValid: serviceNowPageSizeSchema.safeParse(environmentValueOrDefault(env.SERVICENOW_PAGE_SIZE, 100)).success,
      incidentTablePresent: present(env.SERVICENOW_INCIDENT_TABLE),
      incidentTableValid: serviceNowIncidentTableSchema.safeParse(environmentValueOrDefault(env.SERVICENOW_INCIDENT_TABLE, "incident")).success,
      configurationValid: configResult.success && configResult.data.enabled,
      validationIssues: configResult.success ? [] : configResult.issues,
    },
    synchronization: {
      enabledVariablePresent: present(env.SERVICENOW_SYNC_ENABLED),
      enabledNormalized: syncEnabledResult.success ? syncEnabledResult.data : null,
      configurationValid: syncResult.success,
      validationIssues: syncResult.success ? [] : syncResult.issues,
    },
  };
}
