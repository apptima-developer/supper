import { describe, expect, it } from "vitest";
import { serviceNowSyncPresentation } from "./presentation";

describe("ServiceNow synchronization status presentation", () => {
  it.each([
    ["succeeded", "success", "emerald", "Succeeded"],
    ["partial", "warning", "amber", "Partial"],
    ["blocked", "warning", "amber", "Blocked"],
    ["failed", "error", "rose", "Failed"],
    [undefined, "error", "rose", "Unexpected status"],
    ["unknown", "error", "rose", "Unexpected status"],
  ])("maps %s to a status-aware notification", (status, level, tone, label) => {
    expect(serviceNowSyncPresentation(status)).toEqual({ level, tone, label });
  });
});
