import "server-only";
import type { Session } from "../../../auth";
import { writeAudit } from "../../../repositories";
import { HttpError } from "../../../request-security";
import { logServerCritical } from "../../../server-logging";
import { getServiceNowConfigSummary } from "../runtime";
import { serviceNowUnknownCustomerKey } from "../customer-identity";
import { parseServiceNowSyncConfig } from "../sync/config";
import { ServiceNowOperationsRepository } from "./repository";
import type { ServiceNowMappingResult, ServiceNowOperationsSummary } from "./types";

type AuditWriter = typeof writeAudit;

function rowText(row: Record<string, unknown> | null, key: string) {
  return row && typeof row[key] === "string" ? row[key] as string : undefined;
}

function operationalError(error: unknown): never {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("SERVICENOW_UNKNOWN_CUSTOMER_NOT_MAPPABLE")) throw new HttpError(409, "SERVICENOW_UNKNOWN_CUSTOMER_NOT_MAPPABLE", "The ServiceNow company must be corrected before it can be mapped");
  if (message.includes("TARGET_CUSTOMER_NOT_FOUND")) throw new HttpError(404, "TARGET_CUSTOMER_NOT_FOUND", "Target customer was not found");
  if (message.includes("TARGET_CUSTOMER_INACTIVE")) throw new HttpError(409, "TARGET_CUSTOMER_INACTIVE", "Target customer is inactive");
  if (message.includes("CUSTOMER_MAPPING_NOT_FOUND")) throw new HttpError(404, "CUSTOMER_MAPPING_NOT_FOUND", "Customer mapping was not found");
  throw error;
}

async function auditMappingBestEffort(
  result: ServiceNowMappingResult,
  input: { session: Session; externalCustomerKey: string; requestId: string; previousCustomerKey?: string },
  audit: AuditWriter,
) {
  if (result.action === "unchanged") return result;
  try {
    await audit({
      action: result.action === "created" ? "create" : "update",
      entity: "integration-customer-mapping",
      entityId: result.mappingId,
      actor: input.session.username,
      details: {
        provider: "servicenow",
        externalCustomerKey: input.externalCustomerKey,
        action: result.action,
        previousCustomerKey: result.previousCustomerKey || input.previousCustomerKey || null,
        customerKey: result.customerKey,
        affectedTicketCount: result.affectedTicketCount,
      },
    });
    return result;
  } catch (error) {
    logServerCritical("SERVICENOW_CUSTOMER_MAPPING_SUCCEEDED_AUDIT_FAILED", error, {
      requestId: input.requestId,
      operation: "servicenow.customer-mapping.audit",
      mappingId: result.mappingId,
      action: result.action,
    });
    return { ...result, auditWarning: "secondary_audit_write_failed" as const };
  }
}

export async function getServiceNowOperationsSummary(
  repository = new ServiceNowOperationsRepository(),
  now = new Date(),
): Promise<ServiceNowOperationsSummary> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const [status, recent, mappings, unmapped] = await Promise.all([
    repository.readStateAndLatestRun(),
    repository.countRecentRuns(since),
    repository.countMappings(),
    repository.listMappingCandidates({ page: 1, limit: 100, status: "unmapped", search: "" }),
  ]);
  const state = status.state;
  const lockedUntil = rowText(state, "locked_until");
  let syncEnabled = false;
  try { syncEnabled = parseServiceNowSyncConfig(process.env).enabled; } catch { syncEnabled = false; }
  return {
    config: getServiceNowConfigSummary(),
    syncEnabled,
    syncRunning: Boolean(rowText(state, "lock_token") && lockedUntil && new Date(lockedUntil).getTime() > now.getTime()),
    currentWatermark: rowText(state, "watermark_at"), currentWatermarkSysId: rowText(state, "watermark_sys_id"),
    lastAttempt: rowText(state, "last_attempt_at"), lastSuccess: rowText(state, "last_successful_sync_at"),
    latestRun: status.latestRun,
    runsLast24Hours: recent.all, failedOrPartialRunsLast24Hours: recent.failedOrPartial,
    unmappedCustomerSourceCount: unmapped.total,
    unmappedTicketCount: unmapped.matchingTicketCount,
    mappingCandidatesTruncated: unmapped.truncated,
    activeMappingCount: mappings.active, inactiveMappingCount: mappings.inactive,
  };
}

export async function applyServiceNowCustomerMapping(
  input: { externalCustomerKey: string; customerKey: string; session: Session; requestId: string; correlationId: string },
  dependencies: { repository?: ServiceNowOperationsRepository; audit?: AuditWriter; now?: () => Date; createId?: () => string } = {},
) {
  if (input.externalCustomerKey === serviceNowUnknownCustomerKey) {
    throw new HttpError(409, "SERVICENOW_UNKNOWN_CUSTOMER_NOT_MAPPABLE", "The ServiceNow company must be corrected before it can be mapped");
  }
  const repository = dependencies.repository || new ServiceNowOperationsRepository();
  const source = await repository.getMappingSource(input.externalCustomerKey);
  if (!source) throw new HttpError(404, "SERVICENOW_CUSTOMER_SOURCE_NOT_FOUND", "ServiceNow customer source was not found");
  if (!source.mappable) throw new HttpError(409, "SERVICENOW_UNKNOWN_CUSTOMER_NOT_MAPPABLE", "The ServiceNow company must be corrected before it can be mapped");
  const createId = dependencies.createId || (() => crypto.randomUUID());
  const appliedAt = (dependencies.now || (() => new Date()))().toISOString();
  try {
    const result = await repository.applyMapping({
      provider: "servicenow", externalCustomerKey: source.externalCustomerKey,
      externalCustomerId: source.externalCustomerId || "", externalCustomerName: source.externalCustomerName,
      targetCustomerKey: input.customerKey, actorUserId: input.session.userId,
      requestId: input.requestId, correlationId: input.correlationId,
      mappingId: createId(), eventId: createId(), appliedAt,
    });
    return auditMappingBestEffort(result, { session: input.session, externalCustomerKey: source.externalCustomerKey, requestId: input.requestId }, dependencies.audit || writeAudit);
  } catch (error) {
    operationalError(error);
  }
}

export async function deactivateServiceNowCustomerMapping(
  input: { mappingId: string; session: Session; requestId: string; correlationId: string },
  dependencies: { repository?: ServiceNowOperationsRepository; audit?: AuditWriter; now?: () => Date; createId?: () => string } = {},
) {
  const repository = dependencies.repository || new ServiceNowOperationsRepository();
  const mapping = await repository.getMapping(input.mappingId);
  if (!mapping?.id || !mapping.external_customer_key || !mapping.customer_key) throw new HttpError(404, "CUSTOMER_MAPPING_NOT_FOUND", "Customer mapping was not found");
  const createId = dependencies.createId || (() => crypto.randomUUID());
  try {
    const result = await repository.deactivateMapping({
      mappingId: input.mappingId, actorUserId: input.session.userId, requestId: input.requestId,
      correlationId: input.correlationId, eventId: createId(), appliedAt: (dependencies.now || (() => new Date()))().toISOString(),
    });
    return auditMappingBestEffort(result, { session: input.session, externalCustomerKey: mapping.external_customer_key, previousCustomerKey: mapping.customer_key, requestId: input.requestId }, dependencies.audit || writeAudit);
  } catch (error) {
    operationalError(error);
  }
}
