import "server-only";
import { z, type ZodType } from "zod";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import {
  auditListSchema,
  auditSchema,
  customerListSchema,
  customerSchema,
  historyListSchema,
  importBatchListSchema,
  importBatchSchema,
  namedMasterListSchema,
  reportJobListSchema,
  reportJobSchema,
  slaListSchema,
  statusListSchema,
  ticketListSchema,
  ticketSchema,
  userListSchema,
  userSchema,
  type Audit,
  type Customer,
  type ImportBatch,
  type NamedMaster,
  type ReportJob,
  type Sla,
  type Status,
  type Ticket,
  type TicketHistory,
  type User,
} from "./types";

type MasterKind = "statuses" | "sla" | "holidays" | "teams" | "priorities" | "issueTypes" | "contractTypes";
type JsonRow = { data: unknown };

const masterSchemas: Record<MasterKind, ZodType> = {
  statuses: statusListSchema,
  sla: slaListSchema,
  holidays: z.array(z.object({ id: z.string(), date: z.string(), name: z.string() })),
  teams: namedMasterListSchema,
  priorities: namedMasterListSchema,
  issueTypes: namedMasterListSchema,
  contractTypes: namedMasterListSchema,
};

const importCoreSnapshotSchema = z.object({
  tickets: ticketListSchema,
  history: historyListSchema,
  audit: auditListSchema,
  createdAt: z.string(),
});

const reportAssetSchema = z.object({
  fileName: z.string(),
  contentType: z.string(),
  base64: z.string(),
  createdAt: z.string(),
});

export function relationalStoreEnabled() {
  return process.env.DATA_BACKEND === "supabase-relational" || process.env.SUPABASE_DATA_MODEL === "relational";
}

function parseDate(value?: string | null) {
  if (!value) return null;
  const date = value.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function parseTimestamp(value?: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function rows<T>(data: JsonRow[] | null, schema: ZodType<T[]>): T[] {
  return schema.parse((data || []).map((row) => row.data));
}

function row<T>(data: JsonRow | null, schema: ZodType<T>) {
  return data ? schema.parse(data.data) : undefined;
}

async function must<T>(label: string, promise: PromiseLike<{ data: T; error: { message: string } | null }>) {
  const { data, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

function customerRow(customer: Customer) {
  return {
    id: customer.id,
    customer_key: customer.key,
    customer_name: customer.customerName,
    project_code: customer.projectCode,
    active: customer.active,
    end_period: parseDate(customer.endPeriod),
    updated_at: parseTimestamp(customer.updatedAt) || new Date().toISOString(),
    data: customer,
  };
}

function ticketRow(ticket: Ticket) {
  return {
    id: ticket.id,
    issue_id: ticket.issueId,
    customer_key: ticket.customerKey,
    customer_name: ticket.customerName,
    kanban_status: ticket.kanbanStatus,
    status: ticket.status,
    issue_type: ticket.issueType,
    severity: ticket.severity,
    ticket_date: parseDate(ticket.date),
    start_date: parseDate(ticket.startDate),
    due_date: parseDate(ticket.dueDate),
    close_date: parseDate(ticket.closeDate),
    updated_at: parseTimestamp(ticket.updatedAt) || new Date().toISOString(),
    data: ticket,
  };
}

function historyRow(item: TicketHistory) {
  return {
    id: item.id,
    ticket_id: item.ticketId,
    issue_id: item.issueId,
    field: item.field,
    source: item.source,
    created_at: parseTimestamp(item.createdAt) || new Date().toISOString(),
    data: item,
  };
}

function auditRow(item: Audit) {
  return {
    id: item.id,
    action: item.action,
    entity: item.entity,
    entity_id: item.entityId,
    actor: item.actor,
    created_at: parseTimestamp(item.createdAt) || new Date().toISOString(),
    data: item,
  };
}

function userRow(item: User) {
  return {
    id: item.id,
    username: item.username.toLowerCase(),
    email: item.email.toLowerCase(),
    role: item.role,
    active: item.active,
    data: item,
  };
}

function importBatchRow(item: ImportBatch) {
  return {
    id: item.id,
    status: item.status,
    kind: item.kind,
    created_at: parseTimestamp(item.createdAt) || new Date().toISOString(),
    data: item,
  };
}

function reportJobRow(item: ReportJob) {
  return {
    id: item.id,
    customer_key: item.customerKey,
    month: item.month,
    status: item.status,
    created_at: parseTimestamp(item.createdAt) || new Date().toISOString(),
    data: item,
  };
}

function reportAssetRow(asset: z.infer<typeof reportAssetSchema>) {
  return {
    file_name: asset.fileName,
    content_type: asset.contentType,
    created_at: parseTimestamp(asset.createdAt) || new Date().toISOString(),
    data: asset,
  };
}

async function upsertRows(table: string, rowsToWrite: Array<Record<string, unknown>>) {
  const chunkSize = 500;
  for (let index = 0; index < rowsToWrite.length; index += chunkSize) {
    const chunk = rowsToWrite.slice(index, index + chunkSize);
    if (chunk.length) {
      await must(`Failed to upsert ${table}`, supabaseAdmin.from(table).upsert(chunk));
    }
  }
}

export async function listCustomers() {
  const data = await must("Failed to list customers", supabaseAdmin.from("support_customers").select("data").order("customer_name"));
  return rows(data, customerListSchema);
}

export async function getCustomer(id: string) {
  let data = await must("Failed to read customer", supabaseAdmin.from("support_customers").select("data").eq("id", id).maybeSingle());
  if (!data) data = await must("Failed to read customer by key", supabaseAdmin.from("support_customers").select("data").eq("customer_key", id).maybeSingle());
  return row(data, customerSchema);
}

export async function upsertCustomer(customer: Customer) {
  await upsertRows("support_customers", [customerRow(customer)]);
}

export async function deleteCustomer(id: string) {
  await must("Failed to delete customer", supabaseAdmin.from("support_customers").delete().eq("id", id));
}

export async function listTickets() {
  const data = await must("Failed to list tickets", supabaseAdmin.from("support_tickets").select("data").order("updated_at", { ascending: false }));
  return rows(data, ticketListSchema);
}

export async function listTicketsByCustomer(customerKey: string) {
  const data = await must("Failed to list customer tickets", supabaseAdmin.from("support_tickets").select("data").eq("customer_key", customerKey).order("updated_at", { ascending: false }));
  return rows(data, ticketListSchema);
}

export async function getTicket(id: string) {
  let data = await must("Failed to read ticket", supabaseAdmin.from("support_tickets").select("data").eq("id", id).maybeSingle());
  if (!data) data = await must("Failed to read ticket by issue id", supabaseAdmin.from("support_tickets").select("data").eq("issue_id", id).maybeSingle());
  return row(data, ticketSchema);
}

export async function upsertTicket(ticket: Ticket) {
  await upsertRows("support_tickets", [ticketRow(ticket)]);
}

export async function upsertTickets(tickets: Ticket[]) {
  await upsertRows("support_tickets", tickets.map(ticketRow));
}

export async function deleteTicket(id: string) {
  await must("Failed to delete ticket", supabaseAdmin.from("support_tickets").delete().eq("id", id));
}

export async function listTicketHistory(ticketId: string, issueId?: string) {
  const byTicket = await must("Failed to list ticket history", supabaseAdmin.from("support_ticket_history").select("data").eq("ticket_id", ticketId).order("created_at", { ascending: false }));
  if (!issueId) return rows(byTicket, historyListSchema);
  const existingIds = new Set(rows(byTicket, historyListSchema).map((item) => item.id));
  const byIssue = await must("Failed to list issue history", supabaseAdmin.from("support_ticket_history").select("data").eq("issue_id", issueId).order("created_at", { ascending: false }));
  return historyListSchema.parse([...rows(byTicket, historyListSchema), ...rows(byIssue, historyListSchema).filter((item) => !existingIds.has(item.id))]);
}

export async function listAllTicketHistory() {
  const data = await must("Failed to list ticket history", supabaseAdmin.from("support_ticket_history").select("data").order("created_at", { ascending: false }));
  return rows(data, historyListSchema);
}

export async function addTicketHistory(items: TicketHistory[]) {
  await upsertRows("support_ticket_history", items.map(historyRow));
}

export async function replaceTicketHistory(items: TicketHistory[]) {
  await upsertRows("support_ticket_history", items.map(historyRow));
}

export async function listAudit() {
  const data = await must("Failed to list audit log", supabaseAdmin.from("support_audit_log").select("data").order("created_at", { ascending: false }).limit(10000));
  return rows(data, auditListSchema);
}

export async function addAudit(item: Audit) {
  await upsertRows("support_audit_log", [auditRow(item)]);
}

export async function replaceAudit(items: Audit[]) {
  await upsertRows("support_audit_log", items.slice(0, 10000).map(auditRow));
}

export async function listUsers() {
  const data = await must("Failed to list users", supabaseAdmin.from("support_users").select("data").order("username"));
  return rows(data, userListSchema);
}

export async function upsertUser(user: User) {
  await upsertRows("support_users", [userRow(user)]);
}

export async function listMaster<T>(kind: MasterKind, schema: ZodType<T[]>) {
  const data = await must(`Failed to read master ${kind}`, supabaseAdmin.from("support_master_data").select("data").eq("kind", kind).maybeSingle());
  return data ? schema.parse(data.data) : [];
}

export async function saveMaster<T extends Sla | Status | NamedMaster | { id: string; date: string; name: string }>(kind: MasterKind, items: T[]) {
  const schema = masterSchemas[kind];
  const parsed = schema.parse(items);
  await must(`Failed to save master ${kind}`, supabaseAdmin.from("support_master_data").upsert({
    kind,
    data: parsed,
    updated_at: new Date().toISOString(),
  }));
}

export async function listImportBatches() {
  const data = await must("Failed to list import batches", supabaseAdmin.from("support_import_batches").select("data").order("created_at", { ascending: false }));
  return rows(data, importBatchListSchema);
}

export async function addImportBatch(item: ImportBatch) {
  await upsertRows("support_import_batches", [importBatchRow(item)]);
}

export async function updateImportBatch(id: string, patch: Partial<ImportBatch>) {
  const items = await listImportBatches();
  const current = items.find((item) => item.id === id);
  if (!current) return;
  await addImportBatch(importBatchSchema.parse({ ...current, ...patch, id: current.id }));
}

export async function listReportJobs() {
  const data = await must("Failed to list report jobs", supabaseAdmin.from("support_report_jobs").select("data").order("created_at", { ascending: false }));
  return rows(data, reportJobListSchema);
}

export async function addReportJob(item: ReportJob) {
  await upsertRows("support_report_jobs", [reportJobRow(item)]);
}

export async function saveGeneratedReportAsset(asset: z.infer<typeof reportAssetSchema>) {
  await must("Failed to save generated report", supabaseAdmin.from("support_report_assets").upsert(reportAssetRow(reportAssetSchema.parse(asset))));
}

export async function readGeneratedReportAsset(fileName: string) {
  const data = await must("Failed to read generated report", supabaseAdmin.from("support_report_assets").select("data").eq("file_name", fileName).maybeSingle());
  return row(data, reportAssetSchema);
}

async function clearTable(table: string) {
  await must(`Failed to clear ${table}`, supabaseAdmin.from(table).delete().neq("id", "__never__"));
}

export async function saveImportSnapshot(id: string) {
  const [tickets, history, audit] = await Promise.all([
    listTickets(),
    listAllTicketHistory(),
    listAudit(),
  ]);
  const data = importCoreSnapshotSchema.parse({
    tickets,
    history,
    audit,
    createdAt: new Date().toISOString(),
  });
  await must("Failed to save import snapshot", supabaseAdmin.from("support_import_snapshots").upsert({
    id,
    data,
    created_at: data.createdAt,
  }));
}

export async function restoreImportSnapshot(id: string) {
  const data = await must("Failed to read import snapshot", supabaseAdmin.from("support_import_snapshots").select("data").eq("id", id).maybeSingle());
  const snapshot = row(data, importCoreSnapshotSchema);
  if (!snapshot) throw new Error("Relational import snapshot not found");

  await clearTable("support_ticket_history");
  await clearTable("support_tickets");
  await clearTable("support_audit_log");
  await upsertRows("support_tickets", snapshot.tickets.map(ticketRow));
  await upsertRows("support_ticket_history", snapshot.history.map(historyRow));
  await upsertRows("support_audit_log", snapshot.audit.map(auditRow));
  return {
    tickets: snapshot.tickets.length,
    history: snapshot.history.length,
    audit: snapshot.audit.length,
  };
}

export async function loadDashboardData() {
  const [customers, tickets] = await Promise.all([listCustomers(), listTickets()]);
  return { customers, tickets };
}

export async function loadTicketManagerData() {
  const [tickets, customers, statuses, sla, holidays, issueTypes, teams] = await Promise.all([
    listTickets(),
    listCustomers(),
    listMaster("statuses", statusListSchema),
    listMaster("sla", slaListSchema),
    listMaster("holidays", z.array(z.object({ id: z.string(), date: z.string(), name: z.string() }))),
    listMaster("issueTypes", namedMasterListSchema),
    listMaster("teams", namedMasterListSchema),
  ]);
  return { tickets, customers, statuses, sla, holidays, issueTypes, teams };
}

export async function loadMasterData() {
  const [sla, holidays, teams, statuses, priorities, issueTypes, contractTypes] = await Promise.all([
    listMaster("sla", slaListSchema),
    listMaster("holidays", z.array(z.object({ id: z.string(), date: z.string(), name: z.string() }))),
    listMaster("teams", namedMasterListSchema),
    listMaster("statuses", statusListSchema),
    listMaster("priorities", namedMasterListSchema),
    listMaster("issueTypes", namedMasterListSchema),
    listMaster("contractTypes", namedMasterListSchema),
  ]);
  return { sla, holidays, teams, statuses, priorities, issueTypes, contractTypes };
}

export async function loadExportData() {
  const [customers, tickets, sla, holidays, teams, statuses, priorities, issueTypes, contractTypes] = await Promise.all([
    listCustomers(),
    listTickets(),
    listMaster("sla", slaListSchema),
    listMaster("holidays", z.array(z.object({ id: z.string(), date: z.string(), name: z.string() }))),
    listMaster("teams", namedMasterListSchema),
    listMaster("statuses", statusListSchema),
    listMaster("priorities", namedMasterListSchema),
    listMaster("issueTypes", namedMasterListSchema),
    listMaster("contractTypes", namedMasterListSchema),
  ]);
  return { customers, tickets, sla, holidays, teams, statuses, priorities, issueTypes, contractTypes };
}

export const schemas = {
  user: userSchema,
  audit: auditSchema,
  customer: customerSchema,
  ticket: ticketSchema,
  reportJob: reportJobSchema,
};
