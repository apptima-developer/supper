"use client";

import { useMemo, useState } from "react";
import { CalendarDays, UsersRound } from "lucide-react";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input, Label } from "./ui/input";
import { EmptyState } from "./empty-state";
import { HOURS_PER_MD, hoursFromMd, normalize, normalizeOwnerEfforts } from "@/lib/domain";
import { cn, formatNumber } from "@/lib/utils";
import type { Customer, NamedMaster, Ticket } from "@/lib/types";

type CustomerColumn = {
  key: string;
  label: string;
  totalHours: number;
};

type OwnerRow = {
  key: string;
  name: string;
  lob: string;
  totalHours: number;
  cells: Map<string, number>;
};

function parseDateOnly(value?: string | null) {
  if (!value) return null;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  const date = match
    ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
    : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function toIsoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function reportDate(ticket: Ticket) {
  return parseDateOnly(ticket.date) || parseDateOnly(ticket.startDate);
}

function defaultRange(tickets: Ticket[]) {
  const dates = tickets.map(reportDate).filter((date): date is Date => Boolean(date));
  const latest = dates.length ? new Date(Math.max(...dates.map((date) => date.getTime()))) : new Date();
  const firstDay = new Date(latest.getFullYear(), latest.getMonth(), 1);
  const lastDay = new Date(latest.getFullYear(), latest.getMonth() + 1, 0);
  return { from: toIsoDate(firstDay), to: toIsoDate(lastDay) };
}

function inRange(ticket: Ticket, from: string, to: string) {
  const date = reportDate(ticket);
  if (!date) return false;
  const fromDate = parseDateOnly(from);
  const toDate = parseDateOnly(to);
  if (fromDate && date < fromDate) return false;
  if (toDate) {
    const end = new Date(toDate);
    end.setHours(23, 59, 59, 999);
    if (date > end) return false;
  }
  return true;
}

function formatHours(value: number, empty = "-") {
  if (!value) return empty;
  return value.toFixed(5);
}

function totalToneClass(value: number) {
  if (value >= 120) return "bg-rose-50 text-rose-700";
  if (value >= 80) return "bg-amber-50 text-amber-700";
  if (value > 0) return "bg-emerald-50 text-emerald-700";
  return "bg-slate-50 text-slate-400";
}

function periodLabel(from: string, to: string) {
  if (!from && !to) return "All time";
  return `${from || "Start"} to ${to || "Today"}`;
}

export function EffortMatrixReport({
  tickets,
  customers,
  teams,
}: {
  tickets: Ticket[];
  customers: Customer[];
  teams: NamedMaster[];
}) {
  const initialRange = useMemo(() => defaultRange(tickets), [tickets]);
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);

  const matrix = useMemo(() => {
    const customerNames = new Map<string, string>();
    customers.forEach((customer) => {
      const key = normalize(customer.customerName);
      if (!customerNames.has(key) || customer.active) customerNames.set(key, customer.customerName);
    });

    const teamByName = new Map(teams.map((team) => [normalize(team.name), team]));
    const teamOrder = new Map(teams.map((team, index) => [normalize(team.name), index]));
    const customerMap = new Map<string, CustomerColumn>();
    const ownerMap = new Map<string, OwnerRow>();
    let includedTickets = 0;

    function ensureCustomer(rawName: string) {
      const key = normalize(rawName) || "unassigned-customer";
      const existing = customerMap.get(key);
      if (existing) return existing;
      const column = {
        key,
        label: customerNames.get(key) || rawName || "Unassigned customer",
        totalHours: 0,
      };
      customerMap.set(key, column);
      return column;
    }

    function ensureOwner(rawName: string) {
      const cleanName = rawName.trim() || "00 - Unassigned";
      const key = normalize(cleanName) || "00-unassigned";
      const existing = ownerMap.get(key);
      if (existing) return existing;
      const team = teamByName.get(key);
      const row = {
        key,
        name: team?.name || cleanName,
        lob: team?.lob || "",
        totalHours: 0,
        cells: new Map<string, number>(),
      };
      ownerMap.set(key, row);
      return row;
    }

    tickets.filter((ticket) => inRange(ticket, from, to)).forEach((ticket) => {
      const efforts = normalizeOwnerEfforts(ticket.ownerEfforts, ticket.owner, hoursFromMd(ticket.mdUsed));
      if (!efforts.length) return;
      includedTickets += 1;
      const customer = ensureCustomer(ticket.customerName);

      efforts.forEach((effort) => {
        const hours = Number(effort.hours || 0);
        if (hours <= 0) return;
        const owner = ensureOwner(effort.owner);
        owner.cells.set(customer.key, Number(((owner.cells.get(customer.key) || 0) + hours).toFixed(5)));
        owner.totalHours = Number((owner.totalHours + hours).toFixed(5));
        customer.totalHours = Number((customer.totalHours + hours).toFixed(5));
      });
    });

    const columns = [...customerMap.values()]
      .filter((customer) => customer.totalHours > 0)
      .sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base", numeric: true }));
    const rows = [...ownerMap.values()]
      .filter((owner) => owner.totalHours > 0)
      .sort((a, b) => {
        const aOrder = teamOrder.get(a.key) ?? Number.MAX_SAFE_INTEGER;
        const bOrder = teamOrder.get(b.key) ?? Number.MAX_SAFE_INTEGER;
        return aOrder - bOrder || a.name.localeCompare(b.name);
      });
    const totalHours = Number(columns.reduce((sum, customer) => sum + customer.totalHours, 0).toFixed(5));

    return { columns, rows, includedTickets, totalHours };
  }, [customers, from, teams, tickets, to]);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Criteria</CardTitle>
          <Badge tone="blue">{periodLabel(from, to)}</Badge>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 md:grid-cols-[12rem_12rem_1fr]">
            <div>
              <Label>From</Label>
              <Input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
            </div>
            <div>
              <Label>To</Label>
              <Input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
            </div>
            <div className="rounded-xl border border-sky-100 bg-sky-50/45 p-3 text-[11px] leading-5 text-slate-500">
              <p className="font-semibold text-slate-700">Matrix rule</p>
              <p>Rows are team members from master data plus any ticket owner found in the selected period. Columns are customers with recorded effort. Effort is summed in hours from ticket owner effort; legacy ticket MD is converted at {HOURS_PER_MD} hours per MD.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {[
          ["Total MH", formatHours(matrix.totalHours, "0.00000"), CalendarDays, "bg-sky-50 text-sky-700"],
          ["Total MD", formatHours(matrix.totalHours / HOURS_PER_MD, "0.00000"), CalendarDays, "bg-cyan-50 text-cyan-700"],
          ["Contributors", formatNumber(matrix.rows.length, 0), UsersRound, "bg-violet-50 text-violet-700"],
          ["Tickets counted", formatNumber(matrix.includedTickets, 0), CalendarDays, "bg-emerald-50 text-emerald-700"],
        ].map(([label, value, Icon, tone]) => (
          <Card key={String(label)}>
            <CardContent className="flex items-center gap-3">
              <div className={cn("rounded-xl p-2", tone as string)}><Icon size={18} /></div>
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label as string}</p>
                <p className="mt-1 text-[20px] font-semibold text-slate-900">{value as string}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Team x Customer Effort Matrix</CardTitle>
          <span className="text-[10px] text-slate-400">{matrix.rows.length} rows · {matrix.columns.length} customers</span>
        </CardHeader>
        {matrix.rows.length && matrix.columns.length ? (
          <div className="overflow-x-auto">
            <table className="min-w-max text-left text-[12px]">
              <thead className="text-[10px] uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="sticky left-0 z-20 min-w-64 border-b border-r bg-slate-950 px-4 py-2.5 text-white">Name / LOB</th>
                  {matrix.columns.map((customer) => (
                    <th key={customer.key} className="max-w-44 min-w-36 whitespace-normal break-words border-b border-r bg-sky-50 px-3 py-2.5 text-center leading-4 text-[#173b57]">{customer.label}</th>
                  ))}
                  <th className="sticky right-0 z-20 min-w-32 border-b border-l bg-slate-950 px-3 py-2.5 text-right text-white">Total MH</th>
                </tr>
              </thead>
              <tbody>
                {matrix.rows.map((row) => (
                  <tr key={row.key} className="hover:bg-sky-50/40">
                    <td className="sticky left-0 z-10 border-r bg-white px-4 py-2">
                      <p className="font-semibold text-slate-800">{row.name}</p>
                      {row.lob && <p className="mt-0.5 text-[10px] uppercase tracking-wide text-slate-400">{row.lob}</p>}
                    </td>
                    {matrix.columns.map((customer) => {
                      const value = row.cells.get(customer.key) || 0;
                      return (
                        <td key={customer.key} className="border-r px-3 py-2 text-right tabular-nums text-slate-700">
                          {formatHours(value)}
                        </td>
                      );
                    })}
                    <td className={cn("sticky right-0 border-l px-3 py-2 text-right font-semibold tabular-nums", totalToneClass(row.totalHours))}>
                      {formatHours(row.totalHours)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td className="sticky left-0 z-10 border-r bg-sky-100 px-4 py-2 text-right font-semibold text-[#173b57]">Total MH</td>
                  {matrix.columns.map((customer) => (
                    <td key={customer.key} className="border-r bg-sky-50 px-3 py-2 text-right font-semibold tabular-nums text-[#173b57]">
                      {formatHours(customer.totalHours, "0.00000")}
                    </td>
                  ))}
                  <td className="sticky right-0 border-l bg-sky-100 px-3 py-2 text-right font-semibold tabular-nums text-[#173b57]">
                    {formatHours(matrix.totalHours, "0.00000")}
                  </td>
                </tr>
                <tr>
                  <td className="sticky left-0 z-10 border-r bg-cyan-100 px-4 py-2 text-right font-semibold text-[#173b57]">Total MD</td>
                  {matrix.columns.map((customer) => (
                    <td key={customer.key} className="border-r bg-cyan-50 px-3 py-2 text-right font-semibold tabular-nums text-[#173b57]">
                      {formatHours(customer.totalHours / HOURS_PER_MD, "0.00000")}
                    </td>
                  ))}
                  <td className="sticky right-0 border-l bg-cyan-100 px-3 py-2 text-right font-semibold tabular-nums text-[#173b57]">
                    {formatHours(matrix.totalHours / HOURS_PER_MD, "0.00000")}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        ) : (
          <EmptyState title="No effort in this period" description="Change the from/to criteria to include tickets with owner effort." />
        )}
      </Card>
    </div>
  );
}
