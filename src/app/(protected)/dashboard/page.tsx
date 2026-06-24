import {
  Activity,
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock3,
  Headset,
  Hourglass,
  TimerOff,
  UsersRound,
} from "lucide-react";
import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/empty-state";
import { Progress } from "@/components/ui/progress";
import { AgingChart, MdChart, OwnerTicketChart, StatusChart } from "@/components/dashboard-charts";
import { requireSession } from "@/lib/auth";
import { loadDashboardData } from "@/lib/repositories";
import {
  hoursFromMd,
  isKanbanArchiveCandidate,
  normalize,
  normalizeOwnerEfforts,
  ticketAgeDays,
  ticketEffortHours,
  ticketOwnerList,
  ticketSeverityCode,
  ticketSeverityLabel,
} from "@/lib/domain";
import type { Ticket } from "@/lib/types";

export const dynamic = "force-dynamic";

const closedStatuses = new Set(["closed", "cancelled", "resolved"]);
const weekMs = 7 * 24 * 60 * 60 * 1000;

type OwnerSlice = { owner: string; hours: number };
type OwnerWorkload = {
  owner: string;
  tickets: number;
  hours: number;
  overdue: number;
  dueSoon: number;
  waiting: number;
  highPriority: number;
};

function formatHours(value: number) {
  return Math.max(0, Number(value) || 0).toFixed(5);
}

function dueTime(ticket: Ticket) {
  if (!ticket.dueDate) return null;
  const time = new Date(ticket.dueDate).getTime();
  return Number.isNaN(time) ? null : time;
}

function severityRank(severity: string) {
  const code = ticketSeverityCode(severity);
  return code === "P1" ? 0 : code === "P2" ? 1 : code === "P3" ? 2 : 3;
}

function effortSlices(ticket: Ticket): OwnerSlice[] {
  const explicitEfforts = normalizeOwnerEfforts(ticket.ownerEfforts, "", 0);
  if (explicitEfforts.length) {
    return explicitEfforts.map((item) => ({
      owner: item.owner || "Unassigned",
      hours: item.hours,
    }));
  }

  const owners = ticketOwnerList(ticket);
  const totalHours = ticketEffortHours(ticket) || hoursFromMd(ticket.mdUsed);
  if (owners.length) {
    const splitHours = totalHours / owners.length;
    return owners.map((owner) => ({ owner, hours: splitHours }));
  }
  return [{ owner: "Unassigned", hours: totalHours }];
}

function agingBucket(ticket: Ticket, now: Date) {
  const age = ticketAgeDays(ticket, now) ?? 0;
  if (age <= 7) return "0-7d";
  if (age <= 14) return "8-14d";
  if (age <= 30) return "15-30d";
  if (age <= 60) return "31-60d";
  if (age <= 90) return "61-90d";
  return "90d+";
}

function prettyStatus(value: string) {
  return value.replace("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function ownerMatchesSession(owner: string, sessionNames: Set<string>) {
  return sessionNames.has(normalize(owner));
}

function PulseStat({
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
    <div className="rounded-2xl bg-white/76 p-4 ring-1 ring-sky-100/80 shadow-[0_12px_30px_rgba(35,77,112,.06)]">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-semibold uppercase tracking-[.14em] text-slate-400">{label}</p>
          <p className="mt-2 text-[24px] font-semibold tracking-tight text-[#132f46]">{value}</p>
          <p className="mt-1 text-[10px] text-slate-400">{hint}</p>
        </div>
        <div className={`rounded-2xl p-2.5 ${tone}`}>
          <Icon size={18} />
        </div>
      </div>
    </div>
  );
}

export default async function DashboardPage() {
  const [session, { customers, tickets }] = await Promise.all([requireSession(), loadDashboardData()]);
  const now = new Date();
  const openTickets = tickets.filter((ticket) => !closedStatuses.has(ticket.kanbanStatus));
  const overdueTickets = openTickets.filter((ticket) => {
    const due = dueTime(ticket);
    return due !== null && due < now.getTime();
  });
  const dueSoonTickets = openTickets.filter((ticket) => {
    const due = dueTime(ticket);
    return due !== null && due >= now.getTime() && due <= now.getTime() + weekMs;
  });
  const waitingTickets = openTickets.filter((ticket) => ticket.kanbanStatus === "waiting");
  const agedTickets = openTickets.filter((ticket) => isKanbanArchiveCandidate(ticket, now));
  const activeCustomers = customers.filter((customer) => customer.active);

  const overdueIds = new Set(overdueTickets.map((ticket) => ticket.id));
  const dueSoonIds = new Set(dueSoonTickets.map((ticket) => ticket.id));
  const ownerMap = new Map<string, OwnerWorkload>();
  const customerEffort = new Map<string, number>();

  for (const ticket of openTickets) {
    const slices = effortSlices(ticket);
    const ticketHours = slices.reduce((sum, item) => sum + item.hours, 0);
    customerEffort.set(ticket.customerName || "Unknown customer", (customerEffort.get(ticket.customerName || "Unknown customer") || 0) + ticketHours);

    for (const slice of slices) {
      const owner = slice.owner || "Unassigned";
      const current = ownerMap.get(owner) || {
        owner,
        tickets: 0,
        hours: 0,
        overdue: 0,
        dueSoon: 0,
        waiting: 0,
        highPriority: 0,
      };
      current.tickets += 1;
      current.hours += slice.hours;
      if (overdueIds.has(ticket.id)) current.overdue += 1;
      if (dueSoonIds.has(ticket.id)) current.dueSoon += 1;
      if (ticket.kanbanStatus === "waiting") current.waiting += 1;
      if (severityRank(ticket.severity) <= 1) current.highPriority += 1;
      ownerMap.set(owner, current);
    }
  }

  const ownerWorkload = [...ownerMap.values()]
    .sort((a, b) => b.overdue - a.overdue || b.dueSoon - a.dueSoon || b.tickets - a.tickets || b.hours - a.hours)
    .slice(0, 10);
  const allOwnerWorkload = [...ownerMap.values()];
  const sessionOwnerNames = new Set([session.username, session.name].map(normalize).filter(Boolean));
  const visibleOwnerWorkload = session.role === "support"
    ? allOwnerWorkload.filter((item) => ownerMatchesSession(item.owner, sessionOwnerNames))
    : ownerWorkload;
  const maxOwnerTickets = Math.max(1, ...visibleOwnerWorkload.map((item) => item.tickets));
  const totalAssigned = allOwnerWorkload.reduce((sum, item) => sum + item.tickets, 0);
  const totalOpenHours = allOwnerWorkload.reduce((sum, item) => sum + item.hours, 0);
  const unassigned = ownerMap.get("Unassigned")?.tickets || 0;

  const ownerTicketData = visibleOwnerWorkload.slice(0, 8).map((item) => ({
    name: item.owner,
    onTrack: Math.max(0, item.tickets - item.overdue - item.dueSoon),
    dueSoon: item.dueSoon,
    overdue: item.overdue,
  }));
  const ownerEffortData = [...ownerMap.values()]
    .sort((a, b) => b.hours - a.hours)
    .slice(0, 8)
    .map((item) => ({ name: item.owner, value: Number(item.hours.toFixed(5)) }));
  const customerEffortData = [...customerEffort.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([name, value]) => ({ name, value: Number(value.toFixed(5)) }));
  const statusData = Object.entries(openTickets.reduce<Record<string, number>>((acc, ticket) => {
    const key = prettyStatus(ticket.kanbanStatus);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {})).map(([name, value]) => ({ name, value }));
  const severityData = Object.entries(openTickets.reduce<Record<string, number>>((acc, ticket) => {
    const code = ticketSeverityCode(ticket.severity);
    const key = `${code} ${ticketSeverityLabel(ticket.severity)}`;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {})).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => ({ name, value }));
  const agingOrder = ["0-7d", "8-14d", "15-30d", "31-60d", "61-90d", "90d+"];
  const agingCounts = openTickets.reduce<Record<string, number>>((acc, ticket) => {
    const bucket = agingBucket(ticket, now);
    acc[bucket] = (acc[bucket] || 0) + 1;
    return acc;
  }, {});
  const agingData = agingOrder.map((name) => ({ name, value: agingCounts[name] || 0 }));

  return (
    <>
      <PageHeader
        title="Operations dashboard"
        description="Owner assignments, open effort, and ticket pressure without the old shortcut clutter."
      />

      <section className="grid gap-4 xl:grid-cols-[1.15fr_.85fr]">
        <Card className="bg-gradient-to-br from-white/88 via-sky-50/72 to-cyan-50/50">
          <CardContent className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-5">
              <div className="max-w-2xl">
                <p className="text-[10px] font-semibold uppercase tracking-[.2em] text-sky-600/70">Assignment signal</p>
                <h2 className="mt-2 text-[26px] font-semibold tracking-tight text-[#132f46]">
              {overdueTickets.length
                ? `${overdueTickets.length} overdue tickets need owner action`
                : "No overdue assigned work right now"}
                </h2>
                <p className="mt-2 text-[12px] leading-5 text-slate-500">
                  Tracking {openTickets.length} open tickets across {ownerMap.size} owners, with {formatHours(totalOpenHours)} open effort hours currently on assignment.
                </p>
              </div>
              <div className="min-w-64 rounded-2xl bg-white/76 p-4 ring-1 ring-sky-100/80">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[10px] uppercase tracking-wide text-slate-400">Open assignment coverage</p>
                    <p className="mt-1 text-[24px] font-semibold text-slate-900">{totalAssigned}</p>
                  </div>
                  <UsersRound className="text-sky-600" size={24} />
                </div>
                <div className="mt-3">
                  <Progress value={openTickets.length ? ((openTickets.length - unassigned) / openTickets.length) * 100 : 0} />
                </div>
                <p className="mt-2 text-[10px] text-slate-400">{unassigned} open tickets are still unassigned</p>
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="grid gap-3 sm:grid-cols-2">
          <PulseStat label="Open tickets" value={openTickets.length} hint={`${activeCustomers.length} active customers`} icon={Headset} tone="bg-blue-50 text-blue-700" />
          <PulseStat label="Overdue" value={overdueTickets.length} hint="Past due and unresolved" icon={TimerOff} tone="bg-rose-50 text-rose-700" />
          <PulseStat label="Due this week" value={dueSoonTickets.length} hint="Needs scheduling focus" icon={CalendarClock} tone="bg-amber-50 text-amber-700" />
          <PulseStat label="Open effort" value={formatHours(totalOpenHours)} hint={`${agedTickets.length} open tickets older than 90d`} icon={Hourglass} tone="bg-emerald-50 text-emerald-700" />
        </div>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[.85fr_1.15fr]">
        <Card>
          <CardHeader>
            <CardTitle>On assignment by owner</CardTitle>
            <span className="text-[10px] text-slate-400">{session.role === "support" ? "your assigned work" : "account = owner"}</span>
          </CardHeader>
          {visibleOwnerWorkload.length ? (
            <CardContent className="space-y-3">
              {visibleOwnerWorkload.map((item, index) => {
                const riskTone: "rose" | "amber" | "blue" | "slate" = item.overdue ? "rose" : item.dueSoon ? "amber" : item.tickets ? "blue" : "slate";
                return (
                  <div key={item.owner} className="rounded-2xl border border-sky-100/80 bg-white/76 p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-sky-50 text-[11px] font-semibold text-sky-700">{index + 1}</span>
                          <p className="truncate font-semibold text-slate-800">{item.owner}</p>
                        </div>
                        <p className="mt-1 text-[10px] text-slate-400">{formatHours(item.hours)} hrs · {item.waiting} waiting · {item.highPriority} high priority</p>
                      </div>
                      <Badge tone={riskTone}>{item.tickets} open</Badge>
                    </div>
                    <div className="mt-3">
                      <Progress value={(item.tickets / maxOwnerTickets) * 100} tone={item.overdue ? "bg-rose-500" : item.dueSoon ? "bg-amber-500" : undefined} />
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2 text-[10px] text-slate-500">
                      <span>{item.overdue} overdue</span>
                      <span>{item.dueSoon} due soon</span>
                      <span>{Math.max(0, item.tickets - item.overdue - item.dueSoon)} on track</span>
                    </div>
                  </div>
                );
              })}
            </CardContent>
          ) : (
            <EmptyState title="No open assignments" description={session.role === "support" ? "No open tickets are assigned to your account/owner name." : "Open ticket assignment will appear here once tickets have owners."} />
          )}
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Ticket load comparison</CardTitle>
            <span className="text-[10px] text-slate-400">{session.role === "support" ? "Your open / due soon / overdue" : "Open / due soon / overdue"}</span>
          </CardHeader>
          <CardContent>
            {ownerTicketData.length ? <OwnerTicketChart data={ownerTicketData} /> : <EmptyState title="No owner ticket data" />}
          </CardContent>
        </Card>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Effort by owner</CardTitle>
            <span className="text-[10px] text-slate-400">Open hours</span>
          </CardHeader>
          <CardContent>
            {ownerEffortData.length ? <MdChart data={ownerEffortData} color="#20c9b7" /> : <EmptyState title="No effort data" description="Effort appears when tickets have MD or owner hour values." />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Effort by customer</CardTitle>
            <span className="text-[10px] text-slate-400">Top open workload</span>
          </CardHeader>
          <CardContent>
            {customerEffortData.length ? <MdChart data={customerEffortData} color="#0a84ff" /> : <EmptyState title="No customer effort" description="Customer effort appears when open tickets exist." />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Open ticket status mix</CardTitle>
            <span className="text-[10px] text-slate-400">{openTickets.length} open tickets</span>
          </CardHeader>
          <CardContent>
            {statusData.length ? <StatusChart data={statusData} /> : <EmptyState title="No open ticket data" />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Open ticket aging</CardTitle>
            <span className="text-[10px] text-slate-400">Age buckets</span>
          </CardHeader>
          <CardContent>
            {agingData.some((item) => item.value > 0) ? <AgingChart data={agingData} /> : <EmptyState title="No aging data" />}
          </CardContent>
        </Card>
      </section>

      <section className="mt-4 grid gap-4 xl:grid-cols-[.8fr_1.2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Severity pressure</CardTitle>
            <span className="text-[10px] text-slate-400">Open ticket priority</span>
          </CardHeader>
          <CardContent>
            {severityData.length ? <StatusChart data={severityData} /> : <EmptyState title="No severity data" />}
          </CardContent>
        </Card>

        <Card className="bg-gradient-to-br from-white via-slate-50/80 to-sky-50/40">
          <CardHeader>
            <CardTitle>What to watch</CardTitle>
            <span className="text-[10px] text-slate-400">Auto summary</span>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-2xl bg-white/74 p-4 ring-1 ring-sky-100/80">
              <div className="flex items-center gap-2 text-rose-700"><AlertTriangle size={16} /><p className="font-semibold">Highest risk</p></div>
              <p className="mt-2 text-[12px] leading-5 text-slate-500">
                {visibleOwnerWorkload[0]
                  ? `${visibleOwnerWorkload[0].owner} carries ${visibleOwnerWorkload[0].tickets} open assignments and ${visibleOwnerWorkload[0].overdue} overdue items.`
                  : "No owner currently carries open work."}
              </p>
            </div>
            <div className="rounded-2xl bg-white/74 p-4 ring-1 ring-sky-100/80">
              <div className="flex items-center gap-2 text-amber-700"><Clock3 size={16} /><p className="font-semibold">Scheduling</p></div>
              <p className="mt-2 text-[12px] leading-5 text-slate-500">
                {dueSoonTickets.length
                  ? `${dueSoonTickets.length} tickets are due within 7 days. Keep them visible before they roll into overdue.`
                  : "No open tickets are due within the next 7 days."}
              </p>
            </div>
            <div className="rounded-2xl bg-white/74 p-4 ring-1 ring-sky-100/80">
              <div className="flex items-center gap-2 text-violet-700"><Activity size={16} /><p className="font-semibold">Flow health</p></div>
              <p className="mt-2 text-[12px] leading-5 text-slate-500">
                {waitingTickets.length
                  ? `${waitingTickets.length} tickets are waiting on customer input, so owner effort may be blocked.`
                  : "No open tickets are blocked in waiting status."}
              </p>
            </div>
            <div className="rounded-2xl bg-white/74 p-4 ring-1 ring-sky-100/80">
              <div className="flex items-center gap-2 text-emerald-700"><CheckCircle2 size={16} /><p className="font-semibold">Clean board</p></div>
              <p className="mt-2 text-[12px] leading-5 text-slate-500">
                {agedTickets.length
                  ? `${agedTickets.length} open tickets are older than 90 days and should be reviewed for archive or closure.`
                  : "No aged open ticket exceeds the 90 day archive threshold."}
              </p>
            </div>
          </CardContent>
        </Card>
      </section>
    </>
  );
}
