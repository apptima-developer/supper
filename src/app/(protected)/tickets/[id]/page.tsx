import { notFound } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, CalendarClock, CircleUserRound, History, SquarePen, Timer } from "lucide-react";
import { requireSession } from "@/lib/auth";
import { loadTicketDetailData } from "@/lib/repositories";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge, statusTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TicketLogBubbles } from "@/components/ticket-log-bubbles";
import { hoursFromMd, normalizeOwnerEfforts, ticketEffortHours, ticketOwnerLabel } from "@/lib/domain";
import { can } from "@/lib/rbac";
import { formatDate, formatDateTime, formatIssueType } from "@/lib/utils";

export const dynamic = "force-dynamic";

function formatHours(value: number) {
  return Math.max(0, Number(value) || 0).toFixed(5);
}

export default async function TicketDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [session, { ticket, history }] = await Promise.all([requireSession(), loadTicketDetailData(id)]);
  if (!ticket) notFound();
  const ownerEfforts = normalizeOwnerEfforts(ticket.ownerEfforts, ticket.owner, hoursFromMd(ticket.mdUsed));
  const canEdit = can(session.role, "tickets:manage");

  return (
    <>
      <div className="mb-4 flex items-center justify-between gap-3">
        <Link href="/tickets" className="inline-flex items-center gap-2 text-[12px] text-slate-500 hover:text-slate-900">
          <ArrowLeft size={14} />Back to tickets
        </Link>
        {canEdit && (
          <Button asChild size="sm">
            <Link href={`/tickets?edit=${encodeURIComponent(ticket.id)}`}>
              <SquarePen size={14} />Edit ticket
            </Link>
          </Button>
        )}
      </div>
      <div className="mb-5 flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-[#0a84ff]">{ticket.issueId}</p>
          <h1 className="mt-1 text-[21px] font-semibold text-slate-900">{ticket.issueTitle}</h1>
          <p className="mt-1 text-[12px] text-slate-500">{ticket.customerName} · {formatIssueType(ticket.issueType)}</p>
        </div>
        <Badge tone={statusTone(ticket.status)}>{ticket.status}</Badge>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          ["Owner", ticketOwnerLabel(ticket) || "Unassigned", CircleUserRound],
          ["Severity", ticket.severity, Timer],
          ["Due date", formatDateTime(ticket.dueDate), CalendarClock],
          ["Hours used", `${formatHours(ticketEffortHours(ticket))}${ticket.chargeable ? " · Chargeable" : ""}`, History],
        ].map(([label, value, Icon]) => (
          <Card key={String(label)}>
            <CardContent className="flex items-center gap-3 p-4">
              <div className="rounded-lg bg-cyan-50 p-2 text-cyan-700"><Icon size={17} /></div>
              <div>
                <p className="text-[10px] uppercase tracking-wide text-slate-400">{String(label)}</p>
                <p className="mt-1 font-medium text-slate-800">{String(value)}</p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-[.8fr_1.2fr]">
        <Card>
          <CardHeader><CardTitle>Ticket detail</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-4 text-[12px]">
              <div><p className="text-[10px] uppercase text-slate-400">Opened</p><p className="mt-1">{formatDate(ticket.date)}</p></div>
              <div><p className="text-[10px] uppercase text-slate-400">Started</p><p className="mt-1">{formatDateTime(ticket.startDate)}</p></div>
              <div><p className="text-[10px] uppercase text-slate-400">End date</p><p className="mt-1">{formatDateTime(ticket.closeDate)}</p></div>
              <div><p className="text-[10px] uppercase text-slate-400">Status lane</p><p className="mt-1 capitalize">{ticket.kanbanStatus.replace("_", " ")}</p></div>
            </div>
            <div className="border-t pt-4">
              <p className="text-[10px] uppercase text-slate-400">Owner effort</p>
              <div className="mt-2 space-y-1">
                {ownerEfforts.map((item, index) => (
                  <div key={`${item.owner}-${index}`} className="flex justify-between gap-3 rounded-md bg-slate-50 px-3 py-2 text-[12px]">
                    <span className="font-medium text-slate-700">{item.owner || "Unassigned"}</span>
                    <span className="text-slate-500">{formatHours(item.hours)} hrs</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="border-t pt-4">
              <p className="text-[10px] uppercase text-slate-400">Log</p>
              <div className="mt-2"><TicketLogBubbles ticket={ticket} /></div>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle>Change history</CardTitle><span className="text-[10px] text-slate-400">{history.length} field updates</span></CardHeader>
          {history.length ? (
            <div className="max-h-[430px] divide-y overflow-y-auto">
              {history.map((item) => (
                <div key={item.id} className="flex gap-3 px-4 py-3">
                  <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-gradient-to-r from-[#0a84ff] to-[#20c9b7]" />
                  <div className="min-w-0 flex-1">
                    <p className="text-[12px]"><span className="font-medium">{item.actor}</span> changed <span className="font-medium">{item.field}</span></p>
                    <p className="mt-1 truncate text-[10px] text-slate-400">{String(item.previousValue || "Empty")} → {String(item.nextValue || "Empty")}</p>
                    <p className="mt-1 text-[10px] text-slate-400">{formatDate(item.createdAt)} · {item.source}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="p-8 text-center text-[12px] text-slate-400">No field changes recorded yet.</div>
          )}
        </Card>
      </div>
    </>
  );
}
