import type { IntegrationCorrelationId, IntegrationOperation } from "../../contracts";
import { isIntegrationBoundaryError } from "../../errors";
import { getServiceNowAuthorization } from "../auth";
import type { ServiceNowEnabledConfig } from "../config";
import { serviceNowError } from "../errors";
import { serviceNowSysIdWriteSchema } from "./schemas";
import { serviceNowWriteExecutionError } from "./outcomes";
import type {
  NormalizedServiceNowWriteCommand,
  ServiceNowSafeRequestSummary,
  ServiceNowWriteAdapterResult,
  ServiceNowWriteFailurePhase,
  ServiceNowWriteReadBackResult,
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
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumResponseBytes)) {
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
  if (!size) {
    throw serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_RESPONSE_EMPTY", safeMessage: "ServiceNow returned an empty response", retryable: false, operation, correlationId });
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
  readPhase: Extract<ServiceNowWriteFailurePhase, "number_lookup" | "read_back">;
};

export class ServiceNowWriteAdapter {
  constructor(
    private readonly config: ServiceNowEnabledConfig,
    private readonly dependencies: { fetch: typeof fetch; now?: () => number } = { fetch },
  ) {}

  private async request(input: RequestInput) {
    const mutation = input.method === "POST" || input.method === "PATCH";
    let authorization: string;
    try {
      authorization = await getServiceNowAuthorization(this.config, {
        correlationId: input.correlationId,
        operation: input.operation,
        signal: input.signal,
      }, this.dependencies);
    } catch (error) {
      if (!isIntegrationBoundaryError(error)) throw error;
      throw serviceNowWriteExecutionError(error, {
        deliveryDisposition: error.retryable ? "safe_to_retry" : "definitely_rejected",
        failurePhase: "authorization",
        retryAllowed: error.retryable,
      });
    }

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
    let dispatchStarted = false;
    try {
      if (input.signal?.aborted) {
        const error = serviceNowError({ category: "unavailable", code: "SERVICENOW_WRITE_ABORTED", safeMessage: "ServiceNow request was cancelled before dispatch", retryable: false, operation: input.operation, correlationId: input.correlationId });
        throw serviceNowWriteExecutionError(error, {
          deliveryDisposition: "definitely_not_sent",
          failurePhase: mutation ? "mutation_dispatch" : input.readPhase,
          retryAllowed: false,
        });
      }
      dispatchStarted = true;
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
      if (!response.ok) {
        const error = writeHttpError(response.status, input.operation, input.correlationId);
        const uncertain = mutation && (response.status >= 500 || response.status === 408);
        throw serviceNowWriteExecutionError(error, {
          deliveryDisposition: uncertain
            ? "may_have_committed"
            : error.retryable
              ? "safe_to_retry"
              : "definitely_rejected",
          failurePhase: mutation ? "mutation_response" : input.readPhase,
          retryAllowed: !uncertain && error.retryable,
          ...(uncertain ? { reconciliationReason: "Provider returned an ambiguous mutation response" } : {}),
        });
      }
      let raw: unknown;
      try {
        raw = await readBoundedJson(response, input.operation, input.correlationId);
      } catch (error) {
        if (!isIntegrationBoundaryError(error)) throw error;
        throw serviceNowWriteExecutionError(error, {
          deliveryDisposition: mutation ? "may_have_committed" : "safe_to_retry",
          failurePhase: mutation ? "response_parse" : input.readPhase,
          retryAllowed: !mutation,
          ...(mutation ? { reconciliationReason: "Provider accepted the mutation but returned an invalid response" } : {}),
        });
      }
      return { status: response.status, raw };
    } catch (cause) {
      if (isIntegrationBoundaryError(cause)) throw cause;
      const error = timedOut
        ? serviceNowError({ category: "timeout", code: "SERVICENOW_WRITE_TIMEOUT", safeMessage: "ServiceNow request timed out", retryable: true, operation: input.operation, correlationId: input.correlationId, cause })
        : input.signal?.aborted
          ? serviceNowError({ category: "unavailable", code: "SERVICENOW_WRITE_ABORTED", safeMessage: "ServiceNow request was cancelled", retryable: false, operation: input.operation, correlationId: input.correlationId, cause })
          : serviceNowError({ category: "unavailable", code: "SERVICENOW_WRITE_NETWORK_UNAVAILABLE", safeMessage: "ServiceNow is unavailable", retryable: true, operation: input.operation, correlationId: input.correlationId, cause });
      const uncertain = mutation && dispatchStarted;
      throw serviceNowWriteExecutionError(error, {
        deliveryDisposition: uncertain ? "may_have_committed" : "safe_to_retry",
        failurePhase: mutation ? "mutation_dispatch" : input.readPhase,
        retryAllowed: !uncertain && error.retryable,
        ...(uncertain ? { reconciliationReason: "Mutation dispatch ended without a definitive provider response" } : {}),
      });
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

  private async queryRows(
    query: string,
    fields: string[],
    operation: IntegrationOperation,
    correlationId: IntegrationCorrelationId,
    readPhase: "number_lookup" | "read_back",
    signal?: AbortSignal,
  ) {
    const response = await this.request({
      method: "GET",
      path: `/api/now/table/${this.config.incidentTable}`,
      params: new URLSearchParams({
        sysparm_query: query,
        sysparm_fields: fields.join(","),
        sysparm_limit: "2",
        sysparm_exclude_reference_link: "true",
      }),
      operation,
      correlationId,
      signal,
      readPhase,
    });
    const rows = response.raw && typeof response.raw === "object" && !Array.isArray(response.raw)
      ? (response.raw as Record<string, unknown>).result
      : undefined;
    if (!Array.isArray(rows)) {
      const error = serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_LOOKUP_INVALID", safeMessage: "ServiceNow returned an invalid lookup response", retryable: true, operation, correlationId });
      throw serviceNowWriteExecutionError(error, {
        deliveryDisposition: "safe_to_retry",
        failurePhase: readPhase,
        retryAllowed: true,
      });
    }
    return { status: response.status, rows };
  }

  private safeRowIdentity(
    row: unknown,
    operation: IntegrationOperation,
    correlationId: IntegrationCorrelationId,
    failurePhase: "number_lookup" | "read_back" = "read_back",
    expected: {
      sysId?: string;
      number?: string;
      correlationMarker?: string;
    } = {},
  ) {
    if (!row || typeof row !== "object" || Array.isArray(row)) {
      throw serviceNowWriteExecutionError(
        serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_LOOKUP_INVALID", safeMessage: "ServiceNow returned an invalid Incident identity", retryable: true, operation, correlationId }),
        { deliveryDisposition: "safe_to_retry", failurePhase, retryAllowed: true },
      );
    }
    const source = row as Record<string, unknown>;
    const sysId = typeof source.sys_id === "string" ? source.sys_id.trim().toLowerCase() : "";
    const number = typeof source.number === "string" ? source.number.trim() : "";
    if (!serviceNowSysIdWriteSchema.safeParse(sysId).success || !/^[A-Za-z0-9_-]{1,80}$/.test(number)) {
      throw serviceNowWriteExecutionError(
        serviceNowError({ category: "malformed_response", code: "SERVICENOW_WRITE_LOOKUP_INVALID", safeMessage: "ServiceNow returned an invalid Incident identity", retryable: true, operation, correlationId }),
        { deliveryDisposition: "safe_to_retry", failurePhase, retryAllowed: true },
      );
    }
    const correlationMarker = typeof source.correlation_id === "string"
      ? source.correlation_id.trim()
      : "";
    if ((expected.sysId && sysId !== expected.sysId)
      || (expected.number && number !== expected.number)
      || (expected.correlationMarker && correlationMarker !== expected.correlationMarker)) {
      throw serviceNowWriteExecutionError(
        serviceNowError({
          category: "conflict",
          code: "SERVICENOW_WRITE_LOOKUP_MISMATCH",
          safeMessage: "ServiceNow returned an Incident that did not match the exact lookup key",
          retryable: false,
          operation,
          correlationId,
        }),
        { deliveryDisposition: "definitely_not_sent", failurePhase, retryAllowed: false },
      );
    }
    return { sysId, number, correlationMarker, row: source };
  }

  private async resolveNumber(number: string, operation: IntegrationOperation, correlationId: IntegrationCorrelationId, signal?: AbortSignal) {
    const { rows } = await this.queryRows(`number=${number}`, ["sys_id", "number"], operation, correlationId, "number_lookup", signal);
    if (rows.length !== 1) {
      const error = serviceNowError({
        category: rows.length > 1 ? "conflict" : "validation",
        code: rows.length > 1 ? "SERVICENOW_WRITE_NUMBER_AMBIGUOUS" : "SERVICENOW_WRITE_TARGET_NOT_FOUND",
        safeMessage: rows.length > 1 ? "The ServiceNow Incident number is ambiguous" : "The ServiceNow Incident was not found",
        retryable: false,
        operation,
        correlationId,
      });
      throw serviceNowWriteExecutionError(error, {
        deliveryDisposition: "definitely_not_sent",
        failurePhase: "number_lookup",
        retryAllowed: false,
      });
    }
    return this.safeRowIdentity(
      rows[0],
      operation,
      correlationId,
      "number_lookup",
      { number },
    );
  }

  private async findByCorrelationMarker(
    marker: string,
    operation: IntegrationOperation,
    correlationId: IntegrationCorrelationId,
    signal?: AbortSignal,
  ) {
    const { status, rows } = await this.queryRows(
      `correlation_id=${marker}`,
      ["sys_id", "number", "state", "correlation_id"],
      operation,
      correlationId,
      "read_back",
      signal,
    );
    return {
      status,
      rows: rows.map((row) => this.safeRowIdentity(
        row,
        operation,
        correlationId,
        "read_back",
        { correlationMarker: marker },
      )),
    };
  }

  async execute(
    command: NormalizedServiceNowWriteCommand,
    correlationId: IntegrationCorrelationId,
    signal?: AbortSignal,
  ): Promise<ServiceNowWriteAdapterResult> {
    const operation = operationFor(command);
    if (command.commandType === "create_incident") {
      const markerLookup = await this.findByCorrelationMarker(
        command.providerCorrelationMarker || "",
        operation,
        correlationId,
        signal,
      );
      if (markerLookup.rows.length > 1) {
        const error = serviceNowError({ category: "conflict", code: "SERVICENOW_WRITE_CORRELATION_AMBIGUOUS", safeMessage: "Multiple ServiceNow Incidents share the command correlation marker", retryable: false, operation, correlationId });
        throw serviceNowWriteExecutionError(error, {
          deliveryDisposition: "may_have_committed",
          failurePhase: "read_back",
          retryAllowed: false,
          reconciliationReason: "Correlation marker matched multiple Incidents",
        });
      }
      if (markerLookup.rows.length === 1) {
        const existing = markerLookup.rows[0];
        return {
          requestSummary: {
            method: "GET",
            endpointPath: `/api/now/table/${this.config.incidentTable}`,
            targetTable: this.config.incidentTable,
            fieldNames: ["correlation_id", "number", "state", "sys_id"],
            targetSysId: existing.sysId,
            targetNumber: existing.number,
          },
          responseSummary: {
            httpStatus: markerLookup.status,
            sysId: existing.sysId,
            number: existing.number,
            state: typeof existing.row.state === "string" ? existing.row.state : undefined,
            recoveredByCorrelationMarker: true,
          },
          targetSysId: existing.sysId,
          targetNumber: existing.number,
        };
      }
    }

    const targetSysId = command.commandType === "create_incident"
      ? undefined
      : command.targetSysId || (await this.resolveNumber(
        command.targetNumber || "",
        operation,
        correlationId,
        signal,
      )).sysId;
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
      readPhase: "read_back",
    });
    let result: ReturnType<typeof safeResult>;
    try {
      result = safeResult(response.raw, operation, correlationId);
    } catch (error) {
      if (!isIntegrationBoundaryError(error)) throw error;
      throw serviceNowWriteExecutionError(error, {
        deliveryDisposition: "may_have_committed",
        failurePhase: "response_parse",
        retryAllowed: false,
        reconciliationReason: "Provider returned an invalid Incident identity after mutation",
      });
    }
    if ((targetSysId && result.sysId !== targetSysId)
      || (command.targetNumber && result.number !== command.targetNumber)) {
      throw serviceNowWriteExecutionError(
        serviceNowError({
          category: "conflict",
          code: "SERVICENOW_WRITE_LOOKUP_MISMATCH",
          safeMessage: "ServiceNow returned an Incident that did not match the exact command target",
          retryable: false,
          operation,
          correlationId,
        }),
        {
          deliveryDisposition: "may_have_committed",
          failurePhase: "response_parse",
          retryAllowed: false,
          reconciliationReason: "Provider mutation response returned a conflicting Incident identity",
        },
      );
    }
    let postWriteLookupHttpStatus: number | undefined;
    if (command.commandType === "create_incident") {
      try {
        const marker = command.providerCorrelationMarker || "";
        const verified = await this.findByCorrelationMarker(
          marker,
          operation,
          correlationId,
          signal,
        );
        if (verified.rows.length !== 1) {
          throw serviceNowError({
            category: "conflict",
            code: verified.rows.length > 1
              ? "SERVICENOW_WRITE_CORRELATION_AMBIGUOUS"
              : "SERVICENOW_WRITE_POST_CREATE_NOT_FOUND",
            safeMessage: verified.rows.length > 1
              ? "Multiple ServiceNow Incidents share the command correlation marker"
              : "ServiceNow did not return the created Incident by its exact correlation marker",
            retryable: false,
            operation,
            correlationId,
          });
        }
        const exact = verified.rows[0];
        if (exact.sysId !== result.sysId || exact.number !== result.number) {
          throw serviceNowError({
            category: "conflict",
            code: "SERVICENOW_WRITE_LOOKUP_MISMATCH",
            safeMessage: "ServiceNow post-create verification returned a conflicting Incident identity",
            retryable: false,
            operation,
            correlationId,
          });
        }
        postWriteLookupHttpStatus = verified.status;
      } catch (error) {
        const cause = isIntegrationBoundaryError(error)
          ? error
          : serviceNowError({
            category: "internal",
            code: "SERVICENOW_WRITE_POST_CREATE_VERIFICATION_FAILED",
            safeMessage: "ServiceNow could not verify the created Incident",
            retryable: false,
            operation,
            correlationId,
            cause: error,
          });
        throw serviceNowWriteExecutionError(
          serviceNowError({
            category: cause.category,
            code: cause.code,
            safeMessage: cause.safeMessage,
            retryable: false,
            operation,
            correlationId,
            cause,
          }),
          {
            deliveryDisposition: "may_have_committed",
            failurePhase: "read_back",
            retryAllowed: false,
            reconciliationReason: "Post-create correlation-marker verification was not exact",
          },
        );
      }
    }
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
        ...(command.commandType === "create_incident" ? {
          postWriteMarkerVerified: true,
          postWriteLookupHttpStatus,
        } : {}),
      },
      targetSysId: result.sysId,
      targetNumber: result.number,
    };
  }

  async readBack(
    command: NormalizedServiceNowWriteCommand,
    correlationId: IntegrationCorrelationId,
    signal?: AbortSignal,
  ): Promise<ServiceNowWriteReadBackResult> {
    const operation = operationFor(command);
    if (command.commandType === "create_incident") {
      const lookup = await this.findByCorrelationMarker(
        command.providerCorrelationMarker || "",
        operation,
        correlationId,
        signal,
      );
      if (lookup.rows.length > 1) return { result: "ambiguous", summary: { matchCount: 2, method: "correlation_marker" } };
      if (!lookup.rows.length) return { result: "not_found", summary: { matchCount: 0, method: "correlation_marker" } };
      const row = lookup.rows[0];
      return {
        result: "confirmed_succeeded",
        summary: { matchCount: 1, method: "correlation_marker" },
        targetSysId: row.sysId,
        targetNumber: row.number,
      };
    }

    if (command.commandType === "add_comment" || command.commandType === "add_work_note") {
      if (command.targetNumber) {
        let identity;
        try {
          identity = await this.resolveNumber(command.targetNumber, operation, correlationId, signal);
        } catch (error) {
          if (isIntegrationBoundaryError(error) && error.code === "SERVICENOW_WRITE_TARGET_NOT_FOUND") {
            return { result: "not_found", summary: { method: "exact_number", matchCount: 0 } };
          }
          throw error;
        }
        return {
          result: "inconclusive",
          summary: {
            method: "journal_manual_verification",
            journalField: command.commandType === "add_comment" ? "comments" : "work_notes",
            targetIdentityResolved: true,
          },
          targetSysId: identity.sysId,
          targetNumber: identity.number,
        };
      }
      const journalTargetSysId = serviceNowSysIdWriteSchema.parse(command.targetSysId);
      let response;
      try {
        response = await this.request({
          method: "GET",
          path: `/api/now/table/${this.config.incidentTable}/${journalTargetSysId}`,
          params: new URLSearchParams({
            sysparm_fields: "sys_id,number",
            sysparm_exclude_reference_link: "true",
          }),
          operation,
          correlationId,
          signal,
          readPhase: "read_back",
        });
      } catch (error) {
        if (isIntegrationBoundaryError(error) && error.code === "SERVICENOW_WRITE_TARGET_NOT_FOUND") {
          return { result: "not_found", summary: { method: "exact_sys_id", matchCount: 0 } };
        }
        throw error;
      }
      const result = response.raw && typeof response.raw === "object" && !Array.isArray(response.raw)
        ? (response.raw as Record<string, unknown>).result
        : undefined;
      const identity = this.safeRowIdentity(
        result,
        operation,
        correlationId,
        "read_back",
        { sysId: journalTargetSysId },
      );
      return {
        result: "inconclusive",
        summary: {
          method: "journal_manual_verification",
          journalField: command.commandType === "add_comment" ? "comments" : "work_notes",
          targetIdentityResolved: true,
        },
        targetSysId: identity.sysId,
        targetNumber: identity.number,
      };
    }

    let resolvedNumberIdentity;
    if (!command.targetSysId) {
      try {
        resolvedNumberIdentity = await this.resolveNumber(
          command.targetNumber || "",
          operation,
          correlationId,
          signal,
        );
      } catch (error) {
        if (isIntegrationBoundaryError(error) && error.code === "SERVICENOW_WRITE_TARGET_NOT_FOUND") {
          return { result: "not_found", summary: { method: "exact_number", matchCount: 0 } };
        }
        throw error;
      }
    }
    const sysId = command.targetSysId || resolvedNumberIdentity!.sysId;
    let response;
    try {
      response = await this.request({
        method: "GET",
        path: `/api/now/table/${this.config.incidentTable}/${sysId}`,
        params: new URLSearchParams({
          sysparm_fields: ["sys_id", "number", ...Object.keys(command.fields)].join(","),
          sysparm_exclude_reference_link: "true",
        }),
        operation,
        correlationId,
        signal,
        readPhase: "read_back",
      });
    } catch (error) {
      if (isIntegrationBoundaryError(error) && error.code === "SERVICENOW_WRITE_TARGET_NOT_FOUND") {
        return { result: "not_found", summary: { method: "exact_sys_id", matchCount: 0 } };
      }
      throw error;
    }
    const result = response.raw && typeof response.raw === "object" && !Array.isArray(response.raw)
      ? (response.raw as Record<string, unknown>).result
      : undefined;
    if (!result || typeof result !== "object" || Array.isArray(result)) {
      return { result: "not_found", summary: { method: "exact_sys_id", matchedFields: 0, expectedFields: Object.keys(command.fields).length } };
    }
    const row = this.safeRowIdentity(
      result,
      operation,
      correlationId,
      "read_back",
      {
        sysId,
        number: command.targetNumber || resolvedNumberIdentity?.number,
      },
    );
    const expected = Object.entries(command.fields);
    const matchedFields = expected.filter(([field, value]) => String(row.row[field] ?? "") === value).length;
    return {
      result: matchedFields === expected.length ? "confirmed_succeeded" : "inconclusive",
      summary: { method: "exact_sys_id", matchedFields, expectedFields: expected.length },
      targetSysId: row.sysId,
      targetNumber: row.number,
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
      readPhase: "read_back",
    });
    return { connected: true, httpStatus: response.status };
  }
}
