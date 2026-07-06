"use client";

import { useState } from "react";
import Image from "next/image";
import { Download } from "lucide-react";
import { Dialog, DialogContent } from "./ui/dialog";
import { Button } from "./ui/button";
import type { Ticket, TicketLogAttachment } from "@/lib/types";
import { formatDateTime } from "@/lib/utils";

export function TicketLogBubbles({ ticket }: { ticket: Pick<Ticket, "remark" | "ticketLogs"> }) {
  const [selectedImage, setSelectedImage] = useState<TicketLogAttachment | null>(null);
  const entries = [
    ...(ticket.remark.trim()
      ? [{ id: "legacy-remark", message: ticket.remark.trim(), actor: "Legacy remark", createdAt: "", attachments: [] }]
      : []),
    ...(ticket.ticketLogs || []).filter((entry) => entry.message.trim() || entry.attachments.length > 0),
  ];

  if (!entries.length) return <p className="text-[12px] text-slate-400">No log recorded.</p>;

  return (
    <>
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
                  <button
                    key={attachment.id}
                    type="button"
                    className="block overflow-hidden rounded-xl border border-sky-100 bg-slate-50 text-left transition hover:border-sky-300 hover:bg-sky-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-300"
                    title={attachment.fileName}
                    onClick={() => setSelectedImage(attachment)}
                  >
                    <Image src={attachment.dataUrl} alt={attachment.fileName} width={900} height={520} unoptimized className="max-h-72 w-full object-contain" />
                  </button>
                ))}
              </div>
            )}
            <p className="mt-2 text-right text-[10px] font-medium text-slate-400">
              {entry.actor || "unknown"}{entry.createdAt ? ` · ${formatDateTime(entry.createdAt)}` : ""}
            </p>
          </div>
        ))}
      </div>

      <Dialog open={Boolean(selectedImage)} onOpenChange={(open) => !open && setSelectedImage(null)}>
        {selectedImage && (
          <DialogContent title={selectedImage.fileName || "Image attachment"} className="max-h-[90vh] max-w-5xl">
            <div className="space-y-3">
              <div className="overflow-hidden rounded-2xl border border-sky-100 bg-slate-950/95 p-2">
                <Image
                  src={selectedImage.dataUrl}
                  alt={selectedImage.fileName || "Ticket log attachment"}
                  width={1600}
                  height={1000}
                  unoptimized
                  className="max-h-[72vh] w-full object-contain"
                />
              </div>
              <div className="flex justify-end">
                <Button asChild variant="outline" size="sm">
                  <a href={selectedImage.dataUrl} download={selectedImage.fileName || "ticket-attachment.png"}>
                    <Download size={14} />Download image
                  </a>
                </Button>
              </div>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}
