import "server-only";
import { z } from "zod";
import { serviceNowCustomerIdentityFromTicket } from "../customer-identity";
import type { ServiceNowMappingCandidate, ServiceNowMappingResult, ServiceNowRunItem, ServiceNowRunSummary } from "./types";

type RunFilters = { page: number; limit: number; status?: string; mode?: string; dryRun?: boolean; dateFrom?: string; dateTo?: string };
type MappingFilters = { page: number; limit: number; status: "all" | "mapped" | "unmapped" | "inactive"; search: string };
type JsonRecord = Record<string, unknown>;

const mappingResultSchema = z.object({
  mapping_id: z.string(),
  action: z.enum(["created", "changed", "reactivated", "unchanged"]),
  previous_customer_key: z.string().nullable().optional(),
  customer_key: z.string(),
  customer_name: z.string(),
  affected_ticket_count: z.number().int().nonnegative(),
  active: z.boolean(),
});

const deactivationResultSchema = z.object({
  mapping_id: z.string(), action: z.enum(["deactivated", "unchanged"]), customer_key: z.string(),
  affected_ticket_count: z.number().int().nonnegative(), active: z.boolean(),
});

export const serviceNowTicketCandidateScanLimit = 10_000;
export const serviceNowMappingCandidateScanLimit = 2_000;

async function client() {
  return (await import("../../../supabaseAdmin")).supabaseAdmin;
}

async function must<T>(label: string, promise: PromiseLike<{ data: T; error: { message: string; code?: string } | null; count?: number | null }>) {
  const result = await promise;
  if (result.error) throw Object.assign(new Error(result.error.message || label), { code: result.error.code || "SERVICENOW_OPERATIONS_STORAGE_ERROR" });
  return result;
}

function text(row: JsonRecord, key: string) {
  return typeof row[key] === "string" && row[key] ? row[key] as string : undefined;
}

function number(row: JsonRecord, key: string) {
  return typeof row[key] === "number" && Number.isFinite(row[key]) ? row[key] as number : 0;
}

export function safeServiceNowRun(row: JsonRecord): ServiceNowRunSummary {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as JsonRecord : {};
  return {
    runId: text(row, "id") || "",
    mode: text(row, "mode") || "unknown",
    status: text(row, "status") || "unknown",
    dryRun: row.dry_run === true,
    startedAt: text(row, "started_at"), completedAt: text(row, "completed_at"),
    watermarkFrom: text(row, "watermark_from"), watermarkFromSysId: text(row, "watermark_from_sys_id"),
    watermarkTo: text(row, "watermark_to"), watermarkToSysId: text(row, "watermark_to_sys_id"),
    windowStart: text(row, "window_start_at"), windowEnd: text(row, "window_end_at"),
    fetched: number(row, "records_fetched"), created: number(row, "records_created"), updated: number(row, "records_updated"),
    unchanged: number(row, "records_unchanged"), stale: number(row, "records_stale"), skipped: number(row, "records_skipped"),
    failed: number(row, "records_failed"), pages: number(row, "pages_fetched"),
    duration: typeof metadata.durationMs === "number" ? metadata.durationMs : 0,
    safeErrorCategory: text(row, "safe_error_code")?.toLowerCase(),
    auditWarning: metadata.auditWriteFailed === true ? "secondary_audit_write_failed" : undefined,
  };
}

function safeRunItem(row: JsonRecord): ServiceNowRunItem {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata) ? row.metadata as JsonRecord : {};
  return {
    externalNumber: text(row, "external_number"), ticketId: text(row, "ticket_id"),
    outcome: text(row, "outcome") || "unknown", sourceUpdatedAt: text(row, "source_updated_at"),
    safeErrorCode: text(row, "safe_error_code"), warningCode: typeof metadata.warningCode === "string" ? metadata.warningCode.slice(0, 80) : undefined,
  };
}

type TicketSourceRow = {
  id?: string; issue_id?: string; customer_key?: string; customer_name?: string;
  kanban_status?: string; data?: unknown; updated_at?: string;
};
type MappingRow = {
  id?: string; external_customer_key?: string; external_customer_id?: string | null;
  external_customer_name?: string; customer_key?: string; active?: boolean;
};

function mappingStatusMatches(item: ServiceNowMappingCandidate, status: MappingFilters["status"]) {
  if (status === "mapped") return item.mapped && item.activeMapping;
  if (status === "unmapped") return !item.activeMapping;
  if (status === "inactive") return item.mapped && !item.activeMapping;
  return true;
}

export function aggregateServiceNowCustomerMappings(
  ticketRows: TicketSourceRow[], mappingRows: MappingRow[], customerNames: Map<string, string>, filters: MappingFilters,
  bounds: { ticketBoundReached?: boolean; mappingBoundReached?: boolean } = {},
) {
  const byKey = new Map<string, ServiceNowMappingCandidate>();
  for (const row of ticketRows) {
    if (!row.data || typeof row.data !== "object" || Array.isArray(row.data)) continue;
    const data = row.data as JsonRecord;
    const serviceNow = data.serviceNow && typeof data.serviceNow === "object" && !Array.isArray(data.serviceNow) ? data.serviceNow as JsonRecord : undefined;
    if (serviceNow?.provider !== "servicenow") continue;
    const identity = serviceNowCustomerIdentityFromTicket({
      customerKey: row.customer_key, customerName: row.customer_name,
      serviceNow: {
        externalCustomerKey: typeof serviceNow.externalCustomerKey === "string" ? serviceNow.externalCustomerKey : undefined,
        externalCustomerId: typeof serviceNow.externalCustomerId === "string" ? serviceNow.externalCustomerId : undefined,
        externalCustomerName: typeof serviceNow.externalCustomerName === "string" ? serviceNow.externalCustomerName : undefined,
        companyExternalId: typeof serviceNow.companyExternalId === "string" ? serviceNow.companyExternalId : undefined,
        companyReference: typeof serviceNow.companyReference === "string" ? serviceNow.companyReference : undefined,
      },
    });
    const createdAt = typeof data.createdAt === "string" ? data.createdAt : typeof serviceNow.externalCreatedAt === "string" ? serviceNow.externalCreatedAt : undefined;
    const lastSeenAt = typeof serviceNow.externalUpdatedAt === "string" ? serviceNow.externalUpdatedAt : row.updated_at;
    const current = byKey.get(identity.externalCustomerKey) || {
      externalCustomerKey: identity.externalCustomerKey,
      externalCustomerId: identity.externalCustomerId,
      externalCustomerName: identity.externalCustomerName,
      mappable: identity.mappable, mapped: false, activeMapping: false,
      ticketCount: 0, openTicketCount: 0, firstSeenAt: createdAt, lastSeenAt, exampleIncidents: [],
    };
    current.ticketCount += 1;
    if (!["resolved", "closed", "cancelled"].includes(row.kanban_status || "")) current.openTicketCount += 1;
    if (row.issue_id && current.exampleIncidents.length < 3 && !current.exampleIncidents.includes(row.issue_id)) current.exampleIncidents.push(row.issue_id);
    if (createdAt && (!current.firstSeenAt || createdAt < current.firstSeenAt)) current.firstSeenAt = createdAt;
    if (lastSeenAt && (!current.lastSeenAt || lastSeenAt > current.lastSeenAt)) current.lastSeenAt = lastSeenAt;
    byKey.set(identity.externalCustomerKey, current);
  }

  for (const mapping of mappingRows) {
    if (!mapping.external_customer_key) continue;
    const candidate = byKey.get(mapping.external_customer_key) || {
      externalCustomerKey: mapping.external_customer_key,
      externalCustomerId: mapping.external_customer_id || undefined,
      externalCustomerName: mapping.external_customer_name || "Unmapped ServiceNow customer",
      mappable: mapping.external_customer_key !== "servicenow-unmapped:unknown",
      mapped: false, activeMapping: false, ticketCount: 0, openTicketCount: 0, exampleIncidents: [],
    };
    candidate.mappingId = mapping.id;
    candidate.mapped = true;
    candidate.activeMapping = mapping.active === true;
    candidate.mappedCustomerKey = mapping.customer_key;
    candidate.mappedCustomerName = mapping.customer_key ? customerNames.get(mapping.customer_key) : undefined;
    candidate.externalCustomerId ||= mapping.external_customer_id || undefined;
    candidate.externalCustomerName ||= mapping.external_customer_name || "Unmapped ServiceNow customer";
    byKey.set(mapping.external_customer_key, candidate);
  }

  const search = filters.search.toLocaleLowerCase();
  const filtered = [...byKey.values()].filter((item) => {
    if (!mappingStatusMatches(item, filters.status)) return false;
    return !search || item.externalCustomerName.toLocaleLowerCase().includes(search) || item.externalCustomerKey.toLocaleLowerCase().includes(search);
  }).sort((a, b) => {
    const aRank = !a.activeMapping && a.mappable ? 0 : a.activeMapping ? 1 : 2;
    const bRank = !b.activeMapping && b.mappable ? 0 : b.activeMapping ? 1 : 2;
    return aRank - bRank || b.ticketCount - a.ticketCount || (b.lastSeenAt || "").localeCompare(a.lastSeenAt || "");
  });
  const offset = (filters.page - 1) * filters.limit;
  return {
    items: filtered.slice(offset, offset + filters.limit), total: filtered.length,
    matchingTicketCount: filtered.reduce((sum, item) => sum + item.ticketCount, 0),
    page: filters.page, limit: filters.limit,
    truncated: bounds.ticketBoundReached === true || bounds.mappingBoundReached === true,
  };
}

function exactMappingSource(row: JsonRecord): ServiceNowMappingCandidate | undefined {
  const externalCustomerKey = text(row, "external_customer_key");
  if (!externalCustomerKey) return undefined;
  const examples = Array.isArray(row.example_incidents)
    ? row.example_incidents.filter((value): value is string => typeof value === "string").slice(0, 3)
    : [];
  return {
    mappingId: text(row, "mapping_id"),
    externalCustomerKey,
    externalCustomerId: text(row, "external_customer_id"),
    externalCustomerName: text(row, "external_customer_name") || "Unmapped ServiceNow customer",
    mappable: row.mappable === true,
    mapped: row.mapped === true,
    activeMapping: row.active_mapping === true,
    mappedCustomerKey: text(row, "mapped_customer_key"),
    mappedCustomerName: text(row, "mapped_customer_name"),
    ticketCount: number(row, "ticket_count"),
    openTicketCount: number(row, "open_ticket_count"),
    firstSeenAt: text(row, "first_seen_at"),
    lastSeenAt: text(row, "last_seen_at"),
    exampleIncidents: examples,
  };
}

export class ServiceNowOperationsRepository {
  async readStateAndLatestRun() {
    const db = await client();
    const [state, latest] = await Promise.all([
      must("Could not read synchronization state", db.from("integration_sync_state").select("watermark_at,watermark_sys_id,last_attempt_at,last_successful_sync_at,lock_token,locked_until").eq("provider", "servicenow").eq("stream", "incident").maybeSingle()),
      must("Could not read latest synchronization run", db.from("integration_sync_runs").select("id,mode,status,dry_run,started_at,completed_at,watermark_from,watermark_from_sys_id,watermark_to,watermark_to_sys_id,window_start_at,window_end_at,records_fetched,records_created,records_updated,records_unchanged,records_stale,records_skipped,records_failed,pages_fetched,safe_error_code,metadata").eq("provider", "servicenow").eq("stream", "incident").order("started_at", { ascending: false }).limit(1)),
    ]);
    return { state: state.data as JsonRecord | null, latestRun: Array.isArray(latest.data) && latest.data[0] ? safeServiceNowRun(latest.data[0] as JsonRecord) : undefined };
  }

  async countRecentRuns(since: string) {
    const db = await client();
    const [all, failures] = await Promise.all([
      must("Could not count synchronization runs", db.from("integration_sync_runs").select("id", { count: "exact", head: true }).eq("provider", "servicenow").eq("stream", "incident").gte("started_at", since)),
      must("Could not count incomplete synchronization runs", db.from("integration_sync_runs").select("id", { count: "exact", head: true }).eq("provider", "servicenow").eq("stream", "incident").gte("started_at", since).in("status", ["failed", "partial"])),
    ]);
    return { all: all.count || 0, failedOrPartial: failures.count || 0 };
  }

  async countMappings() {
    const db = await client();
    const [active, inactive] = await Promise.all([
      must("Could not count active mappings", db.from("integration_customer_mappings").select("id", { count: "exact", head: true }).eq("provider", "servicenow").eq("active", true)),
      must("Could not count inactive mappings", db.from("integration_customer_mappings").select("id", { count: "exact", head: true }).eq("provider", "servicenow").eq("active", false)),
    ]);
    return { active: active.count || 0, inactive: inactive.count || 0 };
  }

  async listRuns(filters: RunFilters) {
    const db = await client();
    let query = db.from("integration_sync_runs").select("id,mode,status,dry_run,started_at,completed_at,watermark_from,watermark_from_sys_id,watermark_to,watermark_to_sys_id,window_start_at,window_end_at,records_fetched,records_created,records_updated,records_unchanged,records_stale,records_skipped,records_failed,pages_fetched,safe_error_code,metadata", { count: "exact" }).eq("provider", "servicenow").eq("stream", "incident");
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.mode) query = query.eq("mode", filters.mode);
    if (filters.dryRun !== undefined) query = query.eq("dry_run", filters.dryRun);
    if (filters.dateFrom) query = query.gte("started_at", `${filters.dateFrom}T00:00:00.000Z`);
    if (filters.dateTo) query = query.lt("started_at", `${filters.dateTo}T23:59:59.999Z`);
    const offset = (filters.page - 1) * filters.limit;
    const result = await must("Could not list synchronization runs", query.order("started_at", { ascending: false }).range(offset, offset + filters.limit - 1));
    return { items: (result.data || []).map((row) => safeServiceNowRun(row as JsonRecord)), total: result.count || 0, page: filters.page, limit: filters.limit };
  }

  async readRunDetail(runId: string, itemCursor: number, itemLimit: number) {
    const db = await client();
    const [run, items] = await Promise.all([
      must("Could not read synchronization run", db.from("integration_sync_runs").select("id,mode,status,dry_run,started_at,completed_at,watermark_from,watermark_from_sys_id,watermark_to,watermark_to_sys_id,window_start_at,window_end_at,records_fetched,records_created,records_updated,records_unchanged,records_stale,records_skipped,records_failed,pages_fetched,safe_error_code,metadata").eq("provider", "servicenow").eq("stream", "incident").eq("id", runId).maybeSingle()),
      must("Could not read synchronization run items", db.from("integration_sync_run_items").select("external_number,ticket_id,outcome,source_updated_at,safe_error_code,metadata,created_at").eq("run_id", runId).order("created_at", { ascending: true }).range(itemCursor, itemCursor + itemLimit)),
    ]);
    const rows = (items.data || []) as JsonRecord[];
    return { run: run.data ? safeServiceNowRun(run.data as JsonRecord) : undefined, items: rows.slice(0, itemLimit).map(safeRunItem), nextItemCursor: rows.length > itemLimit ? itemCursor + itemLimit : undefined };
  }

  async listMappingCandidates(filters: MappingFilters) {
    if (/^servicenow-unmapped:[a-z0-9-]+$/.test(filters.search)
      && filters.search !== "servicenow-unmapped:unknown") {
      const source = await this.getMappingSource(filters.search);
      const items = source && mappingStatusMatches(source, filters.status) ? [source] : [];
      return {
        items, total: items.length, matchingTicketCount: items.reduce((sum, item) => sum + item.ticketCount, 0),
        page: filters.page, limit: filters.limit, truncated: false,
      };
    }
    const db = await client();
    const [tickets, mappings, customers] = await Promise.all([
      must("Could not read ServiceNow ticket sources", db.from("support_tickets").select("id,issue_id,customer_key,customer_name,kanban_status,data,updated_at", { count: "exact" }).eq("issue_type", "Incident").limit(serviceNowTicketCandidateScanLimit)),
      must("Could not read customer mappings", db.from("integration_customer_mappings").select("id,external_customer_key,external_customer_id,external_customer_name,customer_key,active", { count: "exact" }).eq("provider", "servicenow").limit(serviceNowMappingCandidateScanLimit)),
      must("Could not read mapped customer names", db.from("support_customers").select("customer_key,customer_name").limit(10_000)),
    ]);
    const names = new Map(((customers.data || []) as JsonRecord[]).flatMap((row) => text(row, "customer_key") ? [[text(row, "customer_key")!, text(row, "customer_name") || ""] as const] : []));
    const ticketRows = (tickets.data || []) as TicketSourceRow[];
    const mappingRows = (mappings.data || []) as MappingRow[];
    return aggregateServiceNowCustomerMappings(ticketRows, mappingRows, names, filters, {
      ticketBoundReached: ticketRows.length >= serviceNowTicketCandidateScanLimit || (tickets.count || 0) > ticketRows.length,
      mappingBoundReached: mappingRows.length >= serviceNowMappingCandidateScanLimit || (mappings.count || 0) > mappingRows.length,
    });
  }

  async getMappingSource(externalCustomerKey: string) {
    const db = await client();
    const result = await must("Could not resolve ServiceNow customer source", db.rpc("support_get_servicenow_customer_source", {
      p_external_customer_key: externalCustomerKey,
    }));
    const row = Array.isArray(result.data) ? result.data[0] : result.data;
    return row && typeof row === "object" && !Array.isArray(row) ? exactMappingSource(row as JsonRecord) : undefined;
  }

  async getMapping(mappingId: string) {
    const db = await client();
    const result = await must("Could not read customer mapping", db.from("integration_customer_mappings").select("id,external_customer_key,external_customer_name,customer_key,active").eq("provider", "servicenow").eq("id", mappingId).maybeSingle());
    return result.data as MappingRow | null;
  }

  async applyMapping(payload: JsonRecord): Promise<ServiceNowMappingResult> {
    const db = await client();
    const result = await must("Could not apply customer mapping", db.rpc("support_apply_integration_customer_mapping", { p_payload: payload }));
    const parsed = mappingResultSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data);
    return { mappingId: parsed.mapping_id, action: parsed.action, previousCustomerKey: parsed.previous_customer_key || undefined, customerKey: parsed.customer_key, customerName: parsed.customer_name, affectedTicketCount: parsed.affected_ticket_count, active: parsed.active };
  }

  async deactivateMapping(payload: JsonRecord): Promise<ServiceNowMappingResult> {
    const db = await client();
    const result = await must("Could not deactivate customer mapping", db.rpc("support_deactivate_integration_customer_mapping", { p_payload: payload }));
    const parsed = deactivationResultSchema.parse(Array.isArray(result.data) ? result.data[0] : result.data);
    return { mappingId: parsed.mapping_id, action: parsed.action, customerKey: parsed.customer_key, affectedTicketCount: parsed.affected_ticket_count, active: parsed.active };
  }

  async listCustomerTargets(search: string, limit: number) {
    const db = await client();
    const result = await must("Could not search customer targets", db.from("support_customers").select("customer_key,customer_name,project_code").eq("active", true).order("customer_name", { ascending: true }).limit(10_000));
    const needle = search.toLocaleLowerCase();
    return ((result.data || []) as JsonRecord[]).flatMap((row) => {
      const customerKey = text(row, "customer_key");
      const customerName = text(row, "customer_name");
      const projectCode = text(row, "project_code") || "";
      if (!customerKey || !customerName || (needle && !`${customerName} ${projectCode} ${customerKey}`.toLocaleLowerCase().includes(needle))) return [];
      return [{ customerKey, customerName, projectCode }];
    }).slice(0, limit);
  }
}
