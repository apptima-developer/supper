"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Plus, Search, SquarePen, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Badge, statusTone } from "./ui/badge";
import { Dialog, DialogContent } from "./ui/dialog";
import { Input, Label, Select, Textarea } from "./ui/input";
import { MultiSelectFilter } from "./ui/multi-select-filter";
import { PaginationControls } from "./ui/pagination-controls";
import { EmptyState } from "./empty-state";
import { hoursFromMd, isTicketOwner, mdFromHours, normalizeOwnerEfforts, ownerNamesFromEfforts, ticketEffortHours, ticketLogText, ticketOwnerLabel, ticketSeverityCode, ticketSeverityLabel, totalOwnerEffortHours, type TicketSeverityCode } from "@/lib/domain";
import { formatDate, formatIssueType } from "@/lib/utils";
import type { Customer, Holiday, NamedMaster, Role, Sla, Status, Ticket } from "@/lib/types";

const blank = {
  issueId: "",
  date: new Date().toISOString().slice(0, 10),
  customerKey: "",
  issueTitle: "",
  issueType: "",
  severity: "Medium",
  owner: "",
  status: "00 - Open",
  startDate: "",
  dueDate: "",
  closeDate: "",
  mdUsed: 0,
  ownerEfforts: [],
  chargeable: false,
};
const hourStep = "0.00001";
const pageSize = 20;
const hourMs = 60 * 60 * 1000;
const workingHoursPerDay = 8;
const workStartHour = 9;
const workEndHour = workStartHour + workingHoursPerDay;
const closedKanbanStatuses = new Set(["resolved", "closed", "cancelled"]);
const slaSeverityFields: Record<TicketSeverityCode, keyof Pick<Sla, "p1" | "p2" | "p3" | "p4">> = { P1: "p1", P2: "p2", P3: "p3", P4: "p4" };
const severityOptions = [
  { value: "Critical", label: "P1 - Critical" },
  { value: "High", label: "P2 - High" },
  { value: "Medium", label: "P3 - Medium" },
  { value: "Low", label: "P4 - Low" },
] as const;
const kanbanStatusOptions = [
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In progress" },
  { value: "waiting", label: "Waiting" },
  { value: "monitor", label: "Monitor" },
  { value: "resolved", label: "Resolved" },
  { value: "closed", label: "Closed" },
  { value: "cancelled", label: "Cancelled" },
];

export type InitialTicketFilters = {
  query?: string;
  owner?: string;
  issue?: string;
  customer?: string;
  statuses?: string[];
  types?: string[];
  chargeable?: string[];
  startDateFrom?: string;
  startDateTo?: string;
  editTicketId?: string;
};

function ticketSortTime(ticket: Ticket) {
  const value = ticket.startDate || ticket.date || ticket.updatedAt;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function compareTickets(a: Ticket, b: Ticket) {
  return ticketSortTime(b) - ticketSortTime(a) || b.updatedAt.localeCompare(a.updatedAt) || a.issueId.localeCompare(b.issueId);
}

function filterKey(value: string) {
  return value.trim().toLowerCase();
}

function matchesOwnerFilter(ticket: Ticket, ownerFilter: string) {
  if (!ownerFilter) return true;
  if (ownerFilter === filterKey("Unassigned")) return !ticketOwnerLabel(ticket);
  return isTicketOwner(ticket, [ownerFilter]);
}

type EffortRow = { id: string; owner: string; hours: string };

function rowId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
}

function formatHours(value: number) {
  return Math.max(0, Number(value) || 0).toFixed(5);
}

function severityTone(severity: string) {
  const key = ticketSeverityCode(severity);
  if (key === "P1") return "rose";
  if (key === "P2") return "amber";
  if (key === "P3") return "blue";
  if (key === "P4") return "emerald";
  return "slate";
}

function effortRowsForTicket(ticket: Ticket | null): EffortRow[] {
  const efforts = ticket
    ? normalizeOwnerEfforts(ticket.ownerEfforts, ticket.owner, hoursFromMd(ticket.mdUsed))
    : normalizeOwnerEfforts(undefined, "", 0);
  const rows = efforts.length ? efforts : [{ owner: "", hours: 0 }];
  return rows.map((item) => ({ id: rowId(), owner: item.owner, hours: formatHours(item.hours) }));
}

function effortPayload(rows: EffortRow[]) {
  const ownerEfforts = normalizeOwnerEfforts(
    rows.map((row) => ({ owner: row.owner, hours: Number(row.hours) })),
    "",
    0,
  );
  const totalHours = totalOwnerEffortHours(ownerEfforts);
  return {
    ownerEfforts,
    owner: ownerNamesFromEfforts(ownerEfforts),
    mdUsed: mdFromHours(totalHours),
  };
}

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

function ticketStartDateKey(ticket: Pick<Ticket, "startDate" | "date">) {
  const start = dateValue(ticket.startDate || ticket.date);
  return start ? dateKey(start) : "";
}

function dateInRange(value: string, from: string, to: string) {
  if (!from && !to) return true;
  if (!value) return false;
  return (!from || value >= from) && (!to || value <= to);
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

function slaField(severity: string) {
  return slaSeverityFields[ticketSeverityCode(severity)];
}

function slaHours(customerName: string, severity: string, slaRules: Sla[]) {
  const field = slaField(severity);
  const rule = slaRules.find((item) => item.customerName.toLowerCase() === customerName.toLowerCase());
  return field && rule ? rule[field] : null;
}

function slaState(ticket: Ticket, slaRules: Sla[], holidayDates: Set<string>) {
  const start = dateValue(ticket.startDate || ticket.date);
  const configuredHours = slaHours(ticket.customerName, ticket.severity, slaRules);
  if (!start || !configuredHours) {
    return { label: "N/A", tone: "slate" as const, title: "No start date or matching SLA rule.", dueDate: dateValue(ticket.dueDate, workEndHour), overdue: false };
  }

  const totalHours = configuredHours;
  const businessStart = alignToBusinessTime(start, holidayDates);
  const dueDate = addBusinessHours(businessStart, totalHours, holidayDates);
  const measuredAt = closedKanbanStatuses.has(ticket.kanbanStatus)
    ? dateValue(ticket.closeDate, workEndHour) || new Date()
    : new Date();
  const elapsedHours = businessHoursBetween(businessStart, measuredAt, holidayDates);
  const percent = Math.min(100, Math.max(0, Math.round((elapsedHours / totalHours) * 100)));
  const tone = percent >= 90 ? "rose" as const : percent >= 50 ? "amber" as const : "emerald" as const;
  const overdue = !closedKanbanStatuses.has(ticket.kanbanStatus) && measuredAt.getTime() >= dueDate.getTime();
  return {
    label: `${percent}%`,
    tone,
    title: `${configuredHours} business hour SLA, due ${formatDate(dueDate.toISOString())}`,
    dueDate,
    overdue,
  };
}

export function TicketManager({
  tickets,
  customers,
  statuses,
  slaRules,
  holidays,
  issueTypes,
  teams,
  role,
  initialFilters = {},
}: {
  tickets: Ticket[];
  customers: Customer[];
  statuses: Status[];
  slaRules: Sla[];
  holidays: Holiday[];
  issueTypes: NamedMaster[];
  teams: NamedMaster[];
  role: Role;
  userName: string;
  username: string;
  initialFilters?: InitialTicketFilters;
}) {
  const router = useRouter();
  const [query, setQuery] = useState(initialFilters.query || initialFilters.issue || "");
  const [statusFilters, setStatusFilters] = useState<string[]>(initialFilters.statuses || []);
  const [typeFilters, setTypeFilters] = useState<string[]>(initialFilters.types || []);
  const [customerFilters, setCustomerFilters] = useState<string[]>(initialFilters.customer ? [filterKey(initialFilters.customer)] : []);
  const [chargeableFilters, setChargeableFilters] = useState<string[]>(initialFilters.chargeable || []);
  const [startDateFrom, setStartDateFrom] = useState(initialFilters.startDateFrom || "");
  const [startDateTo, setStartDateTo] = useState(initialFilters.startDateTo || "");
  const manage = role === "admin" || role === "lead" || role === "support";
  const ownerFilter = filterKey(initialFilters.owner || "");
  const issueFilter = filterKey(initialFilters.issue || "");
  const initialEditTicket = useMemo(
    () => manage && initialFilters.editTicketId ? tickets.find((ticket) => ticket.id === initialFilters.editTicketId || ticket.issueId === initialFilters.editTicketId) || null : null,
    [initialFilters.editTicketId, manage, tickets],
  );
  const [currentPage, setCurrentPage] = useState(1);
  const [open, setOpen] = useState(Boolean(initialEditTicket));
  const [editing, setEditing] = useState<Ticket | null>(initialEditTicket);
  const [effortRows, setEffortRows] = useState<EffortRow[]>(() => effortRowsForTicket(initialEditTicket));
  const [busy, setBusy] = useState(false);
  const holidayDates = useMemo(() => new Set(holidays.map((holiday) => holiday.date.slice(0, 10))), [holidays]);
  const statusOptions = useMemo(() => {
    const counts = tickets.reduce<Record<string, number>>((acc, ticket) => {
      acc[ticket.kanbanStatus] = (acc[ticket.kanbanStatus] || 0) + 1;
      return acc;
    }, {});
    return kanbanStatusOptions.map((option) => ({ ...option, count: counts[option.value] || 0 }));
  }, [tickets]);
  const typeOptions = useMemo(() => {
    const labelMap = new Map<string, string>();
    const counts = new Map<string, number>();
    [...issueTypes.map((item) => item.name), ...tickets.map((ticket) => ticket.issueType)]
      .filter(Boolean)
      .forEach((type) => labelMap.set(filterKey(formatIssueType(type)), formatIssueType(type)));
    tickets
      .map((ticket) => ticket.issueType)
      .filter(Boolean)
      .forEach((type) => {
        const key = filterKey(formatIssueType(type));
        counts.set(key, (counts.get(key) || 0) + 1);
      });
    return [...labelMap.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label, count: counts.get(value) || 0 }));
  }, [issueTypes, tickets]);
  const customerOptions = useMemo(() => {
    const labelMap = new Map<string, string>();
    const counts = new Map<string, number>();
    [...customers.map((customer) => customer.customerName), ...tickets.map((ticket) => ticket.customerName)]
      .filter(Boolean)
      .forEach((customerName) => labelMap.set(filterKey(customerName), customerName));
    tickets
      .map((ticket) => ticket.customerName)
      .filter(Boolean)
      .forEach((customerName) => {
        const key = filterKey(customerName);
        counts.set(key, (counts.get(key) || 0) + 1);
      });
    return [...labelMap.entries()]
      .sort((a, b) => a[1].localeCompare(b[1]))
      .map(([value, label]) => ({ value, label, count: counts.get(value) || 0 }));
  }, [customers, tickets]);
  const chargeableOptions = useMemo(() => {
    const chargeableCount = tickets.filter((ticket) => ticket.chargeable).length;
    return [
      { value: "yes", label: "Chargeable", count: chargeableCount },
      { value: "no", label: "Non-charge", count: tickets.length - chargeableCount },
    ];
  }, [tickets]);
  const sortedCustomers = useMemo(
    () => [...customers].sort((a, b) =>
      a.customerName.localeCompare(b.customerName, undefined, { sensitivity: "base", numeric: true }) ||
      a.projectCode.localeCompare(b.projectCode, undefined, { sensitivity: "base", numeric: true })),
    [customers],
  );
  const filtered = useMemo(
    () => tickets
      .filter((t) =>
        `${t.issueId} ${t.issueTitle} ${t.customerName} ${ticketOwnerLabel(t)}`.toLowerCase().includes(query.toLowerCase()) &&
        matchesOwnerFilter(t, ownerFilter) &&
        (!issueFilter || filterKey(t.issueId) === issueFilter) &&
        (statusFilters.length === 0 || statusFilters.includes(t.kanbanStatus)) &&
        (typeFilters.length === 0 || typeFilters.includes(filterKey(formatIssueType(t.issueType)))) &&
        (customerFilters.length === 0 || customerFilters.includes(filterKey(t.customerName))) &&
        dateInRange(ticketStartDateKey(t), startDateFrom, startDateTo) &&
        (chargeableFilters.length === 0 || chargeableFilters.includes(t.chargeable ? "yes" : "no")))
      .sort(compareTickets),
    [tickets, query, ownerFilter, issueFilter, statusFilters, typeFilters, customerFilters, startDateFrom, startDateTo, chargeableFilters],
  );
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const activePage = Math.min(currentPage, totalPages);
  const pageTickets = useMemo(() => filtered.slice((activePage - 1) * pageSize, activePage * pageSize), [activePage, filtered]);

  function patchEffortRow(id: string, field: "owner" | "hours", value: string) {
    setEffortRows((rows) => rows.map((row) => row.id === id ? { ...row, [field]: value } : row));
  }

  function openEditor(ticket: Ticket | null) {
    setEditing(ticket);
    setEffortRows(effortRowsForTicket(ticket));
    setOpen(true);
  }

  function addEffortRow() {
    setEffortRows((rows) => [...rows, { id: rowId(), owner: "", hours: formatHours(0) }]);
  }

  function removeEffortRow(id: string) {
    setEffortRows((rows) => rows.length > 1 ? rows.filter((row) => row.id !== id) : [{ id: rowId(), owner: "", hours: formatHours(0) }]);
  }

  async function save(formData: FormData) {
    setBusy(true);
    const payload = {
      issueId: String(formData.get("issueId")),
      date: String(formData.get("date")),
      customerKey: String(formData.get("customerKey")),
      issueTitle: String(formData.get("issueTitle")),
      issueType: String(formData.get("issueType")),
      severity: ticketSeverityLabel(String(formData.get("severity") || "")),
      ...effortPayload(effortRows),
      status: String(formData.get("status")),
      startDate: String(formData.get("startDate")),
      dueDate: String(formData.get("dueDate")),
      closeDate: String(formData.get("closeDate")),
      chargeable: formData.get("chargeable") === "on",
      logEntry: String(formData.get("logEntry")),
    };
    try {
      const response = await fetch(editing ? `/api/tickets/${editing.id}` : "/api/tickets", {
        method: editing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      toast.success(editing ? "Ticket updated" : "Ticket created");
      setOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not save ticket");
    } finally {
      setBusy(false);
    }
  }

  async function remove(ticket: Ticket) {
    if (!confirm(`Delete ${ticket.issueId}?`)) return;
    const response = await fetch(`/api/tickets/${ticket.id}`, { method: "DELETE" });
    const result = await response.json();
    if (!response.ok) return toast.error(result.error);
    toast.success("Ticket deleted");
    router.refresh();
  }

  const currentLog = editing ? ticketLogText(editing) : "";

  const routeFilterLabels = [
    initialFilters.owner ? `Owner: ${initialFilters.owner}` : "",
    initialFilters.issue ? `Issue: ${initialFilters.issue}` : "",
  ].filter(Boolean);

  return (
    <>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-64 flex-1">
          <Search className="absolute left-3 top-2.5 text-slate-400" size={15} />
          <Input className="pl-9" value={query} onChange={(event) => { setQuery(event.target.value); setCurrentPage(1); }} placeholder="Search issue ID, title, customer, owner..." />
        </div>
        <MultiSelectFilter
          className="w-44"
          label="Status"
          allLabel="All statuses"
          options={statusOptions}
          selected={statusFilters}
          onChange={(values) => { setStatusFilters(values); setCurrentPage(1); }}
        />
        <MultiSelectFilter
          className="w-44"
          label="Type"
          allLabel="All types"
          options={typeOptions}
          selected={typeFilters}
          onChange={(values) => { setTypeFilters(values); setCurrentPage(1); }}
        />
        <MultiSelectFilter
          className="w-48"
          label="Customer"
          allLabel="All customers"
          options={customerOptions}
          selected={customerFilters}
          onChange={(values) => { setCustomerFilters(values); setCurrentPage(1); }}
        />
        <div className="flex items-center gap-2 rounded-lg border border-sky-100/90 bg-white/70 px-2 py-1">
          <span className="whitespace-nowrap text-[10px] font-semibold uppercase tracking-wide text-slate-400">Start</span>
          <Input
            aria-label="Start date from"
            className="h-8 w-36 border-0 bg-transparent px-1 shadow-none focus:ring-0"
            type="date"
            value={startDateFrom}
            onChange={(event) => { setStartDateFrom(event.target.value); setCurrentPage(1); }}
          />
          <span className="text-[10px] font-medium text-slate-400">to</span>
          <Input
            aria-label="Start date to"
            className="h-8 w-36 border-0 bg-transparent px-1 shadow-none focus:ring-0"
            type="date"
            value={startDateTo}
            onChange={(event) => { setStartDateTo(event.target.value); setCurrentPage(1); }}
          />
        </div>
        <MultiSelectFilter
          className="w-40"
          label="Charge"
          allLabel="All charge"
          options={chargeableOptions}
          selected={chargeableFilters}
          onChange={(values) => { setChargeableFilters(values); setCurrentPage(1); }}
        />
        {manage && (
          <Button onClick={() => openEditor(null)}>
            <Plus size={15} />Add ticket
          </Button>
        )}
      </div>
      {routeFilterLabels.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-2xl border border-sky-100 bg-sky-50/60 px-3 py-2 text-[11px] text-slate-600">
          <span>Showing linked filter: <span className="font-semibold text-slate-800">{routeFilterLabels.join(" · ")}</span></span>
          <Link href="/tickets" className="font-semibold text-sky-700 hover:text-sky-900">Clear linked filter</Link>
        </div>
      )}

      <div className="overflow-hidden rounded-lg border bg-white">
        {filtered.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="w-24 px-4 py-2.5">Action</th>
                  <th className="px-4 py-2.5">Issue</th>
                  <th className="px-4 py-2.5">Customer</th>
                  <th className="px-4 py-2.5">Type / Severity</th>
                  <th className="px-4 py-2.5">Start</th>
                  <th className="px-4 py-2.5">Due</th>
                  <th className="px-4 py-2.5">Hours</th>
                  <th className="px-4 py-2.5">Chargeable</th>
                  <th className="px-4 py-2.5">SLA</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {pageTickets.map((ticket) => {
                  const sla = slaState(ticket, slaRules, holidayDates);
                  return (
                    <tr key={ticket.id} className="border-t hover:bg-slate-50/70">
                      <td className="px-4 py-2">
                        <div className="flex justify-start gap-1">
                          {manage && (
                            <Button variant="ghost" size="icon" onClick={() => openEditor(ticket)}>
                              <SquarePen size={14} />
                            </Button>
                          )}
                          {manage && (
                            <Button variant="ghost" size="icon" onClick={() => remove(ticket)}>
                              <Trash2 size={14} className="text-rose-500" />
                            </Button>
                          )}
                        </div>
                      </td>
                      <td className="max-w-[34rem] px-4 py-2">
                        <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
                          <Link href={`/tickets/${ticket.id}`} className="shrink-0 font-medium text-slate-900 hover:text-[#0a84ff]">{ticket.issueId}</Link>
                          <span className="truncate text-[11px] text-slate-500" title={ticket.issueTitle}>{ticket.issueTitle}</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">{ticket.customerName}</td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <div className="flex items-center gap-1.5">
                          <span>{formatIssueType(ticket.issueType)}</span>
                          <Badge tone={severityTone(ticket.severity)}>{ticketSeverityLabel(ticket.severity)}</Badge>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-[11px]">{formatDate(ticket.startDate || ticket.date)}</td>
                      <td className={`whitespace-nowrap px-4 py-2 text-[11px] ${sla.overdue ? "font-medium text-rose-600" : ""}`}>
                        <div className="flex items-center gap-1.5">
                          <span>{formatDate(sla.dueDate?.toISOString() || ticket.dueDate)}</span>
                          {sla.overdue && <Badge tone="rose">Overdue</Badge>}
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        {formatHours(ticketEffortHours(ticket))}
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <Badge tone={ticket.chargeable ? "emerald" : "slate"}>{ticket.chargeable ? "Yes" : "No"}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <Badge tone={sla.tone} title={sla.title}>{sla.label}</Badge>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <Badge tone={statusTone(ticket.status)}>{ticket.status.replace(/^\d{2}\s*-\s*/, "")}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState title={tickets.length ? "No matching tickets" : "No tickets yet"} description={tickets.length ? "Try changing the search or status filter." : "Import Issues_Log or create the first ticket."} />
        )}
        {filtered.length > 0 && <PaginationControls total={filtered.length} page={activePage} pageSize={pageSize} itemLabel="tickets" onPageChange={setCurrentPage} />}
      </div>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent title={editing ? "Edit ticket" : "New ticket"} description="Ticket effort updates automatically recalculate the customer contract.">
          <form action={save} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div><Label required>Issue ID</Label><Input name="issueId" required defaultValue={editing?.issueId} /></div>
              <div><Label required>Date</Label><Input name="date" type="date" required defaultValue={(editing?.date || blank.date).slice(0, 10)} /></div>
            </div>
            <div>
              <Label required>Customer</Label>
              <Select name="customerKey" required defaultValue={editing?.customerKey}>
                <option value="">Select customer</option>
                {sortedCustomers.map((c) => <option key={c.id} value={c.key}>{c.customerName} · {c.projectCode}</option>)}
              </Select>
            </div>
            <div><Label required>Issue title</Label><Input name="issueTitle" required defaultValue={editing?.issueTitle} /></div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label>Issue type</Label>
                <Select name="issueType" defaultValue={editing?.issueType}>
                  {issueTypes.map((i) => <option key={i.id} value={i.name}>{formatIssueType(i.name)}</option>)}
                  {editing?.issueType && !issueTypes.some((i) => i.name === editing.issueType) && <option value={editing.issueType}>{formatIssueType(editing.issueType)}</option>}
                </Select>
              </div>
              <div>
                <Label>Severity</Label>
                <Select name="severity" defaultValue={ticketSeverityLabel(editing?.severity || blank.severity)}>
                  {severityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </Select>
              </div>
              <div>
                <Label>Status</Label>
                <Select name="status" defaultValue={editing?.status || blank.status}>
                  {statuses.map((s) => <option key={s.id}>{s.label}</option>)}
                </Select>
              </div>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <div><Label>Start date</Label><Input name="startDate" type="date" defaultValue={editing?.startDate?.slice(0, 10)} /></div>
              <div><Label>Due date</Label><Input name="dueDate" type="date" defaultValue={editing?.dueDate?.slice(0, 10)} /></div>
              <div><Label>Close date</Label><Input name="closeDate" type="date" defaultValue={editing?.closeDate?.slice(0, 10)} /></div>
            </div>
            <div className="rounded-lg border border-sky-100 bg-sky-50/40 p-3">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <p className="text-[12px] font-semibold text-slate-800">Owner effort</p>
                  <p className="mt-0.5 text-[10px] text-slate-400">Effort is entered in hours. Total is saved back to contract MD automatically.</p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone="blue">{formatHours(totalOwnerEffortHours(effortPayload(effortRows).ownerEfforts))} hrs</Badge>
                  <Button type="button" variant="outline" size="sm" onClick={addEffortRow}><Plus size={14} />Add owner</Button>
                </div>
              </div>
              <div className="space-y-2">
                {effortRows.map((row) => (
                  <div key={row.id} className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_11rem_2.5rem]">
                    <Input list="team-list" value={row.owner} onChange={(event) => patchEffortRow(row.id, "owner", event.target.value)} placeholder="Owner name" />
                    <Input type="number" min="0" step={hourStep} value={row.hours} onChange={(event) => patchEffortRow(row.id, "hours", event.target.value)} placeholder="0.00000" />
                    <Button type="button" variant="ghost" size="icon" onClick={() => removeEffortRow(row.id)} disabled={effortRows.length === 1}>
                      <Trash2 size={14} className="text-rose-500" />
                    </Button>
                  </div>
                ))}
              </div>
              <datalist id="team-list">{teams.map((i) => <option key={i.id}>{i.name}</option>)}</datalist>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="mt-6 flex items-center gap-2 text-[12px] text-slate-700">
                <input name="chargeable" type="checkbox" defaultChecked={editing?.chargeable} /> Chargeable effort
              </label>
            </div>
            <div>
              <Label>{editing ? "Add log entry" : "Log"}</Label>
              {currentLog && (
                <div className="mb-3 max-h-52 overflow-y-auto rounded-lg border border-sky-100 bg-slate-50/70 p-3 text-[11px] leading-5 text-slate-600">
                  <p className="mb-2 font-semibold uppercase tracking-wide text-slate-400">Current log</p>
                  <p className="whitespace-pre-wrap">{currentLog}</p>
                </div>
              )}
              <Textarea name="logEntry" placeholder={editing ? "Type the next update. It will be appended with your account." : "Type the first log update. It will be stamped with your account."} />
              <p className="mt-1 text-[10px] text-slate-400">Saved logs are appended; existing log text is not overwritten.</p>
            </div>
            <div className="flex justify-end gap-2 border-t pt-4">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={busy}>{busy ? "Saving..." : "Save ticket"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
