import "server-only";
import type { Session } from "../../../auth";
import { getDataBackend } from "../../../env";
import { writeAudit } from "../../../repositories";
import { logServerCritical, logServerError } from "../../../server-logging";
import { runSyncEngine } from "../../sync/engine";
import type { SyncMode } from "../../sync/contracts";
import { correlationIdSchema } from "../../schemas";
import { ServiceNowReadClient } from "../client";
import { parseServiceNowConfig } from "../config";
import { normalizeServiceNowField, normalizeServiceNowIncident, parseServiceNowTimestamp } from "../normalization";
import { serviceNowSysIdSchema } from "../schemas";
import { parseServiceNowSyncConfig } from "./config";
import { mapServiceNowIncidentToTicket, type MappedServiceNowIncident } from "./mapping";
import { readServiceNowSyncStatus, ServiceNowSyncRepository } from "./repository";
import type { SyncRepository } from "../../sync/contracts";
import { ServiceNowSyncUnavailableError } from "./errors";
import { writeServiceNowSyncAuditBestEffort } from "./audit";

type Dependencies = {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  repository?: SyncRepository<MappedServiceNowIncident>;
  now?: () => Date;
  createId?: () => string;
  audit?: typeof writeAudit;
};

export async function syncServiceNowIncidents(
  input: { mode: SyncMode; dryRun: boolean; session: Session; requestId: string; correlationId: string; abortSignal?: AbortSignal },
  dependencies: Dependencies = {},
) {
  const env = dependencies.env ?? process.env;
  const syncConfig = parseServiceNowSyncConfig(env);
  if (!syncConfig.enabled) throw new ServiceNowSyncUnavailableError("SERVICENOW_SYNC_DISABLED", "ServiceNow synchronization is disabled");
  if (getDataBackend(env) !== "supabase-relational") throw new ServiceNowSyncUnavailableError("SERVICENOW_SYNC_REQUIRES_RELATIONAL", "ServiceNow synchronization requires relational storage");
  const serviceNowConfig = parseServiceNowConfig(env);
  if (!serviceNowConfig.enabled) throw new ServiceNowSyncUnavailableError("SERVICENOW_DISABLED", "ServiceNow integration is disabled");
  const lockRefreshSafetyMs = serviceNowConfig.timeoutMs + 5_000;
  if (syncConfig.lockTtlSeconds * 1_000 <= lockRefreshSafetyMs) {
    throw new ServiceNowSyncUnavailableError("SERVICENOW_SYNC_LOCK_TTL_TOO_SHORT", "ServiceNow synchronization lock TTL must exceed the provider timeout");
  }

  const correlationId = correlationIdSchema.parse(input.correlationId);
  const client = new ServiceNowReadClient(serviceNowConfig, { fetch: dependencies.fetch ?? fetch, maxPages: syncConfig.maxPages });
  const repository = dependencies.repository ?? new ServiceNowSyncRepository();
  const summary = await runSyncEngine({
    mode: input.mode,
    dryRun: input.dryRun,
    requestedByUserId: input.session.userId,
    requestId: input.requestId,
    correlationId: input.correlationId,
    abortSignal: input.abortSignal,
    initialLookbackDays: syncConfig.initialLookbackDays,
    overlapSeconds: syncConfig.overlapSeconds,
    maxRecords: syncConfig.maxRecords,
    maxPages: syncConfig.maxPages,
    pageSize: serviceNowConfig.pageSize,
    lockTtlSeconds: syncConfig.lockTtlSeconds,
    lockRefreshSafetyMs,
    repository,
    now: dependencies.now,
    createId: dependencies.createId,
    provider: {
      fetchPage: ({ windowStart, windowEnd, cursor, limit, signal }) => client.listIncidentRecordsPage({ windowStart, windowEnd, cursor, limit }, correlationId, signal),
      cursor: (raw) => {
        const sysId = serviceNowSysIdSchema.parse(normalizeServiceNowField(raw.sys_id));
        const updatedAt = parseServiceNowTimestamp(raw.sys_updated_on);
        if (!updatedAt) throw Object.assign(new Error("ServiceNow Incident is missing sys_updated_on"), { code: "SYNC_CURSOR_INVALID" });
        return { updatedAt, sysId };
      },
      prepare: (raw, now) => {
        const incident = normalizeServiceNowIncident(raw, serviceNowConfig);
        const mapped = mapServiceNowIncidentToTicket(incident, { ticketId: (dependencies.createId ?? (() => crypto.randomUUID()))(), now });
        return {
          externalSysId: incident.externalSysId,
          externalNumber: incident.number,
          sourceUpdatedAt: mapped.externalUpdatedAt,
          sourceCursor: { updatedAt: mapped.externalUpdatedAt, sysId: incident.externalSysId },
          mapped,
        };
      },
      identify: (raw) => ({
        externalSysId: normalizeServiceNowField(raw.sys_id) || undefined,
        externalNumber: normalizeServiceNowField(raw.number, true) || undefined,
      }),
    },
  });

  if (summary.status === "failed" || summary.status === "partial") {
    logServerError("servicenow_sync_not_completed", { code: summary.safeErrorCategory || summary.status }, {
      requestId: input.requestId,
      operation: "servicenow.sync",
      provider: "servicenow",
      stream: "incident",
      runId: summary.runId,
      mode: summary.mode,
      dryRun: summary.dryRun,
      status: summary.status,
      pages: summary.pages,
      failed: summary.failed,
      duration: summary.duration,
    });
  }
  if (!input.dryRun) {
    await writeServiceNowSyncAuditBestEffort(summary, input.session, {
      write: dependencies.audit ?? writeAudit,
      markFailed: repository.markAuditWriteFailed?.bind(repository),
      reportCritical: (event, error) => logServerCritical(event, error, { requestId: input.requestId, operation: "servicenow.sync", runId: summary.runId }),
    });
  }
  return summary;
}

export async function getServiceNowSyncStatus(env: Record<string, string | undefined> = process.env) {
  const config = parseServiceNowSyncConfig(env);
  if (!config.enabled) return { enabled: false, running: false, state: undefined, runs: [] };
  if (getDataBackend(env) !== "supabase-relational") throw new ServiceNowSyncUnavailableError("SERVICENOW_SYNC_REQUIRES_RELATIONAL", "ServiceNow synchronization requires relational storage");
  const result = await readServiceNowSyncStatus(10);
  const running = Boolean(result.state?.lockToken && result.state.lockedUntil && new Date(result.state.lockedUntil).getTime() > Date.now());
  return { enabled: true, running, ...result };
}
