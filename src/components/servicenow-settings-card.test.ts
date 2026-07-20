import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = readFileSync(path.join(process.cwd(), "src/components/servicenow-settings-card.tsx"), "utf8");

describe("ServiceNow Settings card synchronization controls", () => {
  it("uses only bounded SUPPER routes and never a provider URL", () => {
    expect(source).toContain('fetch("/api/integrations/servicenow/sync"');
    expect(source).toContain('fetch("/api/integrations/servicenow/incidents?limit=10&offset=0"');
    expect(source).not.toMatch(/fetch\([^\n]*service-now\.com/i);
  });

  it("includes dry-run, committed, refresh, and confirmation controls", () => {
    expect(source).toContain("Dry Run Initial Sync");
    expect(source).toContain("Run Initial Sync");
    expect(source).toContain("Run Incremental Sync");
    expect(source).toContain("Refresh Sync Status");
    expect(source).toContain("Confirm sync");
  });

  it("prevents double submission and renders bounded summaries without secrets", () => {
    expect(source).toContain("if (busy) return");
    expect(source).toContain("disabled={!syncEnabled || !!busy}");
    expect(source).toContain("sync.safeErrorCategory");
    expect(source).not.toMatch(/clientSecret|serviceRole|authorizationHeader|password/i);
  });
});
