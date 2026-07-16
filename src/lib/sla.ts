import { ticketSeverityCode, type TicketSeverityCode } from "./domain";
import type { Holiday, Sla, Ticket } from "./types";
import { formatDateTime } from "./utils";

type SlaClockMode = "calendar" | "business";
type PauseInterval = { start: Date; end: Date };

const hourMs = 60 * 60 * 1000;
const workingHoursPerDay = 8;
const workStartHour = 9;
const workEndHour = workStartHour + workingHoursPerDay;
const bangkokOffsetHours = 7;
const closedKanbanStatuses = new Set(["resolved", "closed", "cancelled"]);
const slaSeverityFields: Record<TicketSeverityCode, keyof Pick<Sla, "p1" | "p2" | "p3" | "p4">> = { P1: "p1", P2: "p2", P3: "p3", P4: "p4" };

function pad2(value: number) {
  return String(value).padStart(2, "0");
}

function bangkokDate(date: Date) {
  const bangkok = new Date(date.getTime() + bangkokOffsetHours * hourMs);
  return {
    year: bangkok.getUTCFullYear(),
    month: bangkok.getUTCMonth() + 1,
    day: bangkok.getUTCDate(),
    hour: bangkok.getUTCHours(),
    minute: bangkok.getUTCMinutes(),
    second: bangkok.getUTCSeconds(),
    millisecond: bangkok.getUTCMilliseconds(),
    weekday: bangkok.getUTCDay(),
  };
}

function fromBangkokDate(parts: { year: number; month: number; day: number; hour?: number; minute?: number; second?: number; millisecond?: number }) {
  return new Date(Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    (parts.hour ?? 0) - bangkokOffsetHours,
    parts.minute ?? 0,
    parts.second ?? 0,
    parts.millisecond ?? 0,
  ));
}

function dateKey(date: Date) {
  const parts = bangkokDate(date);
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function bangkokWorkBoundary(date: Date, hour: number) {
  const parts = bangkokDate(date);
  return fromBangkokDate({ year: parts.year, month: parts.month, day: parts.day, hour });
}

function dateValue(value: string, fallbackHour = workStartHour) {
  if (!value) return null;
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${pad2(fallbackHour)}:00:00+07:00`
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)
      ? `${value.length === 16 ? `${value}:00` : value}+07:00`
      : value;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isBusinessDay(date: Date, holidayDates: Set<string>) {
  const day = bangkokDate(date).weekday;
  return day !== 0 && day !== 6 && !holidayDates.has(dateKey(date));
}

function nextBusinessStart(date: Date, holidayDates: Set<string>) {
  const parts = bangkokDate(date);
  let next = fromBangkokDate({ year: parts.year, month: parts.month, day: parts.day + 1, hour: workStartHour });
  while (!isBusinessDay(next, holidayDates)) {
    const nextParts = bangkokDate(next);
    next = fromBangkokDate({ year: nextParts.year, month: nextParts.month, day: nextParts.day + 1, hour: workStartHour });
  }
  return next;
}

function alignToBusinessTime(date: Date, holidayDates: Set<string>) {
  const aligned = new Date(date);
  while (!isBusinessDay(aligned, holidayDates)) {
    return nextBusinessStart(aligned, holidayDates);
  }
  const parts = bangkokDate(aligned);
  if (parts.hour < workStartHour) return bangkokWorkBoundary(aligned, workStartHour);
  if (parts.hour >= workEndHour) return nextBusinessStart(aligned, holidayDates);
  return aligned;
}

function addBusinessHours(start: Date, hours: number, holidayDates: Set<string>) {
  let current = alignToBusinessTime(start, holidayDates);
  let remaining = Math.max(0, hours);
  let guard = 0;
  while (remaining > 0 && guard < 10000) {
    guard += 1;
    current = alignToBusinessTime(current, holidayDates);
    const endOfWorkday = bangkokWorkBoundary(current, workEndHour);
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
    const endOfWorkday = bangkokWorkBoundary(current, workEndHour);
    const sliceEnd = end.getTime() < endOfWorkday.getTime() ? end : endOfWorkday;
    if (sliceEnd.getTime() > current.getTime()) total += (sliceEnd.getTime() - current.getTime()) / hourMs;
    current = nextBusinessStart(current, holidayDates);
  }
  return total;
}

function calendarHoursBetween(start: Date, end: Date) {
  return Math.max(0, (end.getTime() - start.getTime()) / hourMs);
}

function addClockHours(start: Date, hours: number, mode: SlaClockMode, holidayDates: Set<string>) {
  return mode === "business"
    ? addBusinessHours(start, hours, holidayDates)
    : new Date(start.getTime() + Math.max(0, hours) * hourMs);
}

function clockHoursBetween(start: Date, end: Date, mode: SlaClockMode, holidayDates: Set<string>) {
  return mode === "business"
    ? businessHoursBetween(start, end, holidayDates)
    : calendarHoursBetween(start, end);
}

function slaHours(customerName: string, severity: string, slaRules: Sla[]) {
  const field = slaSeverityFields[ticketSeverityCode(severity)];
  const rule = slaRules.find((item) => item.customerName.toLowerCase() === customerName.toLowerCase());
  return field && rule ? rule[field] : null;
}

function slaClockMode(severity: string): SlaClockMode {
  const code = ticketSeverityCode(severity);
  return code === "P1" || code === "P2" ? "calendar" : "business";
}

function pauseIntervals(ticket: Pick<Ticket, "slaPauses">, now: Date) {
  return (ticket.slaPauses || [])
    .flatMap((pause): PauseInterval[] => {
      const start = dateValue(pause.startAt);
      const end = dateValue(pause.endAt) || now;
      return start && end.getTime() > start.getTime() ? [{ start, end }] : [];
    })
    .sort((a, b) => a.start.getTime() - b.start.getTime());
}

function overlap(start: Date, end: Date, pause: PauseInterval) {
  const overlapStart = new Date(Math.max(start.getTime(), pause.start.getTime()));
  const overlapEnd = new Date(Math.min(end.getTime(), pause.end.getTime()));
  return overlapEnd.getTime() > overlapStart.getTime() ? { start: overlapStart, end: overlapEnd } : null;
}

function pausedHoursBetween(start: Date, end: Date, pauses: PauseInterval[], mode: SlaClockMode, holidayDates: Set<string>) {
  return pauses.reduce((sum, pause) => {
    const slice = overlap(start, end, pause);
    return slice ? sum + clockHoursBetween(slice.start, slice.end, mode, holidayDates) : sum;
  }, 0);
}

function addActiveSlaHours(start: Date, hours: number, pauses: PauseInterval[], mode: SlaClockMode, holidayDates: Set<string>) {
  let current = mode === "business" ? alignToBusinessTime(start, holidayDates) : new Date(start);
  let remaining = Math.max(0, hours);
  let guard = 0;
  while (remaining > 0 && guard < 10000) {
    guard += 1;
    const activePause = pauses.find((pause) => current.getTime() >= pause.start.getTime() && current.getTime() < pause.end.getTime());
    if (activePause) {
      current = new Date(activePause.end);
      continue;
    }
    const nextPause = pauses.find((pause) => pause.start.getTime() > current.getTime());
    if (!nextPause) return addClockHours(current, remaining, mode, holidayDates);
    const available = clockHoursBetween(current, nextPause.start, mode, holidayDates);
    if (remaining <= available) return addClockHours(current, remaining, mode, holidayDates);
    remaining -= available;
    current = new Date(nextPause.end);
  }
  return current;
}

function activePause(ticket: Pick<Ticket, "kanbanStatus" | "slaPauses">) {
  return ticket.kanbanStatus === "waiting"
    ? (ticket.slaPauses || []).find((pause) => !pause.endAt) || null
    : null;
}

export function ticketSlaState(ticket: Ticket, slaRules: Sla[], holidays: Holiday[], now = new Date()) {
  const holidayDates = new Set(holidays.map((holiday) => holiday.date.slice(0, 10)));
  const start = dateValue(ticket.startDate || ticket.date);
  const configuredHours = slaHours(ticket.customerName, ticket.severity, slaRules);
  const pause = activePause(ticket);
  const mode = slaClockMode(ticket.severity);
  if (!start || !configuredHours) {
    return {
      label: pause ? "Paused" : "N/A",
      tone: "slate" as const,
      title: "No start date or matching SLA rule.",
      dueDate: dateValue(ticket.dueDate, workEndHour),
      overdue: false,
      percent: null,
      paused: Boolean(pause),
      pausedSince: pause?.startAt || "",
      pausedHours: 0,
      clockMode: mode,
    };
  }

  const clockStart = mode === "business" ? alignToBusinessTime(start, holidayDates) : start;
  const pauses = pauseIntervals(ticket, now).filter((item) => item.end.getTime() > clockStart.getTime());
  const dueDate = addActiveSlaHours(clockStart, configuredHours, pauses, mode, holidayDates);
  const measuredAt = closedKanbanStatuses.has(ticket.kanbanStatus)
    ? dateValue(ticket.closeDate, workEndHour) || now
    : now;
  const grossElapsed = clockHoursBetween(clockStart, measuredAt, mode, holidayDates);
  const pausedHours = pausedHoursBetween(clockStart, measuredAt, pauses, mode, holidayDates);
  const elapsedHours = Math.max(0, grossElapsed - pausedHours);
  const percent = Math.min(100, Math.max(0, Math.round((elapsedHours / configuredHours) * 100)));
  const paused = Boolean(pause);
  const tone = paused ? "slate" as const : percent >= 90 ? "rose" as const : percent >= 50 ? "amber" as const : "emerald" as const;
  const overdue = !paused && !closedKanbanStatuses.has(ticket.kanbanStatus) && measuredAt.getTime() >= dueDate.getTime();
  const clockLabel = mode === "calendar" ? "calendar hour" : "business hour";
  const pauseLabel = pausedHours > 0 ? `, paused ${pausedHours.toFixed(2)} hrs` : "";
  return {
    label: paused ? "Paused" : `${percent}%`,
    tone,
    title: `${configuredHours} ${clockLabel} SLA, due ${formatDateTime(dueDate)}${pauseLabel}`,
    dueDate,
    overdue,
    percent,
    paused,
    pausedSince: pause?.startAt || "",
    pausedHours,
    clockMode: mode,
  };
}

export function ticketResponseSlaState(ticket: Pick<Ticket, "date" | "startDate">, limitMinutes = 30) {
  const created = dateValue(ticket.date);
  const started = dateValue(ticket.startDate);
  if (!created || !started) {
    return {
      label: "N/A",
      tone: "slate" as const,
      title: "Create ticket date or start date is missing.",
      overdue: false,
      elapsedMinutes: null,
      limitMinutes,
    };
  }

  const elapsedMinutes = Math.max(0, Math.round((started.getTime() - created.getTime()) / (60 * 1000)));
  const overdue = elapsedMinutes > limitMinutes;
  return {
    label: `${elapsedMinutes}m`,
    tone: overdue ? "rose" as const : "emerald" as const,
    title: `Response ${elapsedMinutes} minutes from create ticket date to start date. Target is ${limitMinutes} minutes.`,
    overdue,
    elapsedMinutes,
    limitMinutes,
  };
}
