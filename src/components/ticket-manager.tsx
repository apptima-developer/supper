"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import { Clock3, History, ImagePlus, Plus, Search, SquarePen, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Badge, statusTone } from "./ui/badge";
import { Dialog, DialogContent } from "./ui/dialog";
import { Input, Label, Select, Textarea } from "./ui/input";
import { MultiSelectFilter } from "./ui/multi-select-filter";
import { PaginationControls } from "./ui/pagination-controls";
import { EmptyState } from "./empty-state";
import { TicketLogBubbles } from "./ticket-log-bubbles";
import { activeSlaPause, hoursFromMd, isTicketOwner, mapKanbanStatus, mdFromHours, normalizeOwnerEfforts, ownerNamesFromEfforts, ticketEffortHours, ticketLogText, ticketOwnerLabel, ticketSeverityCode, ticketSeverityLabel, totalOwnerEffortHours } from "@/lib/domain";
import { ticketResponseSlaState, ticketSlaState } from "@/lib/sla";
import { dateTimeInputValue, formatDateTime, formatIssueType, normalizeDateTime } from "@/lib/utils";
import type { Category, Customer, Holiday, NamedMaster, Role, Sla, Status, Ticket, TicketLogAttachment } from "@/lib/types";

const blank = {
  issueId: "",
  date: "",
  customerKey: "",
  issueTitle: "",
  issueType: "",
  category: "",
  severity: "Medium",
  owner: "",
  status: "00 - Open",
  startDate: "",
  dueDate: "",
  closeDate: "",
  mdUsed: 0,
  ownerEfforts: [],
  chargeable: false,
  slaPauses: [],
};
const hourStep = "0.00001";
const maxLogImageCount = 4;
const maxLogImageBytes = 2 * 1024 * 1024;
const pageSize = 20;
const workStartHour = 9;
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

function categoryCustomerName(category: Category, customerNameByKey: Map<string, string>) {
  return category.customerName || customerNameByKey.get(category.customerKey) || "";
}

function categoryMatchesCustomer(category: Category, customerName: string, customerNameByKey: Map<string, string>) {
  if (!customerName) return false;
  return filterKey(categoryCustomerName(category, customerNameByKey)) === filterKey(customerName);
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

function fileToLogAttachment(file: File): Promise<TicketLogAttachment> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({
      id: rowId(),
      fileName: file.name,
      contentType: file.type,
      dataUrl: String(reader.result || ""),
    });
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function formatHours(value: number) {
  return Math.max(0, Number(value) || 0).toFixed(5);
}

function clockModeLabel(mode: string) {
  return mode === "calendar" ? "Calendar hours (24h)" : "Business hours (09:00-17:00)";
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

function createTicketDateValue(ticket: Ticket | null) {
  return ticket?.date || new Date().toISOString();
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
  const normalized = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? `${value}T${pad2(fallbackHour)}:00:00+07:00`
    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)
      ? `${value.length === 16 ? `${value}:00` : value}+07:00`
      : value;
  const date = new Date(normalized);
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

export function TicketManager({
  tickets,
  customers,
  statuses,
  slaRules,
  holidays,
  issueTypes,
  teams,
  categories,
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
  categories: Category[];
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
  const [formCreateDate, setFormCreateDate] = useState(createTicketDateValue(initialEditTicket));
  const [formCustomerKey, setFormCustomerKey] = useState(initialEditTicket?.customerKey || "");
  const [formSeverity, setFormSeverity] = useState(ticketSeverityLabel(initialEditTicket?.severity || blank.severity));
  const [formCategory, setFormCategory] = useState(initialEditTicket?.category || "");
  const [formStatus, setFormStatus] = useState(initialEditTicket?.status || blank.status);
  const [formStartDate, setFormStartDate] = useState(dateTimeInputValue(initialEditTicket?.startDate || ""));
  const [formCloseDate, setFormCloseDate] = useState(dateTimeInputValue(initialEditTicket?.closeDate || "", 17));
  const [effortRows, setEffortRows] = useState<EffortRow[]>(() => effortRowsForTicket(initialEditTicket));
  const [logAttachments, setLogAttachments] = useState<TicketLogAttachment[]>([]);
  const [logDropActive, setLogDropActive] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const customerNameByKey = useMemo(() => new Map(customers.map((customer) => [customer.key, customer.customerName])), [customers]);
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
  const formCustomer = useMemo(() => customers.find((customer) => customer.key === formCustomerKey), [customers, formCustomerKey]);
  const categoryOptions = useMemo(() => {
    const customerName = formCustomer?.customerName || "";
    const options = new Map<string, Category>();
    for (const category of categories) {
      if (!category.category) continue;
      if (!category.active && category.category !== formCategory) continue;
      if (!categoryMatchesCustomer(category, customerName, customerNameByKey)) continue;
      const key = filterKey(category.category);
      const current = options.get(key);
      if (!current || category.active) {
        options.set(key, {
          ...category,
          customerKey: "",
          customerName: categoryCustomerName(category, customerNameByKey),
        });
      }
    }
    return [...options.values()].sort((a, b) =>
      a.category.localeCompare(b.category, undefined, { sensitivity: "base", numeric: true }));
  }, [categories, customerNameByKey, formCategory, formCustomer?.customerName]);
  const formKanbanStatus = useMemo(() => mapKanbanStatus(formStatus), [formStatus]);
  const formTicketForSla = useMemo(() => {
    if (!formCustomer || !formStartDate) return null;
    return {
      ...(editing || blank),
      id: editing?.id || "",
      createdAt: editing?.createdAt || "",
      updatedAt: editing?.updatedAt || "",
      customerKey: formCustomer.key,
      customerName: formCustomer.customerName,
      category: formCategory,
      severity: formSeverity,
      startDate: normalizeDateTime(formStartDate),
      dueDate: editing?.dueDate || "",
      closeDate: normalizeDateTime(formCloseDate, 17),
      date: formCreateDate,
      status: formStatus,
      kanbanStatus: formKanbanStatus,
      slaPauses: editing?.slaPauses || [],
    } as Ticket;
  }, [editing, formCategory, formCloseDate, formCreateDate, formCustomer, formKanbanStatus, formSeverity, formStartDate, formStatus]);
  const formDueDate = useMemo(() => {
    if (!formTicketForSla) return editing?.dueDate || "";
    return ticketSlaState(formTicketForSla, slaRules, holidays).dueDate?.toISOString() || "";
  }, [editing?.dueDate, formTicketForSla, holidays, slaRules]);
  const modalSla = useMemo(
    () => formTicketForSla ? ticketSlaState(formTicketForSla, slaRules, holidays) : null,
    [formTicketForSla, holidays, slaRules],
  );
  const modalResponseSla = useMemo(
    () => formTicketForSla ? ticketResponseSlaState(formTicketForSla) : null,
    [formTicketForSla],
  );
  const activePause = editing ? activeSlaPause(editing) : null;
  const pauseHistory = editing?.slaPauses || [];
  const willStartPauseOnSave = formKanbanStatus === "waiting" && !activePause;
  const willClosePauseOnSave = Boolean(activePause && formKanbanStatus !== "waiting");
  const slaClockBadge = modalSla?.paused
    ? { label: "Paused", tone: "slate" as const }
    : willStartPauseOnSave
      ? { label: "Will pause on save", tone: "amber" as const }
      : willClosePauseOnSave
        ? { label: "Will resume on save", tone: "blue" as const }
        : { label: "Running", tone: "emerald" as const };

  function patchEffortRow(id: string, field: "owner" | "hours", value: string) {
    setEffortRows((rows) => rows.map((row) => row.id === id ? { ...row, [field]: value } : row));
  }

  function openEditor(ticket: Ticket | null) {
    setEditing(ticket);
    setFormCreateDate(createTicketDateValue(ticket));
    setFormCustomerKey(ticket?.customerKey || "");
    setFormSeverity(ticketSeverityLabel(ticket?.severity || blank.severity));
    setFormCategory(ticket?.category || "");
    setFormStatus(ticket?.status || blank.status);
    setFormStartDate(dateTimeInputValue(ticket?.startDate || ""));
    setFormCloseDate(dateTimeInputValue(ticket?.closeDate || "", 17));
    setEffortRows(effortRowsForTicket(ticket));
    setLogAttachments([]);
    setLogDropActive(false);
    setOpen(true);
  }

  function changeFormCustomer(customerKey: string) {
    const customer = customers.find((item) => item.key === customerKey);
    setFormCustomerKey(customerKey);
    if (formCategory && !categories.some((category) =>
      category.category === formCategory && categoryMatchesCustomer(category, customer?.customerName || "", customerNameByKey)
    )) {
      setFormCategory("");
    }
  }

  async function addLogFiles(fileList: FileList | File[]) {
    const files = Array.from(fileList).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return toast.error("Drop image files only");
    const room = maxLogImageCount - logAttachments.length;
    if (room <= 0) return toast.error(`Attach up to ${maxLogImageCount} images per log`);
    const selected = files.slice(0, room);
    const oversized = selected.filter((file) => file.size > maxLogImageBytes);
    if (oversized.length) toast.error(`Some images are over ${Math.round(maxLogImageBytes / 1024 / 1024)}MB and were skipped`);
    const valid = selected.filter((file) => file.size <= maxLogImageBytes);
    if (!valid.length) return;
    try {
      const attachments = await Promise.all(valid.map(fileToLogAttachment));
      setLogAttachments((items) => [...items, ...attachments].slice(0, maxLogImageCount));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not attach image");
    }
  }

  function removeLogAttachment(id: string) {
    setLogAttachments((items) => items.filter((item) => item.id !== id));
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
      category: formCategory,
      severity: ticketSeverityLabel(String(formData.get("severity") || "")),
      ...effortPayload(effortRows),
      status: formStatus,
      startDate: normalizeDateTime(String(formData.get("startDate"))),
      dueDate: formDueDate,
      closeDate: normalizeDateTime(String(formData.get("closeDate")), 17),
      chargeable: formData.get("chargeable") === "on",
      logEntry: {
        message: String(formData.get("logEntry")),
        attachments: logAttachments,
      },
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
      setLogAttachments([]);
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
                  <th className="px-4 py-2.5">Category</th>
                  <th className="px-4 py-2.5">Type / Severity</th>
                  <th className="px-4 py-2.5">Start</th>
                  <th className="px-4 py-2.5">Due</th>
                  <th className="px-4 py-2.5">Hours</th>
                  <th className="px-4 py-2.5">Chargeable</th>
                  <th className="px-4 py-2.5">Response SLA</th>
                  <th className="px-4 py-2.5">Resolution SLA</th>
                  <th className="px-4 py-2.5">Status</th>
                </tr>
              </thead>
              <tbody>
                {pageTickets.map((ticket) => {
                  const sla = ticketSlaState(ticket, slaRules, holidays);
                  const responseSla = ticketResponseSlaState(ticket);
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
                      <td className="max-w-[24rem] px-4 py-2">
                        <div className="flex min-w-0 items-center gap-2 whitespace-nowrap">
                          <Link href={`/tickets/${ticket.id}`} className="shrink-0 font-medium text-slate-900 hover:text-[#0a84ff]">{ticket.issueId}</Link>
                          <span className="truncate text-[11px] text-slate-500" title={ticket.issueTitle}>{ticket.issueTitle}</span>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2">{ticket.customerName}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-[11px] text-slate-600">{ticket.category || "-"}</td>
                      <td className="whitespace-nowrap px-4 py-2">
                        <div className="flex items-center gap-1.5">
                          <span>{formatIssueType(ticket.issueType)}</span>
                          <Badge tone={severityTone(ticket.severity)}>{ticketSeverityLabel(ticket.severity)}</Badge>
                        </div>
                      </td>
                      <td className="whitespace-nowrap px-4 py-2 text-[11px]">{formatDateTime(ticket.startDate || ticket.date)}</td>
                      <td className={`whitespace-nowrap px-4 py-2 text-[11px] ${sla.overdue ? "font-medium text-rose-600" : ""}`}>
                        <div className="flex items-center gap-1.5">
                          <span>{formatDateTime(sla.dueDate?.toISOString() || ticket.dueDate)}</span>
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
                        <Badge tone={responseSla.tone} title={responseSla.title}>{responseSla.label}</Badge>
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
        <DialogContent title={editing ? "Edit ticket" : "New ticket"} description="Ticket effort updates automatically recalculate the customer contract." className="max-h-[75vh] max-w-6xl">
          <form action={save} className="space-y-4">
            <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_24rem]">
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div><Label required>Issue ID</Label><Input name="issueId" required defaultValue={editing?.issueId} /></div>
                  <div>
                    <Label required>Create ticket date</Label>
                    <input type="hidden" name="date" value={formCreateDate} />
                    <div className="flex h-9 items-center rounded-lg border border-sky-100/90 bg-slate-50/70 px-3 text-[13px] font-medium text-slate-700">
                      {formatDateTime(formCreateDate)}
                    </div>
                  </div>
                </div>
                <div>
                  <Label required>Customer</Label>
                  <Select name="customerKey" required value={formCustomerKey} onChange={(event) => changeFormCustomer(event.target.value)}>
                    <option value="">Select customer</option>
                    {sortedCustomers.map((c) => <option key={c.id} value={c.key}>{c.customerName} · {c.projectCode}</option>)}
                  </Select>
                </div>
                <div><Label required>Issue title</Label><Input name="issueTitle" required defaultValue={editing?.issueTitle} /></div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <Label>Severity</Label>
                    <Select name="severity" value={formSeverity} onChange={(event) => setFormSeverity(event.target.value)}>
                      {severityOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                    </Select>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <Label>Issue type</Label>
                    <Select name="issueType" defaultValue={editing?.issueType}>
                      {issueTypes.map((i) => <option key={i.id} value={i.name}>{formatIssueType(i.name)}</option>)}
                      {editing?.issueType && !issueTypes.some((i) => i.name === editing.issueType) && <option value={editing.issueType}>{formatIssueType(editing.issueType)}</option>}
                    </Select>
                  </div>
                  <div>
                    <Label>Category</Label>
                    <Select name="category" value={formCategory} onChange={(event) => setFormCategory(event.target.value)}>
                      <option value="">No category</option>
                      {categoryOptions.map((category) => <option key={category.id} value={category.category}>{category.category}</option>)}
                      {formCategory && !categoryOptions.some((category) => category.category === formCategory) && <option value={formCategory}>{formCategory}</option>}
                    </Select>
                  </div>
                  <div>
                    <Label>Status</Label>
                    <Select name="status" value={formStatus} onChange={(event) => setFormStatus(event.target.value)}>
                      {statuses.map((s) => <option key={s.id}>{s.label}</option>)}
                    </Select>
                  </div>
                </div>
                <div className="grid gap-4 sm:grid-cols-3">
                  <div>
                    <Label>Start date</Label>
                    <Input name="startDate" type="datetime-local" step="1" value={formStartDate} onChange={(event) => setFormStartDate(event.target.value)} />
                  </div>
                  <div>
                    <Label>Due date</Label>
                    <input type="hidden" name="dueDate" value={formDueDate} />
                    <div className="flex h-9 items-center rounded-lg border border-sky-100/90 bg-slate-50/70 px-3 text-[13px] font-medium text-slate-700">
                      {formDueDate ? formatDateTime(formDueDate) : "Select customer, severity, and start date"}
                    </div>
                  </div>
                  <div>
                    <Label>End date</Label>
                    <Input name="closeDate" type="datetime-local" step="1" value={formCloseDate} onChange={(event) => setFormCloseDate(event.target.value)} />
                  </div>
                </div>
                <div className="rounded-2xl border border-sky-100 bg-gradient-to-br from-sky-50/80 via-white to-cyan-50/60 p-3 shadow-[0_10px_30px_rgba(35,77,112,.05)]">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="flex items-start gap-3">
                      <div className="rounded-xl bg-white p-2 text-sky-600 ring-1 ring-sky-100">
                        <Clock3 size={16} />
                      </div>
                      <div>
                        <p className="text-[12px] font-semibold text-slate-800">SLA clock</p>
                        <p className="mt-1 text-[11px] leading-5 text-slate-500">
                          {modalSla?.paused && activePause
                            ? `Paused since ${formatDateTime(activePause.startAt)}`
                            : willStartPauseOnSave
                              ? "Waiting is selected. Save this ticket to start pausing the SLA clock."
                              : willClosePauseOnSave
                                ? "Status is no longer waiting. Save this ticket to resume the SLA clock."
                                : "Clock is running against the calculated due date."}
                        </p>
                      </div>
                    </div>
                    <Badge tone={slaClockBadge.tone}>{slaClockBadge.label}</Badge>
                  </div>
                  <div className="mt-3 grid gap-2 sm:grid-cols-4">
                    <div className="rounded-xl border border-white/80 bg-white/70 px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Response</p>
                      <p className={`mt-1 text-[12px] font-medium ${modalResponseSla?.overdue ? "text-rose-600" : "text-slate-700"}`}>
                        {modalResponseSla ? modalResponseSla.label : "N/A"}
                      </p>
                    </div>
                    <div className="rounded-xl border border-white/80 bg-white/70 px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Clock mode</p>
                      <p className="mt-1 text-[12px] font-medium text-slate-700">{modalSla ? clockModeLabel(modalSla.clockMode) : "-"}</p>
                    </div>
                    <div className="rounded-xl border border-white/80 bg-white/70 px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Total paused</p>
                      <p className="mt-1 text-[12px] font-medium text-slate-700">{modalSla ? `${formatHours(modalSla.pausedHours)} hrs` : "0.00000 hrs"}</p>
                    </div>
                    <div className="rounded-xl border border-white/80 bg-white/70 px-3 py-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Pause history</p>
                      <p className="mt-1 text-[12px] font-medium text-slate-700">{pauseHistory.length} {pauseHistory.length === 1 ? "pause" : "pauses"}</p>
                    </div>
                  </div>
                  {pauseHistory.length > 0 && (
                    <div className="mt-3 space-y-1.5 border-t border-sky-100/80 pt-3">
                      {pauseHistory.slice(-3).reverse().map((pause) => (
                        <div key={pause.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl bg-white/65 px-3 py-2 text-[11px] text-slate-500">
                          <span className="inline-flex items-center gap-1.5 font-medium text-slate-700"><History size={12} />{pause.reason || "waiting"}</span>
                          <span>{formatDateTime(pause.startAt)} → {pause.endAt ? formatDateTime(pause.endAt) : "Now"}</span>
                        </div>
                      ))}
                    </div>
                  )}
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
                <label className="flex items-center gap-2 text-[12px] text-slate-700">
                  <input name="chargeable" type="checkbox" defaultChecked={editing?.chargeable} /> Chargeable effort
                </label>
              </div>
              <aside className="rounded-2xl border border-sky-100 bg-sky-50/45 p-4 lg:sticky lg:top-20 lg:max-h-[calc(75vh-11rem)] lg:overflow-y-auto">
                <Label>{editing ? "Add log entry" : "Log"}</Label>
                <div className="mt-2 min-h-56 rounded-xl border border-white/80 bg-white/70 p-3">
                  {currentLog && editing ? <TicketLogBubbles ticket={editing} /> : <p className="text-[12px] text-slate-400">No log recorded yet.</p>}
                </div>
                <div
                  className={`mt-3 rounded-xl border border-dashed p-3 transition-colors ${logDropActive ? "border-sky-400 bg-sky-100/70" : "border-sky-200 bg-white/55"}`}
                  onDragEnter={(event) => { event.preventDefault(); setLogDropActive(true); }}
                  onDragOver={(event) => { event.preventDefault(); setLogDropActive(true); }}
                  onDragLeave={(event) => { event.preventDefault(); setLogDropActive(false); }}
                  onDrop={(event) => {
                    event.preventDefault();
                    setLogDropActive(false);
                    void addLogFiles(event.dataTransfer.files);
                  }}
                >
                  <input
                    id="ticket-log-images"
                    type="file"
                    accept="image/*"
                    multiple
                    className="sr-only"
                    onChange={(event) => {
                      if (event.target.files) void addLogFiles(event.target.files);
                      event.target.value = "";
                    }}
                  />
                  <label htmlFor="ticket-log-images" className="flex cursor-pointer flex-col items-center justify-center rounded-lg px-3 py-4 text-center">
                    <ImagePlus size={22} className="text-[#0a84ff]" />
                    <span className="mt-2 text-[12px] font-semibold text-slate-700">Drop images here</span>
                    <span className="mt-1 text-[10px] text-slate-400">or click to browse · up to {maxLogImageCount} images</span>
                  </label>
                  {logAttachments.length > 0 && (
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {logAttachments.map((attachment) => (
                        <div key={attachment.id} className="group relative overflow-hidden rounded-xl border border-sky-100 bg-white">
                          <Image src={attachment.dataUrl} alt={attachment.fileName} width={320} height={180} unoptimized className="h-28 w-full object-cover" />
                          <button
                            type="button"
                            className="absolute right-1.5 top-1.5 rounded-full bg-slate-950/70 p-1 text-white opacity-90 transition-opacity hover:opacity-100"
                            onClick={() => removeLogAttachment(attachment.id)}
                            title="Remove image"
                          >
                            <X size={13} />
                          </button>
                          <div className="absolute inset-x-0 bottom-0 truncate bg-slate-950/60 px-2 py-1 text-[10px] text-white">{attachment.fileName}</div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <Textarea className="mt-3 min-h-32" name="logEntry" placeholder={editing ? "Type the next update. It will be appended with your account." : "Type the first log update. It will be stamped with your account."} />
                <p className="mt-1 text-[10px] text-slate-400">Saved logs are appended; existing log text is not overwritten.</p>
              </aside>
            </div>
            <div className="sticky bottom-0 z-10 -mx-5 -mb-5 flex justify-end gap-2 border-t border-sky-100/80 bg-white/90 px-5 py-4 backdrop-blur">
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
              <Button disabled={busy}>{busy ? "Saving..." : "Save ticket"}</Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
