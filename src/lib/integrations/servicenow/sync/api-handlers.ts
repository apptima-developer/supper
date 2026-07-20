import type { Session } from "../../../auth";
import { can } from "../../../rbac";
import { HttpError, jsonResponseWithRequestId, readJsonBody, requestId, safeErrorResponse } from "../../../request-security";
import type { SyncRunSummary } from "../../sync/contracts";
import { syncRequestSchema } from "../../sync/contracts";
import { ServiceNowSyncUnavailableError } from "./errors";

type SyncStatusResult = {
  enabled: boolean;
  running: boolean;
  state?: { watermarkAt?: string; lastAttemptAt?: string; lastSuccessfulSyncAt?: string };
  runs: Array<Record<string, unknown>>;
};

export type ServiceNowSyncApiDependencies = {
  getSession: () => Promise<Session | null>;
  startSync: (input: { mode: "initial" | "incremental"; dryRun: boolean; session: Session; requestId: string; correlationId: string; abortSignal?: AbortSignal }) => Promise<SyncRunSummary>;
  getStatus: () => Promise<SyncStatusResult>;
};

function authorize(session: Session | null, request: Request) {
  if (!session) return jsonResponseWithRequestId({ error: "Unauthorized", code: "UNAUTHORIZED" }, request, { status: 401 });
  if (!can(session.role, "settings:manage")) return jsonResponseWithRequestId({ error: "Forbidden", code: "FORBIDDEN" }, request, { status: 403 });
  return null;
}

function safeFailure(error: unknown, request: Request, correlationId: string) {
  if (error instanceof ServiceNowSyncUnavailableError) {
    return jsonResponseWithRequestId({ error: error.message, code: error.code, category: "configuration" }, request, { status: 409 }, correlationId);
  }
  return safeErrorResponse(error, "ServiceNow synchronization failed", request, 500, correlationId);
}

function safeSummary(summary: SyncRunSummary) {
  return {
    runId: summary.runId,
    mode: summary.mode,
    dryRun: summary.dryRun,
    status: summary.status,
    fetched: summary.fetched,
    created: summary.created,
    updated: summary.updated,
    unchanged: summary.unchanged,
    stale: summary.stale,
    skipped: summary.skipped,
    failed: summary.failed,
    pages: summary.pages,
    watermarkFrom: summary.watermarkFrom,
    watermarkTo: summary.watermarkTo,
    duration: summary.duration,
    safeErrorCategory: summary.safeErrorCategory,
  };
}

export async function handleServiceNowSyncPost(request: Request, dependencies: ServiceNowSyncApiDependencies) {
  const correlationId = requestId(request);
  try {
    const session = await dependencies.getSession();
    const denied = authorize(session, request);
    if (denied) return denied;
    if (!session) throw new HttpError(401, "UNAUTHORIZED", "Unauthorized");
    const body = await readJsonBody(request, syncRequestSchema, 4 * 1024);
    const summary = await dependencies.startSync({ ...body, session, requestId: correlationId, correlationId, abortSignal: request.signal });
    return jsonResponseWithRequestId(safeSummary(summary), request, {}, correlationId);
  } catch (error) {
    return safeFailure(error, request, correlationId);
  }
}

function safeRun(row: Record<string, unknown>) {
  const number = (key: string) => typeof row[key] === "number" ? row[key] : 0;
  const text = (key: string) => typeof row[key] === "string" ? row[key] : undefined;
  return {
    runId: text("id"), mode: text("mode"), status: text("status"), dryRun: row.dry_run === true,
    startedAt: text("started_at"), completedAt: text("completed_at"), watermarkFrom: text("watermark_from"), watermarkTo: text("watermark_to"),
    fetched: number("records_fetched"), created: number("records_created"), updated: number("records_updated"), unchanged: number("records_unchanged"),
    stale: number("records_stale"), skipped: number("records_skipped"), failed: number("records_failed"), pages: number("pages_fetched"), safeErrorCategory: text("safe_error_code")?.toLowerCase(),
  };
}

export async function handleServiceNowSyncGet(request: Request, dependencies: ServiceNowSyncApiDependencies) {
  const correlationId = requestId(request);
  try {
    const denied = authorize(await dependencies.getSession(), request);
    if (denied) return denied;
    const status = await dependencies.getStatus();
    return jsonResponseWithRequestId({
      enabled: status.enabled,
      running: status.running,
      currentWatermark: status.state?.watermarkAt,
      lastAttempt: status.state?.lastAttemptAt,
      lastSuccess: status.state?.lastSuccessfulSyncAt,
      runs: status.runs.slice(0, 10).map(safeRun),
    }, request, {}, correlationId);
  } catch (error) {
    return safeFailure(error, request, correlationId);
  }
}
