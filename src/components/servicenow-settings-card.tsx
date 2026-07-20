"use client";

import { CheckCircle2, CloudCog, Loader2, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import type { ServiceNowConfigSummary } from "@/lib/integrations/servicenow/config";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

type SampleIncident = {
  number: string;
  title: string;
  state?: string;
  priority?: string;
  openedAt?: string;
  assignmentGroupReference?: string;
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

export function ServiceNowSettingsCard({ config }: { config: ServiceNowConfigSummary }) {
  const [busy, setBusy] = useState<"test" | "load" | "">("");
  const [connection, setConnection] = useState<"idle" | "connected" | "failed">("idle");
  const [testedAt, setTestedAt] = useState<string>();
  const [lastErrorCategory, setLastErrorCategory] = useState<string>();
  const [incidents, setIncidents] = useState<SampleIncident[]>([]);
  const enabled = config.enabled && config.configured;

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

  return <Card>
    <CardHeader>
      <div className="flex items-center gap-2"><CloudCog size={17} className="text-sky-600" /><CardTitle>ServiceNow read-only diagnostics</CardTitle></div>
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
      </div>

      <div className="overflow-hidden rounded-xl border border-sky-100/80">
        <div className="flex items-center justify-between bg-sky-50/50 px-3 py-2"><p className="text-[11px] font-semibold text-[#173b57]">Diagnostic sample</p><span className="text-[10px] text-slate-400">{incidents.length} results · never persisted</span></div>
        {incidents.length ? <div className="max-h-80 divide-y divide-sky-100/70 overflow-y-auto">{incidents.map((incident) => <div key={incident.number} className="space-y-1 px-3 py-3 text-[11px]">
          <div className="flex flex-wrap items-center gap-2"><span className="font-semibold text-sky-700">{incident.number}</span>{incident.state && <Badge tone="blue">{incident.state}</Badge>}{incident.priority && <Badge tone="amber">Priority {incident.priority}</Badge>}</div>
          <p className="font-medium text-slate-700">{incident.title}</p>
          <p className="text-[10px] text-slate-400">Opened {displayTimestamp(incident.openedAt)}{incident.assignmentGroupReference ? ` · ${incident.assignmentGroupReference}` : ""}</p>
        </div>)}</div> : <div className="px-3 py-8 text-center text-[11px] text-slate-400">No diagnostic records loaded. This action reads ServiceNow only.</div>}
      </div>
    </CardContent>
  </Card>;
}
