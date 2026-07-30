import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(
  path.join(process.cwd(), "src/components/servicenow-write-controls.tsx"),
  "utf8",
);

describe("ServiceNow write controls safety", () => {
  it("shows Retry only for safe scheduled retries while live writes are ready", () => {
    const guardedRetry = /selected\.status === "retry_scheduled"\s*&&\s*selected\.retryAllowed\s*&&\s*summary\?\.readiness\.liveWriteReady/g;
    expect(source.match(guardedRetry)).toHaveLength(2);
    expect(source).not.toMatch(/selected\.status === "failed"[^;\n]*Manual retry/);
  });

  it("exposes reconciliation actions only from reconciliation_required state", () => {
    expect(source).toContain('selected.status === "reconciliation_required"');
    expect(source).toContain('"reconcile_by_read_back"');
    expect(source).toContain('"mark_succeeded_after_verification"');
    expect(source).toContain('"mark_not_applied_after_verification"');
  });

  it("keeps this milestone manual and excludes future integration features", () => {
    expect(source).not.toMatch(/attachment|line oa|cron|scheduler|automatic intake/i);
  });
});
