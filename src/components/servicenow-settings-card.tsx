"use client";

import { CheckCircle2, CloudCog, Loader2, Play, RefreshCw, SearchCheck, TriangleAlert } from "lucide-react";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import type { ServiceNowConfigSummary } from "@/lib/integrations/servicenow/config";
import type { SafeServiceNowRuntimeDiagnostics } from "@/lib/integrations/servicenow/diagnostics-types";
import { serviceNowSyncPresentation } from "@/lib/integrations/servicenow/sync/presentation";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent } from "./ui/dialog";

type SampleIncident = {
  number: string;
  title: string;
  state?: string;
  priority?: string;
  openedAt?: string;
  assignmentGroupReference?: string;
};

type SyncSummary = {
  runId?: string;
  mode?: "initial" | "incremental";
  status?: string;
  dryRun?: boolean;
  fetched?: number;
  created?: number;
  updated?: number;
  unchanged?: number;
  stale?: number;
  failed?: number;
  currentWatermark?: string;
  watermarkTo?: string;
  lastSuccess?: string;
  safeErrorCategory?: string;
  auditWarning?: string;
};

function displayTimestamp(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("en-GB", { hour12: false });
}

function errorMessage(body: unknown, fallback: string) {
  if (!body || typeof body !== "object") return fallback;
  const value = body as Record<string, unknown>;
  return typeof value.error === "string" ? value.error : fallback;
}

function errorCategory(body: unknown) {
  if (!body || typeof body !== "object") return "request";
  const category = (body as Record<string, unknown>).category;
  return typeof category === "string" && /^[a-z_]{1,40}$/.test(category) ? category : "request";
}

function diagnosticsFromBody(body: unknown) {
  if (!body || typeof body !== "object") return undefined;
  const diagnostics = (body as Record<string, unknown>).diagnostics;
  if (!diagnostics || typeof diagnostics !== "object") return undefined;
  const value = diagnostics as Record<string, unknown>;
  if (!value.deployment || !value.serviceNow || !value.synchronization) return undefined;
  return diagnostics as SafeServiceNowRuntimeDiagnostics;
}

function SafeBooleanBadge({ value }: { value: boolean | null }) {
  if (value === null) return <Badge tone="amber">Invalid</Badge>;
  return <Badge tone={value ? "emerald" : "slate"}>{value ? "Yes" : "No"}</Badge>;
}

export function ServiceNowSettingsCard({ config, diagnosticsAvailable = false }: { config: ServiceNowConfigSummary; diagnosticsAvailable?: boolean }) {
  const [busy, setBusy] = useState<"test" | "load" | "sync" | "refresh" | "diagnose" | "">("");
  const [connection, setConnection] = useState<"idle" | "connected" | "failed">("idle");
  const [testedAt, setTestedAt] = useState<string>();
  const [lastErrorCategory, setLastErrorCategory] = useState<string>();
  const [incidents, setIncidents] = useState<SampleIncident[]>([]);
  const [sync, setSync] = useState<SyncSummary>();
  const [diagnostics, setDiagnostics] = useState<SafeServiceNowRuntimeDiagnostics>();
  const [confirmMode, setConfirmMode] = useState<"initial" | "incremental">();
  const enabled = config.enabled && config.configured;
  const syncEnabled = enabled && config.syncEnabled;

  const refreshSyncStatus = useCallback(async (quiet = false) => {
    if (!quiet) setBusy("refresh");
    try {
      const response = await fetch("/api/integrations/servicenow/sync", { cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(body, "Could not refresh synchronization status"));
      const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
      const runs = Array.isArray(value.runs) ? value.runs : [];
      const latest = runs[0] && typeof runs[0] === "object" ? runs[0] as SyncSummary : {};
      setSync({ ...latest, currentWatermark: typeof value.currentWatermark === "string" ? value.currentWatermark : undefined, lastSuccess: typeof value.lastSuccess === "string" ? value.lastSuccess : undefined });
      if (!quiet) toast.success("Synchronization status refreshed");
    } catch (error) {
      if (!quiet) toast.error(error instanceof Error ? error.message : "Could not refresh synchronization status");
    } finally {
      if (!quiet) setBusy("");
    }
  }, []);

  async function runTest() {
    setBusy("test");
    setTestedAt(new Date().toISOString());
    try {
      const response = await fetch("/api/integrations/servicenow/test", { method: "POST" });
      const body: unknown = await response.json();
      if (!response.ok) {
        setConnection("failed");
        setLastErrorCategory(errorCategory(body));
        throw new Error(errorMessage(body, "ServiceNow connection test failed"));
      }
      setConnection("connected");
      setLastErrorCategory(undefined);
      toast.success("ServiceNow connection succeeded");
    } catch (error) {
      setConnection("failed");
      setLastErrorCategory((current) => current || "request");
      toast.error(error instanceof Error ? error.message : "ServiceNow connection test failed");
    } finally {
      setBusy("");
    }
  }

  async function loadSample() {
    setBusy("load");
    try {
      const response = await fetch("/api/integrations/servicenow/incidents?limit=10&offset=0", { cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok) {
        setLastErrorCategory(errorCategory(body));
        throw new Error(errorMessage(body, "Could not load sample incidents"));
      }
      const rawItems = body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).items)
        ? (body as { items: unknown[] }).items
        : [];
      const safeItems = rawItems.flatMap((item) => {
        if (!item || typeof item !== "object") return [];
        const value = item as Record<string, unknown>;
        if (typeof value.number !== "string" || typeof value.title !== "string") return [];
        return [{
          number: value.number,
          title: value.title,
          state: typeof value.state === "string" ? value.state : undefined,
          priority: typeof value.priority === "string" ? value.priority : undefined,
          openedAt: typeof value.openedAt === "string" ? value.openedAt : undefined,
          assignmentGroupReference: typeof value.assignmentGroupReference === "string" ? value.assignmentGroupReference : undefined,
        }];
      });
      setIncidents(safeItems);
      setLastErrorCategory(undefined);
      toast.success(`Loaded ${safeItems.length} read-only incident${safeItems.length === 1 ? "" : "s"}`);
    } catch (error) {
      setLastErrorCategory((current) => current || "request");
      toast.error(error instanceof Error ? error.message : "Could not load sample incidents");
    } finally {
      setBusy("");
    }
  }

  async function diagnoseConfiguration() {
    if (busy) return;
    setBusy("diagnose");
    try {
      const response = await fetch("/api/integrations/servicenow/diagnostics", { cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(body, "Configuration diagnostics are unavailable"));
      const safeDiagnostics = diagnosticsFromBody(body);
      if (!safeDiagnostics) throw new Error("Configuration diagnostics returned an invalid response");
      setDiagnostics(safeDiagnostics);
      const valid = safeDiagnostics.serviceNow.configurationValid && safeDiagnostics.synchronization.configurationValid;
      if (valid) toast.success("ServiceNow configuration is valid");
      else toast.warning("ServiceNow configuration needs attention");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not diagnose ServiceNow configuration");
    } finally {
      setBusy("");
    }
  }

  async function runSync(mode: "initial" | "incremental", dryRun: boolean) {
    if (busy) return;
    setBusy("sync");
    setConfirmMode(undefined);
    try {
      const response = await fetch("/api/integrations/servicenow/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, dryRun }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(body, "ServiceNow synchronization failed"));
      const value = body && typeof body === "object" ? body as SyncSummary : {};
      setSync(value);
      const presentation = serviceNowSyncPresentation(value.status);
      const message = `${dryRun ? "Dry run" : "Synchronization"} ${presentation.label.toLowerCase()}`;
      if (presentation.level === "success") toast.success(message);
      else if (presentation.level === "warning") toast.warning(message);
      else toast.error(message);
      await refreshSyncStatus(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "ServiceNow synchronization failed");
    } finally {
      setBusy("");
    }
  }

  const syncPresentation = serviceNowSyncPresentation(sync?.status);

  return <Card>
    <CardHeader>
      <div className="flex items-center gap-2"><CloudCog size={17} className="text-sky-600" /><CardTitle>ServiceNow integration</CardTitle></div>
      <Badge tone={enabled ? "emerald" : config.enabled ? "amber" : "slate"}>{enabled ? "Configured" : config.enabled ? "Incomplete" : "Disabled"}</Badge>
    </CardHeader>
    <CardContent className="space-y-4">
      <div className="grid gap-2 text-[11px] sm:grid-cols-2">
        <div className="rounded-xl border border-sky-100/80 bg-white/55 p-3"><p className="text-slate-400">Instance</p><p className="mt-1 font-medium text-slate-700">{config.hostname || "Not configured"}</p></div>
        <div className="rounded-xl border border-sky-100/80 bg-white/55 p-3"><p className="text-slate-400">Authentication</p><p className="mt-1 font-medium text-slate-700">{config.authMode === "oauth_client_credentials" ? "OAuth client credentials" : config.authMode === "basic" ? "Basic (PDI only)" : "Not configured"}</p></div>
        <div className="rounded-xl border border-sky-100/80 bg-white/55 p-3"><p className="text-slate-400">Connection</p><p className="mt-1 flex items-center gap-1.5 font-medium text-slate-700">{connection === "connected" ? <CheckCircle2 size={13} className="text-emerald-500" /> : connection === "failed" ? <TriangleAlert size={13} className="text-rose-500" /> : null}{connection === "connected" ? "Connected" : connection === "failed" ? "Failed" : "Not tested"}</p></div>
        <div className="rounded-xl border border-sky-100/80 bg-white/55 p-3"><p className="text-slate-400">Latest client test</p><p className="mt-1 font-medium text-slate-700">{displayTimestamp(testedAt)}</p></div>
      </div>

      {lastErrorCategory && <div className="rounded-xl border border-rose-100 bg-rose-50/70 px-3 py-2 text-[11px] text-rose-700">Safe error category: <span className="font-semibold">{lastErrorCategory}</span></div>}

      <div className="flex flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={!enabled || !!busy} onClick={runTest}>{busy === "test" ? <Loader2 size={13} className="animate-spin" /> : <CheckCircle2 size={13} />}Test Connection</Button>
        <Button size="sm" disabled={!enabled || !!busy} onClick={loadSample}>{busy === "load" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}Load Sample Incidents</Button>
        {diagnosticsAvailable && <Button variant="ghost" size="sm" disabled={!!busy} onClick={diagnoseConfiguration}>{busy === "diagnose" ? <Loader2 size={13} className="animate-spin" /> : <SearchCheck size={13} />}Diagnose Configuration</Button>}
      </div>

      {diagnosticsAvailable && diagnostics && <div className="rounded-xl border border-sky-100/80 bg-sky-50/35 p-3 text-[10px]">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><p className="text-[11px] font-semibold text-[#173b57]">Safe runtime diagnostics</p><p className="text-slate-400">Presence and validation state only. Credentials are never returned.</p></div>
          <Badge tone={diagnostics.serviceNow.configurationValid && diagnostics.synchronization.configurationValid ? "emerald" : "amber"}>{diagnostics.serviceNow.configurationValid && diagnostics.synchronization.configurationValid ? "Valid" : "Needs attention"}</Badge>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">Deployment</span><p className="mt-0.5 font-semibold text-slate-700">{diagnostics.deployment.gitBranch || "-"} · {diagnostics.deployment.commitSha || "-"}</p></div>
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">ServiceNow enabled</span><p className="mt-1"><SafeBooleanBadge value={diagnostics.serviceNow.enabledNormalized} /></p></div>
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">Authentication mode</span><p className="mt-0.5 font-semibold text-slate-700">{diagnostics.serviceNow.authModeNormalized || "Invalid"}</p></div>
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">Username present</span><p className="mt-1"><SafeBooleanBadge value={diagnostics.serviceNow.usernamePresent && diagnostics.serviceNow.usernameNonEmptyAfterTrim} /></p></div>
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">Password present</span><p className="mt-1"><SafeBooleanBadge value={diagnostics.serviceNow.passwordPresent && diagnostics.serviceNow.passwordNonEmpty} /></p></div>
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">Instance URL valid</span><p className="mt-1"><SafeBooleanBadge value={diagnostics.serviceNow.instanceUrlValid} /></p></div>
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">Configuration valid</span><p className="mt-1"><SafeBooleanBadge value={diagnostics.serviceNow.configurationValid} /></p></div>
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">Sync enabled</span><p className="mt-1"><SafeBooleanBadge value={diagnostics.synchronization.enabledNormalized} /></p></div>
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">Sync configuration valid</span><p className="mt-1"><SafeBooleanBadge value={diagnostics.synchronization.configurationValid} /></p></div>
        </div>
        {[...diagnostics.serviceNow.validationIssues, ...diagnostics.synchronization.validationIssues].length > 0 && <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50/80 p-2 text-amber-900">
          <p className="font-semibold">Validation issues</p>
          <ul className="mt-1 space-y-1">{[...diagnostics.serviceNow.validationIssues, ...diagnostics.synchronization.validationIssues].map((issue, index) => <li key={`${issue.path}-${issue.code}-${index}`}><span className="font-semibold">{issue.path}</span>: {issue.message}</li>)}</ul>
        </div>}
      </div>}

      <div className="rounded-xl border border-sky-100/80 bg-sky-50/35 p-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div><p className="text-[11px] font-semibold text-[#173b57]">Incident synchronization</p><p className="text-[10px] text-slate-400">Bounded, idempotent, and protected by a database lock.</p></div>
          <Badge tone={syncEnabled ? "emerald" : "slate"}>{syncEnabled ? "Enabled" : "Disabled"}</Badge>
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="outline" size="sm" disabled={!syncEnabled || !!busy} onClick={() => runSync("initial", true)}>{busy === "sync" ? <Loader2 size={13} className="animate-spin" /> : <SearchCheck size={13} />}Dry Run Initial Sync</Button>
          <Button variant="outline" size="sm" disabled={!syncEnabled || !!busy} onClick={() => setConfirmMode("initial")}><Play size={13} />Run Initial Sync</Button>
          <Button size="sm" disabled={!syncEnabled || !!busy} onClick={() => setConfirmMode("incremental")}><Play size={13} />Run Incremental Sync</Button>
          <Button variant="ghost" size="sm" disabled={!enabled || !!busy} onClick={() => refreshSyncStatus()}>{busy === "refresh" ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}Refresh Sync Status</Button>
        </div>
        <div className="mt-3 grid gap-2 text-[10px] sm:grid-cols-4">
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">Latest run</span><p className="mt-0.5"><Badge tone={sync ? syncPresentation.tone : "slate"}>{sync ? syncPresentation.label : "No run"}</Badge>{sync?.dryRun ? <span className="ml-1.5 text-slate-500">dry run</span> : null}</p></div>
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">Mode</span><p className="font-semibold capitalize text-slate-700">{sync?.mode || "-"}</p></div>
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">Results</span><p className="font-semibold text-slate-700">{sync?.fetched ?? 0} fetched · {sync?.created ?? 0} new · {sync?.updated ?? 0} updated</p></div>
          <div className="rounded-lg border border-sky-100 bg-white/60 p-2"><span className="text-slate-400">Watermark</span><p className="truncate font-semibold text-slate-700" title={sync?.watermarkTo || sync?.currentWatermark}>{displayTimestamp(sync?.watermarkTo || sync?.currentWatermark)}</p></div>
        </div>
        {sync && <p className="mt-2 text-[10px] text-slate-400">Unchanged {sync.unchanged ?? 0} · stale {sync.stale ?? 0} · failed {sync.failed ?? 0} · last success {displayTimestamp(sync.lastSuccess)}{sync.safeErrorCategory ? ` · ${sync.safeErrorCategory}` : ""}{sync.auditWarning ? " · secondary audit warning" : ""}</p>}
      </div>

      <div className="overflow-hidden rounded-xl border border-sky-100/80">
        <div className="flex items-center justify-between bg-sky-50/50 px-3 py-2"><p className="text-[11px] font-semibold text-[#173b57]">Diagnostic sample</p><span className="text-[10px] text-slate-400">{incidents.length} results · never persisted</span></div>
        {incidents.length ? <div className="max-h-80 divide-y divide-sky-100/70 overflow-y-auto">{incidents.map((incident) => <div key={incident.number} className="space-y-1 px-3 py-3 text-[11px]">
          <div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-sky-700">{incident.number}</span>{incident.state && <Badge tone="blue">{incident.state}</Badge>}{incident.priority && <Badge tone="amber">Priority {incident.priority}</Badge>}</div>
          <p className="font-medium text-slate-700">{incident.title}</p>
          <p className="text-[10px] text-slate-400">Opened {displayTimestamp(incident.openedAt)}{incident.assignmentGroupReference ? ` · ${incident.assignmentGroupReference}` : ""}</p>
        </div>)}</div> : <div className="px-3 py-8 text-center text-[11px] text-slate-400">No diagnostic records loaded. This action reads ServiceNow only.</div>}
      </div>
      <Dialog open={Boolean(confirmMode)} onOpenChange={(open) => { if (!open) setConfirmMode(undefined); }}>
        <DialogContent title={`Run ${confirmMode || ""} ServiceNow sync?`} description="This will update ServiceNow-owned ticket fields. SUPPER effort, billing, logs, and confirmed customer mapping are preserved.">
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmMode(undefined)}>Cancel</Button>
            <Button disabled={!confirmMode || !!busy} onClick={() => confirmMode && runSync(confirmMode, false)}><Play size={14} />Confirm sync</Button>
          </div>
        </DialogContent>
      </Dialog>
    </CardContent>
  </Card>;
}
