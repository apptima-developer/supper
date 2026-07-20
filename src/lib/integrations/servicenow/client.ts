import type { IntegrationCorrelationId, IntegrationOperation } from "../contracts";
import type { SyncCursor } from "../sync/contracts";
import { isIntegrationBoundaryError } from "../errors";
import { z } from "zod";
import type { ServiceNowEnabledConfig } from "./config";
import { getServiceNowAuthorization } from "./auth";
import { mapServiceNowHttpError, serviceNowError } from "./errors";
import { serviceNowIncidentFieldList } from "./field-mapping";
import { serviceNowAdapterListQuerySchema, serviceNowDetailResponseSchema, serviceNowListResponseSchema, serviceNowSysIdSchema, type NormalizedServiceNowIncident } from "./schemas";
import { normalizeServiceNowIncident } from "./normalization";

export type ServiceNowListInput = { limit: number; offset: number; number?: string; updatedAfter?: string };
export type ServiceNowSyncPageInput = { limit: number; windowStart: string; windowEnd: string; cursor?: SyncCursor };

const serviceNowSyncPageSchema = z.object({
  limit: z.number().int().min(1).max(1_000),
  windowStart: z.string().datetime({ offset: true }),
  windowEnd: z.string().datetime({ offset: true }),
  cursor: z.object({
    updatedAt: z.string().datetime({ offset: true }),
    sysId: serviceNowSysIdSchema,
  }).optional(),
}).strict().superRefine((value, context) => {
  if (new Date(value.windowStart).getTime() > new Date(value.windowEnd).getTime()) {
    context.addIssue({ code: "custom", message: "Synchronization window is invalid", path: ["windowStart"] });
  }
  if (value.cursor && (new Date(value.cursor.updatedAt).getTime() < new Date(value.windowStart).getTime() || new Date(value.cursor.updatedAt).getTime() > new Date(value.windowEnd).getTime())) {
    context.addIssue({ code: "custom", message: "Synchronization cursor is outside its window", path: ["cursor"] });
  }
});

function serviceNowDate(value: string) {
  return new Date(value).toISOString().slice(0, 19).replace("T", " ");
}

export function buildServiceNowSyncEncodedQuery(input: Omit<ServiceNowSyncPageInput, "limit">) {
  const validated = serviceNowSyncPageSchema.parse({ ...input, limit: 1 });
  const start = serviceNowDate(validated.windowStart);
  const end = serviceNowDate(validated.windowEnd);
  if (!validated.cursor) {
    return `sys_updated_on>=${start}^sys_updated_on<=${end}^ORDERBYsys_updated_on^ORDERBYsys_id`;
  }
  const cursorAt = serviceNowDate(validated.cursor.updatedAt);
  const common = `sys_updated_on>=${start}^sys_updated_on<=${end}`;
  return `${common}^sys_updated_on>${cursorAt}^NQ${common}^sys_updated_on=${cursorAt}^sys_id>${validated.cursor.sysId}^ORDERBYsys_updated_on^ORDERBYsys_id`;
}

export class ServiceNowReadClient {
  constructor(
    private readonly config: ServiceNowEnabledConfig,
    private readonly dependencies: { fetch: typeof fetch; now?: () => number; maxPages?: number },
  ) {}

  private async request(path: string, params: URLSearchParams, operation: IntegrationOperation, correlationId: IntegrationCorrelationId, signal?: AbortSignal) {
    const authorization = await getServiceNowAuthorization(this.config, { correlationId, operation, signal }, this.dependencies);
    const url = new URL(`/api/now/table/${this.config.incidentTable}${path}`, this.config.instanceUrl);
    for (const [key, value] of params) url.searchParams.set(key, value);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) controller.abort(signal.reason);
    else signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, this.config.timeoutMs);
    try {
      if (signal?.aborted) throw serviceNowError({ category: "unavailable", code: "SERVICENOW_REQUEST_ABORTED", safeMessage: "ServiceNow request was cancelled", retryable: false, operation, correlationId });
      const response = await this.dependencies.fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: authorization, "X-Correlation-ID": correlationId },
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw mapServiceNowHttpError(response.status, operation, correlationId);
      try { return await response.json(); } catch (cause) {
        throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_MALFORMED_JSON", safeMessage: "ServiceNow returned malformed JSON", retryable: false, operation, correlationId, cause });
      }
    } catch (cause) {
      if (isIntegrationBoundaryError(cause)) throw cause;
      if (timedOut) throw serviceNowError({ category: "timeout", code: "SERVICENOW_TIMEOUT", safeMessage: "ServiceNow request timed out", retryable: true, operation, correlationId, cause });
      if (signal?.aborted) throw serviceNowError({ category: "unavailable", code: "SERVICENOW_REQUEST_ABORTED", safeMessage: "ServiceNow request was cancelled", retryable: false, operation, correlationId, cause });
      throw serviceNowError({ category: "unavailable", code: "SERVICENOW_NETWORK_UNAVAILABLE", safeMessage: "ServiceNow is unavailable", retryable: true, operation, correlationId, cause });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async listIncidents(input: ServiceNowListInput, correlationId: IntegrationCorrelationId, signal?: AbortSignal) {
    const validated = serviceNowAdapterListQuerySchema.parse(input);
    const records: NormalizedServiceNowIncident[] = [];
    const maxPages = this.dependencies.maxPages ?? 10;
    let pageCount = 0;
    while (records.length < validated.limit) {
      if (pageCount >= maxPages) throw serviceNowError({ category: "validation", code: "SERVICENOW_MAX_PAGES", safeMessage: "ServiceNow pagination exceeded the safe page limit", retryable: false, operation: "ticket.list", correlationId });
      const pageLimit = Math.min(this.config.pageSize, validated.limit - records.length);
      const query = [
        validated.number ? `number=${validated.number}` : "",
        validated.updatedAfter ? `sys_updated_on>=${serviceNowDate(validated.updatedAfter)}` : "",
      ].filter(Boolean).join("^");
      const params = new URLSearchParams({
        sysparm_fields: serviceNowIncidentFieldList,
        sysparm_limit: String(pageLimit),
        sysparm_offset: String(validated.offset + records.length),
        sysparm_display_value: "all",
      });
      if (query) params.set("sysparm_query", query);
      const raw = await this.request("", params, "ticket.list", correlationId, signal);
      const parsed = serviceNowListResponseSchema.safeParse(raw);
      if (!parsed.success) throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_UNEXPECTED_RESPONSE", safeMessage: "ServiceNow returned an unexpected Incident response", retryable: false, operation: "ticket.list", correlationId, cause: parsed.error });
      let page: NormalizedServiceNowIncident[];
      try {
        page = parsed.data.result.map((record) => normalizeServiceNowIncident(record, this.config));
      } catch (cause) {
        throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_INVALID_INCIDENT", safeMessage: "ServiceNow returned an invalid Incident record", retryable: false, operation: "ticket.list", correlationId, cause });
      }
      records.push(...page);
      pageCount += 1;
      if (page.length < pageLimit) break;
    }
    return { incidents: records.slice(0, validated.limit), pageCount };
  }

  async listIncidentRecordsPage(input: ServiceNowSyncPageInput, correlationId: IntegrationCorrelationId, signal?: AbortSignal) {
    const validated = serviceNowSyncPageSchema.parse(input);
    const params = new URLSearchParams({
      sysparm_fields: serviceNowIncidentFieldList,
      sysparm_limit: String(Math.min(validated.limit, this.config.pageSize)),
      sysparm_display_value: "all",
      sysparm_query: buildServiceNowSyncEncodedQuery(validated),
    });
    const raw = await this.request("", params, "ticket.list", correlationId, signal);
    const parsed = serviceNowListResponseSchema.safeParse(raw);
    if (!parsed.success) throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_UNEXPECTED_RESPONSE", safeMessage: "ServiceNow returned an unexpected Incident response", retryable: false, operation: "ticket.list", correlationId, cause: parsed.error });
    if (parsed.data.result.length > Math.min(validated.limit, this.config.pageSize)) throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_PAGE_LIMIT_EXCEEDED", safeMessage: "ServiceNow returned more Incident records than requested", retryable: false, operation: "ticket.list", correlationId });
    return parsed.data.result;
  }

  async testConnection(correlationId: IntegrationCorrelationId, signal?: AbortSignal) {
    const params = new URLSearchParams({ sysparm_fields: "sys_id", sysparm_limit: "1", sysparm_offset: "0", sysparm_display_value: "false" });
    const raw = await this.request("", params, "provider.test", correlationId, signal);
    const parsed = serviceNowListResponseSchema.safeParse(raw);
    if (!parsed.success) throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_UNEXPECTED_RESPONSE", safeMessage: "ServiceNow returned an unexpected connection response", retryable: false, operation: "provider.test", correlationId, cause: parsed.error });
    return parsed.data.result.length;
  }

  async getIncidentBySysId(sysId: string, correlationId: IntegrationCorrelationId, signal?: AbortSignal) {
    const validatedSysId = serviceNowSysIdSchema.parse(sysId);
    const params = new URLSearchParams({ sysparm_fields: serviceNowIncidentFieldList, sysparm_display_value: "all" });
    const raw = await this.request(`/${validatedSysId}`, params, "ticket.read", correlationId, signal);
    const parsed = serviceNowDetailResponseSchema.safeParse(raw);
    if (!parsed.success) throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_UNEXPECTED_RESPONSE", safeMessage: "ServiceNow returned an unexpected Incident response", retryable: false, operation: "ticket.read", correlationId, cause: parsed.error });
    try {
      return normalizeServiceNowIncident(parsed.data.result, this.config);
    } catch (cause) {
      throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_INVALID_INCIDENT", safeMessage: "ServiceNow returned an invalid Incident record", retryable: false, operation: "ticket.read", correlationId, cause });
    }
  }
}
