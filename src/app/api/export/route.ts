import ExcelJS from "exceljs";
import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { customerRepository, masterRepositories, ticketRepository } from "@/lib/repositories";

export const runtime = "nodejs";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const [customers, tickets, sla, holidays, teams, statuses, priorities, issueTypes, contractTypes] = await Promise.all([
    customerRepository.list(), ticketRepository.list(), masterRepositories.sla.list(),
    masterRepositories.holidays.list(), masterRepositories.teams.list(), masterRepositories.statuses.list(),
    masterRepositories.priorities.list(), masterRepositories.issueTypes.list(), masterRepositories.contractTypes.list(),
  ]);
  const workbook = new ExcelJS.Workbook();
  for (const [name, rows] of [
    ["Customer_MD_Control", customers], ["Issues_Log", tickets], ["SLA", sla],
    ["Holidays", holidays], ["Teams", teams], ["Statuses", statuses],
    ["Priorities", priorities], ["Issue_Types", issueTypes], ["Contract_Types", contractTypes],
  ] as const) {
    const sheet = workbook.addWorksheet(name);
    const keys = rows.length ? Object.keys(rows[0]) : ["No data"];
    sheet.columns = keys.map((key) => ({ header: key, key, width: Math.min(Math.max(key.length + 2, 12), 32) }));
    for (const row of rows) sheet.addRow(row);
    sheet.getRow(1).font = { bold: true };
    sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(sheet.rowCount, 1), column: keys.length } };
  }
  const bytes = await workbook.xlsx.writeBuffer();
  return new NextResponse(Buffer.from(bytes), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="supportdesk-export-${new Date().toISOString().slice(0, 10)}.xlsx"`,
    },
  });
}
