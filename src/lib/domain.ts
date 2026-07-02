import { addDays, format, isWeekend, parseISO } from "date-fns";
import type { Customer, Holiday, Ticket, TicketLog } from "./types";

export const KANBAN_COLUMNS = ["open", "in_progress", "waiting", "monitor", "resolved"] as const;
export const KANBAN_ARCHIVE_AGE_DAYS = 90;
export const HOURS_PER_MD = 8;
const dayMs = 24 * 60 * 60 * 1000;
export const ticketSeverityLabels = { P1: "Critical", P2: "High", P3: "Medium", P4: "Low" } as const;
export type TicketSeverityCode = keyof typeof ticketSeverityLabels;
const ticketSeverityCodes = new Set(Object.keys(ticketSeverityLabels));
const ticketSeverityCodeByLabel = { CRITICAL: "P1", HIGH: "P2", MEDIUM: "P3", LOW: "P4" } as const;

function compactSeverity(value: string) {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function ticketSeverityCode(severity: string): TicketSeverityCode {
  const compact = compactSeverity(severity);
  const code = compact.match(/^P[1-4]/)?.[0];
  if (code && ticketSeverityCodes.has(code)) return code as TicketSeverityCode;
  return ticketSeverityCodeByLabel[compact as keyof typeof ticketSeverityCodeByLabel] || "P3";
}

export function ticketSeverityLabel(severity: string) {
  const raw = severity.trim();
  const compact = compactSeverity(raw);
  const code = compact.match(/^P[1-4]/)?.[0];
  if (code && ticketSeverityCodes.has(code)) return ticketSeverityLabels[code as TicketSeverityCode];
  const mapped = ticketSeverityCodeByLabel[compact as keyof typeof ticketSeverityCodeByLabel];
  if (mapped) return ticketSeverityLabels[mapped];
  return raw || ticketSeverityLabels.P3;
}

export function roundEffortHours(value: number) {
  return Number(Math.max(0, value || 0).toFixed(5));
}

export function hoursFromMd(mdUsed: number) {
  return roundEffortHours((mdUsed || 0) * HOURS_PER_MD);
}

export function mdFromHours(hours: number) {
  return Number((Math.max(0, hours || 0) / HOURS_PER_MD).toFixed(6));
}

export function normalizeOwnerEfforts(
  ownerEfforts: Array<{ owner: string; hours: number }> | undefined,
  fallbackOwner = "",
  fallbackHours = 0,
) {
  const rows = (ownerEfforts || [])
    .map((item) => ({ owner: item.owner.trim(), hours: roundEffortHours(Number(item.hours)) }))
    .filter((item) => item.owner || item.hours > 0);
  if (rows.length) return rows;
  if (!fallbackOwner && fallbackHours <= 0) return [];
  return [{ owner: fallbackOwner.trim(), hours: roundEffortHours(fallbackHours) }];
}

export function totalOwnerEffortHours(ownerEfforts: Array<{ owner: string; hours: number }>) {
  return roundEffortHours(ownerEfforts.reduce((sum, item) => sum + Number(item.hours || 0), 0));
}

export function ownerNamesFromEfforts(ownerEfforts: Array<{ owner: string; hours: number }>) {
  return ownerEfforts.map((item) => item.owner.trim()).filter(Boolean).join(", ");
}

function splitOwnerText(value: string) {
  return value.split(/\s*(?:,|\/|;|\+|&)\s*/).map((item) => item.trim()).filter(Boolean);
}

export function ticketOwnerList(ticket: Pick<Ticket, "owner" | "mdUsed" | "ownerEfforts">) {
  const efforts = normalizeOwnerEfforts(ticket.ownerEfforts, "", 0);
  const owners = efforts.map((item) => item.owner.trim()).filter(Boolean);
  if (owners.length) return owners;
  return splitOwnerText(ticket.owner);
}

export function ticketOwnerLabel(ticket: Pick<Ticket, "owner" | "mdUsed" | "ownerEfforts">) {
  return ticketOwnerList(ticket).join(", ") || ticket.owner || "";
}

export function isTicketOwner(ticket: Pick<Ticket, "owner" | "mdUsed" | "ownerEfforts">, names: string[]) {
  const allowed = new Set(names.map((name) => normalize(name)));
  return ticketOwnerList(ticket).some((owner) => allowed.has(normalize(owner)));
}

export function ticketEffortHours(ticket: Pick<Ticket, "owner" | "mdUsed" | "ownerEfforts">) {
  const fallbackHours = hoursFromMd(ticket.mdUsed);
  const efforts = normalizeOwnerEfforts(ticket.ownerEfforts, ticket.owner, fallbackHours);
  const total = totalOwnerEffortHours(efforts);
  return total || fallbackHours;
}

export function ticketEffortFields(
  raw: { owner?: unknown; mdUsed?: unknown; ownerEfforts?: unknown },
  fallback: Pick<Ticket, "owner" | "mdUsed"> = { owner: "", mdUsed: 0 },
) {
  const owner = typeof raw.owner === "string" ? raw.owner : fallback.owner;
  const rawEfforts = Array.isArray(raw.ownerEfforts)
    ? raw.ownerEfforts.map((item) => {
        const record = item && typeof item === "object" ? item as Record<string, unknown> : {};
        return { owner: String(record.owner ?? ""), hours: Number(record.hours ?? 0) };
      })
    : undefined;
  const fallbackHours = rawEfforts ? 0 : hoursFromMd(Number(raw.mdUsed ?? fallback.mdUsed ?? 0));
  const ownerEfforts = normalizeOwnerEfforts(rawEfforts, owner, fallbackHours);
  const totalHours = totalOwnerEffortHours(ownerEfforts);
  return {
    ownerEfforts,
    owner: ownerNamesFromEfforts(ownerEfforts) || owner,
    mdUsed: mdFromHours(totalHours),
  };
}

function formatLogTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Bangkok",
  }).format(date);
}

export function formatTicketLogEntry(entry: Pick<TicketLog, "message" | "actor" | "createdAt">) {
  const message = entry.message.trim();
  if (!message) return "";
  return `${message}\nUpdated by ${entry.actor || "unknown"} · ${formatLogTimestamp(entry.createdAt)}`;
}

export function ticketLogText(ticket: Pick<Ticket, "remark" | "ticketLogs">) {
  const legacyRemark = ticket.remark.trim();
  const logs = (ticket.ticketLogs || []).map(formatTicketLogEntry).filter(Boolean);
  return [legacyRemark, ...logs].filter(Boolean).join("\n\n");
}

export function normalize(value: string) {
  return value.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US");
}

export function customerKey(projectCode: string, customerName: string) {
  return `${normalize(projectCode)}::${normalize(customerName)}`;
}

export function mapKanbanStatus(raw: string): Ticket["kanbanStatus"] {
  const code = raw.trim().match(/^\d{1,2}/)?.[0].padStart(2, "0");
  if (["00", "09"].includes(code ?? "")) return "open";
  if (["03", "04", "06", "10"].includes(code ?? "")) return "in_progress";
  if (["07", "11"].includes(code ?? "")) return "waiting";
  if (code === "05") return "monitor";
  if (code === "08") return "resolved";
  if (code === "02") return "closed";
  if (code === "01") return "cancelled";
  return "open";
}

function parseTicketAgeDate(value?: string | null) {
  if (!value) return null;
  const dateOnly = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = dateOnly
    ? new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function ticketAgeAnchorDate(ticket: Pick<Ticket, "startDate" | "date" | "createdAt">) {
  return parseTicketAgeDate(ticket.date) || parseTicketAgeDate(ticket.startDate) || parseTicketAgeDate(ticket.createdAt);
}

export function ticketAgeDays(ticket: Pick<Ticket, "startDate" | "date" | "createdAt">, now = new Date()) {
  const anchor = ticketAgeAnchorDate(ticket);
  if (!anchor) return null;
  return Math.floor((now.getTime() - anchor.getTime()) / dayMs);
}

export function isKanbanArchiveCandidate(ticket: Pick<Ticket, "kanbanStatus" | "startDate" | "date" | "createdAt">, now = new Date()) {
  if (ticket.kanbanStatus === "closed" || ticket.kanbanStatus === "cancelled") return false;
  const age = ticketAgeDays(ticket, now);
  return age !== null && age > KANBAN_ARCHIVE_AGE_DAYS;
}

export type ManualContractStatus = "Active" | "Suspended" | "Pre-sales" | "Done";
export type ContractLifecycle = "Expiring" | "Expired";
export type ContractRowState = "active" | "pre-sales" | "suspended" | "done" | "expiring" | "expired";

function dateOnly(value: Date) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

function parseContractDate(value?: string | null) {
  if (!value) return null;
  const localDate = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (localDate) {
    const [, year, month, day] = localDate;
    return dateOnly(new Date(Number(year), Number(month) - 1, Number(day)));
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dateOnly(date);
}

export function manualContractStatus(status?: string | null): ManualContractStatus {
  const normalized = (status || "").toLowerCase().trim();
  if (normalized.includes("suspend")) return "Suspended";
  if (normalized.includes("pre")) return "Pre-sales";
  if (normalized.includes("done")) return "Done";
  return "Active";
}

export function contractLifecycle(customer: Pick<Customer, "endPeriod">, now = new Date()): ContractLifecycle | null {
  const endDate = parseContractDate(customer.endPeriod);
  if (!endDate) return null;
  const today = dateOnly(now);
  if (endDate < today) return "Expired";
  if (endDate <= addMonths(today, 3)) return "Expiring";
  return null;
}

export function contractRowState(customer: Pick<Customer, "contractStatus" | "endPeriod">): ContractRowState {
  const manual = manualContractStatus(customer.contractStatus);
  const lifecycle = contractLifecycle(customer);
  if (manual === "Suspended") return "suspended";
  if (manual === "Done") return "done";
  if (lifecycle === "Expired") return "expired";
  if (lifecycle === "Expiring") return "expiring";
  if (manual === "Pre-sales") return "pre-sales";
  return "active";
}

export function customerCapacity(customer: Pick<Customer, "mdPurchased" | "carryForward">) {
  return customer.mdPurchased + (customer.carryForward || 0);
}

export function customerUtilization(customer: Pick<Customer, "mdPurchased" | "carryForward" | "mdUsed">) {
  const capacity = customerCapacity(customer);
  return capacity > 0 ? (customer.mdUsed / capacity) * 100 : 0;
}

export function recalculateCustomer(customer: Customer, tickets: Ticket[]): Customer {
  const mdUsed = tickets
    .filter((ticket) => ticket.customerKey === customer.key && ticket.chargeable)
    .reduce((total, ticket) => total + ticket.mdUsed, 0);
  const capacity = customerCapacity(customer);
  const mdRemaining = capacity - mdUsed;
  const validDates = tickets
    .map((ticket) => new Date(ticket.date))
    .filter((date) => !Number.isNaN(date.getTime()));
  const firstDate = validDates.length ? new Date(Math.min(...validDates.map((date) => date.getTime()))) : null;
  const now = new Date();
  const elapsedMonths = firstDate
    ? Math.max(1, (now.getUTCFullYear() - firstDate.getUTCFullYear()) * 12 + now.getUTCMonth() - firstDate.getUTCMonth() + 1)
    : 1;
  const monthlyBurnRate = mdUsed / elapsedMonths;
  const burnRate = customerUtilization({ mdPurchased: customer.mdPurchased, carryForward: customer.carryForward, mdUsed });
  const remainingRatio = capacity > 0 ? mdRemaining / capacity : 1;
  return {
    ...customer,
    mdUsed: Number(mdUsed.toFixed(6)),
    mdRemaining: Number(mdRemaining.toFixed(6)),
    burnRate: Number(burnRate.toFixed(2)),
    monthlyBurnRate: Number(monthlyBurnRate.toFixed(6)),
    mdStatus: remainingRatio < 0.1 ? "Critical" : remainingRatio < 0.3 ? "Warning" : "OK",
    updatedAt: new Date().toISOString(),
  };
}

export function addBusinessHours(startDate: string, hours: number, holidays: Holiday[]) {
  const holidaySet = new Set(holidays.map((holiday) => holiday.date));
  let cursor = parseISO(startDate);
  let days = Math.ceil(hours / 8);
  while (days > 0) {
    cursor = addDays(cursor, 1);
    const date = format(cursor, "yyyy-MM-dd");
    if (!isWeekend(cursor) && !holidaySet.has(date)) days -= 1;
  }
  return format(cursor, "yyyy-MM-dd");
}

export function ticketDiff(previous: Ticket, next: Ticket) {
  return Object.entries(next).flatMap(([field, nextValue]) => {
    if (["id", "createdAt", "updatedAt"].includes(field)) return [];
    const previousValue = previous[field as keyof Ticket];
    return JSON.stringify(previousValue) === JSON.stringify(nextValue)
      ? []
      : [{ field, previousValue, nextValue }];
  });
}
