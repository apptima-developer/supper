import "server-only";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import ExcelJS from "exceljs";
import type {
  MonthlyIssueListRow,
  MonthlyNormalizedDataset,
  MonthlyProjectSummary,
  MonthlyReportBatch,
  MonthlyReportExport,
  MonthlyReportPreview,
  MonthlyReportRow,
  MonthlySourceFile,
  MonthlySourceFileType,
} from "./monthly-report-types";

const execFileAsync = promisify(execFile);
const dataRoot = path.join(process.cwd(), "data");
const monthlyRoot = path.join(dataRoot, "reports", "monthly");
const templateRoot = path.join(process.cwd(), "templates", "reports");
const sourceNames: Record<MonthlySourceFileType, string> = {
  monthly_review: "monthly-review.xlsx",
  cr: "cr.xlsx",
  inc: "inc.xlsx",
  sr: "sr.xlsx",
};
const datasetNames: Record<MonthlySourceFileType, string> = {
  monthly_review: "monthly-review.json",
  cr: "cr.json",
  inc: "inc.json",
  sr: "sr.json",
};
const requiredHeaders: Record<MonthlySourceFileType, string[]> = {
  monthly_review: [
    "Company", "Business service", "Start date", "End Date", "Purchased (MDs)", "Type of Rev. Recognition",
    "Owned by", "Used (MDs)", "Carry Forward (MDs)", "Carry Forward Period (Month)", "Task type", "Number",
    "Short description", "Assigned to", "State", "Module", "Sub-Module", "Created", "Closed", "Billable Date",
    "Skill", "Billable (Hrs)", "Non charge reason",
  ],
  cr: [
    "Number", "Title", "Requested by", "Company", "Location", "Priority", "Project Code", "Created", "Closed",
    "Module", "Sub-Module", "Assignment group", "Assigned to", "Responsible group", "Responsible to", "State",
    "Status", "CAB date", "UAT date", "Close notes", "Non charge reason", "Task type", "Type", "Billable Date",
    "Billable (Hrs)", "Satisfaction Level", "Satisfaction Comment", "First Response Time", "SLA Overdue",
  ],
  inc: [
    "Number", "Title", "Requested by", "Company", "Location", "Priority", "Project Code", "Created", "Closed",
    "Module", "Sub-Module", "Assignment group", "Assigned to", "Responsible group", "Responsible to", "State",
    "Status", "Close notes", "Root Cause", "Non charge reason", "Resolved", "Task type", "Problem Type",
    "Billable Date", "Billable (Hrs)", "Satisfaction Level", "Satisfaction Comment", "First Response Time", "SLA Overdue",
  ],
  sr: [
    "Number", "Title", "Requested by", "Company", "Location", "Priority", "Project Code", "Created", "Closed",
    "Module", "Sub-Module", "Assignment group", "Assigned to", "Responsible group", "Responsible to", "State",
    "Status", "Close notes", "Non charge reason", "Task type", "Service Type", "Billable Date", "Billable (Hrs)",
    "Satisfaction Level", "Satisfaction Comment", "First Response Time", "SLA Overdue",
  ],
};
const previewLimit = 150;

type UploadedMonthlyFile = {
  originalFileName: string;
  buffer: Buffer;
};

function padMonth(month: number) {
  return String(month).padStart(2, "0");
}

function periodKey(year: number, month: number) {
  return `${year}-${padMonth(month)}`;
}

function periodFromKey(period: string) {
  const match = period.match(/^(\d{4})-(\d{2})$/);
  if (!match) throw new Error("Invalid report period");
  return { year: Number(match[1]), month: Number(match[2]) };
}

function monthBounds(year: number, month: number) {
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  return { start, end, periodStart: start.toISOString(), periodEnd: end.toISOString() };
}

function batchDirectory(period: string) {
  return path.join(monthlyRoot, period);
}

function relativeDataPath(fullPath: string) {
  return path.relative(dataRoot, fullPath).split(path.sep).join("/");
}

function safeProjectSegment(projectCode: string) {
  return projectCode.replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, "_").slice(0, 90) || "project";
}

function normalizeLabel(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function normalizeKey(value: unknown) {
  return normalizeLabel(value).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function uniqueHeaderKeys(headers: string[], fileType: MonthlySourceFileType) {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const label = String(header || "").trim();
    const normalized = normalizeLabel(label);
    const count = (seen.get(normalized) || 0) + 1;
    seen.set(normalized, count);
    if (fileType === "monthly_review" && normalized === "number") return count === 1 ? "ticketNumber" : "taskNumber";
    if (fileType === "monthly_review" && normalized === "assigned to") return count === 1 ? "ticketAssignedTo" : "taskAssignedTo";
    const base = normalizeKey(label) || `column_${count}`;
    return count === 1 ? base : `${base}_${count}`;
  });
}

function cellToJson(value: ExcelJS.CellValue): unknown {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== "object") return value;
  if ("text" in value && typeof value.text === "string") return value.text;
  if ("richText" in value && Array.isArray(value.richText)) return value.richText.map((item) => item.text || "").join("");
  if ("result" in value) return cellToJson(value.result as ExcelJS.CellValue);
  if ("formula" in value) return String(value.formula || "");
  if ("hyperlink" in value && "text" in value) return String(value.text || value.hyperlink || "");
  return String(value);
}

function jsonToExcelValue(header: string, value: unknown): ExcelJS.CellValue {
  if (value == null || value === "") return "";
  if (typeof value === "number" || typeof value === "boolean") return value;
  const text = String(value);
  const label = normalizeLabel(header);
  if ((label.includes("date") || label === "created" || label === "closed" || label === "resolved" || label.endsWith("time")) && /^\d{4}-\d{2}-\d{2}T/.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return text;
}

function valueAsString(value: unknown) {
  if (value == null) return "";
  if (value instanceof Date) return value.toISOString();
  return String(value).trim();
}

function valueAsNumber(value: unknown) {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  const parsed = Number(String(value ?? "").replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function valueAsDate(value: unknown) {
  if (!value) return "";
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  if (!text) return "";
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
}

function dateInMonth(value: string, start: Date, end: Date) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return date.getTime() >= start.getTime() && date.getTime() <= end.getTime();
}

function rowInMonth(row: MonthlyReportRow, start: Date, end: Date) {
  return dateInMonth(row.created, start, end) || dateInMonth(row.billableDate, start, end);
}

function splitCodeName(value: unknown) {
  const text = valueAsString(value);
  const [code, ...rest] = text.split(":");
  return {
    code: (rest.length ? code : text).trim(),
    name: rest.join(":").trim(),
    text,
  };
}

function normalizeSubject(value: unknown) {
  return valueAsString(value)
    .toLowerCase()
    .replace(/\b(?:inc|req|chg)\d+\b/g, " ")
    .replace(/\b(?:inc|sr|cr|re|fw)\s*:/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\([^)]*(?:ticket|ref|id|เลข|no)[^)]*\)/g, " ")
    .replace(/\b\d{1,4}[/-]\d{1,2}[/-]\d{1,4}\b/g, " ")
    .replace(/\b\d{6,}\b/g, " ")
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((part) => part.length > 1)
    .slice(0, 18)
    .join(" ");
}

function sourceValue(values: Record<string, unknown>, key: string) {
  return values[key];
}

function normalizeRow(fileType: MonthlySourceFileType, headers: string[], keys: string[], raw: unknown[]): MonthlyReportRow {
  const values = Object.fromEntries(keys.map((key, index) => [key, raw[index] ?? ""]));
  const company = valueAsString(sourceValue(values, "company"));
  const companyInfo = splitCodeName(company);
  const projectInfo = fileType === "monthly_review"
    ? splitCodeName(sourceValue(values, "business_service"))
    : splitCodeName(sourceValue(values, "project_code"));
  const title = fileType === "monthly_review"
    ? valueAsString(sourceValue(values, "short_description"))
    : valueAsString(sourceValue(values, "title"));
  const number = fileType === "monthly_review"
    ? valueAsString(sourceValue(values, "ticketNumber"))
    : valueAsString(sourceValue(values, "number"));
  const assignedTo = fileType === "monthly_review"
    ? valueAsString(sourceValue(values, "taskAssignedTo") || sourceValue(values, "ticketAssignedTo"))
    : valueAsString(sourceValue(values, "assigned_to"));
  const state = valueAsString(sourceValue(values, "state"));
  const status = valueAsString(sourceValue(values, "status"));
  return {
    values,
    raw: headers.map((_, index) => raw[index] ?? ""),
    company,
    companyCode: companyInfo.code,
    companyName: companyInfo.name || company,
    projectCode: projectInfo.code,
    projectName: projectInfo.name || projectInfo.text,
    number,
    title,
    created: valueAsDate(sourceValue(values, "created")),
    closed: valueAsDate(sourceValue(values, "closed")),
    billableDate: valueAsDate(sourceValue(values, "billable_date")),
    billableHours: valueAsNumber(sourceValue(values, "billable_hrs")),
    state,
    status,
    taskType: valueAsString(sourceValue(values, "task_type")),
    module: valueAsString(sourceValue(values, "module")),
    subModule: valueAsString(sourceValue(values, "sub_module")),
    assignedTo,
    slaOverdue: /^true|yes|y|1$/i.test(valueAsString(sourceValue(values, "sla_overdue"))),
    recurrenceKey: normalizeSubject(title),
  };
}

async function readWorkbookDataset(fileType: MonthlySourceFileType, buffer: Buffer): Promise<MonthlyNormalizedDataset> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const worksheet = workbook.getWorksheet("Page 1");
  if (!worksheet) throw new Error(`${fileType}: missing required sheet "Page 1"`);
  const headerRow = worksheet.getRow(1);
  const columnCount = Math.max(headerRow.cellCount, worksheet.columnCount);
  const headers = Array.from({ length: columnCount }, (_, index) => valueAsString(headerRow.getCell(index + 1).value));
  const normalizedHeaders = new Set(headers.map(normalizeLabel));
  const missing = requiredHeaders[fileType].filter((header) => !normalizedHeaders.has(normalizeLabel(header)));
  if (missing.length) throw new Error(`${fileType}: missing required headers ${missing.join(", ")}`);
  const keys = uniqueHeaderKeys(headers, fileType);
  const rows: MonthlyReportRow[] = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const raw = headers.map((_, index) => cellToJson(row.getCell(index + 1).value));
    if (raw.every((value) => valueAsString(value) === "")) return;
    rows.push(normalizeRow(fileType, headers, keys, raw));
  });
  return { headers, keys, rows };
}

function hashHeaders(headers: string[]) {
  return createHash("sha256").update(headers.join("|")).digest("hex").slice(0, 16);
}

async function writeJsonFile(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as T;
  } catch {
    return fallback;
  }
}

async function readDataset(period: string, type: MonthlySourceFileType): Promise<MonthlyNormalizedDataset> {
  return readJsonFile<MonthlyNormalizedDataset>(path.join(batchDirectory(period), "normalized", datasetNames[type]), { headers: [], keys: [], rows: [] });
}

async function readBatch(period: string) {
  const batch = await readJsonFile<MonthlyReportBatch | null>(path.join(batchDirectory(period), "batch.json"), null);
  if (!batch) throw new Error("Monthly batch not found");
  return batch;
}

async function readExports(period: string) {
  return readJsonFile<MonthlyReportExport[]>(path.join(batchDirectory(period), "exports", "export-history.json"), []);
}

async function writeExports(period: string, exports: MonthlyReportExport[]) {
  await writeJsonFile(path.join(batchDirectory(period), "exports", "export-history.json"), exports);
}

function buildIssueListRows(monthlyRows: MonthlyReportRow[], relatedRows: MonthlyReportRow[]) {
  const recurrenceCounts = new Map<string, number>();
  for (const row of relatedRows) {
    if (!row.recurrenceKey) continue;
    const key = `${row.companyCode}|${row.projectCode}|${row.recurrenceKey}`;
    recurrenceCounts.set(key, (recurrenceCounts.get(key) || 0) + 1);
  }
  return monthlyRows
    .map((row) => {
      const recurrenceKey = `${row.companyCode}|${row.projectCode}|${row.recurrenceKey}`;
      const highEffort = row.billableHours > 2;
      const reoccurred = Boolean(row.recurrenceKey) && (recurrenceCounts.get(recurrenceKey) || 0) > 3;
      if (!highEffort && !reoccurred) return null;
      const values = row.values;
      const reason = highEffort && reoccurred ? "High effort + reoccurred" : highEffort ? "High effort" : "Reoccurred issue";
      return {
        startDate: valueAsDate(sourceValue(values, "start_date")),
        endDate: valueAsDate(sourceValue(values, "end_date")),
        taskType: row.taskType,
        number: row.number,
        shortDescription: row.title,
        assignedTo: row.assignedTo,
        state: row.state,
        module: row.module,
        created: row.created,
        closed: row.closed,
        billableDate: row.billableDate,
        billableHours: row.billableHours,
        recurrenceKey: row.recurrenceKey,
        reason,
      } satisfies MonthlyIssueListRow;
    })
    .filter((row): row is MonthlyIssueListRow => Boolean(row))
    .sort((a, b) => b.billableHours - a.billableHours || a.created.localeCompare(b.created) || a.number.localeCompare(b.number));
}

function summarizeProject(projectCode: string, rows: {
  monthlyReview: MonthlyReportRow[];
  cr: MonthlyReportRow[];
  inc: MonthlyReportRow[];
  sr: MonthlyReportRow[];
  issueList: MonthlyIssueListRow[];
}): MonthlyProjectSummary {
  const allTicketRows = [...rows.cr, ...rows.inc, ...rows.sr];
  const first = rows.monthlyReview[0] || allTicketRows[0];
  const closed = allTicketRows.filter((row) => row.closed || /closed|resolved|cancel/i.test(`${row.state} ${row.status}`)).length;
  const highEffortIssueCount = rows.issueList.filter((row) => row.reason.includes("High effort")).length;
  const reoccurredIssueCount = rows.issueList.filter((row) => row.reason.includes("reoccurred")).length;
  const totalBillableHours = Number(rows.monthlyReview.reduce((sum, row) => sum + row.billableHours, 0).toFixed(5));
  return {
    projectCode,
    companyCode: first?.companyCode,
    companyName: first?.companyName || first?.company,
    monthlyReviewRows: rows.monthlyReview.length,
    crRows: rows.cr.length,
    incRows: rows.inc.length,
    srRows: rows.sr.length,
    totalBillableHours,
    totalBillableMd: Number((totalBillableHours / 8).toFixed(5)),
    openTickets: Math.max(0, allTicketRows.length - closed),
    closedTickets: closed,
    highEffortIssueCount,
    reoccurredIssueCount,
    slaOverdueCount: allTicketRows.filter((row) => row.slaOverdue).length,
  };
}

function filteredRowsForProject(period: string, year: number, month: number, projectCode: string, datasets: {
  monthlyReview: MonthlyNormalizedDataset;
  cr: MonthlyNormalizedDataset;
  inc: MonthlyNormalizedDataset;
  sr: MonthlyNormalizedDataset;
}) {
  const { start, end } = monthBounds(year, month);
  const byProject = (row: MonthlyReportRow) => row.projectCode === projectCode && rowInMonth(row, start, end);
  const monthlyReview = datasets.monthlyReview.rows.filter(byProject);
  const cr = datasets.cr.rows.filter(byProject);
  const inc = datasets.inc.rows.filter(byProject);
  const sr = datasets.sr.rows.filter(byProject);
  const issueList = buildIssueListRows(monthlyReview, [...monthlyReview, ...cr, ...inc, ...sr].filter((row) => row.projectCode === projectCode && rowInMonth(row, start, end)));
  return { monthlyReview, cr, inc, sr, issueList, period };
}

function buildProjectSummaries(year: number, month: number, datasets: {
  monthlyReview: MonthlyNormalizedDataset;
  cr: MonthlyNormalizedDataset;
  inc: MonthlyNormalizedDataset;
  sr: MonthlyNormalizedDataset;
}) {
  const { start, end } = monthBounds(year, month);
  const projectCodes = new Set<string>();
  for (const dataset of Object.values(datasets)) {
    for (const row of dataset.rows) {
      if (row.projectCode && rowInMonth(row, start, end)) projectCodes.add(row.projectCode);
    }
  }
  return [...projectCodes].sort().map((projectCode) => {
    const rows = filteredRowsForProject(periodKey(year, month), year, month, projectCode, datasets);
    return summarizeProject(projectCode, rows);
  });
}

function trimRows<T>(rows: T[]) {
  return rows.slice(0, previewLimit);
}

export async function listMonthlyReportBatches() {
  try {
    const entries = await fs.readdir(monthlyRoot, { withFileTypes: true });
    const batches = await Promise.all(entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => readJsonFile<MonthlyReportBatch | null>(path.join(monthlyRoot, entry.name, "batch.json"), null)));
    return batches.filter((batch): batch is MonthlyReportBatch => Boolean(batch)).sort((a, b) => b.periodStart.localeCompare(a.periodStart));
  } catch {
    return [];
  }
}

export async function getMonthlyReportPreview(period: string, projectCode?: string): Promise<MonthlyReportPreview> {
  const { year, month } = periodFromKey(period);
  const batch = await readBatch(period);
  const datasets = {
    monthlyReview: await readDataset(period, "monthly_review"),
    cr: await readDataset(period, "cr"),
    inc: await readDataset(period, "inc"),
    sr: await readDataset(period, "sr"),
  };
  const selectedProject = projectCode || batch.projectSummaries[0]?.projectCode || "";
  const rows = selectedProject
    ? filteredRowsForProject(period, year, month, selectedProject, datasets)
    : { monthlyReview: [], cr: [], inc: [], sr: [], issueList: [], period };
  return {
    batch,
    selected: batch.projectSummaries.find((summary) => summary.projectCode === selectedProject),
    rows: {
      monthlyReview: trimRows(rows.monthlyReview),
      cr: trimRows(rows.cr),
      inc: trimRows(rows.inc),
      sr: trimRows(rows.sr),
      issueList: trimRows(rows.issueList),
    },
    headers: {
      monthlyReview: datasets.monthlyReview.headers,
      cr: datasets.cr.headers,
      inc: datasets.inc.headers,
      sr: datasets.sr.headers,
    },
    exports: (await readExports(period)).filter((item) => !selectedProject || item.projectCode === selectedProject),
  };
}

export async function createMonthlyReportBatch({
  year,
  month,
  files,
  actor,
}: {
  year: number;
  month: number;
  files: Record<MonthlySourceFileType, UploadedMonthlyFile>;
  actor: string;
}) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new Error("Choose a valid year");
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new Error("Choose a valid month");
  const missing = (Object.keys(sourceNames) as MonthlySourceFileType[]).filter((type) => !files[type]);
  if (missing.length) throw new Error(`Upload all required source files first: ${missing.join(", ")}`);
  const period = periodKey(year, month);
  const directory = batchDirectory(period);
  const sourceDir = path.join(directory, "source");
  const normalizedDir = path.join(directory, "normalized");
  await fs.mkdir(sourceDir, { recursive: true });
  await fs.mkdir(normalizedDir, { recursive: true });
  const now = new Date().toISOString();
  const batchId = randomUUID();
  const datasets = {} as Record<MonthlySourceFileType, MonthlyNormalizedDataset>;
  const sourceFiles: MonthlySourceFile[] = [];
  const errors: string[] = [];

  for (const type of Object.keys(sourceNames) as MonthlySourceFileType[]) {
    const uploaded = files[type];
    const sourcePath = path.join(sourceDir, sourceNames[type]);
    await fs.writeFile(sourcePath, uploaded.buffer, { mode: 0o600 });
    try {
      const dataset = await readWorkbookDataset(type, uploaded.buffer);
      datasets[type] = dataset;
      await writeJsonFile(path.join(normalizedDir, datasetNames[type]), dataset);
      sourceFiles.push({
        id: randomUUID(),
        batchId,
        fileType: type,
        originalFileName: uploaded.originalFileName,
        sheetName: "Page 1",
        headerHash: hashHeaders(dataset.headers),
        rowCount: dataset.rows.length,
        storagePath: relativeDataPath(sourcePath),
        importedAt: now,
      });
    } catch (error) {
      errors.push(error instanceof Error ? error.message : `${type}: import failed`);
    }
  }

  const { periodStart, periodEnd } = monthBounds(year, month);
  const batch: MonthlyReportBatch = {
    id: batchId,
    year,
    month,
    periodStart,
    periodEnd,
    status: errors.length ? "failed" : "validated",
    sourceFiles,
    projectSummaries: errors.length ? [] : buildProjectSummaries(year, month, {
      monthlyReview: datasets.monthly_review,
      cr: datasets.cr,
      inc: datasets.inc,
      sr: datasets.sr,
    }),
    errors,
    createdBy: actor,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonFile(path.join(directory, "batch.json"), batch);
  return batch;
}

function captureRowStyle(source: ExcelJS.Row, columnCount: number) {
  return {
    height: source.height,
    cells: Array.from({ length: columnCount }, (_, index) => {
      const cell = source.getCell(index + 1);
      return {
        style: { ...cell.style },
        numFmt: cell.numFmt,
        alignment: cell.alignment ? { ...cell.alignment } : null,
        border: cell.border ? { ...cell.border } : null,
        fill: cell.fill ? { ...cell.fill } : null,
        font: cell.font ? { ...cell.font } : null,
      };
    }),
  };
}

function applyCapturedRowStyle(template: ReturnType<typeof captureRowStyle>, target: ExcelJS.Row) {
  target.height = template.height;
  template.cells.forEach((sourceCell, index) => {
    const targetCell = target.getCell(index + 1);
    targetCell.style = { ...sourceCell.style };
    targetCell.numFmt = sourceCell.numFmt;
    if (sourceCell.alignment) targetCell.alignment = { ...sourceCell.alignment };
    if (sourceCell.border) targetCell.border = { ...sourceCell.border };
    if (sourceCell.fill) targetCell.fill = { ...sourceCell.fill };
    if (sourceCell.font) targetCell.font = { ...sourceCell.font };
  });
}

function resetWorksheetDataRows(worksheet: ExcelJS.Worksheet) {
  const internal = worksheet as ExcelJS.Worksheet & { _rows?: ExcelJS.Row[] };
  if (Array.isArray(internal._rows)) {
    // ExcelJS spliceRows leaves stale rows in these report templates; reset the raw row model directly.
    internal._rows = internal._rows.slice(0, 1);
    return;
  }
  worksheet.spliceRows(2, Math.max(worksheet.rowCount - 1, 0));
}

function replaceSheetData(worksheet: ExcelJS.Worksheet, dataset: MonthlyNormalizedDataset, rows: MonthlyReportRow[]) {
  const columnCount = dataset.headers.length;
  const header = worksheet.getRow(1);
  dataset.headers.forEach((label, index) => {
    header.getCell(index + 1).value = label;
  });
  header.commit();
  const templateRow = worksheet.getRow(2);
  const capturedStyle = captureRowStyle(templateRow, columnCount);
  resetWorksheetDataRows(worksheet);
  rows.forEach((sourceRow, rowIndex) => {
    const row = worksheet.getRow(rowIndex + 2);
    applyCapturedRowStyle(capturedStyle, row);
    sourceRow.raw.forEach((value, columnIndex) => {
      row.getCell(columnIndex + 1).value = jsonToExcelValue(dataset.headers[columnIndex], value);
    });
    row.commit();
  });
}

function upsertIssueListSheet(workbook: ExcelJS.Workbook, rows: MonthlyIssueListRow[]) {
  const existing = workbook.getWorksheet("issue list");
  if (existing) workbook.removeWorksheet(existing.id);
  const worksheet = workbook.addWorksheet("issue list", {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0, paperSize: 9 },
    views: [{ state: "frozen", ySplit: 1 }],
  });
  const columns = [
    ["Start date", "startDate", 12],
    ["End Date", "endDate", 12],
    ["Task type", "taskType", 16],
    ["Number", "number", 15],
    ["Short description", "shortDescription", 54],
    ["Assigned to", "assignedTo", 20],
    ["State", "state", 16],
    ["Module", "module", 14],
    ["Created", "created", 16],
    ["Closed", "closed", 16],
    ["Billable Date", "billableDate", 14],
    ["Billable (Hrs)", "billableHours", 13],
  ] as const;
  worksheet.columns = columns.map(([header, key, width]) => ({ header, key, width }));
  const headerRow = worksheet.getRow(1);
  headerRow.font = { name: "Prompt", bold: true, size: 10, color: { argb: "FFFFFFFF" } };
  headerRow.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FF173B57" } };
  headerRow.alignment = { vertical: "middle", horizontal: "center", wrapText: true };
  headerRow.height = 24;
  rows.forEach((item) => {
    worksheet.addRow({
      ...item,
      startDate: jsonToExcelValue("Start date", item.startDate),
      endDate: jsonToExcelValue("End Date", item.endDate),
      created: jsonToExcelValue("Created", item.created),
      closed: jsonToExcelValue("Closed", item.closed),
      billableDate: jsonToExcelValue("Billable Date", item.billableDate),
    });
  });
  worksheet.eachRow((row, rowNumber) => {
    row.font = rowNumber === 1 ? row.font : { name: "Prompt", size: 9 };
    row.alignment = { vertical: "top", wrapText: true };
    row.eachCell((cell) => {
      cell.border = {
        top: { style: "thin", color: { argb: "FFD7E3F2" } },
        left: { style: "thin", color: { argb: "FFD7E3F2" } },
        bottom: { style: "thin", color: { argb: "FFD7E3F2" } },
        right: { style: "thin", color: { argb: "FFD7E3F2" } },
      };
    });
  });
  worksheet.getColumn("billableHours").numFmt = "0.00";
  ["startDate", "endDate", "created", "closed", "billableDate"].forEach((key) => {
    worksheet.getColumn(key).numFmt = "dd/mm/yyyy";
  });
}

async function saveWorkbook(workbook: ExcelJS.Workbook, target: string) {
  workbook.calcProperties.fullCalcOnLoad = true;
  await fs.mkdir(path.dirname(target), { recursive: true });
  await workbook.xlsx.writeFile(target);
}

async function findSoffice() {
  const candidates = [
    process.env.LIBREOFFICE_PATH,
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "soffice",
    "libreoffice",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ["--version"], { timeout: 5000 });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

async function exportPdfWithLibreOffice(workbookPath: string, outputDir: string) {
  const soffice = await findSoffice();
  if (!soffice) throw new Error("LibreOffice headless executable was not found. Install LibreOffice or set LIBREOFFICE_PATH to enable exact Excel-to-PDF export.");
  await execFileAsync(soffice, ["--headless", "--convert-to", "pdf", "--outdir", outputDir, workbookPath], { timeout: 120000 });
  const pdfPath = path.join(outputDir, `${path.basename(workbookPath, ".xlsx")}.pdf`);
  await fs.access(pdfPath);
  return pdfPath;
}

export async function generateMonthlyReportOutputs({
  period,
  projectCode,
  actor,
  force = false,
}: {
  period: string;
  projectCode: string;
  actor: string;
  force?: boolean;
}) {
  const { year, month } = periodFromKey(period);
  const batch = await readBatch(period);
  if (batch.status !== "validated" && batch.status !== "exported") throw new Error("Validate the monthly batch before exporting");
  const exports = await readExports(period);
  const existing = exports.find((item) => item.projectCode === projectCode && item.status === "generated");
  if (existing && !force) {
    const error = new Error("A successful export already exists for this project and month");
    (error as Error & { code?: string; existing?: MonthlyReportExport }).code = "EXPORT_EXISTS";
    (error as Error & { existing?: MonthlyReportExport }).existing = existing;
    throw error;
  }
  const datasets = {
    monthlyReview: await readDataset(period, "monthly_review"),
    cr: await readDataset(period, "cr"),
    inc: await readDataset(period, "inc"),
    sr: await readDataset(period, "sr"),
  };
  const rows = filteredRowsForProject(period, year, month, projectCode, datasets);
  if (!rows.monthlyReview.length && !rows.cr.length && !rows.inc.length && !rows.sr.length) throw new Error("No rows found for the selected project code and month");
  const exportDir = path.join(batchDirectory(period), "exports", safeProjectSegment(projectCode), String(Date.now()));
  const monthLabel = padMonth(month);
  const projectName = safeProjectSegment(projectCode);
  const mandayPath = path.join(exportDir, `${projectName}_OT_${year}_Manday_Summary_${monthLabel}.xlsx`);
  const reportWorkbookPath = path.join(exportDir, `${projectName}_Support_Service_Monthly_Report_${monthLabel}.xlsx`);
  const exportRecord: MonthlyReportExport = {
    id: randomUUID(),
    batchId: batch.id,
    year,
    month,
    projectCode,
    generatedBy: actor,
    generatedAt: new Date().toISOString(),
    mandaySummaryPath: relativeDataPath(mandayPath),
    monthlyReportWorkbookPath: relativeDataPath(reportWorkbookPath),
    monthlyReportPdfPath: relativeDataPath(path.join(exportDir, `${projectName}_Support_Service_Monthly_Report_${monthLabel}.pdf`)),
    status: "generated",
  };
  try {
    const mandayWorkbook = new ExcelJS.Workbook();
    await mandayWorkbook.xlsx.readFile(path.join(templateRoot, "manday-summary-template.xlsx"));
    const mandayData = mandayWorkbook.getWorksheet("data");
    if (!mandayData) throw new Error("Manday template is missing data sheet");
    replaceSheetData(mandayData, datasets.monthlyReview, rows.monthlyReview);
    await saveWorkbook(mandayWorkbook, mandayPath);

    const reportWorkbook = new ExcelJS.Workbook();
    await reportWorkbook.xlsx.readFile(path.join(templateRoot, "support-service-monthly-report-template.xlsx"));
    const sheets = {
      data: reportWorkbook.getWorksheet("data"),
      cr: reportWorkbook.getWorksheet("cr"),
      inc: reportWorkbook.getWorksheet("inc"),
      sr: reportWorkbook.getWorksheet("sr"),
    };
    if (!sheets.data || !sheets.cr || !sheets.inc || !sheets.sr) throw new Error("Monthly report template is missing one or more raw data sheets");
    replaceSheetData(sheets.data, datasets.monthlyReview, rows.monthlyReview);
    replaceSheetData(sheets.cr, datasets.cr, rows.cr);
    replaceSheetData(sheets.inc, datasets.inc, rows.inc);
    replaceSheetData(sheets.sr, datasets.sr, rows.sr);
    upsertIssueListSheet(reportWorkbook, rows.issueList);
    const calc = reportWorkbook.getWorksheet("calc");
    if (calc) {
      const { start, end } = monthBounds(year, month);
      calc.getCell("A1").value = start;
      calc.getCell("B1").value = end;
    }
    const visibleSheets = new Set(["dash", "open close", "case type", "issue list"]);
    reportWorkbook.eachSheet((worksheet) => {
      worksheet.state = visibleSheets.has(worksheet.name.toLowerCase()) ? "visible" : "hidden";
    });
    await saveWorkbook(reportWorkbook, reportWorkbookPath);
    const pdfPath = await exportPdfWithLibreOffice(reportWorkbookPath, exportDir);
    exportRecord.monthlyReportPdfPath = relativeDataPath(pdfPath);
    exports.unshift(exportRecord);
    await writeExports(period, exports);
    await writeJsonFile(path.join(batchDirectory(period), "batch.json"), { ...batch, status: "exported", updatedAt: new Date().toISOString() });
    return exportRecord;
  } catch (error) {
    const failed: MonthlyReportExport = {
      ...exportRecord,
      status: "failed",
      errorMessage: error instanceof Error ? error.message : "Export failed",
    };
    exports.unshift(failed);
    await writeExports(period, exports);
    await writeJsonFile(path.join(batchDirectory(period), "batch.json"), { ...batch, updatedAt: new Date().toISOString() });
    throw error;
  }
}

export async function readMonthlyReportFile(relativePath: string) {
  const normalized = path.normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  if (!normalized.startsWith(`reports${path.sep}monthly${path.sep}`) && !normalized.startsWith("reports/monthly/")) throw new Error("Invalid report file path");
  const fullPath = path.join(dataRoot, normalized);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(monthlyRoot + path.sep)) throw new Error("Invalid report file path");
  const bytes = await fs.readFile(resolved);
  const fileName = path.basename(resolved);
  const extension = path.extname(fileName).toLowerCase();
  const contentType = extension === ".pdf"
    ? "application/pdf"
    : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  return { bytes, fileName, contentType };
}
