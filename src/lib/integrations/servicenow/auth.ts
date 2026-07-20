import type { IntegrationCorrelationId, IntegrationOperation } from "../contracts";
import { isIntegrationBoundaryError } from "../errors";
import type { ServiceNowEnabledConfig } from "./config";
import { serviceNowError } from "./errors";
import { serviceNowOAuthTokenSchema } from "./schemas";

type TokenEntry = { accessToken: string; expiresAt: number };
const oauthTokens = new Map<string, TokenEntry>();

export function clearServiceNowOAuthTokenCache() {
  oauthTokens.clear();
}

export function buildServiceNowBasicAuthorization(username: string, password: string) {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function oauthCacheKey(config: Extract<ServiceNowEnabledConfig, { authMode: "oauth_client_credentials" }>) {
  return `${config.instanceUrl}|${config.clientId}`;
}

export async function getServiceNowAuthorization(
  config: ServiceNowEnabledConfig,
  context: { correlationId: IntegrationCorrelationId; operation: IntegrationOperation; signal?: AbortSignal },
  dependencies: { fetch: typeof fetch; now?: () => number },
) {
  if (config.authMode === "basic") return buildServiceNowBasicAuthorization(config.username, config.password);

  const now = dependencies.now?.() ?? Date.now();
  const cacheKey = oauthCacheKey(config);
  const cached = oauthTokens.get(cacheKey);
  if (cached && cached.expiresAt - 30_000 > now) return `Bearer ${cached.accessToken}`;

  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(context.signal?.reason);
  if (context.signal?.aborted) controller.abort(context.signal.reason);
  else context.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutMs);
  try {
    if (context.signal?.aborted) throw serviceNowError({ category: "unavailable", code: "SERVICENOW_REQUEST_ABORTED", safeMessage: "ServiceNow request was cancelled", retryable: false, operation: context.operation, correlationId: context.correlationId });
    const response = await dependencies.fetch(`${config.instanceUrl}/oauth_token.do`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ grant_type: "client_credentials", client_id: config.clientId, client_secret: config.clientSecret }),
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) throw serviceNowError({
      category: response.status === 429 ? "rate_limit" : "authentication",
      code: response.status === 429 ? "SERVICENOW_OAUTH_RATE_LIMITED" : "SERVICENOW_OAUTH_FAILED",
      safeMessage: response.status === 429 ? "ServiceNow temporarily rate limited authentication" : "ServiceNow OAuth authentication failed",
      retryable: response.status === 429 || response.status >= 500,
      operation: context.operation,
      correlationId: context.correlationId,
    });
    let raw: unknown;
    try { raw = await response.json(); } catch (cause) {
      throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_OAUTH_MALFORMED", safeMessage: "ServiceNow returned an invalid OAuth response", retryable: false, operation: context.operation, correlationId: context.correlationId, cause });
    }
    const parsed = serviceNowOAuthTokenSchema.safeParse(raw);
    if (!parsed.success) throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_OAUTH_MALFORMED", safeMessage: "ServiceNow returned an invalid OAuth response", retryable: false, operation: context.operation, correlationId: context.correlationId, cause: parsed.error });
    oauthTokens.set(cacheKey, { accessToken: parsed.data.access_token, expiresAt: now + parsed.data.expires_in * 1_000 });
    return `Bearer ${parsed.data.access_token}`;
  } catch (cause) {
    if (isIntegrationBoundaryError(cause)) throw cause;
    if (timedOut) throw serviceNowError({ category: "timeout", code: "SERVICENOW_OAUTH_TIMEOUT", safeMessage: "ServiceNow authentication timed out", retryable: true, operation: context.operation, correlationId: context.correlationId, cause });
    if (context.signal?.aborted) throw serviceNowError({ category: "unavailable", code: "SERVICENOW_REQUEST_ABORTED", safeMessage: "ServiceNow request was cancelled", retryable: false, operation: context.operation, correlationId: context.correlationId, cause });
    throw serviceNowError({ category: "unavailable", code: "SERVICENOW_OAUTH_UNAVAILABLE", safeMessage: "ServiceNow authentication is unavailable", retryable: true, operation: context.operation, correlationId: context.correlationId, cause });
  } finally {
    clearTimeout(timer);
    context.signal?.removeEventListener("abort", onAbort);
  }
}
