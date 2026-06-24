import { customerListSchema, ticketListSchema, historyListSchema, auditListSchema, statusListSchema, slaListSchema, namedMasterListSchema, holidayListSchema, importBatchListSchema, reportJobListSchema, type Customer, type Ticket, type TicketHistory, type Audit, type Status, type Sla, type NamedMaster, type Holiday, type ImportBatch, type ReportJob } from "./types";
import { readJson, updateJson } from "./json-store";
import { recalculateCustomer, ticketDiff } from "./domain";

const paths = {
  customers: "core/customers.json",
  tickets: "core/tickets.json",
  history: "core/ticket-history.json",
  audit: "audit/audit-log.json",
  statuses: "master/statuses.json",
  sla: "master/sla.json",
  holidays: "master/holidays.json",
  teams: "master/teams.json",
  issueTypes: "master/issue-types.json",
  contractTypes: "master/contract-types.json",
  priorities: "master/priorities.json",
  imports: "imports/import-batches.json",
  reports: "reports/report-jobs.json",
} as const;

export async function writeAudit(entry: Omit<Audit, "id" | "createdAt">) {
  const audit: Audit = { ...entry, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  await updateJson(paths.audit, auditListSchema, (items) => [audit, ...items].slice(0, 10000));
  return audit;
}

export const auditRepository = { list: () => readJson(paths.audit, auditListSchema) };

export const customerRepository = {
  list: () => readJson(paths.customers, customerListSchema),
  async get(id: string) { return (await this.list()).find((item) => item.id === id || item.key === id); },
  async create(input: Omit<Customer, "id" | "createdAt" | "updatedAt">, actor: string) {
    const now = new Date().toISOString();
    const customer: Customer = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    await updateJson(paths.customers, customerListSchema, (items) => {
      if (items.some((item) => item.key === customer.key)) throw new Error("Customer project and name already exist");
      return [...items, customer];
    });
    await writeAudit({ action: "create", entity: "customer", entityId: customer.id, actor, details: { key: customer.key } });
    return customer;
  },
  async update(id: string, patch: Partial<Customer>, actor: string) {
    let updated: Customer | undefined;
    await updateJson(paths.customers, customerListSchema, (items) => items.map((item) => {
      if (item.id !== id) return item;
      updated = { ...item, ...patch, id: item.id, updatedAt: new Date().toISOString() };
      return updated;
    }));
    if (!updated) throw new Error("Customer not found");
    if (["mdPurchased", "carryForward"].some((field) => field in patch)) {
      await refreshCustomer(updated.key);
      updated = await this.get(updated.id) || updated;
    }
    await writeAudit({ action: "update", entity: "customer", entityId: id, actor, details: { fields: Object.keys(patch) } });
    return updated;
  },
  async delete(id: string, actor: string) {
    await updateJson(paths.customers, customerListSchema, (items) => items.filter((item) => item.id !== id));
    await writeAudit({ action: "delete", entity: "customer", entityId: id, actor, details: {} });
  },
};

async function appendTicketHistory(previous: Ticket, next: Ticket, actor: string, source: TicketHistory["source"]) {
  const changes: TicketHistory[] = ticketDiff(previous, next).map((change) => ({
    id: crypto.randomUUID(), ticketId: next.id, issueId: next.issueId, ...change, actor, source, createdAt: new Date().toISOString(),
  }));
  if (changes.length) await updateJson(paths.history, historyListSchema, (items) => [...changes.reverse(), ...items]);
}

async function refreshCustomer(customerKey: string) {
  const tickets = await readJson(paths.tickets, ticketListSchema);
  await updateJson(paths.customers, customerListSchema, (items) => items.map((customer) => customer.key === customerKey ? recalculateCustomer(customer, tickets) : customer));
}

export const ticketRepository = {
  list: () => readJson(paths.tickets, ticketListSchema),
  async get(id: string) { return (await this.list()).find((item) => item.id === id || item.issueId === id); },
  history: async (id: string) => (await readJson(paths.history, historyListSchema)).filter((item) => item.ticketId === id || item.issueId === id),
  async create(input: Omit<Ticket, "id" | "createdAt" | "updatedAt">, actor: string, source: TicketHistory["source"] = "ui") {
    const now = new Date().toISOString();
    const ticket: Ticket = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    await updateJson(paths.tickets, ticketListSchema, (items) => {
      if (items.some((item) => item.issueId === ticket.issueId)) throw new Error("Issue ID already exists");
      return [...items, ticket];
    });
    await writeAudit({ action: "create", entity: "ticket", entityId: ticket.id, actor, details: { issueId: ticket.issueId, source } });
    await refreshCustomer(ticket.customerKey);
    return ticket;
  },
  async update(id: string, patch: Partial<Ticket>, actor: string, source: TicketHistory["source"] = "ui") {
    let previous: Ticket | undefined;
    let updated: Ticket | undefined;
    await updateJson(paths.tickets, ticketListSchema, (items) => items.map((item) => {
      if (item.id !== id) return item;
      previous = item;
      updated = { ...item, ...patch, id: item.id, updatedAt: new Date().toISOString() };
      return updated;
    }));
    if (!previous || !updated) throw new Error("Ticket not found");
    await appendTicketHistory(previous, updated, actor, source);
    await writeAudit({ action: "update", entity: "ticket", entityId: id, actor, details: { fields: Object.keys(patch), source } });
    await refreshCustomer(previous.customerKey);
    if (previous.customerKey !== updated.customerKey) await refreshCustomer(updated.customerKey);
    return updated;
  },
  async delete(id: string, actor: string) {
    const ticket = await this.get(id);
    await updateJson(paths.tickets, ticketListSchema, (items) => items.filter((item) => item.id !== id));
    await writeAudit({ action: "delete", entity: "ticket", entityId: id, actor, details: {} });
    if (ticket) await refreshCustomer(ticket.customerKey);
  },
};

function namedRepository(file: "teams" | "issueTypes" | "contractTypes" | "priorities") {
  return {
    list: () => readJson(paths[file], namedMasterListSchema),
    async save(items: NamedMaster[], actor: string) {
      await updateJson(paths[file], namedMasterListSchema, () => items);
      await writeAudit({ action: "update", entity: file, entityId: "all", actor, details: { count: items.length } });
    },
  };
}

export const masterRepositories = {
  statuses: { list: () => readJson(paths.statuses, statusListSchema), save: async (items: Status[], actor: string) => { await updateJson(paths.statuses, statusListSchema, () => items); await writeAudit({ action: "update", entity: "statuses", entityId: "all", actor, details: { count: items.length } }); } },
  sla: { list: () => readJson(paths.sla, slaListSchema), save: async (items: Sla[], actor: string) => { await updateJson(paths.sla, slaListSchema, () => items); await writeAudit({ action: "update", entity: "sla", entityId: "all", actor, details: { count: items.length } }); } },
  holidays: { list: () => readJson(paths.holidays, holidayListSchema), save: async (items: Holiday[], actor: string) => { await updateJson(paths.holidays, holidayListSchema, () => items); await writeAudit({ action: "update", entity: "holidays", entityId: "all", actor, details: { count: items.length } }); } },
  teams: namedRepository("teams"), priorities: namedRepository("priorities"), issueTypes: namedRepository("issueTypes"), contractTypes: namedRepository("contractTypes"),
};

export const importRepository = { list: () => readJson(paths.imports, importBatchListSchema), add: async (item: ImportBatch) => updateJson(paths.imports, importBatchListSchema, (items) => [item, ...items]), update: async (id: string, patch: Partial<ImportBatch>) => updateJson(paths.imports, importBatchListSchema, (items) => items.map((item) => item.id === id ? { ...item, ...patch, id: item.id } : item)) };
export const reportRepository = { list: () => readJson(paths.reports, reportJobListSchema), add: async (item: ReportJob) => updateJson(paths.reports, reportJobListSchema, (items) => [item, ...items]) };
