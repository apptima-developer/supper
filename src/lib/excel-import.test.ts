import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { importPreview, parseWorkbook } from "./excel-import";
import { customerKey } from "./domain";

const references = {
  customers: [
    { key: customerKey("P-01", "Example Co"), customerName: "Example Co", startPeriod: "2026-01-31", endPeriod: "2026-12-31" },
  ],
  priorities: [
    { id: "critical", name: "Critical", active: true },
    { id: "high", name: "High", active: true },
    { id: "medium", name: "Medium", active: true },
    { id: "low", name: "Low", active: true },
  ],
  issueTypes: [
    { id: "request", name: "Request", active: true },
    { id: "change", name: "Change", active: true },
    { id: "incident", name: "Incident", active: true },
  ],
};

describe("SupportDesk workbook parser", () => {
  it("normalizes workbook headers and consolidates compatible duplicate Issue IDs", async () => {
    const workbook = new ExcelJS.Workbook();
    const customers = workbook.addWorksheet("Customer_MD_Control");
    customers.addRow([
      "Year", "Project Code", "Customer", "Contract\n Type", "Contract \nStatus",
      "MD\n Purchased", "MD \nUsed ", "MD \nRemaining ", "MD Rate",
      "Start Period", "End Period", "Burn Rate ", "MD Status", "Renewal Alert", "AE Update",
    ]);
    customers.addRow([
      2026, " P-01 ", "Example Co", "Annual", "Active", 20, 2, 18, 1000,
      "31/01/2026", "31/12/2026", 0.5, "OK", "", "",
    ]);

    const tickets = workbook.addWorksheet("Issues_Log");
    tickets.addRow([
      "Issue ID", "Date", "Customer", "Issue Title", "Issue Type", "Severity",
      "Owner", "Status", "Start Date", "Due Date", "Close Date", "MD Used",
      "Chargeable", "Remark",
    ]);
    tickets.addRow(["INC001", "05/06/2026", "Example Co", "Login issue", "Incident", "Medium", "Agent", "07 - Waiting user", "", "", "", .5, "Y", ""]);
    tickets.addRow(["INC001", "06/06/2026", "Example Co", "Login issue", "Incident", "Medium", "Agent", "08 - Resolved", "", "", "", .25, "ํY", "Done"]);
    tickets.addRow(["", "06/06/2026", "Example Co", "Missing ID", "CR", "P1 - Critical", "Agent", "00 - Open", "", "", "", 1, "Y", ""]);

    const master = workbook.addWorksheet("Master");
    master.addRow(["", "", "", "", "", "", "", "", "", "", "", "SLA"]);
    master.addRow(["Resources", "Priority", "Contract Type", "Contract Status", "Issue Type", "Issues Status", "", "", "", "", "", "Customer"]);
    master.addRow(["Agent One", "High", "Annual", "Active", "Incident", "00 - Open", "", "", "", "", "", "Example Co"]);

    const bytes = await workbook.xlsx.writeBuffer();
    const parsed = await parseWorkbook(Buffer.from(bytes), "supportdesk", references);
    const preview = importPreview(parsed);

    expect(preview.counts.customers).toBe(0);
    expect(preview.counts.issueTypes).toBe(0);
    expect(preview.counts.priorities).toBe(0);
    expect(preview.counts.tickets).toBe(2);
    expect(parsed.tickets.find((ticket) => ticket.issueId === "INC001")).toMatchObject({
      issueId: "INC001", date: "2026-06-06", kanbanStatus: "resolved",
      customerKey: "p-01::example co", customerName: "Example Co",
      issueType: "Incident", severity: "Medium", chargeable: true, mdUsed: .5,
    });
    expect(parsed.tickets.find((ticket) => ticket.issueId.startsWith("ADJ-"))).toMatchObject({
      issueType: "Change", severity: "Critical",
    });
    expect(parsed.master.issueTypes).toEqual([]);
    expect(parsed.master.priorities).toEqual([]);
    const parsedAgain = await parseWorkbook(Buffer.from(bytes), "supportdesk", references);
    expect(parsedAgain.master).toEqual(parsed.master);
    expect(parsed.diagnostics).toMatchObject({ blankIssueIds: 1, syntheticIssueIds: 1, consolidatedDuplicateGroups: 1 });
    expect(parsed.tickets.some((ticket) => ticket.issueId.startsWith("ADJ-"))).toBe(true);
  });
});
