export type SyncNotificationLevel = "success" | "warning" | "error";
export type SyncBadgeTone = "emerald" | "amber" | "rose";

export function serviceNowSyncPresentation(status: unknown): {
  level: SyncNotificationLevel;
  tone: SyncBadgeTone;
  label: string;
} {
  if (status === "succeeded") return { level: "success", tone: "emerald", label: "Succeeded" };
  if (status === "partial") return { level: "warning", tone: "amber", label: "Partial" };
  if (status === "blocked") return { level: "warning", tone: "amber", label: "Blocked" };
  if (status === "failed") return { level: "error", tone: "rose", label: "Failed" };
  return { level: "error", tone: "rose", label: "Unexpected status" };
}
