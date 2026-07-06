import Image from "next/image";
import type { Ticket } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

export function TicketLogBubbles({ ticket }: { ticket: Pick<Ticket, "remark" | "ticketLogs"> }) {
  const entries = [
    ...(ticket.remark.trim()
      ? [{ id: "legacy-remark", message: ticket.remark.trim(), actor: "Legacy remark", createdAt: "", attachments: [] }]
      : []),
    ...(ticket.ticketLogs || []).filter((entry) => entry.message.trim() || entry.attachments.length > 0),
  ];

  if (!entries.length) return <p className="text-[12px] text-slate-400">No log recorded.</p>;

  return (
    <div className="space-y-2">
      {entries.map((entry, index) => (
        <div
          key={entry.id || `${entry.actor}-${index}`}
          className="rounded-2xl border border-sky-100/80 bg-white/85 px-3 py-2 shadow-sm"
        >
          {entry.message.trim() && <p className="whitespace-pre-wrap text-[12px] leading-5 text-slate-700">{entry.message.trim()}</p>}
          {entry.attachments.length > 0 && (
            <div className="mt-2 grid gap-2">
              {entry.attachments.map((attachment) => (
                <a
                  key={attachment.id}
                  href={attachment.dataUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="block overflow-hidden rounded-xl border border-sky-100 bg-slate-50"
                  title={attachment.fileName}
                >
                  <Image src={attachment.dataUrl} alt={attachment.fileName} width={900} height={520} unoptimized className="max-h-72 w-full object-contain" />
                </a>
              ))}
            </div>
          )}
          <p className="mt-2 text-right text-[10px] font-medium text-slate-400">
            {entry.actor || "unknown"}{entry.createdAt ? ` · ${formatDateTime(entry.createdAt)}` : ""}
          </p>
        </div>
      ))}
    </div>
  );
}
