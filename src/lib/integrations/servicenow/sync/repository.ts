import "server-only";
import { z } from "zod";
import type { SyncDecision, SyncRepository, SyncRunItem, SyncRunSummary, SyncState } from "../../sync/contracts";
import { mergeServiceNowIncidentIntoTicket, type MappedServiceNowIncident } from "./mapping";
import { ticketSchema } from "../../../types";

const outcomeSchema = z.object({ outcome: z.enum(["created", "updated", "unchanged", "stale"]), ticket_id: z.string(), warning_code: z.string().nullable().optional() });

async function client() {
  return (await import("../../../supabaseAdmin")).supabaseAdmin;
}

async function must<T>(label: string, promise: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>) {
  const { data, error } = await promise;
  if (error) throw Object.assign(new Error(label), { code: error.code || "SYNC_STORAGE_ERROR" });
  return data;
}

function stateFromRow(row: Record<string, unknown> | null): SyncState | undefined {
  if (!row) return undefined;
  const text = (key: string) => typeof row[key] === "string" ? row[key] as string : undefined;
  return { watermarkAt: text("watermark_at"), lastAttemptAt: text("last_attempt_at"), lastSuccessfulSyncAt: text("last_successful_sync_at"), lockToken: text("lock_token"), lockedUntil: text("locked_until") };
}

export class ServiceNowSyncRepository implements SyncRepository<MappedServiceNowIncident> {
  async getState() {
    const db = await client();
    const row = await must("Could not read synchronization state", db.from("integration_sync_state").select("watermark_at,last_attempt_at,last_successful_sync_at,lock_token,locked_until").eq("provider", "servicenow").eq("stream", "incident").maybeSingle());
    return stateFromRow(row as Record<string, unknown> | null);
  }

  async createRun(input: Parameters<SyncRepository<MappedServiceNowIncident>["createRun"]>[0]) {
    const db = await client();
    await must("Could not create synchronization run", db.from("integration_sync_runs").insert({
      id: input.id, provider: "servicenow", stream: "incident", mode: input.mode,
      trigger_type: input.dryRun ? "test" : "manual", status: "running", dry_run: input.dryRun,
      requested_by_user_id: input.requestedByUserId, request_id: input.requestId,
      correlation_id: input.correlationId, started_at: input.startedAt,
      watermark_from: input.watermarkFrom || null, metadata: {},
    }));
  }

  async finishRun(summary: SyncRunSummary) {
    const db = await client();
    const rows = await must("Could not finish synchronization run", db.from("integration_sync_runs").update({
      status: summary.status, completed_at: summary.completedAt, watermark_to: summary.watermarkTo || null,
      records_fetched: summary.fetched, records_created: summary.created, records_updated: summary.updated,
      records_unchanged: summary.unchanged, records_stale: summary.stale, records_skipped: summary.skipped,
      records_failed: summary.failed, pages_fetched: summary.pages,
      safe_error_code: summary.safeErrorCategory ? summary.safeErrorCategory.toUpperCase() : null,
      safe_error_message: summary.safeErrorCategory ? "Synchronization did not complete successfully" : null,
      metadata: { durationMs: summary.duration },
    }).eq("id", summary.runId).select("id"));
    if (!Array.isArray(rows) || rows.length !== 1) throw Object.assign(new Error("Could not finish synchronization run"), { code: "SYNC_RUN_MISSING" });
  }

  async completeSuccessfulRun(summary: SyncRunSummary, lockToken: string) {
    const db = await client();
    const completed = await must("Could not complete synchronization run", db.rpc("support_complete_integration_sync_run", {
      p_run_id: summary.runId,
      p_lock_token: lockToken,
      p_watermark: summary.watermarkTo || null,
      p_completed_at: summary.completedAt,
      p_summary: {
        fetched: summary.fetched, created: summary.created, updated: summary.updated,
        unchanged: summary.unchanged, stale: summary.stale, skipped: summary.skipped,
        failed: summary.failed, pages: summary.pages, durationMs: summary.duration,
      },
    }));
    return completed === true;
  }

  async acquireLock(token: string, ttlSeconds: number, now: string) {
    const db = await client();
    const result = await must("Could not acquire synchronization lock", db.rpc("support_acquire_integration_sync_lock", { p_provider: "servicenow", p_stream: "incident", p_lock_token: token, p_ttl_seconds: ttlSeconds, p_now: now }));
    return result === true;
  }

  async releaseLock(token: string) {
    const db = await client();
    const result = await must("Could not release synchronization lock", db.rpc("support_release_integration_sync_lock", { p_provider: "servicenow", p_stream: "incident", p_lock_token: token }));
    return result === true;
  }

  async preview(mapped: MappedServiceNowIncident): Promise<SyncDecision> {
    const db = await client();
    const link = await must("Could not inspect external ticket link", db.from("external_ticket_links").select("ticket_id,external_updated_at,source_hash").eq("provider", "servicenow").eq("external_sys_id", mapped.ticket.serviceNow?.externalSysId || "").maybeSingle()) as Record<string, unknown> | null;
    if (!link) return { outcome: "created" };
    const ticketRow = await must("Could not inspect linked ticket", db.from("support_tickets").select("data").eq("id", String(link.ticket_id)).maybeSingle()) as { data?: unknown } | null;
    if (!ticketRow?.data) throw Object.assign(new Error("Linked ticket is missing"), { code: "SYNC_LINKED_TICKET_MISSING" });
    const externalUpdatedAt = typeof link.external_updated_at === "string" ? link.external_updated_at : "1970-01-01T00:00:00.000Z";
    const decision = mergeServiceNowIncidentIntoTicket(ticketSchema.parse(ticketRow.data) as ReturnType<typeof ticketSchema.parse> & Record<string, unknown>, mapped, { externalUpdatedAt, sourceHash: String(link.source_hash || "") });
    return { outcome: decision.outcome, ticketId: String(link.ticket_id), warningCode: decision.warningCode };
  }

  async upsert(mapped: MappedServiceNowIncident): Promise<SyncDecision> {
    const serviceNow = mapped.ticket.serviceNow;
    if (!serviceNow) throw Object.assign(new Error("Missing ServiceNow metadata"), { code: "SYNC_MAPPING_INVALID" });
    const db = await client();
    const data = await must("Could not upsert ServiceNow Incident", db.rpc("support_upsert_servicenow_incident", { p_payload: {
      provider: "servicenow", linkId: crypto.randomUUID(), externalSysId: serviceNow.externalSysId,
      externalNumber: serviceNow.externalNumber, externalUrl: serviceNow.externalUrl,
      externalCreatedAt: serviceNow.externalCreatedAt || null, externalUpdatedAt: mapped.externalUpdatedAt,
      sourceHash: mapped.sourceHash, linkMetadata: mapped.linkMetadata, ticket: mapped.ticket,
    } }));
    const row = outcomeSchema.parse(Array.isArray(data) ? data[0] : data);
    return { outcome: row.outcome, ticketId: row.ticket_id, warningCode: row.warning_code || undefined };
  }

  async addRunItem(item: SyncRunItem) {
    const db = await client();
    await must("Could not write synchronization run item", db.from("integration_sync_run_items").insert({
      id: item.id, run_id: item.runId, external_sys_id: item.externalSysId || null,
      external_number: item.externalNumber || null, ticket_id: item.ticketId || null,
      outcome: item.outcome, source_updated_at: item.sourceUpdatedAt || null,
      safe_error_code: item.safeErrorCode || null, created_at: item.createdAt, metadata: item.metadata,
    }));
  }

}

export async function readServiceNowSyncStatus(limit = 10) {
  const boundedLimit = Math.max(1, Math.min(10, limit));
  const db = await client();
  const [stateResult, runsResult] = await Promise.all([
    db.from("integration_sync_state").select("watermark_at,last_attempt_at,last_successful_sync_at,lock_token,locked_until").eq("provider", "servicenow").eq("stream", "incident").maybeSingle(),
    db.from("integration_sync_runs").select("id,mode,status,dry_run,started_at,completed_at,watermark_from,watermark_to,records_fetched,records_created,records_updated,records_unchanged,records_stale,records_skipped,records_failed,pages_fetched,safe_error_code").eq("provider", "servicenow").eq("stream", "incident").order("started_at", { ascending: false }).limit(boundedLimit),
  ]);
  if (stateResult.error || runsResult.error) throw Object.assign(new Error("Could not read synchronization status"), { code: "SYNC_STORAGE_ERROR" });
  return { state: stateFromRow(stateResult.data as Record<string, unknown> | null), runs: runsResult.data || [] };
}
