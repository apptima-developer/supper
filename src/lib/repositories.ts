import { cache } from "react";
import { customerListSchema, ticketListSchema, historyListSchema, auditListSchema, statusListSchema, slaListSchema, namedMasterListSchema, holidayListSchema, importBatchListSchema, reportJobListSchema, userListSchema, type Customer, type Ticket, type TicketHistory, type Audit, type Status, type Sla, type NamedMaster, type Holiday, type ImportBatch, type ReportJob, type User } from "./types";
import { readJson, readJsonBatch, restoreBackupSet, updateJson } from "./json-store";
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

const specs = {
  customers: { path: paths.customers, schema: customerListSchema },
  tickets: { path: paths.tickets, schema: ticketListSchema },
  history: { path: paths.history, schema: historyListSchema },
  audit: { path: paths.audit, schema: auditListSchema },
  statuses: { path: paths.statuses, schema: statusListSchema },
  sla: { path: paths.sla, schema: slaListSchema },
  holidays: { path: paths.holidays, schema: holidayListSchema },
  teams: { path: paths.teams, schema: namedMasterListSchema },
  priorities: { path: paths.priorities, schema: namedMasterListSchema },
  issueTypes: { path: paths.issueTypes, schema: namedMasterListSchema },
  contractTypes: { path: paths.contractTypes, schema: namedMasterListSchema },
  imports: { path: paths.imports, schema: importBatchListSchema },
  reports: { path: paths.reports, schema: reportJobListSchema },
  users: { path: "auth/users.json", schema: userListSchema },
} as const;

function relationalEnabled() {
  return process.env.DATA_BACKEND === "supabase-relational" || process.env.SUPABASE_DATA_MODEL === "relational";
}

async function relational() {
  return import("./relational-store");
}

export const loadDashboardData = cache(async () => relationalEnabled()
  ? (await relational()).loadDashboardData()
  : readJsonBatch({
      customers: specs.customers,
      tickets: specs.tickets,
    }));

export const loadCustomerManagerData = cache(async () => {
  if (relationalEnabled()) {
    const store = await relational();
    const [customers, contractTypes] = await Promise.all([
      store.listCustomers(),
      store.listMaster("contractTypes", namedMasterListSchema),
    ]);
    return { customers, contractTypes };
  }
  return readJsonBatch({
    customers: specs.customers,
    contractTypes: specs.contractTypes,
  });
});

export const loadCustomerDetailData = cache(async (id: string) => {
  if (relationalEnabled()) {
    const store = await relational();
    const customer = await store.getCustomer(id);
    return {
      customer,
      tickets: customer ? await store.listTicketsByCustomer(customer.key) : [],
    };
  }
  const { customers, tickets } = await loadDashboardData();
  const customer = customers.find((item) => item.id === id || item.key === id);
  return {
    customer,
    tickets: customer ? tickets.filter((ticket) => ticket.customerKey === customer.key) : [],
  };
});

export const loadTicketManagerData = cache(async () => relationalEnabled()
  ? (await relational()).loadTicketManagerData()
  : readJsonBatch({
      tickets: specs.tickets,
      customers: specs.customers,
      statuses: specs.statuses,
      sla: specs.sla,
      holidays: specs.holidays,
      issueTypes: specs.issueTypes,
      teams: specs.teams,
    }));

export const loadTicketDetailData = cache(async (id: string) => {
  if (relationalEnabled()) {
    const store = await relational();
    const ticket = await store.getTicket(id);
    return {
      ticket,
      history: ticket ? await store.listTicketHistory(ticket.id, ticket.issueId) : [],
    };
  }
  const { tickets, history } = await readJsonBatch({
    tickets: specs.tickets,
    history: specs.history,
  });
  const ticket = tickets.find((item) => item.id === id || item.issueId === id);
  return {
    ticket,
    history: ticket ? history.filter((item) => item.ticketId === ticket.id || item.issueId === ticket.issueId) : [],
  };
});

export const loadMasterData = cache(async () => relationalEnabled()
  ? (await relational()).loadMasterData()
  : readJsonBatch({
      sla: specs.sla,
      holidays: specs.holidays,
      teams: specs.teams,
      statuses: specs.statuses,
      priorities: specs.priorities,
      issueTypes: specs.issueTypes,
      contractTypes: specs.contractTypes,
    }));

export const loadEffortMatrixData = cache(async () => {
  if (relationalEnabled()) {
    const store = await relational();
    const [tickets, customers, teams] = await Promise.all([
      store.listTickets(),
      store.listCustomers(),
      store.listMaster("teams", namedMasterListSchema),
    ]);
    return { tickets, customers, teams };
  }
  return readJsonBatch({
    tickets: specs.tickets,
    customers: specs.customers,
    teams: specs.teams,
  });
});

export const loadReportPageData = cache(async () => {
  if (relationalEnabled()) {
    const store = await relational();
    const [customers, tickets, jobs] = await Promise.all([
      store.listCustomers(),
      store.listTickets(),
      store.listReportJobs(),
    ]);
    return { customers, tickets, jobs };
  }
  return readJsonBatch({
    customers: specs.customers,
    tickets: specs.tickets,
    jobs: specs.reports,
  });
});

export const loadExportData = cache(async () => relationalEnabled()
  ? (await relational()).loadExportData()
  : readJsonBatch({
      customers: specs.customers,
      tickets: specs.tickets,
      sla: specs.sla,
      holidays: specs.holidays,
      teams: specs.teams,
      statuses: specs.statuses,
      priorities: specs.priorities,
      issueTypes: specs.issueTypes,
      contractTypes: specs.contractTypes,
    }));

export async function writeAudit(entry: Omit<Audit, "id" | "createdAt">) {
  const audit: Audit = { ...entry, id: crypto.randomUUID(), createdAt: new Date().toISOString() };
  if (relationalEnabled()) {
    await (await relational()).addAudit(audit);
    return audit;
  }
  await updateJson(paths.audit, auditListSchema, (items) => [audit, ...items].slice(0, 10000));
  return audit;
}

export const auditRepository = { list: async () => relationalEnabled() ? (await relational()).listAudit() : readJson(paths.audit, auditListSchema) };

export const ticketHistoryRepository = {
  list: async () => relationalEnabled() ? (await relational()).listAllTicketHistory() : readJson(paths.history, historyListSchema),
};

export const customerRepository = {
  list: async () => relationalEnabled() ? (await relational()).listCustomers() : readJson(paths.customers, customerListSchema),
  async get(id: string) { return relationalEnabled() ? (await relational()).getCustomer(id) : (await this.list()).find((item) => item.id === id || item.key === id); },
  async create(input: Omit<Customer, "id" | "createdAt" | "updatedAt">, actor: string) {
    const now = new Date().toISOString();
    const customer: Customer = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    if (relationalEnabled()) {
      if ((await this.list()).some((item) => item.key === customer.key)) throw new Error("Customer project and name already exist");
      await (await relational()).upsertCustomer(customer);
      await writeAudit({ action: "create", entity: "customer", entityId: customer.id, actor, details: { key: customer.key } });
      return customer;
    }
    await updateJson(paths.customers, customerListSchema, (items) => {
      if (items.some((item) => item.key === customer.key)) throw new Error("Customer project and name already exist");
      return [...items, customer];
    });
    await writeAudit({ action: "create", entity: "customer", entityId: customer.id, actor, details: { key: customer.key } });
    return customer;
  },
  async update(id: string, patch: Partial<Customer>, actor: string) {
    let updated: Customer | undefined;
    if (relationalEnabled()) {
      const current = await this.get(id);
      if (!current) throw new Error("Customer not found");
      if (patch.key && patch.key !== current.key && (await this.list()).some((item) => item.id !== current.id && item.key === patch.key)) throw new Error("Customer project and name already exist");
      updated = { ...current, ...patch, id: current.id, updatedAt: new Date().toISOString() };
      await (await relational()).upsertCustomer(updated);
      if (["mdPurchased", "carryForward"].some((field) => field in patch)) {
        await refreshCustomer(updated.key);
        updated = await this.get(updated.id) || updated;
      }
      await writeAudit({ action: "update", entity: "customer", entityId: id, actor, details: { fields: Object.keys(patch) } });
      return updated;
    }
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
    if (relationalEnabled()) {
      await (await relational()).deleteCustomer(id);
      await writeAudit({ action: "delete", entity: "customer", entityId: id, actor, details: {} });
      return;
    }
    await updateJson(paths.customers, customerListSchema, (items) => items.filter((item) => item.id !== id));
    await writeAudit({ action: "delete", entity: "customer", entityId: id, actor, details: {} });
  },
};

async function appendTicketHistory(previous: Ticket, next: Ticket, actor: string, source: TicketHistory["source"]) {
  const changes: TicketHistory[] = ticketDiff(previous, next).map((change) => ({
    id: crypto.randomUUID(), ticketId: next.id, issueId: next.issueId, ...change, actor, source, createdAt: new Date().toISOString(),
  }));
  if (changes.length && relationalEnabled()) {
    await (await relational()).addTicketHistory(changes.reverse());
    return;
  }
  if (changes.length) await updateJson(paths.history, historyListSchema, (items) => [...changes.reverse(), ...items]);
}

async function refreshCustomer(customerKey: string) {
  if (relationalEnabled()) {
    const store = await relational();
    const customer = await store.getCustomer(customerKey);
    if (customer) await store.upsertCustomer(recalculateCustomer(customer, await store.listTicketsByCustomer(customer.key)));
    return;
  }
  const tickets = await readJson(paths.tickets, ticketListSchema);
  await updateJson(paths.customers, customerListSchema, (items) => items.map((customer) => customer.key === customerKey ? recalculateCustomer(customer, tickets) : customer));
}

export const ticketRepository = {
  list: async () => relationalEnabled() ? (await relational()).listTickets() : readJson(paths.tickets, ticketListSchema),
  async get(id: string) { return relationalEnabled() ? (await relational()).getTicket(id) : (await this.list()).find((item) => item.id === id || item.issueId === id); },
  history: async (id: string) => {
    if (relationalEnabled()) {
      const ticket = await (await relational()).getTicket(id);
      return ticket ? (await relational()).listTicketHistory(ticket.id, ticket.issueId) : [];
    }
    return (await readJson(paths.history, historyListSchema)).filter((item) => item.ticketId === id || item.issueId === id);
  },
  async create(input: Omit<Ticket, "id" | "createdAt" | "updatedAt">, actor: string, source: TicketHistory["source"] = "ui") {
    const now = new Date().toISOString();
    const ticket: Ticket = { ...input, id: crypto.randomUUID(), createdAt: now, updatedAt: now };
    if (relationalEnabled()) {
      if (await (await relational()).getTicket(ticket.issueId)) throw new Error("Issue ID already exists");
      await (await relational()).upsertTicket(ticket);
      await writeAudit({ action: "create", entity: "ticket", entityId: ticket.id, actor, details: { issueId: ticket.issueId, source } });
      await refreshCustomer(ticket.customerKey);
      return ticket;
    }
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
    if (relationalEnabled()) {
      previous = await this.get(id);
      if (!previous) throw new Error("Ticket not found");
      updated = { ...previous, ...patch, id: previous.id, updatedAt: new Date().toISOString() };
      await (await relational()).upsertTicket(updated);
      await appendTicketHistory(previous, updated, actor, source);
      await writeAudit({ action: "update", entity: "ticket", entityId: id, actor, details: { fields: Object.keys(patch), source } });
      await refreshCustomer(previous.customerKey);
      if (previous.customerKey !== updated.customerKey) await refreshCustomer(updated.customerKey);
      return updated;
    }
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
    if (relationalEnabled()) {
      await (await relational()).deleteTicket(id);
      await writeAudit({ action: "delete", entity: "ticket", entityId: id, actor, details: {} });
      if (ticket) await refreshCustomer(ticket.customerKey);
      return;
    }
    await updateJson(paths.tickets, ticketListSchema, (items) => items.filter((item) => item.id !== id));
    await writeAudit({ action: "delete", entity: "ticket", entityId: id, actor, details: {} });
    if (ticket) await refreshCustomer(ticket.customerKey);
  },
};

function namedRepository(file: "teams" | "issueTypes" | "contractTypes" | "priorities") {
  return {
    list: async () => relationalEnabled() ? (await relational()).listMaster(file, namedMasterListSchema) : readJson(paths[file], namedMasterListSchema),
    async save(items: NamedMaster[], actor: string) {
      if (relationalEnabled()) await (await relational()).saveMaster(file, items);
      else await updateJson(paths[file], namedMasterListSchema, () => items);
      await writeAudit({ action: "update", entity: file, entityId: "all", actor, details: { count: items.length } });
    },
  };
}

export const masterRepositories = {
  statuses: {
    list: async () => relationalEnabled() ? (await relational()).listMaster("statuses", statusListSchema) : readJson(paths.statuses, statusListSchema),
    save: async (items: Status[], actor: string) => {
      if (relationalEnabled()) await (await relational()).saveMaster("statuses", items);
      else await updateJson(paths.statuses, statusListSchema, () => items);
      await writeAudit({ action: "update", entity: "statuses", entityId: "all", actor, details: { count: items.length } });
    },
  },
  sla: {
    list: async () => relationalEnabled() ? (await relational()).listMaster("sla", slaListSchema) : readJson(paths.sla, slaListSchema),
    save: async (items: Sla[], actor: string) => {
      if (relationalEnabled()) await (await relational()).saveMaster("sla", items);
      else await updateJson(paths.sla, slaListSchema, () => items);
      await writeAudit({ action: "update", entity: "sla", entityId: "all", actor, details: { count: items.length } });
    },
  },
  holidays: {
    list: async () => relationalEnabled() ? (await relational()).listMaster("holidays", holidayListSchema) : readJson(paths.holidays, holidayListSchema),
    save: async (items: Holiday[], actor: string) => {
      if (relationalEnabled()) await (await relational()).saveMaster("holidays", items);
      else await updateJson(paths.holidays, holidayListSchema, () => items);
      await writeAudit({ action: "update", entity: "holidays", entityId: "all", actor, details: { count: items.length } });
    },
  },
  teams: namedRepository("teams"),
  priorities: namedRepository("priorities"),
  issueTypes: namedRepository("issueTypes"),
  contractTypes: namedRepository("contractTypes"),
};

export const importRepository = {
  list: async () => relationalEnabled() ? (await relational()).listImportBatches() : readJson(paths.imports, importBatchListSchema),
  add: async (item: ImportBatch) => relationalEnabled()
    ? (await relational()).addImportBatch(item)
    : updateJson(paths.imports, importBatchListSchema, (items) => [item, ...items]),
  update: async (id: string, patch: Partial<ImportBatch>) => relationalEnabled()
    ? (await relational()).updateImportBatch(id, patch)
    : updateJson(paths.imports, importBatchListSchema, (items) => items.map((item) => item.id === id ? { ...item, ...patch, id: item.id } : item)),
};

export const reportRepository = {
  list: async () => relationalEnabled() ? (await relational()).listReportJobs() : readJson(paths.reports, reportJobListSchema),
  add: async (item: ReportJob) => relationalEnabled()
    ? (await relational()).addReportJob(item)
    : updateJson(paths.reports, reportJobListSchema, (items) => [item, ...items]),
};

export const userRepository = {
  list: async () => relationalEnabled() ? (await relational()).listUsers() : readJson("auth/users.json", userListSchema),
  async create(input: User) {
    if (relationalEnabled()) {
      await (await relational()).upsertUser(input);
      return input;
    }
    await updateJson("auth/users.json", userListSchema, (users) => [...users, input]);
    return input;
  },
  async save(user: User) {
    if (relationalEnabled()) {
      await (await relational()).upsertUser(user);
      return user;
    }
    await updateJson("auth/users.json", userListSchema, (users) => users.map((item) => item.id === user.id ? user : item));
    return user;
  },
};

export async function replaceImportedCoreData({
  tickets,
  history,
  audit,
  backupId,
}: {
  tickets: Ticket[];
  history: TicketHistory[];
  audit: Audit[];
  backupId?: string;
}): Promise<string[]> {
  if (relationalEnabled()) {
    const store = await relational();
    const snapshotId = backupId || crypto.randomUUID();
    await store.saveImportSnapshot(snapshotId);
    await Promise.all([
      store.upsertTickets(tickets),
      store.replaceTicketHistory(history),
      store.replaceAudit(audit),
    ]);
    return [`relational:${snapshotId}`];
  }
  await writeJsonAtomicCompat(tickets, history, audit);
  return [];
}

export async function restoreImportedCoreDataBackup(paths: string[]) {
  if (relationalEnabled()) {
    const marker = paths.find((path) => path.startsWith("relational:"));
    if (!marker) throw new Error("Relational import snapshot not found for this batch");
    const restored = await (await relational()).restoreImportSnapshot(marker.slice("relational:".length));
    return [marker, restored];
  }
  return restoreBackupSet(paths);
}

async function writeJsonAtomicCompat(tickets: Ticket[], history: TicketHistory[], audit: Audit[]) {
  const { writeJsonAtomic } = await import("./json-store");
  await writeJsonAtomic("core/tickets.json", tickets, ticketListSchema);
  await writeJsonAtomic("core/ticket-history.json", history, historyListSchema);
  await writeJsonAtomic("audit/audit-log.json", audit, auditListSchema);
}
