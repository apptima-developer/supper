import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const source = fs.readFileSync(path.join(process.cwd(), "src/components/servicenow-operations.tsx"), "utf8");

describe("ServiceNow Operations UI boundary", () => {
  it("uses protected SUPPER APIs and renders all required operations sections", () => {
    for (const route of ["/api/integrations/servicenow/operations", "/api/integrations/servicenow/runs", "/api/integrations/servicenow/customer-mappings", "/api/integrations/servicenow/customer-targets"]) expect(source).toContain(route);
    for (const section of ["ServiceNow controls", "Synchronization runs", "Customer mapping queue", "Safe runtime diagnostics"]) expect(source).toContain(section);
  });

  it("contains explicit mapping and deactivation confirmations with mobile presentation", () => {
    expect(source).toContain("preserving effort, billing, notes, status, logs, and ticket identity");
    expect(source).toContain("Existing ticket assignments remain unchanged");
    expect(source).toContain("md:hidden");
    expect(source).toContain("hidden overflow-x-auto");
  });

  it("warns when mapping candidates are bounded and reports repeated deactivation truthfully", () => {
    expect(source).toContain("Results are bounded for operational safety. Some sources or totals may not be shown.");
    expect(source).toContain("Customer mapping was already inactive; no changes were made");
    expect(source).toContain('result.action === "deactivated"');
  });

  it("does not render raw JSON, browser alerts, or ServiceNow credentials", () => {
    expect(source).not.toContain("JSON.stringify(selectedRun");
    expect(source).not.toContain("alert(");
    expect(source).not.toMatch(/SERVICENOW_(PASSWORD|CLIENT_SECRET|USERNAME)/);
  });
});
