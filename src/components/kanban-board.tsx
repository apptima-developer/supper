"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { DndContext, PointerSensor, useDraggable, useDroppable, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { CalendarClock, GripVertical, UserRound } from "lucide-react";
import { toast } from "sonner";
import type { Role, Ticket } from "@/lib/types";
import { KANBAN_ARCHIVE_AGE_DAYS, isKanbanArchiveCandidate, isTicketOwner, ticketAgeAnchorDate, ticketAgeDays, ticketOwnerLabel } from "@/lib/domain";
import { Badge, statusTone } from "./ui/badge";
import { Button } from "./ui/button";
import { cn, formatDate } from "@/lib/utils";

const columns = [
  { id: "open", label: "Open", dot: "bg-sky-500", status: "00 - Open" },
  { id: "in_progress", label: "In progress", dot: "bg-amber-500", status: "03 - Dev Inprogress" },
  { id: "waiting", label: "Waiting", dot: "bg-violet-500", status: "07 - Waiting user" },
  { id: "monitor", label: "Monitor", dot: "bg-cyan-500", status: "05 - Monitor" },
  { id: "resolved", label: "Resolved", dot: "bg-emerald-500", status: "08 - Resolved" },
] as const;

function isTicketClosed(ticket: Ticket) {
  return ticket.kanbanStatus === "closed" || ticket.kanbanStatus === "cancelled";
}

function canMoveTicket(ticket: Ticket, role: Role, userName: string, username: string) {
  if (role === "sales") return false;
  if (role !== "support") return true;
  return isTicketOwner(ticket, [userName, username]);
}

function TicketCard({ ticket, disabled }: { ticket: Ticket; disabled: boolean }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: ticket.id, disabled, data: { ticket } });

  return (
    <article ref={setNodeRef} style={{ transform: CSS.Translate.toString(transform) }} className={cn("lux-surface rounded-xl border bg-white/85 p-3 shadow-sm transition-shadow hover:shadow-[0_14px_34px_rgba(35,77,112,.10)]", isDragging && "z-50 opacity-75 shadow-xl")}>
      <div className="flex items-start gap-2">
        <button {...listeners} {...attributes} disabled={disabled} className="mt-0.5 text-slate-300 transition-colors hover:text-slate-500 disabled:cursor-default">
          <GripVertical size={14} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <Link href={`/tickets/${ticket.id}`} className="text-[11px] font-semibold text-[#0a84ff] hover:underline">{ticket.issueId}</Link>
            <Badge tone={ticket.severity === "P1" ? "rose" : ticket.severity === "P2" ? "amber" : "slate"}>{ticket.severity}</Badge>
          </div>
          <p className="mt-1.5 line-clamp-2 text-[12px] font-medium leading-5 text-slate-800">{ticket.issueTitle}</p>
          <p className="mt-1 truncate text-[10px] text-slate-400">{ticket.customerName}</p>
          <div className="mt-3 flex items-center justify-between border-t border-sky-100/80 pt-2 text-[10px] text-slate-400">
            <span className="flex min-w-0 items-center gap-1"><UserRound size={11} /><span className="truncate">{ticketOwnerLabel(ticket) || "Unassigned"}</span></span>
            <span className="flex items-center gap-1"><CalendarClock size={11} />{formatDate(ticket.dueDate)}</span>
          </div>
        </div>
      </div>
    </article>
  );
}

function ArchivedTicketCard({ ticket, now }: { ticket: Ticket; now: Date }) {
  const age = ticketAgeDays(ticket, now);
  const anchor = ticketAgeAnchorDate(ticket);

  return (
    <article className="rounded-xl border border-slate-200/80 bg-white/90 p-3 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={`/tickets/${ticket.id}`} className="text-[11px] font-semibold text-[#0a84ff] hover:underline">{ticket.issueId}</Link>
          <p className="mt-1 line-clamp-2 text-[12px] font-medium leading-5 text-slate-800">{ticket.issueTitle}</p>
          <p className="mt-1 truncate text-[10px] text-slate-400">{ticket.customerName}</p>
        </div>
        <Badge tone={statusTone(ticket.status)}>{ticket.status.replace(/^\d{2}\s*-\s*/, "")}</Badge>
      </div>
      <div className="mt-3 flex items-center justify-between border-t border-slate-100 pt-2 text-[10px] text-slate-400">
        <span className="flex min-w-0 items-center gap-1"><UserRound size={11} /><span className="truncate">{ticketOwnerLabel(ticket) || "Unassigned"}</span></span>
        <span className="whitespace-nowrap">{age === null ? "No age" : `${age} days`} · {anchor ? formatDate(anchor.toISOString()) : "-"}</span>
      </div>
    </article>
  );
}

function Column({ column, tickets, role, userName, username }: { column: typeof columns[number]; tickets: Ticket[]; role: Role; userName: string; username: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });

  return (
    <section ref={setNodeRef} className={cn("min-h-[540px] rounded-2xl border border-white/70 bg-white/55 p-2 shadow-[0_14px_34px_rgba(35,77,112,.07)] backdrop-blur-xl transition-colors", isOver && "border-sky-300 bg-sky-50/80")}>
      <header className="mb-2 flex items-center justify-between px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className={`h-2 w-2 rounded-full shadow-sm ${column.dot}`} />
          <h2 className="text-[12px] font-semibold text-slate-700">{column.label}</h2>
        </div>
        <span className="rounded-full bg-white/85 px-2 py-0.5 text-[10px] font-semibold text-slate-500 ring-1 ring-sky-100">{tickets.length}</span>
      </header>
      <div className="space-y-2">
        {tickets.map((ticket) => (
          <TicketCard key={ticket.id} ticket={ticket} disabled={!canMoveTicket(ticket, role, userName, username)} />
        ))}
      </div>
    </section>
  );
}

export function KanbanBoard({ initialTickets, role, userName, username }: { initialTickets: Ticket[]; role: Role; userName: string; username: string }) {
  const [tickets, setTickets] = useState(initialTickets.filter((ticket) => !isTicketClosed(ticket)));
  const [showArchived, setShowArchived] = useState(false);
  const now = useMemo(() => new Date(), []);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));
  const archivedTickets = useMemo(
    () => tickets
      .filter((ticket) => isKanbanArchiveCandidate(ticket, now))
      .sort((a, b) => (ticketAgeAnchorDate(a)?.getTime() || 0) - (ticketAgeAnchorDate(b)?.getTime() || 0)),
    [now, tickets],
  );
  const boardTickets = useMemo(() => tickets.filter((ticket) => !isKanbanArchiveCandidate(ticket, now)), [now, tickets]);
  const grouped = useMemo(() => Object.fromEntries(columns.map((c) => [c.id, boardTickets.filter((t) => t.kanbanStatus === c.id)])), [boardTickets]);

  async function onDragEnd(event: DragEndEvent) {
    const target = columns.find((c) => c.id === event.over?.id);
    const ticket = tickets.find((t) => t.id === event.active.id);
    if (!target || !ticket || ticket.kanbanStatus === target.id) return;
    const previous = ticket;
    setTickets((items) => items.map((item) => item.id === ticket.id ? { ...item, status: target.status, kanbanStatus: target.id } : item));
    const response = await fetch(`/api/tickets/${ticket.id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: target.status }) });
    if (!response.ok) {
      const result = await response.json();
      setTickets((items) => items.map((item) => item.id === ticket.id ? previous : item));
      toast.error(result.error || "Could not update status");
    } else toast.success(`${ticket.issueId} moved to ${target.label}`);
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant={showArchived ? "default" : "outline"} size="sm" onClick={() => setShowArchived((current) => !current)}>
          Archived
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold", showArchived ? "bg-white/20 text-white" : "bg-slate-100 text-slate-600")}>{archivedTickets.length}</span>
        </Button>
      </div>

      {showArchived && (
        <section className="rounded-2xl border border-slate-200/80 bg-white/70 p-3 shadow-[0_14px_34px_rgba(35,77,112,.07)] backdrop-blur-xl">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <h2 className="text-[13px] font-semibold text-slate-800">Archived tickets</h2>
              <p className="mt-0.5 text-[11px] text-slate-500">Tickets older than {KANBAN_ARCHIVE_AGE_DAYS} days that are not closed or cancelled.</p>
            </div>
            <Badge tone="slate">{archivedTickets.length} hidden from board</Badge>
          </div>
          {archivedTickets.length ? (
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
              {archivedTickets.map((ticket) => <ArchivedTicketCard key={ticket.id} ticket={ticket} now={now} />)}
            </div>
          ) : (
            <div className="rounded-xl border border-dashed border-slate-200 bg-white/60 p-6 text-center text-[12px] text-slate-400">No ticket is old enough to archive.</div>
          )}
        </section>
      )}

      <DndContext sensors={sensors} onDragEnd={onDragEnd}>
        <div className="overflow-x-auto pb-3">
          <div className="grid min-w-[1050px] grid-cols-5 gap-3">{columns.map((column) => <Column key={column.id} column={column} tickets={grouped[column.id] || []} role={role} userName={userName} username={username} />)}</div>
        </div>
      </DndContext>
    </div>
  );
}
