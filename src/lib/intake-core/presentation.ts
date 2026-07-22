import { z } from "zod";
import { maskedIdentityFromHash } from "./identity";
import { canonicalTimestampSchema } from "./schemas";

export const operationsSummarySchema = z.object({
  channels: z.number().int().nonnegative(), enabledChannels: z.number().int().nonnegative(), linkedIdentities: z.number().int().nonnegative(),
  unlinkedIdentities: z.number().int().nonnegative(), openConversations: z.number().int().nonnegative(), activeSessions: z.number().int().nonnegative(),
  acceptedEvents24h: z.number().int().nonnegative(), duplicateEvents24h: z.number().int().nonnegative(), failedEvents24h: z.number().int().nonnegative(),
  pendingOutbox: z.number().int().nonnegative(), retryingOutbox: z.number().int().nonnegative(), deadLetterOutbox: z.number().int().nonnegative(),
  attachmentStatuses: z.record(z.string(), z.number().int().nonnegative()), scanStatuses: z.record(z.string(), z.number().int().nonnegative()),
  latestActivityAt: canonicalTimestampSchema.nullable(),
}).strict();

export type IntakeOperationsSummary = z.infer<typeof operationsSummarySchema>;

export function presentIdentity(row: Record<string, unknown>, extras: { provider?: string; channelName?: string; customerName?: string; projectCode?: string; conversationCount?: number } = {}) {
  const hash = typeof row.external_subject_hash === "string" ? row.external_subject_hash : "0".repeat(64);
  return {
    identityId: String(row.id || ""), maskedExternalIdentity: maskedIdentityFromHash(hash),
    provider: extras.provider || "unknown", channelName: extras.channelName || "Unknown channel",
    displayName: String(row.display_name || ""), linkedStatus: String(row.status || "unlinked"),
    customerName: extras.customerName, projectCode: extras.projectCode || "",
    lastSeenAt: String(row.last_seen_at || ""), conversationCount: extras.conversationCount || 0,
  };
}

export function plainTextPreview(value: unknown, maximum = 280) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, maximum);
}
