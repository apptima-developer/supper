import { getRequestLimits } from "./env";
import { validateInlineImageDataUrl } from "./request-limits";
import type { TicketLog } from "./types";

export type TicketLogInput = {
  message: string;
  attachments: Array<{ id: string; fileName: string; contentType: string; dataUrl: string }>;
};

export function makeTicketLog(input: TicketLogInput | undefined, actor: string): TicketLog | null {
  if (!input) return null;
  const message = input.message.trim();
  const attachments = input.attachments.map((attachment) => {
    const validated = validateInlineImageDataUrl(attachment.dataUrl, getRequestLimits().maxInlineImageBytes);
    if (validated.contentType !== attachment.contentType.toLowerCase()) {
      throw new Error("Image MIME type does not match the data URL");
    }
    return attachment;
  });
  return message || attachments.length
    ? { id: crypto.randomUUID(), message, attachments, actor, createdAt: new Date().toISOString() }
    : null;
}
