import { ticketSeverityCode, type TicketSeverityCode } from "./domain";
import type { Holiday, Sla, Ticket } from "./types";

const hourMs = 60 * 60 * 1000;
const workingHoursPerDay = 8;
const workStartHour = 9;
const workEndHour = workStartHour + workingHoursPerDay;
const closedKanbanStatuses = new Set(["resolved", "closed", "cancelled"]);
const slaSeverityFields: Record<TicketSeverityCode, keyof Pick<Sla, "p1" | "p2" | "p3" | "p4">> = { P1: "p1", P2: "p2", P3: "p3", P4: "p4" };

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function dateKey(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function dateValue(value: string, fallbackHour = workStartHour) {
  if (!value) return null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T${pad2(fallbackHour)}:00:00`)
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isBusinessDay(date: Date, holidayDates: Set<string>) {
  const day = date.getDay();
  return day !== 0 && day !== 6 && !holidayDates.has(dateKey(date));
}

function nextBusinessStart(date: Date, holidayDates: Set<string>) {
  const next = new Date(date);
  next.setDate(next.getDate() + 1);
  next.setHours(workStartHour, 0, 0, 0);
  while (!isBusinessDay(next, holidayDates)) next.setDate(next.getDate() + 1);
  return next;
}

function alignToBusinessTime(date: Date, holidayDates: Set<string>) {
  const aligned = new Date(date);
  while (!isBusinessDay(aligned, holidayDates)) {
    aligned.setDate(aligned.getDate() + 1);
    aligned.setHours(workStartHour, 0, 0, 0);
  }
  if (aligned.getHours() < workStartHour) aligned.setHours(workStartHour, 0, 0, 0);
  if (aligned.getHours() >= workEndHour) return nextBusinessStart(aligned, holidayDates);
  return aligned;
}

function addBusinessHours(start: Date, hours: number, holidayDates: Set<string>) {
  let current = alignToBusinessTime(start, holidayDates);
  let remaining = Math.max(0, hours);
  let guard = 0;
  while (remaining > 0 && guard < 10000) {
    guard += 1;
    current = alignToBusinessTime(current, holidayDates);
    const endOfWorkday = new Date(current);
    endOfWorkday.setHours(workEndHour, 0, 0, 0);
    const available = Math.max(0, (endOfWorkday.getTime() - current.getTime()) / hourMs);
    if (remaining <= available) return new Date(current.getTime() + remaining * hourMs);
    remaining -= available;
    current = nextBusinessStart(current, holidayDates);
  }
  return current;
}

function businessHoursBetween(start: Date, end: Date, holidayDates: Set<string>) {
  let current = alignToBusinessTime(start, holidayDates);
  let total = 0;
  let guard = 0;
  if (end.getTime() <= current.getTime()) return total;
  while (current.getTime() < end.getTime() && guard < 10000) {
    guard += 1;
    current = alignToBusinessTime(current, holidayDates);
    if (current.getTime() >= end.getTime()) break;
    const endOfWorkday = new Date(current);
    endOfWorkday.setHours(workEndHour, 0, 0, 0);
    const sliceEnd = end.getTime() < endOfWorkday.getTime() ? end : endOfWorkday;
    if (sliceEnd.getTime() > current.getTime()) total += (sliceEnd.getTime() - current.getTime()) / hourMs;
    current = nextBusinessStart(current, holidayDates);
  }
  return total;
}

function slaHours(customerName: string, severity: string, slaRules: Sla[]) {
  const field = slaSeverityFields[ticketSeverityCode(severity)];
  const rule = slaRules.find((item) => item.customerName.toLowerCase() === customerName.toLowerCase());
  return field && rule ? rule[field] : null;
}

export function ticketSlaState(ticket: Ticket, slaRules: Sla[], holidays: Holiday[], now = new Date()) {
  const holidayDates = new Set(holidays.map((holiday) => holiday.date.slice(0, 10)));
  const start = dateValue(ticket.startDate || ticket.date);
  const configuredHours = slaHours(ticket.customerName, ticket.severity, slaRules);
  if (!start || !configuredHours) {
    return {
      label: "N/A",
      tone: "slate" as const,
      title: "No start date or matching SLA rule.",
      dueDate: dateValue(ticket.dueDate, workEndHour),
      overdue: false,
      percent: null,
    };
  }

  const businessStart = alignToBusinessTime(start, holidayDates);
  const dueDate = addBusinessHours(businessStart, configuredHours, holidayDates);
  const measuredAt = closedKanbanStatuses.has(ticket.kanbanStatus)
    ? dateValue(ticket.closeDate, workEndHour) || now
    : now;
  const elapsedHours = businessHoursBetween(businessStart, measuredAt, holidayDates);
  const percent = Math.min(100, Math.max(0, Math.round((elapsedHours / configuredHours) * 100)));
  const tone = percent >= 90 ? "rose" as const : percent >= 50 ? "amber" as const : "emerald" as const;
  const overdue = !closedKanbanStatuses.has(ticket.kanbanStatus) && measuredAt.getTime() >= dueDate.getTime();
  return {
    label: `${percent}%`,
    tone,
    title: `${configuredHours} business hour SLA, due ${dueDate.toISOString().slice(0, 10)}`,
    dueDate,
    overdue,
    percent,
  };
}
