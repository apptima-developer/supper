import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  customerKey,
  hoursFromMd,
  mapKanbanStatus,
  normalize,
  normalizeOwnerEfforts,
  ticketDiff,
} from "./domain";
import { listBackups, readJson } from "./json-store";
import {
  auditRepository,
  customerRepository,
  importRepository,
  masterRepositories,
  replaceImportedCoreData,
  ticketHistoryRepository,
  ticketRepository,
  writeAudit,
} from "./repositories";
import {
  auditListSchema,
  historyListSchema,
  ticketListSchema,
  type Audit,
  type Customer,
  type Holiday,
  type ImportBatch,
  type NamedMaster,
  type Sla,
  type Status,
  type Ticket,
} from "./types";

type Row = Record<string, unknown>;
type CustomerInput = Omit<Customer, "id" | "createdAt" | "updatedAt">;
type TicketInput = Omit<Ticket, "id" | "createdAt" | "updatedAt">;
type CustomerLookup = Pick<Customer, "key" | "customerName" | "startPeriod" | "endPeriod">;

type ImportReferenceData = {
  customers: CustomerLookup[];
  priorities: NamedMaster[];
  issueTypes: NamedMaster[];
};

const mappingsSchema = z.object({
  snow: z.record(z.string(), z.string()),
  supportdesk: z.object({
    customerAliases: z.record(z.string(), z.string()).default({}),
  }).default({ customerAliases: {} }),
});

const text = (value: unknown) => value == null ? "" : String(value).trim();
const cleanHeader = (value: unknown) => text(value).replace(/\s+/g, " ");
const number = (value: unknown) => {
  const parsed = Number(String(value ?? "0").replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
};
const bool = (value: unknown) => {
  const normalized = text(value).toLowerCase();
  return ["yes", "y", "true", "1", "chargeable"].includes(normalized);
};

function stableId(value: string) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12).toUpperCase();
}

function normalizeToken(value: string) {
  return normalize(value).replace(/[^a-z0-9ก-๙]+/giu, "");
}

function activeMasterNames(items: NamedMaster[]) {
  return items.filter((item) => item.active).map((item) => item.name).filter(Boolean);
}

function canonicalNamedValue(raw: string, names: string[], fallback: string, aliases: Record<string, string> = {}) {
  const value = text(raw);
  if (!value) return fallback;
  const byNormalize = new Map(names.map((name) => [normalize(name), name]));
  const normalized = normalize(value);
  const direct = byNormalize.get(normalized);
  if (direct) return direct;

  const token = normalizeToken(value);
  const aliasTarget = aliases[normalized] || aliases[token];
  if (aliasTarget) {
    const canonical = byNormalize.get(normalize(aliasTarget));
    if (canonical) return canonical;
  }

  const tokenMatch = names.find((name) => normalizeToken(name) === token);
  return tokenMatch || value || fallback;
}

function canonicalSeverity(raw: string, priorities: NamedMaster[]) {
  return canonicalNamedValue(raw, activeMasterNames(priorities), "Unspecified", {
    "1": "Critical",
    "1critical": "Critical",
    p1: "Critical",
    p1critical: "Critical",
    critical: "Critical",
    crit: "Critical",
    "priority1": "Critical",
    priority1critical: "Critical",
    "2": "High",
    "2high": "High",
    p2: "High",
    p2high: "High",
    high: "High",
    "priority2": "High",
    priority2high: "High",
    "3": "Medium",
    "3medium": "Medium",
    p3: "Medium",
    p3medium: "Medium",
    medium: "Medium",
    med: "Medium",
    "priority3": "Medium",
    priority3medium: "Medium",
    "4": "Low",
    "4low": "Low",
    p4: "Low",
    p4low: "Low",
    low: "Low",
    "priority4": "Low",
    priority4low: "Low",
    unspecified: "Unspecified",
  });
}

function canonicalIssueType(raw: string, issueTypes: NamedMaster[]) {
  return canonicalNamedValue(raw, activeMasterNames(issueTypes), "", {
    cr: "Change",
    change: "Change",
    changerequest: "Change",
    sr: "Request",
    request: "Request",
    servicerequest: "Request",
    incident: "Incident",
    inc: "Incident",
    problem: "Incident",
  });
}

function date(value: unknown) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    return new Date(Date.UTC(1899, 11, 30 + value)).toISOString().slice(0, 10);
  }
  const raw = text(value);
  const dmy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmy) {
    const year = Number(dmy[3]) > 2400 ? Number(dmy[3]) - 543 : Number(dmy[3]);
    return `${year}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : parsed.toISOString().slice(0, 10);
}

function cellValue(value: ExcelJS.CellValue): unknown {
  if (value == null) return "";
  if (value instanceof Date) return value;
  if (typeof value === "object") {
    if ("result" in value) return value.result ?? "";
    if ("richText" in value) return value.richText.map((part) => part.text).join("");
    if ("text" in value) return value.text;
  }
  return value;
}

function sheetRows(workbook: ExcelJS.Workbook, name: string, headerRow = 1) {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) return [];
  const headers = sheet.getRow(headerRow).values as ExcelJS.CellValue[];
  const rows: Row[] = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRow) return;
    const record: Row = {};
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      const header = cleanHeader(cellValue(headers[column]));
      if (header) record[header] = cellValue(cell.value);
    });
    if (Object.values(record).some((value) => value !== "")) rows.push(record);
  });
  return rows;
}

export type ImportDiagnostics = {
  sourceTicketRows: number;
  blankIssueIds: number;
  syntheticIssueIds: number;
  consolidatedDuplicateGroups: number;
  conflictingDuplicateGroups: number;
  unmappedTickets: number;
  ambiguousContractMatches: number;
};

export type ParsedImport = {
  customers: CustomerInput[];
  tickets: TicketInput[];
  master: {
    sla: Sla[];
    holidays: Holiday[];
    teams: NamedMaster[];
    statuses: Status[];
    priorities: NamedMaster[];
    issueTypes: NamedMaster[];
    contractTypes: NamedMaster[];
  };
  diagnostics: ImportDiagnostics;
  warnings: string[];
};

function emptyMaster(): ParsedImport["master"] {
  return {
    sla: [], holidays: [], teams: [], statuses: [], priorities: [],
    issueTypes: [], contractTypes: [],
  };
}

function emptyDiagnostics(): ImportDiagnostics {
  return {
    sourceTicketRows: 0,
    blankIssueIds: 0,
    syntheticIssueIds: 0,
    consolidatedDuplicateGroups: 0,
    conflictingDuplicateGroups: 0,
    unmappedTickets: 0,
    ambiguousContractMatches: 0,
  };
}

function resolveCustomer(
  sourceName: string,
  ticketDate: string,
  customers: CustomerLookup[],
  aliases: Record<string, string>,
) {
  const aliasMap = new Map(
    Object.entries(aliases).map(([from, to]) => [normalize(from), to]),
  );
  const canonicalName = aliasMap.get(normalize(sourceName)) ?? sourceName;
  const matches = customers.filter(
    (customer) => normalize(customer.customerName) === normalize(canonicalName),
  );
  if (matches.length <= 1) return { customer: matches[0], ambiguous: false };

  const dated = matches.filter((customer) => {
    if (!ticketDate) return false;
    const afterStart = !customer.startPeriod || ticketDate >= customer.startPeriod;
    const beforeEnd = !customer.endPeriod || ticketDate <= customer.endPeriod;
    return afterStart && beforeEnd;
  });
  const candidates = dated.length ? dated : matches;
  const customer = [...candidates].sort((a, b) =>
    (b.startPeriod || b.endPeriod).localeCompare(a.startPeriod || a.endPeriod)
  )[0];
  return { customer, ambiguous: true };
}

function parseTickets(
  rows: Row[],
  customers: CustomerLookup[],
  aliases: Record<string, string>,
  references: Pick<ImportReferenceData, "priorities" | "issueTypes">,
  mapping?: Record<string, string>,
) {
  const col = (field: string, fallback: string) => mapping?.[field] || fallback;
  const diagnostics = emptyDiagnostics();
  diagnostics.sourceTicketRows = rows.length;
  const warnings: string[] = [];
  const parsed: Array<TicketInput & { sourceIndex: number }> = [];

  rows.forEach((row, sourceIndex) => {
    const rawIssueId = text(row[col("issueId", "Issue ID")]);
    const sourceCustomerName = text(row[col("customer", "Customer")]);
    const ticketDate = date(row[col("date", "Date")]);
    const issueTitle = text(row[col("issueTitle", "Issue Title")]);
    const isSynthetic = !rawIssueId;
    if (isSynthetic) {
      diagnostics.blankIssueIds += 1;
      diagnostics.syntheticIssueIds += 1;
    }
    const issueId = rawIssueId || `ADJ-${stableId(`${sourceCustomerName}|${ticketDate}|${issueTitle}|${number(row[col("mdUsed", "MD Used")])}`)}`;
    const resolved = resolveCustomer(sourceCustomerName, ticketDate, customers, aliases);
    if (resolved.ambiguous) diagnostics.ambiguousContractMatches += 1;
    const status = text(row[col("status", "Status")]) || (isSynthetic ? "02 - Closed" : "00 - Open");
    const owner = text(row[col("owner", "Owner")]);
    const mdUsed = number(row[col("mdUsed", "MD Used")]);
    parsed.push({
      sourceIndex,
      issueId,
      date: ticketDate,
      customerKey: resolved.customer?.key || customerKey("unmapped", sourceCustomerName),
      customerName: resolved.customer?.customerName || sourceCustomerName,
      issueTitle,
      issueType: canonicalIssueType(text(row[col("issueType", "Issue Type")]), references.issueTypes),
      severity: canonicalSeverity(text(row[col("severity", "Severity")]), references.priorities),
      owner,
      ownerEfforts: normalizeOwnerEfforts(undefined, owner, hoursFromMd(mdUsed)),
      status,
      kanbanStatus: mapKanbanStatus(status),
      startDate: date(row[col("startDate", "Start Date")]),
      dueDate: date(row[col("dueDate", "Due Date")]),
      closeDate: date(row[col("closeDate", "Close Date")]),
      mdUsed,
      chargeable: bool(row[col("chargeable", "Chargeable")]),
      remark: text(row[col("remark", "Remark")]),
      ticketLogs: [],
    });
  });

  const groups = new Map<string, typeof parsed>();
  for (const ticket of parsed) {
    groups.set(ticket.issueId, [...(groups.get(ticket.issueId) ?? []), ticket]);
  }
  const tickets: TicketInput[] = [];
  const conflictingIds: string[] = [];
  for (const [issueId, group] of groups) {
    if (group.length === 1) {
      const { sourceIndex: _, ...ticket } = group[0];
      void _;
      tickets.push(ticket);
      continue;
    }
    const customerKeys = new Set(group.map((ticket) => ticket.customerKey));
    const titles = new Set(group.map((ticket) => normalize(ticket.issueTitle)));
    if (customerKeys.size > 1 || (titles.size > 1 && group.every((ticket) => ticket.chargeable))) {
      diagnostics.conflictingDuplicateGroups += 1;
      conflictingIds.push(issueId);
      for (const item of group) {
        const { sourceIndex: _, ...ticket } = item;
        void _;
        tickets.push({
          ...ticket,
          issueId: `${issueId}~${stableId(`${ticket.customerKey}|${ticket.issueTitle}|${ticket.date}`)}`,
        });
      }
      continue;
    }
    diagnostics.consolidatedDuplicateGroups += 1;
    const latest = [...group].sort((a, b) =>
      a.date === b.date ? a.sourceIndex - b.sourceIndex : a.date.localeCompare(b.date)
    ).at(-1)!;
    const chargeableRows = group.filter((ticket) => ticket.chargeable);
    const { sourceIndex: _, ...ticket } = latest;
    void _;
    const mdUsed = chargeableRows.length
      ? Number(chargeableRows.reduce((sum, item) => sum + item.mdUsed, 0).toFixed(6))
      : ticket.mdUsed;
    tickets.push({
      ...ticket,
      chargeable: chargeableRows.length > 0,
      mdUsed,
      ownerEfforts: normalizeOwnerEfforts(undefined, ticket.owner, hoursFromMd(mdUsed)),
    });
  }

  diagnostics.unmappedTickets = tickets.filter((ticket) =>
    ticket.customerKey.startsWith("unmapped::")
  ).length;
  if (diagnostics.blankIssueIds) {
    warnings.push(`${diagnostics.blankIssueIds} rows with blank Issue ID were assigned deterministic ADJ IDs`);
  }
  if (diagnostics.consolidatedDuplicateGroups) {
    warnings.push(`${diagnostics.consolidatedDuplicateGroups} duplicate Issue ID groups for the same customer were consolidated`);
  }
  if (conflictingIds.length) {
    warnings.push(`${conflictingIds.length} conflicting Issue IDs were preserved with deterministic suffixes: ${conflictingIds.join(", ")}`);
  }
  if (diagnostics.unmappedTickets) {
    const names = [...new Set(tickets
      .filter((ticket) => ticket.customerKey.startsWith("unmapped::"))
      .map((ticket) => ticket.customerName))];
    warnings.push(`${diagnostics.unmappedTickets} tickets are not mapped to a contract: ${names.join(", ")}`);
  }
  if (diagnostics.ambiguousContractMatches) {
    warnings.push(`${diagnostics.ambiguousContractMatches} ticket rows matched a repeated customer name and were assigned by contract period`);
  }
  return { tickets, diagnostics, warnings };
}

async function loadImportReferenceData(overrides?: Partial<ImportReferenceData>): Promise<ImportReferenceData> {
  const [customers, priorities, issueTypes] = await Promise.all([
    overrides?.customers ?? customerRepository.list(),
    overrides?.priorities ?? masterRepositories.priorities.list(),
    overrides?.issueTypes ?? masterRepositories.issueTypes.list(),
  ]);
  return { customers, priorities, issueTypes };
}

export async function parseWorkbook(
  buffer: Buffer,
  kind: "supportdesk" | "snow",
  references?: Partial<ImportReferenceData>,
): Promise<ParsedImport> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  const sheetNames = workbook.worksheets.map((sheet) => sheet.name);
  const mappings = await readJson("imports/mappings.json", mappingsSchema);
  const referenceData = await loadImportReferenceData(references);
  const warnings: string[] = [];
  if (kind === "supportdesk") {
    for (const sheet of ["Issues_Log"]) {
      if (!sheetNames.includes(sheet)) warnings.push(`Missing sheet: ${sheet}`);
    }
    const parsedTickets = parseTickets(
      sheetRows(workbook, "Issues_Log"),
      referenceData.customers,
      mappings.supportdesk.customerAliases,
      referenceData,
    );
    return {
      customers: [],
      tickets: parsedTickets.tickets,
      master: emptyMaster(),
      diagnostics: parsedTickets.diagnostics,
      warnings: [
        ...warnings,
        "Import Center updates tickets only. Customer and master data stay as currently edited in the system.",
        ...parsedTickets.warnings,
      ],
    };
  }
  const parsedTickets = parseTickets(
    sheetRows(workbook, sheetNames[0]),
    referenceData.customers,
    mappings.supportdesk.customerAliases,
    referenceData,
    mappings.snow,
  );
  return {
    customers: [],
    tickets: parsedTickets.tickets,
    master: emptyMaster(),
    diagnostics: parsedTickets.diagnostics,
    warnings: parsedTickets.warnings,
  };
}

export function importPreview(parsed: ParsedImport) {
  return {
    counts: {
      customers: parsed.customers.length,
      tickets: parsed.tickets.length,
      sla: parsed.master.sla.length,
      holidays: parsed.master.holidays.length,
      teams: parsed.master.teams.length,
      statuses: parsed.master.statuses.length,
      priorities: parsed.master.priorities.length,
      issueTypes: parsed.master.issueTypes.length,
      contractTypes: parsed.master.contractTypes.length,
    },
    diagnostics: parsed.diagnostics,
    customers: parsed.customers.slice(0, 5).map((customer) => ({
      projectCode: customer.projectCode,
      customerName: customer.customerName,
      contractType: customer.contractType,
      mdPurchased: customer.mdPurchased,
    })),
    tickets: parsed.tickets.slice(0, 5).map((ticket) => ({
      issueId: ticket.issueId,
      customerName: ticket.customerName,
      issueType: ticket.issueType,
      severity: ticket.severity,
      issueTitle: ticket.issueTitle,
      status: ticket.status,
    })),
    warnings: [...new Set(parsed.warnings)].slice(0, 30),
  };
}

function auditEntry(
  action: Audit["action"],
  entity: string,
  entityId: string,
  actor: string,
  details: Record<string, unknown>,
): Audit {
  return {
    id: crypto.randomUUID(), action, entity, entityId, actor, details,
    createdAt: new Date().toISOString(),
  };
}

export async function commitImport(
  parsed: ParsedImport,
  fileName: string,
  kind: "supportdesk" | "snow",
  actor: string,
) {
  const beforeBackups = new Set(await listBackups());
  const [existingCustomers, existingTickets, existingHistory, existingAudit] = await Promise.all([
    customerRepository.list(),
    ticketRepository.list(),
    ticketHistoryRepository.list(),
    auditRepository.list(),
  ]);
  const now = new Date().toISOString();
  const batchId = crypto.randomUUID();
  const tickets = [...existingTickets];
  const history = [...existingHistory];
  const audits: Audit[] = [];
  const customersCreated = 0, customersUpdated = 0;
  let ticketsCreated = 0, ticketsUpdated = 0, ticketsSkipped = 0;

  const customerKeys = new Set(existingCustomers.map((customer) => customer.key));
  for (const incoming of parsed.tickets) {
    if (incoming.customerKey.startsWith("unmapped::") || !customerKeys.has(incoming.customerKey)) {
      ticketsSkipped += 1;
      continue;
    }
    const index = tickets.findIndex((ticket) => ticket.issueId === incoming.issueId);
    if (index >= 0) {
      const previous = tickets[index];
      const candidate: Ticket = { ...previous, ...incoming, id: previous.id, updatedAt: previous.updatedAt };
      const changes = ticketDiff(previous, candidate);
      if (!changes.length) continue;
      const next: Ticket = { ...candidate, updatedAt: now };
      tickets[index] = next;
      for (const change of changes) {
        history.unshift({
          id: crypto.randomUUID(), ticketId: next.id, issueId: next.issueId,
          ...change, actor, source: kind === "snow" ? "snow" : "excel", createdAt: now,
        });
      }
      ticketsUpdated += 1;
      audits.push(auditEntry("update", "ticket", next.id, actor, {
        source: kind, fields: changes.map((change) => change.field),
      }));
    } else {
      const ticket: Ticket = {
        ...incoming, id: crypto.randomUUID(), createdAt: now, updatedAt: now,
      };
      tickets.push(ticket);
      ticketsCreated += 1;
      audits.push(auditEntry("create", "ticket", ticket.id, actor, { source: kind }));
    }
  }

  const relationalBackups = await replaceImportedCoreData({
    tickets: ticketListSchema.parse(tickets),
    history: historyListSchema.parse(history),
    audit: auditListSchema.parse([...audits.reverse(), ...existingAudit].slice(0, 10000)),
    backupId: batchId,
  });

  const summary = {
    customersCreated, customersUpdated, ticketsCreated, ticketsUpdated, ticketsSkipped,
      blankIssueIds: parsed.diagnostics.blankIssueIds,
      syntheticIssueIds: parsed.diagnostics.syntheticIssueIds,
    duplicatesConsolidated: parsed.diagnostics.consolidatedDuplicateGroups,
    duplicateConflicts: parsed.diagnostics.conflictingDuplicateGroups,
    unmappedTickets: parsed.diagnostics.unmappedTickets,
  };
  const afterBackups = (await listBackups()).filter((backup) => !beforeBackups.has(backup));
  const batch: ImportBatch = {
    id: batchId, fileName, kind, status: "completed", summary,
    backupPaths: [...relationalBackups, ...afterBackups], actor, createdAt: now,
  };
  await importRepository.add(batch);
  await writeAudit({
    action: "import", entity: "import-batch", entityId: batch.id, actor,
    details: { fileName, kind, ...summary },
  });
  return batch;
}
