import type { IntegrationCorrelationId, IntegrationOperation } from "../../contracts";
import { isIntegrationBoundaryError } from "../../errors";
import { getServiceNowAuthorization } from "../auth";
import type { ServiceNowEnabledConfig } from "../config";
import { serviceNowError } from "../errors";
import type {
  NormalizedServiceNowWriteCommand,
  ServiceNowSafeRequestSummary,
  ServiceNowWriteAdapterResult,
} from "./types";

const maximumResponseBytes = 64 * 1024;

function operationFor(command: NormalizedServiceNowWriteCommand): IntegrationOperation {
  if (command.commandType === "create_incident") return "ticket.create";
  if (command.commandType === "update_incident") return "ticket.update";
  if (command.commandType === "add_comment") return "ticket.comment";
  return "ticket.work_note";
}

function writeHttpError(status: number, operation: IntegrationOperation, correlationId: IntegrationCorrelationId) {
  if (status === 400) return serviceNowError({ category: "validation", code: "SERVICENOW_WRITE_REJECTED", safeMessage: "ServiceNow rejected the write request", retryable: false, operation, correlationId });
  if (status === 401) return serviceNowError({ category: "authentication", code: "SERVICENOW_AUTHENTICATION_FAILED", safeMessage: "ServiceNow authentication failed", retryable: false, operation, correlationId });
  if (status === 403) return serviceNowError({ category: "authorization", code: "SERVICENOW_WRITE_ACCESS_DENIED", safeMessage: "ServiceNow denied the write request", retryable: false, operation, correlationId });
  if (status === 404) return serviceNowError({ category: "validation", code: "SERVICENOW_WRITE_TARGET_NOT_FOUND", safeMessage: "The ServiceNow Incident was not found", retryable: false, operation, correlationId });
  if (status === 409) return serviceNowError({ category: "conflict", code: "SERVICENOW_WRITE_CONFLICT", safeMessage: "ServiceNow reported a write conflict", retryable: true, operation, correlationId });
  if (status === 429) return serviceNowError({ category: "rate_limit", code: "SERVICENOW_WRITE_RATE_LIMITED", safeMessage: "ServiceNow temporarily rate limited the write request", retryable: true, operation, correlationId });
  return serviceNowError({
    category: status >= 500 ? "unavailable" : "internal",
    code: status >= 500 ? "SERVICENOW_WRITE_UNAVAILABLE" : "SERVICENOW_WRITE_FAILED",
    safeMessage: status >= 500 ? "ServiceNow is temporarily unavailable" : "ServiceNow could not complete the write request",
    retryable: status >= 500,
    operation,
    correlationId,
  });
}

async function readBoundedJson(response: Response, operation: IntegrationOperation, correlationId: IntegrationCorrelationId) {
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > maximumResponseBytes) {
    throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_RESPONSE_TOO_LARGE", safeMessage: "ServiceNow returned an oversized response", retryable: false, operation, correlationId });
  }
  if (!response.body) {
    throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_RESPONSE_EMPTY", safeMessage: "ServiceNow returned an empty response", retryable: false, operation, correlationId });
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maximumResponseBytes) {
      await reader.cancel();
      throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_RESPONSE_TOO_LARGE", safeMessage: "ServiceNow returned an oversized response", retryable: false, operation, correlationId });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (cause) {
    throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_RESPONSE_INVALID", safeMessage: "ServiceNow returned an invalid response", retryable: false, operation, correlationId, cause });
  }
}

function safeResult(raw: unknown, operation: IntegrationOperation, correlationId: IntegrationCorrelationId) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_RESPONSE_INVALID", safeMessage: "ServiceNow returned an invalid response", retryable: false, operation, correlationId });
  }
  const result = (raw as Record<string, unknown>).result;
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_RESPONSE_INVALID", safeMessage: "ServiceNow returned an invalid response", retryable: false, operation, correlationId });
  }
  const row = result as Record<string, unknown>;
  const sysId = typeof row.sys_id === "string" ? row.sys_id.trim().toLowerCase() : "";
  const number = typeof row.number === "string" ? row.number.trim() : "";
  const state = typeof row.state === "string" ? row.state.trim() : undefined;
  if (!/^[a-f0-9]{32}$/.test(sysId) || !/^[A-Za-z0-9_-]{1,80}$/.test(number)) {
    throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_RESPONSE_INVALID", safeMessage: "ServiceNow returned an invalid Incident identity", retryable: false, operation, correlationId });
  }
  return { sysId, number, state };
}

type RequestInput = {
  method: "GET" | "POST" | "PATCH";
  path: string;
  params?: URLSearchParams;
  body?: Record<string, string>;
  operation: IntegrationOperation;
  correlationId: IntegrationCorrelationId;
  signal?: AbortSignal;
};

export class ServiceNowWriteAdapter {
  constructor(
    private readonly config: ServiceNowEnabledConfig,
    private readonly dependencies: { fetch: typeof fetch; now?: () => number } = { fetch },
  ) {}

  private async request(input: RequestInput) {
    const authorization = await getServiceNowAuthorization(this.config, {
      correlationId: input.correlationId,
      operation: input.operation,
      signal: input.signal,
    }, this.dependencies);
    const url = new URL(input.path, this.config.instanceUrl);
    for (const [key, value] of input.params || []) url.searchParams.set(key, value);
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(input.signal?.reason);
    if (input.signal?.aborted) controller.abort(input.signal.reason);
    else input.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.config.timeoutMs);
    try {
      if (input.signal?.aborted) throw serviceNowError({ category: "unavailable", code: "SERVICENOW_WRITE_ABORTED", safeMessage: "ServiceNow write was cancelled", retryable: false, operation: input.operation, correlationId: input.correlationId });
      const response = await this.dependencies.fetch(url, {
        method: input.method,
        headers: {
          Accept: "application/json",
          Authorization: authorization,
          "Content-Type": "application/json",
          "X-Correlation-ID": input.correlationId,
        },
        ...(input.body ? { body: JSON.stringify(input.body) } : {}),
        signal: controller.signal,
        cache: "no-store",
        redirect: "error",
      });
      if (!response.ok) throw writeHttpError(response.status, input.operation, input.correlationId);
      return { status: response.status, raw: await readBoundedJson(response, input.operation, input.correlationId) };
    } catch (cause) {
      if (isIntegrationBoundaryError(cause)) throw cause;
      if (timedOut) throw serviceNowError({ category: "timeout", code: "SERVICENOW_WRITE_TIMEOUT", safeMessage: "ServiceNow write timed out", retryable: true, operation: input.operation, correlationId: input.correlationId, cause });
      if (input.signal?.aborted) throw serviceNowError({ category: "unavailable", code: "SERVICENOW_WRITE_ABORTED", safeMessage: "ServiceNow write was cancelled", retryable: false, operation: input.operation, correlationId: input.correlationId, cause });
      throw serviceNowError({ category: "unavailable", code: "SERVICENOW_WRITE_NETWORK_UNAVAILABLE", safeMessage: "ServiceNow is unavailable", retryable: true, operation: input.operation, correlationId: input.correlationId, cause });
    } finally {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", onAbort);
    }
  }

  preview(command: NormalizedServiceNowWriteCommand): ServiceNowSafeRequestSummary {
    const target = command.commandType === "create_incident"
      ? ""
      : command.targetSysId || "{resolved-sys-id}";
    return {
      method: command.commandType === "create_incident" ? "POST" : "PATCH",
      endpointPath: `/api/now/table/${this.config.incidentTable}${target ? `/${target}` : ""}`,
      targetTable: this.config.incidentTable,
      fieldNames: Object.keys(command.fields).sort(),
      targetSysId: command.targetSysId,
      targetNumber: command.targetNumber,
    };
  }

  private async resolveNumber(number: string, operation: IntegrationOperation, correlationId: IntegrationCorrelationId, signal?: AbortSignal) {
    const params = new URLSearchParams({
      sysparm_query: `number=${number}`,
      sysparm_fields: "sys_id,number",
      sysparm_limit: "2",
      sysparm_exclude_reference_link: "true",
    });
    const response = await this.request({
      method: "GET",
      path: `/api/now/table/${this.config.incidentTable}`,
      params,
      operation,
      correlationId,
      signal,
    });
    if (!response.raw || typeof response.raw !== "object" || Array.isArray(response.raw)) {
      throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_LOOKUP_INVALID", safeMessage: "ServiceNow returned an invalid lookup response", retryable: false, operation, correlationId });
    }
    const rows = (response.raw as Record<string, unknown>).result;
    if (!Array.isArray(rows) || rows.length !== 1) {
      throw serviceNowError({
        category: rows && Array.isArray(rows) && rows.length > 1 ? "conflict" : "validation",
        code: rows && Array.isArray(rows) && rows.length > 1 ? "SERVICENOW_WRITE_NUMBER_AMBIGUOUS" : "SERVICENOW_WRITE_TARGET_NOT_FOUND",
        safeMessage: rows && Array.isArray(rows) && rows.length > 1 ? "The ServiceNow Incident number is ambiguous" : "The ServiceNow Incident was not found",
        retryable: false,
        operation,
        correlationId,
      });
    }
    const row = rows[0];
    const sysId = row && typeof row === "object" && !Array.isArray(row) && typeof (row as Record<string, unknown>).sys_id === "string"
      ? ((row as Record<string, unknown>).sys_id as string).trim().toLowerCase()
      : "";
    if (!/^[a-f0-9]{32}$/.test(sysId)) {
      throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_LOOKUP_INVALID", safeMessage: "ServiceNow returned an invalid Incident identity", retryable: false, operation, correlationId });
    }
    return sysId;
  }

  async execute(command: NormalizedServiceNowWriteCommand, correlationId: IntegrationCorrelationId, signal?: AbortSignal): Promise<ServiceNowWriteAdapterResult> {
    const operation = operationFor(command);
    const targetSysId = command.commandType === "create_incident"
      ? undefined
      : command.targetSysId || await this.resolveNumber(command.targetNumber || "", operation, correlationId, signal);
    const path = `/api/now/table/${this.config.incidentTable}${targetSysId ? `/${targetSysId}` : ""}`;
    const response = await this.request({
      method: command.commandType === "create_incident" ? "POST" : "PATCH",
      path,
      params: new URLSearchParams({
        sysparm_fields: "sys_id,number,state",
        sysparm_exclude_reference_link: "true",
      }),
      body: command.fields,
      operation,
      correlationId,
      signal,
    });
    const result = safeResult(response.raw, operation, correlationId);
    return {
      requestSummary: {
        method: command.commandType === "create_incident" ? "POST" : "PATCH",
        endpointPath: path,
        targetTable: this.config.incidentTable,
        fieldNames: Object.keys(command.fields).sort(),
        targetSysId: targetSysId || result.sysId,
        targetNumber: command.targetNumber || result.number,
      },
      responseSummary: {
        httpStatus: response.status,
        sysId: result.sysId,
        number: result.number,
        state: result.state,
      },
      targetSysId: result.sysId,
      targetNumber: result.number,
    };
  }

  async testReadiness(correlationId: IntegrationCorrelationId, signal?: AbortSignal) {
    const response = await this.request({
      method: "GET",
      path: `/api/now/table/${this.config.incidentTable}`,
      params: new URLSearchParams({
        sysparm_fields: "sys_id,number",
        sysparm_limit: "1",
        sysparm_exclude_reference_link: "true",
      }),
      operation: "provider.test",
      correlationId,
      signal,
    });
    return { connected: true, httpStatus: response.status };
  }
}
