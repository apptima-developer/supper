import path from "node:path";
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("Missing Supabase env. Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.");
}

const supabase = createClient(new URL(supabaseUrl).origin, serviceRoleKey, {
  auth: {
    persistSession: false,
  },
});

const coreKeys = [
  "core/customers.json",
  "core/tickets.json",
  "core/ticket-history.json",
  "audit/audit-log.json",
  "auth/users.json",
  "imports/import-batches.json",
  "reports/report-jobs.json",
  "master/statuses.json",
  "master/sla.json",
  "master/holidays.json",
  "master/teams.json",
  "master/priorities.json",
  "master/issue-types.json",
  "master/contract-types.json",
];

const masterKinds = [
  ["statuses", "master/statuses.json"],
  ["sla", "master/sla.json"],
  ["holidays", "master/holidays.json"],
  ["teams", "master/teams.json"],
  ["priorities", "master/priorities.json"],
  ["issueTypes", "master/issue-types.json"],
  ["contractTypes", "master/contract-types.json"],
];

function parseDate(value) {
  if (!value) return null;
  const date = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
}

function parseTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function readAppStore(keys) {
  const { data, error } = await supabase
    .from("app_store")
    .select("key,value")
    .in("key", keys);

  if (error) throw new Error(`Failed to read app_store: ${error.message}`);
  return new Map((data || []).map((row) => [row.key, row.value]));
}

async function listAppStoreKeys(prefix) {
  const keys = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from("app_store")
      .select("key")
      .like("key", `${prefix}%`)
      .order("key", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw new Error(`Failed to list app_store keys for ${prefix}: ${error.message}`);
    keys.push(...(data || []).map((row) => row.key));
    if (!data || data.length < pageSize) break;
  }
  return keys;
}

async function upsertRows(table, rows, options = undefined) {
  const chunkSize = 500;
  let count = 0;
  for (let index = 0; index < rows.length; index += chunkSize) {
    const chunk = rows.slice(index, index + chunkSize);
    if (!chunk.length) continue;
    const { error } = await supabase.from(table).upsert(chunk, options);
    if (error) {
      throw new Error(`Failed to upsert ${table}: ${error.message}. Run scripts/supabase-relational-schema.sql in Supabase SQL Editor first.`);
    }
    count += chunk.length;
  }
  console.log(`Upserted ${count} rows -> ${table}`);
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function customerRow(customer) {
  return {
    id: customer.id,
    customer_key: customer.key,
    customer_name: customer.customerName || "",
    project_code: customer.projectCode || "",
    active: Boolean(customer.active),
    end_period: parseDate(customer.endPeriod),
    updated_at: parseTimestamp(customer.updatedAt) || new Date().toISOString(),
    data: customer,
  };
}

function ticketRow(ticket) {
  return {
    id: ticket.id,
    issue_id: ticket.issueId,
    customer_key: ticket.customerKey || "",
    customer_name: ticket.customerName || "",
    kanban_status: ticket.kanbanStatus || "",
    status: ticket.status || "",
    issue_type: ticket.issueType || "",
    severity: ticket.severity || "",
    ticket_date: parseDate(ticket.date),
    start_date: parseDate(ticket.startDate),
    due_date: parseDate(ticket.dueDate),
    close_date: parseDate(ticket.closeDate),
    updated_at: parseTimestamp(ticket.updatedAt) || new Date().toISOString(),
    data: ticket,
  };
}

function historyRow(item) {
  return {
    id: item.id,
    ticket_id: item.ticketId || "",
    issue_id: item.issueId || "",
    field: item.field || "",
    source: item.source || "",
    created_at: parseTimestamp(item.createdAt) || new Date().toISOString(),
    data: item,
  };
}

function auditRow(item) {
  return {
    id: item.id,
    action: item.action || "",
    entity: item.entity || "",
    entity_id: item.entityId || "",
    actor: item.actor || "",
    created_at: parseTimestamp(item.createdAt) || new Date().toISOString(),
    data: item,
  };
}

function userRow(item) {
  return {
    id: item.id,
    username: String(item.username || "").toLowerCase(),
    email: String(item.email || "").toLowerCase(),
    role: item.role || "",
    active: item.active !== false,
    data: item,
  };
}

function importBatchRow(item) {
  return {
    id: item.id,
    status: item.status || "",
    kind: item.kind || "",
    created_at: parseTimestamp(item.createdAt) || new Date().toISOString(),
    data: item,
  };
}

function reportJobRow(item) {
  return {
    id: item.id,
    customer_key: item.customerKey || "",
    month: item.month || "",
    status: item.status || "",
    created_at: parseTimestamp(item.createdAt) || new Date().toISOString(),
    data: item,
  };
}

function reportAssetRow(key, asset) {
  const fileName = path.basename(asset?.fileName || key);
  return {
    file_name: fileName,
    content_type: asset?.contentType || "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    created_at: parseTimestamp(asset?.createdAt) || new Date().toISOString(),
    data: {
      fileName,
      contentType: asset?.contentType || "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      base64: asset?.base64 || "",
      createdAt: asset?.createdAt || new Date().toISOString(),
    },
  };
}

const reportAssetKeys = await listAppStoreKeys("reports/generated/");
const appStore = await readAppStore([...coreKeys, ...reportAssetKeys]);

await upsertRows("support_customers", list(appStore.get("core/customers.json")).map(customerRow));
await upsertRows("support_tickets", list(appStore.get("core/tickets.json")).map(ticketRow));
await upsertRows("support_ticket_history", list(appStore.get("core/ticket-history.json")).map(historyRow));
await upsertRows("support_audit_log", list(appStore.get("audit/audit-log.json")).slice(0, 10000).map(auditRow));
await upsertRows("support_users", list(appStore.get("auth/users.json")).map(userRow));
await upsertRows("support_import_batches", list(appStore.get("imports/import-batches.json")).map(importBatchRow));
await upsertRows("support_report_jobs", list(appStore.get("reports/report-jobs.json")).map(reportJobRow));
await upsertRows("support_master_data", masterKinds.map(([kind, key]) => ({
  kind,
  data: list(appStore.get(key)),
  updated_at: new Date().toISOString(),
})));
await upsertRows("support_report_assets", reportAssetKeys
  .map((key) => reportAssetRow(key, appStore.get(key)))
  .filter((row) => row.data.base64));

console.log("Relational migration complete. Set DATA_BACKEND=supabase-relational after verifying row counts.");
