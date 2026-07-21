import { z } from "zod";
import {
  disabledByDefaultBooleanSchema,
  environmentValueOrDefault,
  normalizeLowerEnvironmentValue,
  trimAsciiEnvironmentValue,
} from "./env-normalization";

const safeTableName = /^[a-z][a-z0-9_]{0,79}$/;
const boundedInteger = (minimum: number, maximum: number) => z.coerce.number().int().min(minimum).max(maximum);

function isLocalhost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

export const serviceNowInstanceUrlSchema = z.string().trim().url().transform((value, context) => {
  const url = new URL(value);
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    context.addIssue({ code: "custom", message: "ServiceNow instance URL must contain only scheme and host" });
    return z.NEVER;
  }
  const localHttp = url.protocol === "http:" && isLocalhost(url.hostname);
  if (url.protocol !== "https:" && !localHttp) {
    context.addIssue({ code: "custom", message: "ServiceNow instance URL must use HTTPS" });
    return z.NEVER;
  }
  return url.origin;
});

const common = {
  instanceUrl: serviceNowInstanceUrlSchema,
  timeoutMs: boundedInteger(1_000, 60_000),
  pageSize: boundedInteger(1, 100),
  incidentTable: z.string().trim().regex(safeTableName),
};

const enabledConfigSchema = z.discriminatedUnion("authMode", [
  z.object({ enabled: z.literal(true), authMode: z.literal("basic"), username: z.string().trim().min(1).max(255), password: z.string().min(1).max(2_048), ...common }).strict(),
  z.object({ enabled: z.literal(true), authMode: z.literal("oauth_client_credentials"), clientId: z.string().trim().min(1).max(512), clientSecret: z.string().min(1).max(2_048), ...common }).strict(),
]);

export const serviceNowAuthModeSchema = z.enum(["basic", "oauth_client_credentials"]);
export const serviceNowTimeoutSchema = common.timeoutMs;
export const serviceNowPageSizeSchema = common.pageSize;
export const serviceNowIncidentTableSchema = common.incidentTable;

export type ServiceNowEnabledConfig = z.infer<typeof enabledConfigSchema>;
export type ServiceNowConfig = ServiceNowEnabledConfig | { enabled: false };
export type ServiceNowConfigSummary = {
  enabled: boolean;
  configured: boolean;
  syncEnabled: boolean;
  hostname?: string;
  authMode?: "basic" | "oauth_client_credentials";
  errorCategory?: "disabled" | "configuration";
};

export function parseServiceNowConfig(env: Record<string, string | undefined>): ServiceNowConfig {
  const enabled = z.object({ enabled: disabledByDefaultBooleanSchema }).parse({ enabled: env.SERVICENOW_ENABLED }).enabled;
  if (!enabled) return Object.freeze({ enabled: false });
  const authMode = normalizeLowerEnvironmentValue(env.SERVICENOW_AUTH_MODE) || "basic";
  const commonInput = {
    enabled: true as const,
    authMode,
    instanceUrl: trimAsciiEnvironmentValue(env.SERVICENOW_INSTANCE_URL),
    timeoutMs: environmentValueOrDefault(env.SERVICENOW_TIMEOUT_MS, 15_000),
    pageSize: environmentValueOrDefault(env.SERVICENOW_PAGE_SIZE, 100),
    incidentTable: environmentValueOrDefault(env.SERVICENOW_INCIDENT_TABLE, "incident"),
  };
  return enabledConfigSchema.parse(authMode === "basic"
    ? { ...commonInput, username: trimAsciiEnvironmentValue(env.SERVICENOW_USERNAME), password: env.SERVICENOW_PASSWORD }
    : { ...commonInput, clientId: trimAsciiEnvironmentValue(env.SERVICENOW_CLIENT_ID), clientSecret: env.SERVICENOW_CLIENT_SECRET });
}

export function summarizeServiceNowConfig(env: Record<string, string | undefined>): ServiceNowConfigSummary {
  const enabledResult = disabledByDefaultBooleanSchema.safeParse(env.SERVICENOW_ENABLED);
  const syncResult = disabledByDefaultBooleanSchema.safeParse(env.SERVICENOW_SYNC_ENABLED);
  const authResult = serviceNowAuthModeSchema.safeParse(normalizeLowerEnvironmentValue(env.SERVICENOW_AUTH_MODE) || "basic");
  const instanceResult = serviceNowInstanceUrlSchema.safeParse(trimAsciiEnvironmentValue(env.SERVICENOW_INSTANCE_URL));
  const syncEnabled = syncResult.success ? syncResult.data : false;
  if (enabledResult.success && !enabledResult.data) return { enabled: false, configured: false, syncEnabled, errorCategory: "disabled" };
  try {
    const config = parseServiceNowConfig(env);
    if (!config.enabled) return { enabled: false, configured: false, syncEnabled, errorCategory: "disabled" };
    return { enabled: true, configured: true, syncEnabled, hostname: new URL(config.instanceUrl).hostname, authMode: config.authMode };
  } catch {
    return {
      enabled: true,
      configured: false,
      syncEnabled,
      ...(instanceResult.success ? { hostname: new URL(instanceResult.data).hostname } : {}),
      ...(authResult.success ? { authMode: authResult.data } : {}),
      errorCategory: "configuration",
    };
  }
}
