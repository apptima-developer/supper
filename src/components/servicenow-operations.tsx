"use client";

import { Activity, ArrowRightLeft, CheckCircle2, CloudCog, History, Loader2, Play, RefreshCw, Search, ShieldCheck, TriangleAlert, Unplug } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { SafeServiceNowRuntimeDiagnostics } from "@/lib/integrations/servicenow/diagnostics-types";
import type { ServiceNowMappingCandidate, ServiceNowOperationsSummary, ServiceNowRunItem, ServiceNowRunSummary } from "@/lib/integrations/servicenow/operations/types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent } from "./ui/dialog";
import { Input } from "./ui/input";
import { PaginationControls } from "./ui/pagination-controls";

type Tab = "overview" | "runs" | "mappings" | "diagnostics";
type PageResult<T> = { items: T[]; total: number; page: number; limit: number };
type TargetCustomer = { customerKey: string; customerName: string; projectCode?: string };
type RunDetail = { run: ServiceNowRunSummary; items: ServiceNowRunItem[]; nextItemCursor?: number };

function timestamp(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("en-GB", { hour12: false });
}

function duration(milliseconds: number) {
  if (!milliseconds) return "-";
  return milliseconds < 1_000 ? `${milliseconds} ms` : `${(milliseconds / 1_000).toFixed(1)} s`;
}

function statusTone(status?: string): "emerald" | "amber" | "rose" | "blue" | "slate" {
  if (status === "succeeded") return "emerald";
  if (status === "partial" || status === "blocked") return "amber";
  if (status === "failed") return "rose";
  if (status === "running") return "blue";
  return "slate";
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
      ? (body as Record<string, unknown>).error as string : "Request failed";
    throw new Error(message);
  }
  return body as T;
}

function Stat({ label, value, detail }: { label: string; value: string | number; detail?: string }) {
  return <div className="rounded-xl border border-sky-100/80 bg-white/55 p-3 dark:border-slate-700 dark:bg-slate-900/55">
    <p className="text-[10px] font-semibold uppercase tracking-[.12em] text-slate-400">{label}</p>
    <p className="mt-1 text-xl font-semibold text-[#173b57] dark:text-slate-100">{value}</p>
    {detail && <p className="mt-1 text-[10px] text-slate-400">{detail}</p>}
  </div>;
}

export function ServiceNowOperations({ diagnosticsAvailable }: { diagnosticsAvailable: boolean }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [busy, setBusy] = useState("");
  const [summary, setSummary] = useState<ServiceNowOperationsSummary>();
  const [runs, setRuns] = useState<PageResult<ServiceNowRunSummary>>({ items: [], total: 0, page: 1, limit: 25 });
  const [runStatus, setRunStatus] = useState("");
  const [runMode, setRunMode] = useState("");
  const [runDryRun, setRunDryRun] = useState("");
  const [runDateFrom, setRunDateFrom] = useState("");
  const [runDateTo, setRunDateTo] = useState("");
  const [runSearch, setRunSearch] = useState("");
  const [selectedRun, setSelectedRun] = useState<RunDetail>();
  const [mappings, setMappings] = useState<PageResult<ServiceNowMappingCandidate>>({ items: [], total: 0, page: 1, limit: 25 });
  const [mappingStatus, setMappingStatus] = useState("all");
  const [mappingSearch, setMappingSearch] = useState("");
  const [appliedMappingSearch, setAppliedMappingSearch] = useState("");
  const [mappingCandidate, setMappingCandidate] = useState<ServiceNowMappingCandidate>();
  const [targetSearch, setTargetSearch] = useState("");
  const [targets, setTargets] = useState<TargetCustomer[]>([]);
  const [selectedTarget, setSelectedTarget] = useState<TargetCustomer>();
  const [deactivateCandidate, setDeactivateCandidate] = useState<ServiceNowMappingCandidate>();
  const [confirmSync, setConfirmSync] = useState<"initial" | "incremental">();
  const [diagnostics, setDiagnostics] = useState<SafeServiceNowRuntimeDiagnostics>();

  const loadSummary = useCallback(async () => {
    setSummary(await api<ServiceNowOperationsSummary>("/api/integrations/servicenow/operations"));
  }, []);

  const loadRuns = useCallback(async (page = 1) => {
    const query = new URLSearchParams({ page: String(page), limit: "25" });
    if (runStatus) query.set("status", runStatus);
    if (runMode) query.set("mode", runMode);
    if (runDryRun) query.set("dryRun", runDryRun);
    if (runDateFrom) query.set("dateFrom", runDateFrom);
    if (runDateTo) query.set("dateTo", runDateTo);
    setRuns(await api<PageResult<ServiceNowRunSummary>>(`/api/integrations/servicenow/runs?${query}`));
  }, [runDateFrom, runDateTo, runDryRun, runMode, runStatus]);

  const loadMappings = useCallback(async (page = 1) => {
    const query = new URLSearchParams({ page: String(page), limit: "25", status: mappingStatus, search: appliedMappingSearch });
    setMappings(await api<PageResult<ServiceNowMappingCandidate>>(`/api/integrations/servicenow/customer-mappings?${query}`));
  }, [appliedMappingSearch, mappingStatus]);

  useEffect(() => {
    let active = true;
    api<ServiceNowOperationsSummary>("/api/integrations/servicenow/operations")
      .then((result) => { if (active) setSummary(result); })
      .catch((error) => toast.error(error instanceof Error ? error.message : "Could not load operations"));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (tab !== "runs") return;
    let active = true;
    const query = new URLSearchParams({ page: "1", limit: "25" });
    if (runStatus) query.set("status", runStatus);
    if (runMode) query.set("mode", runMode);
    if (runDryRun) query.set("dryRun", runDryRun);
    if (runDateFrom) query.set("dateFrom", runDateFrom);
    if (runDateTo) query.set("dateTo", runDateTo);
    api<PageResult<ServiceNowRunSummary>>(`/api/integrations/servicenow/runs?${query}`)
      .then((result) => { if (active) setRuns(result); })
      .catch((error) => toast.error(error instanceof Error ? error.message : "Could not load runs"));
    return () => { active = false; };
  }, [runDateFrom, runDateTo, runDryRun, runMode, runStatus, tab]);
  useEffect(() => {
    if (tab !== "mappings") return;
    let active = true;
    const query = new URLSearchParams({ page: "1", limit: "25", status: mappingStatus, search: appliedMappingSearch });
    api<PageResult<ServiceNowMappingCandidate>>(`/api/integrations/servicenow/customer-mappings?${query}`)
      .then((result) => { if (active) setMappings(result); })
      .catch((error) => toast.error(error instanceof Error ? error.message : "Could not load mappings"));
    return () => { active = false; };
  }, [appliedMappingSearch, mappingStatus, tab]);

  async function refreshAll() {
    setBusy("refresh");
    try {
      await Promise.all([loadSummary(), loadRuns(runs.page), loadMappings(mappings.page)]);
      toast.success("ServiceNow operations refreshed");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not refresh operations"); }
    finally { setBusy(""); }
  }

  async function runConnectionTest() {
    setBusy("test");
    try { await api("/api/integrations/servicenow/test", { method: "POST" }); toast.success("ServiceNow connection succeeded"); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Connection test failed"); }
    finally { setBusy(""); }
  }

  async function loadSamples() {
    setBusy("sample");
    try {
      const result = await api<{ items?: unknown[] }>("/api/integrations/servicenow/incidents?limit=10&offset=0");
      toast.success(`Loaded ${result.items?.length || 0} read-only sample Incidents`);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not load samples"); }
    finally { setBusy(""); }
  }

  async function runSync(mode: "initial" | "incremental", dryRun: boolean) {
    setBusy("sync"); setConfirmSync(undefined);
    try {
      const result = await api<ServiceNowRunSummary>("/api/integrations/servicenow/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode, dryRun }) });
      const notify = result.status === "succeeded" ? toast.success : result.status === "failed" ? toast.error : toast.warning;
      notify(`${dryRun ? "Dry run" : "Synchronization"} ${result.status}`);
      await Promise.all([loadSummary(), loadRuns(1), loadMappings(1)]);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Synchronization failed"); }
    finally { setBusy(""); }
  }

  async function openRun(runId: string) {
    setBusy("run-detail");
    try { setSelectedRun(await api<RunDetail>(`/api/integrations/servicenow/runs/${encodeURIComponent(runId)}?itemLimit=100&itemCursor=0`)); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not load run detail"); }
    finally { setBusy(""); }
  }

  async function searchTargets(search = targetSearch) {
    setBusy("targets");
    try {
      const result = await api<{ items: TargetCustomer[] }>(`/api/integrations/servicenow/customer-targets?search=${encodeURIComponent(search)}&limit=50`);
      setTargets(result.items);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not search customers"); }
    finally { setBusy(""); }
  }

  async function beginMapping(candidate: ServiceNowMappingCandidate) {
    setMappingCandidate(candidate); setSelectedTarget(undefined); setTargetSearch(""); setTargets([]);
    await searchTargets("");
  }

  async function applyMapping() {
    if (!mappingCandidate || !selectedTarget) return;
    setBusy("map");
    try {
      const result = await api<{ affectedTicketCount: number; auditWarning?: string }>("/api/integrations/servicenow/customer-mappings", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ externalCustomerKey: mappingCandidate.externalCustomerKey, customerKey: selectedTarget.customerKey }),
      });
      toast.success(`Customer mapping applied to ${result.affectedTicketCount} ticket${result.affectedTicketCount === 1 ? "" : "s"}`);
      if (result.auditWarning) toast.warning("Mapping succeeded, but the secondary audit write needs attention");
      setMappingCandidate(undefined); setSelectedTarget(undefined);
      await Promise.all([loadMappings(1), loadSummary()]);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not apply mapping"); }
    finally { setBusy(""); }
  }

  async function deactivateMapping() {
    if (!deactivateCandidate?.mappingId) return;
    setBusy("deactivate");
    try {
      const result = await api<{ auditWarning?: string }>(`/api/integrations/servicenow/customer-mappings/${encodeURIComponent(deactivateCandidate.mappingId)}/deactivate`, { method: "POST" });
      toast.success("Customer mapping deactivated; existing ticket assignments were preserved");
      if (result.auditWarning) toast.warning("Deactivation succeeded, but the secondary audit write needs attention");
      setDeactivateCandidate(undefined);
      await Promise.all([loadMappings(1), loadSummary()]);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not deactivate mapping"); }
    finally { setBusy(""); }
  }

  async function loadDiagnostics() {
    if (!diagnosticsAvailable) return;
    setBusy("diagnostics");
    try {
      const result = await api<{ diagnostics: SafeServiceNowRuntimeDiagnostics }>("/api/integrations/servicenow/diagnostics");
      setDiagnostics(result.diagnostics);
    } catch (error) { toast.error(error instanceof Error ? error.message : "Diagnostics are unavailable"); }
    finally { setBusy(""); }
  }

  const visibleRuns = useMemo(() => {
    const search = runSearch.trim().toLocaleLowerCase();
    return search ? runs.items.filter((run) => `${run.runId} ${run.status} ${run.mode}`.toLocaleLowerCase().includes(search)) : runs.items;
  }, [runSearch, runs.items]);

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-sky-100/80 bg-white/60 p-3 shadow-sm backdrop-blur dark:border-slate-700 dark:bg-slate-900/60">
      <div className="flex flex-wrap gap-1">
        {(["overview", "runs", "mappings", "diagnostics"] as Tab[]).map((item) => <Button key={item} variant={tab === item ? "default" : "ghost"} size="sm" onClick={() => setTab(item)} disabled={item === "diagnostics" && !diagnosticsAvailable}>{item === "overview" ? <Activity size={14} /> : item === "runs" ? <History size={14} /> : item === "mappings" ? <ArrowRightLeft size={14} /> : <ShieldCheck size={14} />}{item === "mappings" ? "Customer mapping" : item[0].toUpperCase() + item.slice(1)}</Button>)}
      </div>
      <Button variant="outline" size="sm" onClick={refreshAll} disabled={!!busy}>{busy === "refresh" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}Refresh</Button>
    </div>

    {tab === "overview" && <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <Stat label="Configuration" value={summary?.config.configured ? "Ready" : "Attention"} detail={summary?.config.hostname || "Not configured"} />
        <Stat label="Sync state" value={summary?.syncRunning ? "Running" : summary?.syncEnabled ? "Idle" : "Disabled"} detail={`Last success ${timestamp(summary?.lastSuccess)}`} />
        <Stat label="Runs / 24h" value={summary?.runsLast24Hours ?? 0} detail={`${summary?.failedOrPartialRunsLast24Hours ?? 0} failed or partial`} />
        <Stat label="Unmapped" value={summary?.unmappedCustomerSourceCount ?? 0} detail={`${summary?.unmappedTicketCount ?? 0} tickets`} />
        <Stat label="Active mappings" value={summary?.activeMappingCount ?? 0} detail={`${summary?.inactiveMappingCount ?? 0} inactive`} />
      </div>
      <Card><CardHeader><div className="flex items-center gap-2"><CloudCog size={17} className="text-sky-600" /><CardTitle>ServiceNow controls</CardTitle></div><Badge tone={summary?.config.configured ? "emerald" : "amber"}>{summary?.config.configured ? "Configured" : "Needs attention"}</Badge></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-2 text-[11px] md:grid-cols-4">
            <div className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><span className="text-slate-400">Watermark</span><p className="mt-1 font-medium">{timestamp(summary?.currentWatermark)}</p></div>
            <div className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><span className="text-slate-400">Last attempt</span><p className="mt-1 font-medium">{timestamp(summary?.lastAttempt)}</p></div>
            <div className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><span className="text-slate-400">Latest run</span><p className="mt-1"><Badge tone={statusTone(summary?.latestRun?.status)}>{summary?.latestRun?.status || "No run"}</Badge></p></div>
            <div className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><span className="text-slate-400">Latest results</span><p className="mt-1 font-medium">{summary?.latestRun?.fetched ?? 0} fetched · {summary?.latestRun?.updated ?? 0} updated</p></div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={runConnectionTest} disabled={!!busy}><CheckCircle2 size={14} />Test Connection</Button>
            <Button variant="outline" size="sm" onClick={loadSamples} disabled={!!busy}><Search size={14} />Load Sample Incidents</Button>
            <Button variant="outline" size="sm" onClick={() => runSync("initial", true)} disabled={!!busy || !summary?.syncEnabled}><Search size={14} />Dry Run Initial Sync</Button>
            <Button variant="outline" size="sm" onClick={() => setConfirmSync("initial")} disabled={!!busy || !summary?.syncEnabled}><Play size={14} />Run Initial Sync</Button>
            <Button size="sm" onClick={() => setConfirmSync("incremental")} disabled={!!busy || !summary?.syncEnabled}><Play size={14} />Run Incremental Sync</Button>
          </div>
        </CardContent></Card>
    </div>}

    {tab === "runs" && <Card><CardHeader><CardTitle>Synchronization runs</CardTitle><span className="text-[10px] text-slate-400">{runs.total} runs</span></CardHeader><CardContent className="space-y-3">
      <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[1fr_150px_150px_130px_150px_150px_auto]">
        <Input value={runSearch} onChange={(event) => setRunSearch(event.target.value)} placeholder="Search current page by run ID or status" />
        <select className="h-9 rounded-lg border border-sky-100 bg-white px-3 text-[11px] dark:border-slate-700 dark:bg-slate-900" value={runStatus} onChange={(event) => setRunStatus(event.target.value)}><option value="">All statuses</option>{["running", "succeeded", "partial", "failed", "blocked"].map((value) => <option key={value}>{value}</option>)}</select>
        <select className="h-9 rounded-lg border border-sky-100 bg-white px-3 text-[11px] dark:border-slate-700 dark:bg-slate-900" value={runMode} onChange={(event) => setRunMode(event.target.value)}><option value="">All modes</option><option value="initial">initial</option><option value="incremental">incremental</option></select>
        <select className="h-9 rounded-lg border border-sky-100 bg-white px-3 text-[11px] dark:border-slate-700 dark:bg-slate-900" value={runDryRun} onChange={(event) => setRunDryRun(event.target.value)}><option value="">Dry + commit</option><option value="true">Dry run</option><option value="false">Committed</option></select>
        <Input type="date" aria-label="Run date from" value={runDateFrom} onChange={(event) => setRunDateFrom(event.target.value)} />
        <Input type="date" aria-label="Run date to" value={runDateTo} onChange={(event) => setRunDateTo(event.target.value)} />
        <Button variant="outline" size="sm" onClick={() => loadRuns(1)}>Apply</Button>
      </div>
      <div className="hidden overflow-x-auto rounded-xl border border-sky-100/80 md:block dark:border-slate-700"><table className="w-full text-left text-[10px]"><thead className="bg-sky-50/60 text-slate-500 dark:bg-slate-800"><tr>{["Started", "Mode", "Dry", "Status", "Fetched", "Created", "Updated", "Unchanged", "Failed", "Pages", "Duration", "Watermark", "Warning"].map((header) => <th className="px-3 py-2" key={header}>{header}</th>)}</tr></thead><tbody>{visibleRuns.map((run) => <tr key={run.runId} className="cursor-pointer border-t border-sky-100/70 hover:bg-sky-50/40 dark:border-slate-800" onClick={() => openRun(run.runId)}><td className="px-3 py-2">{timestamp(run.startedAt)}</td><td className="px-3 py-2 capitalize">{run.mode}</td><td className="px-3 py-2">{run.dryRun ? "Yes" : "No"}</td><td className="px-3 py-2"><Badge tone={statusTone(run.status)}>{run.status}</Badge></td><td className="px-3 py-2">{run.fetched}</td><td className="px-3 py-2">{run.created}</td><td className="px-3 py-2">{run.updated}</td><td className="px-3 py-2">{run.unchanged}</td><td className="px-3 py-2">{run.failed}</td><td className="px-3 py-2">{run.pages}</td><td className="px-3 py-2">{duration(run.duration)}</td><td className="max-w-40 truncate px-3 py-2" title={run.watermarkTo}>{timestamp(run.watermarkTo)}</td><td className="max-w-32 truncate px-3 py-2" title={run.safeErrorCategory || run.auditWarning}>{run.safeErrorCategory || run.auditWarning || "-"}</td></tr>)}</tbody></table></div>
      <div className="space-y-2 md:hidden">{visibleRuns.map((run) => <button type="button" key={run.runId} onClick={() => openRun(run.runId)} className="w-full rounded-xl border border-sky-100 bg-white/60 p-3 text-left dark:border-slate-700 dark:bg-slate-900/60"><div className="flex items-center justify-between"><span className="font-semibold">{timestamp(run.startedAt)}</span><Badge tone={statusTone(run.status)}>{run.status}</Badge></div><p className="mt-2 text-[11px] text-slate-500">{run.mode}{run.dryRun ? " · dry run" : ""} · {run.fetched} fetched · {run.updated} updated · {run.failed} failed</p></button>)}</div>
      <PaginationControls page={runs.page} total={runs.total} pageSize={runs.limit} itemLabel="runs" onPageChange={loadRuns} />
    </CardContent></Card>}

    {tab === "mappings" && <Card><CardHeader><CardTitle>Customer mapping queue</CardTitle><span className="text-[10px] text-slate-400">{mappings.total} ServiceNow sources</span></CardHeader><CardContent className="space-y-3">
      <div className="grid gap-2 md:grid-cols-[1fr_200px_auto]"><Input value={mappingSearch} onChange={(event) => setMappingSearch(event.target.value)} placeholder="Search ServiceNow company or stable key" /><select className="h-9 rounded-lg border border-sky-100 bg-white px-3 text-[11px] dark:border-slate-700 dark:bg-slate-900" value={mappingStatus} onChange={(event) => setMappingStatus(event.target.value)}><option value="all">All</option><option value="unmapped">Unmapped</option><option value="mapped">Mapped</option><option value="inactive">Inactive</option></select><Button variant="outline" size="sm" onClick={() => setAppliedMappingSearch(mappingSearch)}>Search</Button></div>
      <div className="space-y-2">{mappings.items.map((candidate) => <div key={candidate.externalCustomerKey} className="grid gap-3 rounded-xl border border-sky-100/80 bg-white/55 p-3 md:grid-cols-[1.4fr_1fr_120px_1fr_auto] md:items-center dark:border-slate-700 dark:bg-slate-900/55">
        <div><div className="flex flex-wrap items-center gap-2"><p className="font-semibold text-[#173b57] dark:text-slate-100">{candidate.mappable ? candidate.externalCustomerName : "Needs ServiceNow company"}</p><Badge tone={candidate.activeMapping ? "emerald" : candidate.mapped ? "amber" : "slate"}>{candidate.activeMapping ? "Mapped" : candidate.mapped ? "Inactive" : "Unmapped"}</Badge></div><p className="mt-1 max-w-md truncate text-[10px] text-slate-400" title={candidate.externalCustomerKey}>{candidate.externalCustomerKey}</p></div>
        <div><p className="text-[10px] text-slate-400">SUPPER customer</p><p className="text-[11px] font-medium">{candidate.mappedCustomerName || "-"}</p></div>
        <div><p className="text-[10px] text-slate-400">Tickets</p><p className="text-[11px] font-medium">{candidate.ticketCount} total · {candidate.openTicketCount} open</p></div>
        <div><p className="text-[10px] text-slate-400">Seen / examples</p><p className="text-[11px]">{timestamp(candidate.lastSeenAt)}</p><p className="truncate text-[10px] text-slate-400">{candidate.exampleIncidents.join(", ") || "-"}</p></div>
        <div className="flex flex-wrap gap-1.5 md:justify-end">{candidate.mappable ? <Button size="sm" variant={candidate.activeMapping ? "outline" : "default"} onClick={() => beginMapping(candidate)}>{candidate.activeMapping ? "Change" : candidate.mapped ? "Reactivate" : "Map"}</Button> : <Button size="sm" variant="outline" disabled title="Correct the Incident company in ServiceNow first">Map</Button>}{candidate.activeMapping && candidate.mappingId && <Button size="sm" variant="ghost" onClick={() => setDeactivateCandidate(candidate)}><Unplug size={13} />Deactivate</Button>}</div>
        {!candidate.mappable && <p className="text-[10px] text-amber-700 md:col-span-5">This source has no stable ServiceNow company. Correct the Incident company in ServiceNow, then synchronize again.</p>}
      </div>)}</div>
      {!mappings.items.length && <p className="py-10 text-center text-[11px] text-slate-400">No customer mapping sources match these filters.</p>}
      <PaginationControls page={mappings.page} total={mappings.total} pageSize={mappings.limit} itemLabel="sources" onPageChange={loadMappings} />
    </CardContent></Card>}

    {tab === "diagnostics" && <Card><CardHeader><CardTitle>Safe runtime diagnostics</CardTitle><Badge tone="amber">AI-development Preview only</Badge></CardHeader><CardContent>
      {!diagnostics ? <div className="rounded-xl border border-dashed border-sky-200 p-8 text-center"><p className="text-[11px] text-slate-500">Diagnostics are collapsed and never loaded by default.</p><Button className="mt-3" variant="outline" size="sm" onClick={loadDiagnostics} disabled={!diagnosticsAvailable || !!busy}>{busy === "diagnostics" ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}Load safe diagnostics</Button></div> : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Stat label="ServiceNow config" value={diagnostics.serviceNow.configurationValid ? "Valid" : "Invalid"} /><Stat label="Sync config" value={diagnostics.synchronization.configurationValid ? "Valid" : "Invalid"} /><Stat label="Branch" value={diagnostics.deployment.gitBranch || "-"} /><Stat label="Commit" value={diagnostics.deployment.commitSha || "-"} /></div>}
    </CardContent></Card>}

    <Dialog open={Boolean(confirmSync)} onOpenChange={(open) => !open && setConfirmSync(undefined)}><DialogContent title={`Run ${confirmSync || ""} ServiceNow sync?`} description="The operation reads ServiceNow Incidents and updates only ServiceNow-owned SUPPER fields. No ServiceNow write is performed."><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setConfirmSync(undefined)}>Cancel</Button><Button onClick={() => confirmSync && runSync(confirmSync, false)}><Play size={14} />Confirm sync</Button></div></DialogContent></Dialog>

    <Dialog open={Boolean(selectedRun)} onOpenChange={(open) => !open && setSelectedRun(undefined)}><DialogContent title="Synchronization run detail" description="Sanitized counters and bounded per-record outcomes only." className="max-w-5xl"><>{selectedRun && <div className="space-y-4 text-[11px]"><div className="grid gap-2 sm:grid-cols-3"><Stat label="Status" value={selectedRun.run.status} detail={`${selectedRun.run.mode}${selectedRun.run.dryRun ? " · dry run" : ""}`} /><Stat label="Fixed window" value={timestamp(selectedRun.run.windowStart)} detail={`to ${timestamp(selectedRun.run.windowEnd)}`} /><Stat label="Watermark" value={timestamp(selectedRun.run.watermarkTo)} detail={selectedRun.run.safeErrorCategory || selectedRun.run.auditWarning || "No warning"} /></div><div className="max-h-96 overflow-auto rounded-xl border border-sky-100 dark:border-slate-700"><table className="w-full text-left text-[10px]"><thead className="sticky top-0 bg-sky-50 dark:bg-slate-800"><tr>{["Incident", "Outcome", "Source time", "Ticket", "Safe code"].map((header) => <th className="px-3 py-2" key={header}>{header}</th>)}</tr></thead><tbody>{selectedRun.items.map((item, index) => <tr key={`${item.externalNumber}-${index}`} className="border-t border-sky-100 dark:border-slate-800"><td className="px-3 py-2 font-semibold">{item.externalNumber || "-"}</td><td className="px-3 py-2">{item.outcome}</td><td className="px-3 py-2">{timestamp(item.sourceUpdatedAt)}</td><td className="px-3 py-2">{item.ticketId || "-"}</td><td className="px-3 py-2">{item.safeErrorCode || item.warningCode || "-"}</td></tr>)}</tbody></table>{!selectedRun.items.length && <p className="p-8 text-center text-slate-400">No committed per-record items for this run.</p>}</div></div>}</></DialogContent></Dialog>

    <Dialog open={Boolean(mappingCandidate)} onOpenChange={(open) => !open && setMappingCandidate(undefined)}><DialogContent title="Confirm ServiceNow customer mapping" description="Choose an existing active SUPPER customer. Free-text customer keys and customer creation are not allowed." className="max-w-3xl"><>{mappingCandidate && <div className="space-y-4 text-[11px]"><div className="rounded-xl border border-sky-100 bg-sky-50/40 p-3 dark:border-slate-700 dark:bg-slate-900"><p className="font-semibold">{mappingCandidate.externalCustomerName}</p><p className="mt-1 text-slate-500">This mapping will update customer assignment on all {mappingCandidate.ticketCount} linked SUPPER tickets while preserving effort, billing, notes, status, logs, and ticket identity.</p></div><div className="flex gap-2"><Input value={targetSearch} onChange={(event) => setTargetSearch(event.target.value)} placeholder="Search active SUPPER customers" /><Button variant="outline" onClick={() => searchTargets()}><Search size={14} />Search</Button></div><div className="max-h-56 space-y-1 overflow-y-auto">{targets.map((target) => <button type="button" key={target.customerKey} onClick={() => setSelectedTarget(target)} className={`w-full rounded-lg border p-2 text-left ${selectedTarget?.customerKey === target.customerKey ? "border-sky-400 bg-sky-50 dark:bg-slate-800" : "border-sky-100 dark:border-slate-700"}`}><span className="font-semibold">{target.customerName}</span><span className="ml-2 text-slate-400">{target.projectCode || target.customerKey}</span></button>)}</div><div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setMappingCandidate(undefined)}>Cancel</Button><Button onClick={applyMapping} disabled={!selectedTarget || busy === "map"}>{busy === "map" ? <Loader2 size={14} className="animate-spin" /> : <ArrowRightLeft size={14} />}Map to {selectedTarget?.customerName || "selected customer"}</Button></div></div>}</></DialogContent></Dialog>

    <Dialog open={Boolean(deactivateCandidate)} onOpenChange={(open) => !open && setDeactivateCandidate(undefined)}><DialogContent title="Deactivate customer mapping?" description="Deactivation stops automatic mapping for future synchronization. Existing ticket assignments remain unchanged."><div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-900"><div className="flex gap-2"><TriangleAlert size={15} /><p>{deactivateCandidate?.externalCustomerName} will no longer map automatically to {deactivateCandidate?.mappedCustomerName || "the current customer"}.</p></div></div><div className="mt-4 flex justify-end gap-2"><Button variant="outline" onClick={() => setDeactivateCandidate(undefined)}>Cancel</Button><Button onClick={deactivateMapping} disabled={busy === "deactivate"}><Unplug size={14} />Confirm deactivation</Button></div></DialogContent></Dialog>
  </div>;
}
