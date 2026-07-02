import type { Ticket } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

export function TicketLogBubbles({ ticket }: { ticket: Pick<Ticket, "remark" | "ticketLogs"> }) {
  const entries = [
    ...(ticket.remark.trim()
      ? [{ id: "legacy-remark", message: ticket.remark.trim(), actor: "Legacy remark", createdAt: "" }]
      : []),
    ...(ticket.ticketLogs || []).filter((entry) => entry.message.trim()),
  ];

  if (!entries.length) return <p className="text-[12px] text-slate-400">No log recorded.</p>;

  return (
    <div className="space-y-2">
      {entries.map((entry, index) => (
        <div
          key={entry.id || `${entry.actor}-${index}`}
          className="rounded-2xl border border-sky-100/80 bg-white/85 px-3 py-2 shadow-sm"
        >
          <p className="whitespace-pre-wrap text-[12px] leading-5 text-slate-700">{entry.message.trim()}</p>
          <p className="mt-2 text-right text-[10px] font-medium text-slate-400">
            {entry.actor || "unknown"}{entry.createdAt ? ` · ${formatDateTime(entry.createdAt)}` : ""}
          </p>
        </div>
      ))}
    </div>
  );
}
