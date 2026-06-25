export type MonthlySourceFileType = "monthly_review" | "cr" | "inc" | "sr";

export type MonthlyReportBatchStatus = "draft" | "validated" | "exported" | "failed";

export type MonthlySourceFile = {
  id: string;
  batchId: string;
  fileType: MonthlySourceFileType;
  originalFileName: string;
  sheetName: string;
  headerHash: string;
  rowCount: number;
  storagePath: string;
  importedAt: string;
};

export type MonthlyProjectSummary = {
  projectCode: string;
  companyCode?: string;
  companyName?: string;
  monthlyReviewRows: number;
  crRows: number;
  incRows: number;
  srRows: number;
  totalBillableHours: number;
  totalBillableMd: number;
  openTickets: number;
  closedTickets: number;
  highEffortIssueCount: number;
  reoccurredIssueCount: number;
  slaOverdueCount: number;
};

export type MonthlyReportBatch = {
  id: string;
  year: number;
  month: number;
  periodStart: string;
  periodEnd: string;
  status: MonthlyReportBatchStatus;
  sourceFiles: MonthlySourceFile[];
  projectSummaries: MonthlyProjectSummary[];
  errors?: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
};

export type MonthlyReportExportStatus = "generated" | "failed";

export type MonthlyReportExport = {
  id: string;
  batchId: string;
  year: number;
  month: number;
  projectCode: string;
  generatedBy: string;
  generatedAt: string;
  mandaySummaryPath: string;
  monthlyReportWorkbookPath?: string;
  monthlyReportPdfPath: string;
  status: MonthlyReportExportStatus;
  errorMessage?: string;
};

export type MonthlyReportRow = {
  values: Record<string, unknown>;
  raw: unknown[];
  company: string;
  companyCode: string;
  companyName: string;
  projectCode: string;
  projectName: string;
  number: string;
  title: string;
  created: string;
  closed: string;
  billableDate: string;
  billableHours: number;
  state: string;
  status: string;
  taskType: string;
  module: string;
  subModule: string;
  assignedTo: string;
  slaOverdue: boolean;
  recurrenceKey: string;
};

export type MonthlyNormalizedDataset = {
  headers: string[];
  keys: string[];
  rows: MonthlyReportRow[];
};

export type MonthlyIssueListRow = {
  startDate: string;
  endDate: string;
  taskType: string;
  number: string;
  shortDescription: string;
  assignedTo: string;
  state: string;
  module: string;
  created: string;
  closed: string;
  billableDate: string;
  billableHours: number;
  recurrenceKey: string;
  reason: "High effort" | "Reoccurred issue" | "High effort + reoccurred";
};

export type MonthlyReportPreview = {
  batch: MonthlyReportBatch;
  selected?: MonthlyProjectSummary;
  rows: {
    monthlyReview: MonthlyReportRow[];
    cr: MonthlyReportRow[];
    inc: MonthlyReportRow[];
    sr: MonthlyReportRow[];
    issueList: MonthlyIssueListRow[];
  };
  headers: {
    monthlyReview: string[];
    cr: string[];
    inc: string[];
    sr: string[];
  };
  exports: MonthlyReportExport[];
};
