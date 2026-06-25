"use client";

import { useEffect, useMemo, useState } from "react";
import { Download, FileSpreadsheet, LoaderCircle, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input, Label, Select } from "./ui/input";
import { EmptyState } from "./empty-state";
import { cn, formatDate, formatNumber } from "@/lib/utils";
import type { MonthlyIssueListRow, MonthlyProjectSummary, MonthlyReportBatch, MonthlyReportPreview, MonthlyReportRow } from "@/lib/monthly-report-types";
import type { Role } from "@/lib/types";

type TabKey = "summary" | "monthly" | "cr" | "inc" | "sr" | "issue" | "exports";

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: "summary", label: "Summary" },
  { key: "monthly", label: "Monthly Review Data" },
  { key: "cr", label: "CR" },
  { key: "inc", label: "INC" },
  { key: "sr", label: "SR" },
  { key: "issue", label: "Issue List Preview" },
  { key: "exports", label: "Export History" },
];

const uploadFields = [
  { name: "monthlyReview", label: "Monthly Review" },
  { name: "cr", label: "Change Request" },
  { name: "inc", label: "Incident" },
  { name: "sr", label: "Service Request" },
] as const;

type UploadFieldName = (typeof uploadFields)[number]["name"];

function periodLabel(batch: MonthlyReportBatch) {
  return `${batch.year}-${String(batch.month).padStart(2, "0")}`;
}

function downloadUrl(file?: string) {
  return file ? `/api/monthly-reports/download?file=${encodeURIComponent(file)}` : "#";
}

function fieldValue(row: MonthlyReportRow, keys: string[]) {
  for (const key of keys) {
    const value = row.values[key];
    if (value != null && String(value).trim()) return String(value);
  }
  return "-";
}

function DataTable({
  rows,
  kind,
}: {
  rows: MonthlyReportRow[];
  kind: "monthly" | "ticket";
}) {
  const columns = kind === "monthly"
    ? [
        ["Number", (row: MonthlyReportRow) => row.number],
        ["Description", (row: MonthlyReportRow) => row.title],
        ["Task", (row: MonthlyReportRow) => row.taskType],
        ["Assigned", (row: MonthlyReportRow) => row.assignedTo || "-"],
        ["Created", (row: MonthlyReportRow) => formatDate(row.created)],
        ["Billable", (row: MonthlyReportRow) => formatDate(row.billableDate)],
        ["Hrs", (row: MonthlyReportRow) => formatNumber(row.billableHours, 2)],
      ] as const
    : [
        ["Number", (row: MonthlyReportRow) => row.number],
        ["Title", (row: MonthlyReportRow) => row.title],
        ["Priority", (row: MonthlyReportRow) => fieldValue(row, ["priority"])],
        ["Assigned", (row: MonthlyReportRow) => row.assignedTo || "-"],
        ["State", (row: MonthlyReportRow) => row.state || row.status || "-"],
        ["Created", (row: MonthlyReportRow) => formatDate(row.created)],
        ["SLA", (row: MonthlyReportRow) => row.slaOverdue ? "Overdue" : "-"],
      ] as const;
  if (!rows.length) return <EmptyState title="No rows in preview" description="No data matched this project code and month." />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-[11px]">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
          <tr>{columns.map(([label]) => <th key={label} className="px-3 py-2">{label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.number}-${index}`} className="border-t hover:bg-sky-50/70">
              {columns.map(([label, render], columnIndex) => (
                <td key={label} className={cn("px-3 py-2", columnIndex === 1 && "max-w-xl truncate")} title={String(render(row))}>
                  {render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function IssueListTable({ rows }: { rows: MonthlyIssueListRow[] }) {
  const columns = [
    ["Start date", (row: MonthlyIssueListRow) => formatDate(row.startDate)],
    ["End Date", (row: MonthlyIssueListRow) => formatDate(row.endDate)],
    ["Task type", (row: MonthlyIssueListRow) => row.taskType],
    ["Number", (row: MonthlyIssueListRow) => row.number],
    ["Short description", (row: MonthlyIssueListRow) => row.shortDescription],
    ["Assigned to", (row: MonthlyIssueListRow) => row.assignedTo],
    ["State", (row: MonthlyIssueListRow) => row.state],
    ["Module", (row: MonthlyIssueListRow) => row.module],
    ["Created", (row: MonthlyIssueListRow) => formatDate(row.created)],
    ["Closed", (row: MonthlyIssueListRow) => formatDate(row.closed)],
    ["Billable Date", (row: MonthlyIssueListRow) => formatDate(row.billableDate)],
    ["Billable (Hrs)", (row: MonthlyIssueListRow) => formatNumber(row.billableHours, 2)],
    ["Reason", (row: MonthlyIssueListRow) => row.reason],
  ] as const;
  if (!rows.length) return <EmptyState title="No issue list rows" description="No high-effort or reoccurred issues were detected for this project and month." />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-[1200px] w-full text-left text-[11px]">
        <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
          <tr>{columns.map(([label]) => <th key={label} className="px-3 py-2">{label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={`${row.number}-${index}`} className="border-t hover:bg-sky-50/70">
              {columns.map(([label, render], columnIndex) => (
                <td key={label} className={cn("px-3 py-2", columnIndex === 4 && "max-w-lg truncate")} title={String(render(row) || "")}>
                  {render(row) || "-"}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryGrid({ summary }: { summary?: MonthlyProjectSummary }) {
  if (!summary) return <EmptyState title="Select project code" description="Project preview appears after a validated batch has matching data." />;
  const cards = [
    ["Project Code", summary.projectCode],
    ["Company", summary.companyName || "-"],
    ["Monthly Review", summary.monthlyReviewRows],
    ["CR / INC / SR", `${summary.crRows} / ${summary.incRows} / ${summary.srRows}`],
    ["Billable Hours", formatNumber(summary.totalBillableHours, 2)],
    ["Billable MD", formatNumber(summary.totalBillableMd, 5)],
    ["Open / Closed", `${summary.openTickets} / ${summary.closedTickets}`],
    ["High / Reoccurred / SLA", `${summary.highEffortIssueCount} / ${summary.reoccurredIssueCount} / ${summary.slaOverdueCount}`],
  ];
  return (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map(([label, value]) => (
        <div key={String(label)} className="rounded-2xl border border-sky-100/80 bg-white/70 p-4">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
          <p className="mt-2 text-[16px] font-semibold text-slate-900">{value}</p>
        </div>
      ))}
    </div>
  );
}

function UploadField({
  name,
  label,
  file,
  disabled,
  onFileChange,
}: {
  name: UploadFieldName;
  label: string;
  file?: File;
  disabled?: boolean;
  onFileChange: (name: UploadFieldName, file?: File) => void;
}) {
  return (
    <div>
      <Label required>{label}</Label>
      <input
        name={name}
        type="file"
        accept=".xlsx"
        disabled={disabled}
        className="block w-full cursor-pointer rounded-lg border border-sky-100/90 bg-white/80 px-3 py-2 text-[13px] text-slate-800 shadow-[0_1px_0_rgba(255,255,255,.9)_inset] outline-none transition-all file:mr-4 file:cursor-pointer file:rounded-full file:border-0 file:bg-sky-50 file:px-3 file:py-1.5 file:text-[12px] file:font-semibold file:text-sky-700 hover:border-sky-200 hover:bg-sky-50/80 focus:border-sky-300 focus:ring-4 focus:ring-sky-200/35 disabled:cursor-not-allowed disabled:opacity-55"
        onChange={(event) => onFileChange(name, event.target.files?.[0])}
      />
      {file ? <p className="mt-1 text-[10px] text-slate-400">{file.name}</p> : null}
    </div>
  );
}

export function MonthlyReportFactory({ initialBatches, role }: { initialBatches: MonthlyReportBatch[]; role: Role }) {
  const current = new Date();
  const [year, setYear] = useState(current.getFullYear());
  const [month, setMonth] = useState(current.getMonth() + 1);
  const [batches, setBatches] = useState(initialBatches);
  const [selectedPeriod, setSelectedPeriod] = useState(initialBatches[0] ? periodLabel(initialBatches[0]) : "");
  const [selectedProjectCode, setSelectedProjectCode] = useState(initialBatches[0]?.projectSummaries[0]?.projectCode || "");
  const [preview, setPreview] = useState<MonthlyReportPreview | null>(null);
  const [tab, setTab] = useState<TabKey>("summary");
  const [busy, setBusy] = useState("");
  const [selectedFiles, setSelectedFiles] = useState<Partial<Record<UploadFieldName, File>>>({});
  const canManage = role === "admin" || role === "lead";
  const selectedBatch = useMemo(() => batches.find((batch) => periodLabel(batch) === selectedPeriod), [batches, selectedPeriod]);
  const allFilesSelected = uploadFields.every((field) => selectedFiles[field.name]);

  useEffect(() => {
    if (!selectedPeriod) return;
    let active = true;
    async function load() {
      try {
        const params = new URLSearchParams({ period: selectedPeriod });
        if (selectedProjectCode) params.set("projectCode", selectedProjectCode);
        const response = await fetch(`/api/monthly-reports/batches?${params.toString()}`);
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        if (active) {
          setPreview(result);
          if (!selectedProjectCode && result.batch?.projectSummaries?.[0]?.projectCode) setSelectedProjectCode(result.batch.projectSummaries[0].projectCode);
        }
      } catch (error) {
        if (active) toast.error(error instanceof Error ? error.message : "Could not load monthly report preview");
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [selectedPeriod, selectedProjectCode]);

  async function createBatch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const missing = uploadFields.filter((field) => !selectedFiles[field.name]);
    if (missing.length) {
      toast.error(`Choose all required workbooks first: ${missing.map((field) => field.label).join(", ")}`);
      return;
    }
    setBusy("upload");
    const formData = new FormData();
    formData.set("year", String(year));
    formData.set("month", String(month));
    for (const field of uploadFields) formData.set(field.name, selectedFiles[field.name] as File);
    try {
      const response = await fetch("/api/monthly-reports/batches", { method: "POST", body: formData });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      const nextPreview = result as MonthlyReportPreview;
      setPreview(nextPreview);
      setBatches((items) => [nextPreview.batch, ...items.filter((item) => item.id !== nextPreview.batch.id && periodLabel(item) !== periodLabel(nextPreview.batch))]);
      setSelectedPeriod(periodLabel(nextPreview.batch));
      setSelectedProjectCode(nextPreview.batch.projectSummaries[0]?.projectCode || "");
      setTab("summary");
      toast.success("Monthly batch validated and stored");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Monthly batch validation failed");
    } finally {
      setBusy("");
    }
  }

  function handleFileChange(name: UploadFieldName, file?: File) {
    setSelectedFiles((current) => ({ ...current, [name]: file }));
  }

  async function exportProject(force = false) {
    if (!selectedPeriod || !selectedProjectCode) return toast.error("Select month and project code first");
    setBusy("export");
    try {
      const response = await fetch("/api/monthly-reports/exports", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ period: selectedPeriod, projectCode: selectedProjectCode, force }),
      });
      const result = await response.json();
      if (response.status === 409 && confirm("A successful export already exists. Regenerate anyway?")) {
        return exportProject(true);
      }
      if (!response.ok) throw new Error(result.error);
      toast.success("Monthly outputs generated");
      const params = new URLSearchParams({ period: selectedPeriod, projectCode: selectedProjectCode });
      const refreshed = await fetch(`/api/monthly-reports/batches?${params.toString()}`).then((item) => item.json());
      setPreview(refreshed);
      setTab("exports");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Monthly report export failed");
      try {
        const params = new URLSearchParams({ period: selectedPeriod, projectCode: selectedProjectCode });
        setPreview(await fetch(`/api/monthly-reports/batches?${params.toString()}`).then((item) => item.json()));
      } catch {
        // Keep the current preview if refresh fails.
      }
    } finally {
      setBusy("");
    }
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Monthly Report Factory</CardTitle>
          <Badge tone="blue">{batches.length} batches</Badge>
        </CardHeader>
        <CardContent>
          <div className="grid gap-4 xl:grid-cols-[.9fr_1.1fr]">
            {canManage ? (
              <form onSubmit={createBatch} className="space-y-4 rounded-2xl border border-sky-100/80 bg-sky-50/35 p-4">
                <div className="flex items-center gap-2">
                  <UploadCloud size={18} className="text-[#0a84ff]" />
                  <div>
                    <p className="font-semibold text-slate-800">Create Monthly Batch</p>
                    <p className="mt-0.5 text-[11px] text-slate-400">Upload all 4 Snow/Monthly Review source files for one month.</p>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div><Label>Year</Label><Input type="number" value={year} onChange={(event) => setYear(Number(event.target.value))} /></div>
                  <div><Label>Month</Label><Select value={String(month)} onChange={(event) => setMonth(Number(event.target.value))}>{Array.from({ length: 12 }, (_, index) => index + 1).map((item) => <option key={item} value={item}>{String(item).padStart(2, "0")}</option>)}</Select></div>
                </div>
                <div className="grid gap-3">
                  {uploadFields.map((field) => (
                    <UploadField
                      key={field.name}
                      name={field.name}
                      label={field.label}
                      file={selectedFiles[field.name]}
                      disabled={Boolean(busy)}
                      onFileChange={handleFileChange}
                    />
                  ))}
                </div>
                <Button className="w-full" disabled={Boolean(busy) || !allFilesSelected}>
                  {busy === "upload" ? <><LoaderCircle size={15} className="animate-spin" />Validating...</> : <><FileSpreadsheet size={15} />Validate and store batch</>}
                </Button>
              </form>
            ) : (
              <div className="rounded-2xl border border-sky-100/80 bg-slate-50 p-4 text-[12px] text-slate-500">Your role can view and download generated monthly reports. Batch creation is available to admin and lead.</div>
            )}

            <div className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <Label>Batch month</Label>
                  <Select value={selectedPeriod} onChange={(event) => { setSelectedPeriod(event.target.value); setSelectedProjectCode(""); }}>
                    <option value="">Select batch</option>
                    {batches.map((batch) => <option key={batch.id} value={periodLabel(batch)}>{periodLabel(batch)} · {batch.status}</option>)}
                  </Select>
                </div>
                <div>
                  <Label>Project code</Label>
                  <Select value={selectedProjectCode} onChange={(event) => setSelectedProjectCode(event.target.value)}>
                    <option value="">Select project</option>
                    {(selectedBatch?.projectSummaries || []).map((summary) => <option key={summary.projectCode} value={summary.projectCode}>{summary.projectCode}</option>)}
                  </Select>
                </div>
              </div>
              <div className="rounded-2xl border border-sky-100/80 bg-white/70 p-4">
                <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Validation result</p>
                {selectedBatch ? (
                  <div className="mt-2 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge tone={selectedBatch.status === "failed" ? "rose" : selectedBatch.status === "exported" ? "emerald" : "blue"}>{selectedBatch.status}</Badge>
                      <span className="text-[11px] text-slate-500">{selectedBatch.sourceFiles.length}/4 files · {selectedBatch.projectSummaries.length} project codes</span>
                    </div>
                    {selectedBatch.errors?.length ? <ul className="space-y-1 text-[11px] text-rose-600">{selectedBatch.errors.map((error) => <li key={error}>• {error}</li>)}</ul> : null}
                  </div>
                ) : (
                  <p className="mt-2 text-[12px] text-slate-400">No batch selected.</p>
                )}
              </div>
              {canManage && (
                <Button className="w-full" disabled={!preview?.selected || Boolean(busy)} onClick={() => exportProject(false)}>
                  {busy === "export" ? <><LoaderCircle size={15} className="animate-spin" />Generating outputs...</> : "Generate Manday XLSX + Monthly Report PDF"}
                </Button>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Preview by project code</CardTitle>
          <span className="text-[10px] text-slate-400">{selectedPeriod || "No period selected"}</span>
        </CardHeader>
        <div className="flex flex-wrap gap-2 border-b border-sky-100/80 px-4 py-3">
          {tabs.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setTab(item.key)}
              className={cn("rounded-full px-3 py-1.5 text-[11px] font-semibold transition-colors", tab === item.key ? "bg-gradient-to-r from-[#0a84ff] to-[#20c9b7] text-white shadow-sm" : "bg-slate-50 text-slate-500 hover:bg-sky-50 hover:text-slate-800")}
            >
              {item.label}
            </button>
          ))}
        </div>
        <CardContent>
          {!preview ? <EmptyState title="No monthly batch preview" description="Create or select a monthly batch to preview project-code scoped data." /> : (
            <>
              {tab === "summary" && <SummaryGrid summary={preview.selected} />}
              {tab === "monthly" && <DataTable kind="monthly" rows={preview.rows.monthlyReview} />}
              {tab === "cr" && <DataTable kind="ticket" rows={preview.rows.cr} />}
              {tab === "inc" && <DataTable kind="ticket" rows={preview.rows.inc} />}
              {tab === "sr" && <DataTable kind="ticket" rows={preview.rows.sr} />}
              {tab === "issue" && <IssueListTable rows={preview.rows.issueList} />}
              {tab === "exports" && (
                preview.exports.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-[11px]">
                      <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr><th className="px-3 py-2">Generated</th><th className="px-3 py-2">By</th><th className="px-3 py-2">Status</th><th className="px-3 py-2">Files</th><th className="px-3 py-2">Error</th></tr></thead>
                      <tbody>
                        {preview.exports.map((item) => (
                          <tr key={item.id} className="border-t">
                            <td className="px-3 py-2">{formatDate(item.generatedAt)}</td>
                            <td className="px-3 py-2">{item.generatedBy}</td>
                            <td className="px-3 py-2"><Badge tone={item.status === "generated" ? "emerald" : "rose"}>{item.status}</Badge></td>
                            <td className="px-3 py-2">
                              <div className="flex flex-wrap gap-2">
                                {item.mandaySummaryPath && <Button variant="outline" size="sm" asChild><a href={downloadUrl(item.mandaySummaryPath)}><Download size={13} />Manday XLSX</a></Button>}
                                {item.monthlyReportPdfPath && item.status === "generated" && <Button variant="outline" size="sm" asChild><a href={downloadUrl(item.monthlyReportPdfPath)}><Download size={13} />Monthly PDF</a></Button>}
                                {item.monthlyReportWorkbookPath && <Button variant="ghost" size="sm" asChild><a href={downloadUrl(item.monthlyReportWorkbookPath)}><Download size={13} />Debug XLSX</a></Button>}
                              </div>
                            </td>
                            <td className="max-w-md truncate px-3 py-2 text-rose-600" title={item.errorMessage}>{item.errorMessage || "-"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <EmptyState title="No exports yet" description="Generate outputs for this project code to create export history." />
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
