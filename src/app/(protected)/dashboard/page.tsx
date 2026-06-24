import Link from "next/link";
import {
  Activity,
  AlertTriangle,
  Archive,
  Building2,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Headset,
  Hourglass,
  TimerOff,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { Progress } from "@/components/ui/progress";
import { MdChart, StatusChart } from "@/components/dashboard-charts";
import { loadDashboardData } from "@/lib/repositories";
import {
  contractLifecycle,
  hoursFromMd,
  isKanbanArchiveCandidate,
  normalizeOwnerEfforts,
  ticketAgeDays,
  ticketEffortHours,
  ticketOwnerLabel,
} from "@/lib/domain";
import { formatDate, formatNumber } from "@/lib/utils";
import type { Customer, Ticket } from "@/lib/types";

export const dynamic = "force-dynamic";

const closedStatuses = new Set(["closed", "cancelled", "resolved"]);
const weekMs = 7 * 24 * 60 * 60 * 1000;

function formatHours(value: number) {
  return Math.max(0, Number(value) || 0).toFixed(5);
}

function dueTime(ticket: Ticket) {
  if (!ticket.dueDate) return null;
  const time = new Date(ticket.dueDate).getTime();
  return Number.isNaN(time) ? null : time;
}

function severityRank(severity: string) {
  const normalized = severity.trim().toLowerCase();
  if (["p1", "critical"].includes(normalized)) return 0;
  if (["p2", "high"].includes(normalized)) return 1;
  if (["p3", "medium"].includes(normalized)) return 2;
  return 3;
}

function riskScore(customer: Customer) {
  const lifecycle = contractLifecycle(customer);
  return (
    (customer.mdRemaining < 0 ? 1000 : 0) +
    (customer.burnRate >= 100 ? 500 : customer.burnRate >= 80 ? 250 : 0) +
    (lifecycle === "Expired" ? 200 : lifecycle === "Expiring" ? 100 : 0) +
    customer.burnRate
  );
}

function reasonFor(ticket: Ticket, now: Date) {
  const due = dueTime(ticket);
  const age = ticketAgeDays(ticket, now) ?? 0;
  const highPriority = severityRank(ticket.severity) <= 1;
  if (due && due < now.getTime()) return { label: "Overdue", tone: "rose" as const, priority: 0 };
  if (highPriority) return { label: "High priority", tone: "rose" as const, priority: 1 };
  if (ticket.kanbanStatus === "waiting") return { label: "Waiting customer", tone: "amber" as const, priority: 2 };
  if (due && due <= now.getTime() + weekMs) return { label: "Due this week", tone: "amber" as const, priority: 3 };
  if (age > 30) return { label: `${age}d open`, tone: "slate" as const, priority: 4 };
  return null;
}

function MetricCard({
  label,
  value,
  hint,
  icon: Icon,
  tone,
}: {
  label: string;
  value: string | number;
  hint: string;
  icon: typeof Activity;
  tone: string;
}) {
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[11px] font-medium text-slate-500">{label}</p>
            <p className="mt-2 text-[25px] font-semibold tracking-tight text-slate-900">{value}</p>
            <p className="mt-1 text-[10px] text-slate-400">{hint}</p>
          </div>
          <div className={`rounded-2xl p-2.5 shadow-sm ${tone}`}>
            <Icon size={18} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

export default async function DashboardPage() {
  const { customers, tickets } = await loadDashboardData();
  const now = new Date();
  const activeCustomers = customers.filter((customer) => customer.active);
  const archivedCustomers = customers.length - activeCustomers.length;
  const openTickets = tickets.filter((ticket) => !closedStatuses.has(ticket.kanbanStatus));
  const closedTickets = tickets.filter((ticket) => closedStatuses.has(ticket.kanbanStatus));
  const overdueTickets = openTickets.filter((ticket) => {
    const due = dueTime(ticket);
    return due !== null && due < now.getTime();
  });
  const overdueTicketIds = new Set(overdueTickets.map((ticket) => ticket.id));
  const dueThisWeek = openTickets.filter((ticket) => {
    const due = dueTime(ticket);
    return due !== null && due >= now.getTime() && due <= now.getTime() + weekMs;
  });
  const waitingTickets = openTickets.filter((ticket) => ticket.kanbanStatus === "waiting");
  const staleTickets = openTickets.filter((ticket) => isKanbanArchiveCandidate(ticket, now));
  const expiringCustomers = activeCustomers.filter((customer) => contractLifecycle(customer) === "Expiring");
  const expiredCustomers = activeCustomers.filter((customer) => contractLifecycle(customer) === "Expired");
  const capacity = activeCustomers.reduce((sum, customer) => sum + customer.mdPurchased + (customer.carryForward || 0), 0);
  const used = activeCustomers.reduce((sum, customer) => sum + customer.mdUsed, 0);
  const remaining = activeCustomers.reduce((sum, customer) => sum + customer.mdRemaining, 0);
  const utilization = capacity ? (used / capacity) * 100 : 0;
  const statusData = Object.entries(tickets.reduce<Record<string, number>>((acc, ticket) => {
    const key = ticket.kanbanStatus.replace("_", " ");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {})).map(([name, value]) => ({ name, value }));
  const riskCustomers = [...activeCustomers]
    .filter((customer) => riskScore(customer) >= 80)
    .sort((a, b) => riskScore(b) - riskScore(a))
    .slice(0, 8);
  const mdPressure = [...activeCustomers]
    .sort((a, b) => a.mdRemaining - b.mdRemaining || b.burnRate - a.burnRate)
    .slice(0, 8)
    .map((customer) => ({ name: customer.customerName, value: customer.mdRemaining }));
  const actionQueue = openTickets
    .map((ticket) => ({ ticket, reason: reasonFor(ticket, now), due: dueTime(ticket), age: ticketAgeDays(ticket, now) ?? 0 }))
    .filter((item): item is { ticket: Ticket; reason: NonNullable<ReturnType<typeof reasonFor>>; due: number | null; age: number } => item.reason !== null)
    .sort((a, b) =>
      a.reason.priority - b.reason.priority ||
      (a.due ?? Number.MAX_SAFE_INTEGER) - (b.due ?? Number.MAX_SAFE_INTEGER) ||
      severityRank(a.ticket.severity) - severityRank(b.ticket.severity) ||
      b.age - a.age
    )
    .slice(0, 10);
  const ownerWorkload = [...openTickets.reduce((map, ticket) => {
    const efforts = normalizeOwnerEfforts(ticket.ownerEfforts, ticket.owner, hoursFromMd(ticket.mdUsed));
    const normalized = efforts.length ? efforts : [{ owner: "Unassigned", hours: ticketEffortHours(ticket) }];
    for (const effort of normalized) {
      const name = effort.owner || "Unassigned";
      const current = map.get(name) || { owner: name, tickets: 0, hours: 0, overdue: 0 };
      current.tickets += 1;
      current.hours += effort.hours;
      if (overdueTicketIds.has(ticket.id)) current.overdue += 1;
      map.set(name, current);
    }
    return map;
  }, new Map<string, { owner: string; tickets: number; hours: number; overdue: number }>()).values()]
    .sort((a, b) => b.overdue - a.overdue || b.tickets - a.tickets || b.hours - a.hours)
    .slice(0, 8);
  const recentTickets = [...tickets].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8);
  const cards = [
    { label: "Open tickets", value: openTickets.length, hint: `${closedTickets.length} closed/resolved`, icon: Headset, tone: "bg-blue-50 text-blue-700" },
    { label: "Overdue", value: overdueTickets.length, hint: "Unresolved and past due", icon: TimerOff, tone: "bg-rose-50 text-rose-700" },
    { label: "Due this week", value: dueThisWeek.length, hint: "Needs scheduling attention", icon: CalendarClock, tone: "bg-amber-50 text-amber-700" },
    { label: "Waiting customer", value: waitingTickets.length, hint: "Blocked on customer input", icon: Clock3, tone: "bg-violet-50 text-violet-700" },
    { label: "Active contracts", value: activeCustomers.length, hint: `${archivedCustomers} archived inactive`, icon: Building2, tone: "bg-cyan-50 text-cyan-700" },
    { label: "Expiring / expired", value: `${expiringCustomers.length}/${expiredCustomers.length}`, hint: "Active customers by end period", icon: AlertTriangle, tone: "bg-amber-50 text-amber-700" },
    { label: "MD remaining", value: formatNumber(remaining), hint: `${formatNumber(utilization, 0)}% utilization`, icon: Hourglass, tone: "bg-emerald-50 text-emerald-700" },
    { label: "Aged open", value: staleTickets.length, hint: "Open > 90 days", icon: Archive, tone: "bg-slate-100 text-slate-700" },
  ];

  return (
    <>
      <PageHeader title="Operations overview" description="Prioritized contract risk, ticket exposure, owner workload, and service activity in one working view." />

      <section className="mb-4 grid gap-4 xl:grid-cols-[1.35fr_.65fr]">
        <Card className="bg-gradient-to-br from-white/88 via-sky-50/70 to-cyan-50/50">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-[.18em] text-sky-600/70">Today&apos;s control signal</p>
                <h2 className="mt-2 text-[24px] font-semibold tracking-tight text-[#132f46]">
                  {overdueTickets.length ? `${overdueTickets.length} tickets need attention first` : "No overdue tickets right now"}
                </h2>
                <p className="mt-1 max-w-2xl text-[12px] leading-5 text-slate-500">
                  {dueThisWeek.length} due this week, {waitingTickets.length} waiting on customer, and {riskCustomers.length} contracts above the risk threshold.
                </p>
              </div>
              <div className="rounded-2xl bg-white/70 p-4 ring-1 ring-sky-100">
                <p className="text-[10px] uppercase tracking-wide text-slate-400">MD capacity</p>
                <p className="mt-1 text-[22px] font-semibold text-slate-900">{formatNumber(used)} / {formatNumber(capacity)}</p>
                <Progress value={utilization} tone={utilization >= 100 ? "bg-rose-500" : utilization >= 80 ? "bg-amber-500" : "bg-gradient-to-r from-[#0a84ff] to-[#20c9b7]"} />
                <p className="mt-2 text-[10px] text-slate-400">{formatNumber(remaining)} MD remaining across active contracts</p>
              </div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Quick links</CardTitle><span className="text-[10px] text-slate-400">Jump to work</span></CardHeader>
          <CardContent className="grid gap-2 p-3">
            {[
              ["/tickets", "Ticket operations", `${openTickets.length} open`],
              ["/kanban", "Kanban board", `${staleTickets.length} archived stale`],
              ["/customers", "Customer contracts", `${riskCustomers.length} risk watch`],
              ["/imports", "Import center", "Workbook pipeline"],
            ].map(([href, label, hint]) => (
              <Link key={href} href={href} className="flex items-center justify-between rounded-xl bg-white/70 px-3 py-2 text-[12px] font-medium text-slate-700 ring-1 ring-sky-100/70 transition-colors hover:bg-sky-50">
                <span>{label}</span>
                <span className="text-[10px] font-normal text-slate-400">{hint}</span>
              </Link>
            ))}
          </CardContent>
        </Card>
      </section>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {cards.map((card) => <MetricCard key={card.label} {...card} />)}
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[1.25fr_.75fr]">
        <Card>
          <CardHeader><CardTitle>Action queue</CardTitle><span className="text-[10px] text-slate-400">Sorted by urgency</span></CardHeader>
          {actionQueue.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                  <tr><th className="px-4 py-2.5">Ticket</th><th className="px-4 py-2.5">Customer</th><th className="px-4 py-2.5">Owner</th><th className="px-4 py-2.5">Due</th><th className="px-4 py-2.5">Reason</th></tr>
                </thead>
                <tbody>
                  {actionQueue.map(({ ticket, reason }) => (
                    <tr key={ticket.id} className="border-t hover:bg-slate-50/70">
                      <td className="max-w-[28rem] px-4 py-3">
                        <Link href={`/tickets/${ticket.id}`} className="font-medium text-slate-900 hover:text-[#0a84ff]">{ticket.issueId}</Link>
                        <p className="mt-0.5 truncate text-[10px] text-slate-400">{ticket.issueTitle}</p>
                      </td>
                      <td className="whitespace-nowrap px-4 py-3">{ticket.customerName}</td>
                      <td className="whitespace-nowrap px-4 py-3">{ticketOwnerLabel(ticket) || "Unassigned"}</td>
                      <td className="whitespace-nowrap px-4 py-3 text-[11px]">{formatDate(ticket.dueDate)}</td>
                      <td className="whitespace-nowrap px-4 py-3"><Badge tone={reason.tone}>{reason.label}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No urgent queue" description="No overdue, high-priority, waiting, due-soon, or aging tickets match the current rules." />
          )}
        </Card>

        <Card>
          <CardHeader><CardTitle>Owner workload</CardTitle><span className="text-[10px] text-slate-400">Open tickets</span></CardHeader>
          {ownerWorkload.length ? (
            <div className="divide-y">
              {ownerWorkload.map((item) => (
                <div key={item.owner} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-medium text-slate-800">{item.owner}</p>
                    {item.overdue ? <Badge tone="rose">{item.overdue} overdue</Badge> : <Badge tone="slate">{item.tickets} tickets</Badge>}
                  </div>
                  <div className="mt-2 flex items-center gap-2 text-[10px] text-slate-400">
                    <div className="min-w-0 flex-1"><Progress value={Math.min(item.tickets * 12, 100)} /></div>
                    <span>{formatHours(item.hours)} hrs</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No open workload" description="Owner load appears when tickets are assigned and still open." />
          )}
        </Card>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>Contract pressure</CardTitle><span className="text-[10px] text-slate-400">Lowest remaining MD</span></CardHeader>
          <CardContent>{mdPressure.length ? <MdChart data={mdPressure} /> : <EmptyState title="No active contract data" description="Active customers will appear here once contracts are created." />}</CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Ticket status mix</CardTitle><span className="text-[10px] text-slate-400">{tickets.length} total tickets</span></CardHeader>
          <CardContent>{tickets.length ? <StatusChart data={statusData} /> : <EmptyState title="No ticket data" description="Import Issues_Log or create tickets to see status distribution." />}</CardContent>
        </Card>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
        <Card>
          <CardHeader><CardTitle>Customer risk watch</CardTitle><span className="text-[10px] text-slate-400">Utilization, remaining MD, renewal exposure</span></CardHeader>
          {riskCustomers.length ? (
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                  <tr><th className="px-4 py-2.5">Customer</th><th className="px-4 py-2.5">Used / Capacity</th><th className="px-4 py-2.5">Remaining</th><th className="px-4 py-2.5">Renewal</th><th className="px-4 py-2.5">Health</th></tr>
                </thead>
                <tbody>
                  {riskCustomers.map((customer) => {
                    const customerCapacity = customer.mdPurchased + (customer.carryForward || 0);
                    const lifecycle = contractLifecycle(customer);
                    return (
                      <tr key={customer.id} className="border-t hover:bg-slate-50/70">
                        <td className="px-4 py-3">
                          <Link href={`/customers/${customer.id}`} className="font-medium text-slate-900 hover:text-[#0a84ff]">{customer.customerName}</Link>
                          <p className="mt-0.5 truncate text-[10px] text-slate-400">{customer.projectCode}</p>
                        </td>
                        <td className="min-w-44 px-4 py-3">
                          <div className="flex items-center gap-2 text-[10px]">
                            <span>{formatNumber(customer.mdUsed)} / {formatNumber(customerCapacity)}</span>
                            <div className="min-w-20 flex-1"><Progress value={customer.burnRate} tone={customer.burnRate >= 100 ? "bg-rose-500" : customer.burnRate >= 80 ? "bg-amber-500" : undefined} /></div>
                          </div>
                        </td>
                        <td className="whitespace-nowrap px-4 py-3 font-medium">{formatNumber(customer.mdRemaining)} MD</td>
                        <td className="whitespace-nowrap px-4 py-3">{lifecycle ? <Badge tone={lifecycle === "Expired" ? "slate" : "amber"}>{lifecycle}</Badge> : <Badge tone="emerald"><CheckCircle2 size={11} />OK</Badge>}</td>
                        <td className="whitespace-nowrap px-4 py-3"><Badge tone={statusTone(customer.mdStatus)}>{customer.mdStatus}</Badge></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState title="No customers at risk" description={customers.length ? "Active contracts are below the risk threshold." : "Customer risk appears once contract data exists."} />
          )}
        </Card>

        <Card>
          <CardHeader><CardTitle>Recent ticket updates</CardTitle><span className="text-[10px] text-slate-400">Latest activity</span></CardHeader>
          {recentTickets.length ? (
            <div className="divide-y">
              {recentTickets.map((ticket) => (
                <div key={ticket.id} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <Link href={`/tickets/${ticket.id}`} className="truncate font-medium text-slate-800 hover:text-[#0a84ff]">{ticket.issueId} · {ticket.issueTitle}</Link>
                    <Badge tone={statusTone(ticket.status)}>{ticket.status.replace(/^\d{2}\s*-\s*/, "")}</Badge>
                  </div>
                  <div className="mt-1 flex justify-between gap-3 text-[10px] text-slate-400">
                    <span className="truncate">{ticket.customerName} · {ticketOwnerLabel(ticket) || "Unassigned"}</span>
                    <span className="whitespace-nowrap">{formatDate(ticket.updatedAt)}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <EmptyState title="No recent updates" />
          )}
        </Card>
      </section>
    </>
  );
}
