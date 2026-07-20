import { z } from "zod";

const safeTableName = /^[a-z][a-z0-9_]{0,79}$/;
const boundedInteger = (minimum: number, maximum: number) => z.coerce.number().int().min(minimum).max(maximum);

function isLocalhost(hostname: string) {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";
}

const instanceUrlSchema = z.string().trim().url().transform((value, context) => {
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
  instanceUrl: instanceUrlSchema,
  timeoutMs: boundedInteger(1_000, 60_000),
  pageSize: boundedInteger(1, 100),
  incidentTable: z.string().trim().regex(safeTableName),
};

const enabledConfigSchema = z.discriminatedUnion("authMode", [
  z.object({ enabled: z.literal(true), authMode: z.literal("basic"), username: z.string().trim().min(1).max(255), password: z.string().min(1).max(2_048), ...common }).strict(),
  z.object({ enabled: z.literal(true), authMode: z.literal("oauth_client_credentials"), clientId: z.string().trim().min(1).max(512), clientSecret: z.string().min(1).max(2_048), ...common }).strict(),
]);

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
  if (env.SERVICENOW_ENABLED !== "true") return Object.freeze({ enabled: false });
  const authMode = env.SERVICENOW_AUTH_MODE || "basic";
  const commonInput = {
    enabled: true as const,
    authMode,
    instanceUrl: env.SERVICENOW_INSTANCE_URL,
    timeoutMs: env.SERVICENOW_TIMEOUT_MS || 15_000,
    pageSize: env.SERVICENOW_PAGE_SIZE || 100,
    incidentTable: env.SERVICENOW_INCIDENT_TABLE || "incident",
  };
  return enabledConfigSchema.parse(authMode === "basic"
    ? { ...commonInput, username: env.SERVICENOW_USERNAME, password: env.SERVICENOW_PASSWORD }
    : { ...commonInput, clientId: env.SERVICENOW_CLIENT_ID, clientSecret: env.SERVICENOW_CLIENT_SECRET });
}

export function summarizeServiceNowConfig(env: Record<string, string | undefined>): ServiceNowConfigSummary {
  const syncEnabled = env.SERVICENOW_SYNC_ENABLED === "true";
  if (env.SERVICENOW_ENABLED !== "true") return { enabled: false, configured: false, syncEnabled, errorCategory: "disabled" };
  try {
    const config = parseServiceNowConfig(env);
    if (!config.enabled) return { enabled: false, configured: false, syncEnabled, errorCategory: "disabled" };
    return { enabled: true, configured: true, syncEnabled, hostname: new URL(config.instanceUrl).hostname, authMode: config.authMode };
  } catch {
    let hostname: string | undefined;
    try { hostname = env.SERVICENOW_INSTANCE_URL ? new URL(env.SERVICENOW_INSTANCE_URL).hostname : undefined; } catch { hostname = undefined; }
    return { enabled: true, configured: false, syncEnabled, ...(hostname ? { hostname } : {}), errorCategory: "configuration" };
  }
}
