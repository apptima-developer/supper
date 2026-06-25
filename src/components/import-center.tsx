"use client";

import { useState } from "react";
import { AlertTriangle, CheckCircle2, FileSpreadsheet, RotateCcw, UploadCloud } from "lucide-react";
import { toast } from "sonner";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Select } from "./ui/input";
import type { ImportBatch } from "@/lib/types";
import { formatDate } from "@/lib/utils";

type Preview = {
  counts: Record<string, number>;
  customers: Record<string, unknown>[];
  tickets: Record<string, unknown>[];
  warnings: string[];
};

export function ImportCenter({ batches }: { batches: ImportBatch[] }) {
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("supportdesk");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  async function run(mode: "preview" | "commit") {
    if (!file) return toast.error("Choose an Excel file first");
    setBusy(true);
    const data = new FormData();
    data.append("file", file);
    data.append("kind", kind);
    data.append("mode", mode);
    try {
      const response = await fetch("/api/imports", { method: "POST", body: data });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      if (mode === "preview") setPreview(result);
      else {
        toast.success("Import completed");
        window.location.reload();
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  async function rollback(batch: ImportBatch) {
    if (!confirm(`Roll back ${batch.fileName}? Current JSON files will be backed up first.`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/imports/${batch.id}/rollback`, { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      toast.success("Import rolled back");
      window.location.reload();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Rollback failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid gap-4 xl:grid-cols-[.85fr_1.15fr]">
      <div className="space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>Upload workbook</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="mb-4">
              <label className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Import type
              </label>
              <Select value={kind} onChange={(event) => { setKind(event.target.value); setPreview(null); }}>
                <option value="supportdesk">SupportDesk workbook</option>
                <option value="snow">Snow monthly export</option>
              </Select>
            </div>

            <div>
              <label htmlFor="import-workbook-file" className="mb-1.5 block text-[11px] font-medium uppercase tracking-wide text-slate-500">
                Excel workbook
              </label>
              <label
                htmlFor="import-workbook-file"
                className="flex min-h-36 cursor-pointer flex-col items-center justify-center rounded-2xl border border-dashed border-sky-200 bg-sky-50/60 px-6 text-center transition-colors hover:border-sky-300 hover:bg-white/80"
              >
                <input
                  id="import-workbook-file"
                  type="file"
                  accept=".xlsx"
                  disabled={busy}
                  className="sr-only"
                  onChange={(event) => {
                    setFile(event.target.files?.[0] || null);
                    setPreview(null);
                  }}
                />
                <UploadCloud size={24} className="text-[#0a84ff]" />
                <p className="mt-3 font-medium text-slate-700">{file ? file.name : "Choose an Excel workbook"}</p>
                <p className="mt-1 text-[11px] text-slate-400">Click anywhere in this box to browse</p>
              </label>
              <p className="mt-1 text-[10px] text-slate-400">.xlsx · parsed on the server</p>
            </div>

            <div className="mt-4 flex gap-2">
              <Button variant="outline" className="flex-1" disabled={!file || busy} onClick={() => run("preview")}>
                {busy ? "Parsing..." : "Preview import"}
              </Button>
              <Button className="flex-1" disabled={!preview || busy} onClick={() => run("commit")}>
                Commit changes
              </Button>
            </div>
            <p className="mt-3 text-[10px] leading-4 text-slate-400">
              Incremental imports update tickets only. Customer and master data stay as currently edited in the system;
              ticket customer, severity, and type values are normalized against those records.
            </p>
          </CardContent>
        </Card>

        {preview && (
          <Card>
            <CardHeader>
              <CardTitle>Import summary</CardTitle>
              <CheckCircle2 size={16} className="text-emerald-600" />
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {Object.entries(preview.counts).map(([key, value]) => (
                  <div key={key} className="rounded-md bg-slate-50 p-3">
                    <p className="text-[18px] font-semibold text-slate-800">{value}</p>
                    <p className="mt-1 text-[10px] capitalize text-slate-400">{key.replace(/([A-Z])/g, " $1")}</p>
                  </div>
                ))}
              </div>
              {preview.warnings.length > 0 && (
                <div className="mt-4 rounded-md border border-amber-200 bg-amber-50 p-3">
                  <p className="flex items-center gap-2 text-[11px] font-medium text-amber-800">
                    <AlertTriangle size={14} />Review warnings
                  </p>
                  <ul className="mt-2 space-y-1 text-[10px] text-amber-700">
                    {preview.warnings.map((warning, index) => <li key={index}>• {warning}</li>)}
                  </ul>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{preview ? "Data preview" : "Import history"}</CardTitle>
          <FileSpreadsheet size={16} className="text-slate-400" />
        </CardHeader>
        {preview ? (
          <div className="p-4">
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Customer mapping</p>
            <div className="mb-5 rounded-md border bg-slate-50 p-3 text-[11px] text-slate-500">
              Customer records are not imported from the workbook. Tickets are matched to the existing Customer menu records and skipped if no customer can be matched.
            </div>
            <p className="mb-2 text-[10px] font-semibold uppercase tracking-wide text-slate-400">Tickets</p>
            <div className="overflow-x-auto rounded-md border">
              <table className="w-full text-left text-[11px]">
                <tbody>
                  {preview.tickets.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t first:border-0">
                      {Object.values(row).map((value, columnIndex) => (
                        <td key={columnIndex} className="max-w-48 truncate whitespace-nowrap px-3 py-2">{String(value)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : batches.length ? (
          <div className="divide-y">
            {batches.map((batch) => (
              <div key={batch.id} className="px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="font-medium text-slate-800">{batch.fileName}</p>
                    <p className="mt-1 text-[10px] text-slate-400">{formatDate(batch.createdAt)} · {batch.actor} · {batch.kind}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${batch.status === "completed" ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-600"}`}>
                      {batch.status}
                    </span>
                    {batch.status === "completed" && (
                      <Button variant="ghost" size="icon" disabled={busy} title="Roll back import" onClick={() => rollback(batch)}>
                        <RotateCcw size={14} />
                      </Button>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
                  {Object.entries(batch.summary).map(([key, value]) => (
                    <span key={key}>{key.replace(/([A-Z])/g, " $1")}: <b>{value}</b></span>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-10 text-center text-[12px] text-slate-400">No imports have been committed yet.</div>
        )}
      </Card>
    </div>
  );
}
