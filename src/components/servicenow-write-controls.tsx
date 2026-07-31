"use client";

import {
  Activity,
  CheckCircle2,
  Clock3,
  Eye,
  Loader2,
  Play,
  RefreshCw,
  RotateCcw,
  Send,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import type {
  ServiceNowWriteCommandSummary,
  ServiceNowWriteCommandType,
  ServiceNowWriteConfirmation,
  ServiceNowManualOperationIdentity,
  ServiceNowWriteOperationsSummary,
  ServiceNowWriteReconciliationAction,
  ServiceNowWriteStatus,
} from "@/lib/integrations/servicenow/write/types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent } from "./ui/dialog";
import { Input, Label, Select, Textarea } from "./ui/input";
import { PaginationControls } from "./ui/pagination-controls";

type PageResult = {
  items: ServiceNowWriteCommandSummary[];
  total: number;
  page: number;
  limit: number;
};

const commandTypes: ServiceNowWriteCommandType[] = [
  "create_incident",
  "update_incident",
  "add_comment",
  "add_work_note",
];
const statuses: ServiceNowWriteStatus[] = [
  "pending",
  "validated",
  "dry_run_ready",
  "executing",
  "succeeded",
  "failed",
  "retry_scheduled",
  "reconciliation_required",
  "cancelled",
];

function timestamp(value?: string) {
  if (!value) return "-";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("en-GB", { hour12: false });
}

function statusTone(status?: string): "emerald" | "amber" | "rose" | "blue" | "slate" {
  if (status === "succeeded" || status === "dry_run_ready") return "emerald";
  if (status === "retry_scheduled") return "amber";
  if (status === "failed" || status === "reconciliation_required" || status === "uncertain") return "rose";
  if (status === "executing" || status === "validated") return "blue";
  return "slate";
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = body && typeof body === "object" && typeof (body as Record<string, unknown>).error === "string"
      ? (body as Record<string, unknown>).error as string
      : "Request failed";
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

function payloadFor(commandType: ServiceNowWriteCommandType, fields: Record<string, string>) {
  const defined = (values: Record<string, string>) => Object.fromEntries(
    Object.entries(values).filter(([, value]) => value.trim()),
  );
  if (commandType === "create_incident") {
    return defined({
      shortDescription: fields.shortDescription,
      description: fields.description,
      callerId: fields.callerId,
      category: fields.category,
      subcategory: fields.subcategory,
      impact: fields.impact,
      urgency: fields.urgency,
      assignmentGroup: fields.assignmentGroup,
      contactChannel: fields.contactChannel,
      customer: fields.customer,
      projectCode: fields.projectCode,
      supperTicketNo: fields.supperTicketNo,
    });
  }
  if (commandType === "update_incident") {
    return defined({
      sysId: fields.sysId,
      number: fields.number,
      shortDescription: fields.shortDescription,
      description: fields.description,
      state: fields.state,
      impact: fields.impact,
      urgency: fields.urgency,
      assignmentGroup: fields.assignmentGroup,
      customer: fields.customer,
      projectCode: fields.projectCode,
    });
  }
  return defined({ sysId: fields.sysId, number: fields.number, text: fields.text });
}

const emptyFields = {
  sysId: "",
  number: "",
  shortDescription: "",
  description: "",
  callerId: "",
  category: "",
  subcategory: "",
  impact: "",
  urgency: "",
  state: "",
  assignmentGroup: "",
  contactChannel: "",
  customer: "",
  projectCode: "",
  supperTicketNo: "",
  text: "",
};

export function ServiceNowWriteControls() {
  const composerId = useId();
  const [busy, setBusy] = useState("");
  const [summary, setSummary] = useState<ServiceNowWriteOperationsSummary>();
  const [commands, setCommands] = useState<PageResult>({ items: [], total: 0, page: 1, limit: 25 });
  const [statusFilter, setStatusFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [commandType, setCommandType] = useState<ServiceNowWriteCommandType>("create_incident");
  const [sourceEntityReference, setSourceEntityReference] = useState(`manual:${composerId}`);
  const [manualOperation, setManualOperation] = useState<ServiceNowManualOperationIdentity>();
  const [fields, setFields] = useState<Record<string, string>>(emptyFields);
  const [selected, setSelected] = useState<ServiceNowWriteCommandSummary>();
  const [detailOpen, setDetailOpen] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    command: ServiceNowWriteCommandSummary;
    action: "execute" | "retry" | "recover_stuck_attempt" | ServiceNowWriteReconciliationAction;
  }>();
  const [verifiedTargetSysId, setVerifiedTargetSysId] = useState("");
  const [verifiedTargetNumber, setVerifiedTargetNumber] = useState("");
  const [verificationNote, setVerificationNote] = useState("");
  const [verificationAcknowledged, setVerificationAcknowledged] = useState(false);
  const [duplicateJournalRiskAcknowledged, setDuplicateJournalRiskAcknowledged] = useState(false);
  const [mutationCandidateRiskAcknowledged, setMutationCandidateRiskAcknowledged] = useState(false);

  const loadSummary = useCallback(async () => {
    setSummary(await api<ServiceNowWriteOperationsSummary>("/api/integrations/servicenow/write/operations"));
  }, []);

  const loadCommands = useCallback(async (page = 1) => {
    const query = new URLSearchParams({ page: String(page), limit: "25" });
    if (statusFilter) query.set("status", statusFilter);
    if (typeFilter) query.set("commandType", typeFilter);
    if (dateFrom) query.set("dateFrom", dateFrom);
    if (dateTo) query.set("dateTo", dateTo);
    setCommands(await api<PageResult>(`/api/integrations/servicenow/write/commands?${query}`));
  }, [dateFrom, dateTo, statusFilter, typeFilter]);

  useEffect(() => {
    let active = true;
    Promise.all([
      api<ServiceNowWriteOperationsSummary>("/api/integrations/servicenow/write/operations"),
      api<PageResult>("/api/integrations/servicenow/write/commands?page=1&limit=25"),
    ]).then(([nextSummary, nextCommands]) => {
      if (!active) return;
      setSummary(nextSummary);
      setCommands(nextCommands);
    }).catch((error) => toast.error(error instanceof Error ? error.message : "Could not load write controls"));
    return () => { active = false; };
  }, []);

  function setField(name: string, value: string) {
    setFields((current) => ({ ...current, [name]: value }));
  }

  async function refresh() {
    setBusy("refresh");
    try {
      await Promise.all([loadSummary(), loadCommands(commands.page)]);
      toast.success("Write controls refreshed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not refresh write controls");
    } finally {
      setBusy("");
    }
  }

  async function createValidatedCommand() {
    setBusy("create");
    try {
      const operation = manualOperation || await api<ServiceNowManualOperationIdentity>(
        "/api/integrations/servicenow/write/manual-operation",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            commandType,
            sourceType: "manual",
            sourceEntityReference: sourceEntityReference || undefined,
          }),
        },
      );
      if (!manualOperation) setManualOperation(operation);
      const command = await api<ServiceNowWriteCommandSummary>("/api/integrations/servicenow/write/commands", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          commandType,
          sourceType: "manual",
          sourceEntityReference: sourceEntityReference || undefined,
          manualOperationToken: operation.operationToken,
          payload: payloadFor(commandType, fields),
        }),
      });
      setSelected(command);
      setManualOperation(undefined);
      toast.success(command.status === "validated" ? "Validated command created" : "Existing idempotent command loaded");
      await Promise.all([loadSummary(), loadCommands(1)]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not create command");
    } finally {
      setBusy("");
    }
  }

  async function openCommand(commandId: string) {
    setBusy("detail");
    try {
      setSelected(await api<ServiceNowWriteCommandSummary>(
        `/api/integrations/servicenow/write/commands/${encodeURIComponent(commandId)}`,
      ));
      setDetailOpen(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load command");
    } finally {
      setBusy("");
    }
  }

  async function confirmedAction(
    command: ServiceNowWriteCommandSummary,
    action: "execute" | "retry" | "recover_stuck_attempt" | ServiceNowWriteReconciliationAction,
  ) {
    const confirmation = await api<ServiceNowWriteConfirmation>(
      `/api/integrations/servicenow/write/commands/${encodeURIComponent(command.id)}/confirmation`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          expectedVersion: command.version,
          expectedNormalizedPayloadHash: command.normalizedPayloadHash,
          ...(command.mutationCandidate
            ? { mutationCandidateEventId: command.mutationCandidate.id }
            : {}),
        }),
      },
    );
    const reconciliation = action.startsWith("reconcile_") || action.startsWith("mark_");
    const endpoint = reconciliation
      ? "reconcile"
      : action === "recover_stuck_attempt"
        ? "recover"
        : action;
    return api<ServiceNowWriteCommandSummary>(
      `/api/integrations/servicenow/write/commands/${encodeURIComponent(command.id)}/${endpoint}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          confirmed: true,
          expectedVersion: confirmation.expectedVersion,
          expectedNormalizedPayloadHash: confirmation.expectedNormalizedPayloadHash,
          confirmationNonce: confirmation.confirmationNonce,
          ...(confirmation.mutationCandidateEventId
            ? { mutationCandidateEventId: confirmation.mutationCandidateEventId }
            : {}),
          ...(reconciliation ? {
            action,
            ...(action === "mark_succeeded_after_verification" ? {
              verifiedTargetSysId,
              verifiedTargetNumber,
              verificationAcknowledged,
              verificationNote,
            } : {}),
            ...(action === "mark_not_applied_after_verification" ? {
              verificationAcknowledged,
              verificationNote,
              ...(["add_comment", "add_work_note"].includes(command.commandType)
                ? { duplicateJournalRiskAcknowledged }
                : command.commandType === "create_incident" && command.mutationCandidate
                  ? { mutationCandidateRiskAcknowledged }
                  : {}),
            } : {}),
          } : {}),
        }),
      },
    );
  }

  async function commandAction(
    command: ServiceNowWriteCommandSummary,
    action: "dry-run" | "execute" | "retry" | "recover_stuck_attempt" | ServiceNowWriteReconciliationAction,
  ) {
    setBusy(action);
    setPendingAction(undefined);
    try {
      const updated = action === "dry-run"
        ? await api<ServiceNowWriteCommandSummary>(
          `/api/integrations/servicenow/write/commands/${encodeURIComponent(command.id)}/dry-run`,
          { method: "POST" },
        )
        : await confirmedAction(command, action);
      setSelected(updated);
      setVerificationAcknowledged(false);
      setDuplicateJournalRiskAcknowledged(false);
      setMutationCandidateRiskAcknowledged(false);
      setVerificationNote("");
      if (updated.status === "succeeded") toast.success("ServiceNow write succeeded");
      else if (updated.status === "dry_run_ready") toast.success("Dry run validated without a provider write");
      else if (updated.status === "retry_scheduled") toast.warning("Provider attempt failed and a bounded retry is available");
      else if (updated.status === "reconciliation_required") toast.warning("Mutation outcome requires administrator reconciliation");
      else toast.error(updated.errorMessage || "ServiceNow write failed");
      if (updated.auditWarning) toast.warning("Write state is safe, but the secondary audit needs attention");
      await Promise.all([loadSummary(), loadCommands(commands.page)]);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Command action failed");
    } finally {
      setBusy("");
    }
  }

  async function testReadiness() {
    setBusy("readiness");
    try {
      const readiness = await api<ServiceNowWriteOperationsSummary["readiness"]>(
        "/api/integrations/servicenow/write/readiness",
        { method: "POST" },
      );
      setSummary((current) => current ? { ...current, readiness } : current);
      toast.success("ServiceNow table readiness test passed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Write readiness test failed");
    } finally {
      setBusy("");
    }
  }

  const updateTarget = commandType !== "create_incident";
  const journal = commandType === "add_comment" || commandType === "add_work_note";
  const readinessLabel = !summary?.readiness.configured
    ? "Configuration invalid"
    : summary.readiness.connectionTestExpired
      ? "Connection test expired"
      : summary.readiness.connectionTested
        ? "Connection tested"
        : "Connection untested";

  function openConfirmedAction(
    command: ServiceNowWriteCommandSummary,
    action: "execute" | "retry" | "recover_stuck_attempt" | ServiceNowWriteReconciliationAction,
  ) {
    setVerifiedTargetSysId(command.mutationCandidate?.sysId || command.targetSysId || "");
    setVerifiedTargetNumber(command.mutationCandidate?.number || command.targetNumber || "");
    setVerificationNote("");
    setVerificationAcknowledged(false);
    setDuplicateJournalRiskAcknowledged(false);
    setMutationCandidateRiskAcknowledged(false);
    setPendingAction({ command, action });
  }

  return <div className="space-y-4">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <Stat label="Live write" value={summary?.readiness.liveWriteReady ? "Ready" : "Blocked"} detail={summary?.readiness.safeErrorMessage || summary?.readiness.hostname || "Loading"} />
      <Stat label="Auth mode" value={summary?.readiness.authMode || "-"} detail="Credentials stay server-side" />
      <Stat label="Incident table" value={summary?.readiness.incidentTable || "-"} detail={summary?.readiness.relationalStorage ? "Relational ledger" : "Wrong backend"} />
      <Stat label="Succeeded" value={summary?.countsByStatus.succeeded ?? 0} detail={`${summary?.countsByStatus.retry_scheduled ?? 0} retry scheduled`} />
      <Stat label="Latest command" value={summary?.latestCommand?.status || "None"} detail={timestamp(summary?.latestCommand?.updatedAt)} />
    </div>

    <Card>
      <CardHeader>
        <div className="flex items-center gap-2"><ShieldCheck size={17} className="text-sky-600" /><CardTitle>Controlled execution gate</CardTitle></div>
        <div className="flex items-center gap-2">
          <Badge tone={summary?.readiness.liveWriteReady ? "emerald" : "amber"}>{summary?.readiness.liveWriteReady ? "Live mutation ready" : "Live mutation blocked"}</Badge>
          <Badge tone={summary?.readiness.connectionTested ? "emerald" : "amber"}>{readinessLabel}</Badge>
          {!summary?.readiness.liveWriteEnabled && <Badge tone="slate">Live switch disabled</Badge>}
          <Button variant="outline" size="sm" onClick={testReadiness} disabled={!!busy || !summary?.readiness.connectionTestable}>
            {busy === "readiness" ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}Test readiness
          </Button>
          <Button variant="outline" size="sm" onClick={refresh} disabled={!!busy}>
            {busy === "refresh" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}Refresh
          </Button>
        </div>
      </CardHeader>
      <CardContent className="text-[11px] text-slate-500">
        Dry-run records validation and the final mapped field set without sending a provider request. Live execution requires
        <code className="mx-1 rounded bg-slate-100 px-1.5 py-0.5 text-[10px] dark:bg-slate-800">SERVICENOW_WRITE_ENABLED=true</code>
        and an explicit confirmation.
      </CardContent>
    </Card>

    <div className="grid gap-4 xl:grid-cols-[1.05fr_.95fr]">
      <Card>
        <CardHeader><div className="flex items-center gap-2"><Send size={17} className="text-sky-600" /><CardTitle>Command composer</CardTitle></div><Badge tone="blue">Manual only</Badge></CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div><Label required>Command type</Label><Select value={commandType} onChange={(event) => { setCommandType(event.target.value as ServiceNowWriteCommandType); setSelected(undefined); setManualOperation(undefined); }}>
              {commandTypes.map((type) => <option key={type} value={type}>{type.replaceAll("_", " ")}</option>)}
            </Select></div>
            <div><Label>Optional admin source context</Label><Input value={sourceEntityReference} onChange={(event) => { setSourceEntityReference(event.target.value); setManualOperation(undefined); }} placeholder="Manual context only; operation ID is server-generated" /></div>
          </div>

          {updateTarget && <div className="grid gap-3 md:grid-cols-2">
            <div><Label>ServiceNow sys_id</Label><Input value={fields.sysId} onChange={(event) => { setField("sysId", event.target.value); if (event.target.value) setField("number", ""); }} placeholder="Lowercase 32-character sys_id" /></div>
            <div><Label>ServiceNow number</Label><Input value={fields.number} onChange={(event) => { setField("number", event.target.value); if (event.target.value) setField("sysId", ""); }} placeholder="Choose this only when sys_id is empty" /></div>
          </div>}

          {journal ? <div><Label required>{commandType === "add_comment" ? "Customer comment" : "Internal work note"}</Label><Textarea className="min-h-32" value={fields.text} onChange={(event) => setField("text", event.target.value)} /></div> : <>
            <div><Label required={commandType === "create_incident"}>Short description</Label><Input value={fields.shortDescription} onChange={(event) => setField("shortDescription", event.target.value)} /></div>
            <div><Label required={commandType === "create_incident"}>Description</Label><Textarea className="min-h-28" value={fields.description} onChange={(event) => setField("description", event.target.value)} /></div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {commandType === "create_incident" && <div><Label>Caller ID</Label><Input value={fields.callerId} onChange={(event) => setField("callerId", event.target.value)} /></div>}
              {commandType === "create_incident" && <div><Label>Category</Label><Input value={fields.category} onChange={(event) => setField("category", event.target.value)} /></div>}
              {commandType === "create_incident" && <div><Label>Subcategory</Label><Input value={fields.subcategory} onChange={(event) => setField("subcategory", event.target.value)} /></div>}
              {commandType === "update_incident" && <div><Label>State</Label><Select value={fields.state} onChange={(event) => setField("state", event.target.value)}><option value="">No change</option>{["1", "2", "3", "6", "7", "8"].map((value) => <option key={value}>{value}</option>)}</Select></div>}
              <div><Label>Impact</Label><Select value={fields.impact} onChange={(event) => setField("impact", event.target.value)}><option value="">Not set</option>{["1", "2", "3"].map((value) => <option key={value}>{value}</option>)}</Select></div>
              <div><Label>Urgency</Label><Select value={fields.urgency} onChange={(event) => setField("urgency", event.target.value)}><option value="">Not set</option>{["1", "2", "3"].map((value) => <option key={value}>{value}</option>)}</Select></div>
              <div><Label>Assignment group</Label><Input value={fields.assignmentGroup} onChange={(event) => setField("assignmentGroup", event.target.value)} /></div>
              <div><Label>Customer</Label><Input value={fields.customer} onChange={(event) => setField("customer", event.target.value)} /></div>
              <div><Label>Project code</Label><Input value={fields.projectCode} onChange={(event) => setField("projectCode", event.target.value)} /></div>
              {commandType === "create_incident" && <div><Label>Contact channel</Label><Input value={fields.contactChannel} onChange={(event) => setField("contactChannel", event.target.value)} /></div>}
              {commandType === "create_incident" && <div><Label>SUPPER ticket no.</Label><Input value={fields.supperTicketNo} onChange={(event) => setField("supperTicketNo", event.target.value)} /></div>}
            </div>
          </>}

          <div className="flex flex-wrap justify-end gap-2">
            {manualOperation && <Button type="button" variant="outline" onClick={() => setManualOperation(undefined)} disabled={!!busy}>
              Start a new operation
            </Button>}
            <Button onClick={createValidatedCommand} disabled={!!busy}>
              {busy === "create" ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle2 size={14} />}Validate and create command
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><div className="flex items-center gap-2"><Eye size={17} className="text-sky-600" /><CardTitle>Safe mapping preview</CardTitle></div>{selected && <Badge tone={statusTone(selected.status)}>{selected.status}</Badge>}</CardHeader>
        <CardContent className="space-y-4">
          {!selected?.normalizedPreview ? <div className="rounded-xl border border-dashed border-sky-200 p-10 text-center text-[11px] text-slate-400 dark:border-slate-700">Validate a command to preview mapped field names. Long text values are never echoed here.</div> : <>
            <div className="grid gap-2 text-[11px] sm:grid-cols-2">
              <div className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><span className="text-slate-400">Command</span><p className="mt-1 font-semibold">{selected.commandType}</p></div>
              <div className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><span className="text-slate-400">Target</span><p className="mt-1 truncate font-semibold">{selected.targetSysId || selected.targetNumber || "New Incident"}</p></div>
            </div>
            <div className="space-y-1">
              {selected.normalizedPreview.fields.map((field) => <div key={field.name} className="flex items-center justify-between rounded-lg border border-sky-100/80 px-3 py-2 text-[11px] dark:border-slate-700">
                <span className="font-mono text-sky-700 dark:text-sky-300">{field.name}</span>
                <span className="text-slate-400">{field.value || `${field.length} characters`} · {field.kind}</span>
              </div>)}
            </div>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => commandAction(selected, "dry-run")} disabled={!!busy || !["validated", "dry_run_ready"].includes(selected.status)}>
                {busy === "dry-run" ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}Dry run
              </Button>
              <Button onClick={() => openConfirmedAction(selected, "execute")} disabled={!!busy || !summary?.readiness.liveWriteReady || !["validated", "dry_run_ready"].includes(selected.status)}>
                <Play size={14} />Execute live
              </Button>
              {selected.status === "retry_scheduled" && selected.retryAllowed && summary?.readiness.liveWriteReady && <Button variant="outline" onClick={() => openConfirmedAction(selected, "retry")} disabled={!!busy || selected.attemptCount >= selected.maxAttempts}>
                {busy === "retry" ? <Loader2 size={14} className="animate-spin" /> : <RotateCcw size={14} />}Manual retry
              </Button>}
            </div>
          </>}
        </CardContent>
      </Card>
    </div>

    <Card>
      <CardHeader><div className="flex items-center gap-2"><Clock3 size={17} className="text-sky-600" /><CardTitle>Command queue and history</CardTitle></div><span className="text-[10px] text-slate-400">{commands.total} commands</span></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[180px_200px_160px_160px_auto]">
          <Select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="">All statuses</option>{statuses.map((status) => <option key={status}>{status}</option>)}</Select>
          <Select value={typeFilter} onChange={(event) => setTypeFilter(event.target.value)}><option value="">All command types</option>{commandTypes.map((type) => <option key={type}>{type}</option>)}</Select>
          <Input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} aria-label="Date from" />
          <Input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} aria-label="Date to" />
          <Button variant="outline" onClick={() => loadCommands(1)} disabled={!!busy}>Apply filters</Button>
        </div>
        <div className="space-y-2">
          {commands.items.map((command) => <button key={command.id} type="button" onClick={() => openCommand(command.id)} className="grid w-full gap-2 rounded-xl border border-sky-100/80 bg-white/45 p-3 text-left text-[11px] transition hover:border-sky-300 hover:bg-sky-50/50 dark:border-slate-700 dark:bg-slate-900/45 md:grid-cols-[1.3fr_1fr_1fr_130px_auto] md:items-center">
            <div><p className="font-semibold text-[#173b57] dark:text-slate-100">{command.commandType.replaceAll("_", " ")}</p><p className="mt-1 truncate text-[10px] text-slate-400">{command.id}</p></div>
            <div><span className="text-slate-400">Operation</span><p className="mt-1 truncate">{command.operationReference}</p></div>
            <div><span className="text-slate-400">Target</span><p className="mt-1 truncate">{command.targetNumber || command.targetSysId || "New Incident"}</p></div>
            <div><Badge tone={statusTone(command.status)}>{command.status}</Badge><p className="mt-1 text-[10px] text-slate-400">{command.attemptCount}/{command.maxAttempts} live</p></div>
            <div className="text-right text-[10px] text-slate-400">{timestamp(command.updatedAt)}</div>
          </button>)}
          {!commands.items.length && <div className="py-10 text-center text-[11px] text-slate-400">No commands match these filters.</div>}
        </div>
        <PaginationControls total={commands.total} page={commands.page} pageSize={commands.limit} itemLabel="commands" onPageChange={loadCommands} />
      </CardContent>
    </Card>

    <Dialog open={detailOpen && Boolean(selected)} onOpenChange={setDetailOpen}>
      <DialogContent title="ServiceNow write command" description="Safe command state, summaries, and bounded attempt history. Stored raw payloads are not returned." className="max-w-4xl">
        {selected && <div className="space-y-4 text-[11px]">
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><span className="text-slate-400">Status</span><p className="mt-1"><Badge tone={statusTone(selected.status)}>{selected.status}</Badge></p></div>
            <div className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><span className="text-slate-400">Type</span><p className="mt-1 font-semibold">{selected.commandType}</p></div>
            <div className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><span className="text-slate-400">Attempts</span><p className="mt-1 font-semibold">{selected.attemptCount} / {selected.maxAttempts}</p></div>
            <div className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><span className="text-slate-400">Updated</span><p className="mt-1 font-semibold">{timestamp(selected.updatedAt)}</p></div>
          </div>
          {selected.errorCode && <div className="flex gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-700 dark:border-rose-900 dark:bg-rose-950/30"><TriangleAlert size={15} className="shrink-0" /><div><p className="font-semibold">{selected.errorCode}</p><p className="mt-1">{selected.errorMessage}</p></div></div>}
          {selected.status === "reconciliation_required" && <div className="space-y-3 rounded-xl border border-amber-200 bg-amber-50/70 p-4 text-amber-950 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-100">
            <div className="flex items-center gap-2"><TriangleAlert size={15} /><p className="font-semibold">Administrator reconciliation required</p></div>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <div><span className="text-slate-500">Failure phase</span><p className="mt-1 font-semibold">{selected.failurePhase || "-"}</p></div>
              <div><span className="text-slate-500">Delivery</span><p className="mt-1 font-semibold">{selected.deliveryDisposition || "-"}</p></div>
              <div><span className="text-slate-500">Confirmed target</span><p className="mt-1 font-semibold">{selected.targetNumber || selected.targetSysId || "Not confirmed"}</p></div>
              <div><span className="text-slate-500">Read-back</span><p className="mt-1 font-semibold">{selected.reconciliationResult || "Not checked"}</p></div>
            </div>
            {selected.mutationCandidate && <div className="rounded-xl border border-rose-300 bg-rose-50/80 p-3 text-rose-900 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-100">
              <p className="font-semibold">Current unresolved candidate, not a confirmed target</p>
              <p className="mt-1 break-all font-mono text-[10px] opacity-80">{selected.mutationCandidate.id}</p>
              <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
                <div><span className="opacity-70">Attempt</span><p className="mt-1 font-semibold">#{selected.mutationCandidate.attemptNumber}</p></div>
                <div><span className="opacity-70">Incident</span><p className="mt-1 font-semibold">{selected.mutationCandidate.number}</p></div>
                <div><span className="opacity-70">sys_id</span><p className="mt-1 break-all font-mono">{selected.mutationCandidate.sysId}</p></div>
                <div><span className="opacity-70">Mutation HTTP</span><p className="mt-1 font-semibold">{selected.mutationCandidate.httpStatus}</p></div>
                <div><span className="opacity-70">Proof</span><p className="mt-1 font-semibold">{selected.mutationCandidate.proofStatus}</p></div>
              </div>
              <p className="mt-2 text-[10px] opacity-80">Observed {timestamp(selected.mutationCandidate.observedAt)} from the bounded mutation response.</p>
            </div>}
            <p>{selected.reconciliationReason || "The provider mutation may have committed and cannot be retried safely."}</p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="outline" onClick={() => openConfirmedAction(selected, "reconcile_by_read_back")}>Read back safely</Button>
              <Button variant="outline" onClick={() => openConfirmedAction(selected, "mark_not_applied_after_verification")}>Mark not applied</Button>
              <Button onClick={() => openConfirmedAction(selected, "mark_succeeded_after_verification")}>Verify and mark succeeded</Button>
            </div>
          </div>}
          <div className="grid gap-3 lg:grid-cols-2">
            <div><p className="mb-2 font-semibold">Safe request summary</p><pre className="max-h-52 overflow-auto rounded-xl bg-slate-950 p-3 text-[10px] leading-5 text-sky-100">{JSON.stringify(selected.safeRequestSummary, null, 2)}</pre></div>
            <div><p className="mb-2 font-semibold">Safe response summary</p><pre className="max-h-52 overflow-auto rounded-xl bg-slate-950 p-3 text-[10px] leading-5 text-emerald-100">{JSON.stringify(selected.safeResponseSummary, null, 2)}</pre></div>
          </div>
          <div><p className="mb-2 font-semibold">Attempts</p><div className="space-y-2">{selected.attempts?.map((attempt) => <div key={attempt.id} className="rounded-xl border border-sky-100 p-3 dark:border-slate-700">
            <div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><Badge tone={statusTone(attempt.outcome)}>{attempt.outcome}</Badge><span>#{attempt.attemptNumber} · {attempt.executionMode}</span></div><span className="text-slate-400">{timestamp(attempt.startedAt)} → {timestamp(attempt.finishedAt)}</span></div>
            {attempt.safeErrorCode && <p className="mt-2 text-rose-600">{attempt.safeErrorCode}: {attempt.safeErrorMessage}</p>}
            {(attempt.failurePhase || attempt.deliveryDisposition) && <p className="mt-2 text-slate-500">{attempt.failurePhase || "-"} · {attempt.deliveryDisposition || "-"} · retry {attempt.retryAllowed ? "allowed" : "blocked"}</p>}
          </div>)}{!selected.attempts?.length && <p className="text-slate-400">No attempt recorded yet.</p>}</div></div>
          <div><p className="mb-2 font-semibold">Candidate history</p><div className="space-y-2">{selected.mutationCandidateHistory?.map((candidate) => <div key={candidate.id} className="rounded-xl border border-sky-100 bg-sky-50/30 p-3 dark:border-slate-700 dark:bg-slate-900/30">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><Badge tone={candidate.resolutionState === "current_unresolved" ? "rose" : candidate.resolutionState === "confirmed_succeeded" ? "emerald" : "blue"}>{candidate.resolutionState.replaceAll("_", " ")}</Badge><span className="ml-2">Attempt #{candidate.attemptNumber} · {candidate.number}</span></div>
              <span className="text-slate-400">{timestamp(candidate.observedAt)}</span>
            </div>
            <p className="mt-2 break-all font-mono text-[10px] text-slate-500">{candidate.id} · {candidate.sysId}</p>
            <p className="mt-1 text-slate-500">HTTP {candidate.httpStatus} · {candidate.proofStatus}{candidate.reconciliationResult ? ` · ${candidate.reconciliationResult}` : ""}</p>
          </div>)}{!selected.mutationCandidateHistory?.length && <p className="text-slate-400">No mutation candidate observed.</p>}</div></div>
          <div><p className="mb-2 font-semibold">Reconciliation history</p><div className="space-y-2">{selected.reconciliationHistory?.map((event) => <div key={event.id} className="rounded-xl border border-amber-100 bg-amber-50/40 p-3 dark:border-amber-900 dark:bg-amber-950/10">
            <div className="flex flex-wrap items-center justify-between gap-2"><div><Badge tone={event.result === "confirmed_succeeded" ? "emerald" : event.result === "confirmed_not_applied" ? "blue" : "amber"}>{event.result}</Badge><span className="ml-2">{event.action.replaceAll("_", " ")} · {event.evidenceClassification}</span></div><span className="text-slate-400">{timestamp(event.createdAt)}</span></div>
            <p className="mt-2 text-slate-500">Command version {event.commandVersionBefore} → {event.commandVersionAfter}{event.mutationCandidateEventId ? ` · Candidate ${event.mutationCandidateEventId}` : ""}</p>
            {Object.keys(event.safeReadBackSummary).length > 0 && <pre className="mt-2 max-h-32 overflow-auto rounded-lg bg-slate-950 p-2 text-[10px] leading-5 text-amber-100">{JSON.stringify(event.safeReadBackSummary, null, 2)}</pre>}
          </div>)}{!selected.reconciliationHistory?.length && <p className="text-slate-400">No reconciliation decision recorded.</p>}</div></div>
          {Boolean(selected.recoveryHistory?.length) && <div><p className="mb-2 font-semibold">Attempt recovery history</p><div className="space-y-2">{selected.recoveryHistory?.map((event) => <div key={event.id} className="rounded-xl border border-rose-100 bg-rose-50/30 p-3 dark:border-rose-900 dark:bg-rose-950/10">
            <div className="flex flex-wrap items-center justify-between gap-2"><span>Attempt #{event.attemptNumber} recovered without a provider mutation</span><span className="text-slate-400">{timestamp(event.createdAt)}</span></div>
            <p className="mt-1 text-slate-500">Command version {event.commandVersionBefore} → {event.commandVersionAfter}</p>
          </div>)}</div></div>}
          <div className="flex flex-wrap justify-end gap-2">
            {["validated", "dry_run_ready"].includes(selected.status) && <Button variant="outline" onClick={() => commandAction(selected, "dry-run")} disabled={!!busy}><ShieldCheck size={14} />Dry run</Button>}
            {["validated", "dry_run_ready"].includes(selected.status) && <Button onClick={() => { setDetailOpen(false); openConfirmedAction(selected, "execute"); }} disabled={!!busy || !summary?.readiness.liveWriteReady}><Play size={14} />Execute live</Button>}
            {selected.status === "retry_scheduled" && selected.retryAllowed && summary?.readiness.liveWriteReady && <Button onClick={() => openConfirmedAction(selected, "retry")} disabled={!!busy || selected.attemptCount >= selected.maxAttempts}><RotateCcw size={14} />Manual retry</Button>}
            {selected.status === "executing" && <Button variant="outline" onClick={() => openConfirmedAction(selected, "recover_stuck_attempt")} disabled={!!busy}><TriangleAlert size={14} />Recover stuck Attempt</Button>}
          </div>
        </div>}
      </DialogContent>
    </Dialog>

    <Dialog open={Boolean(pendingAction)} onOpenChange={(open) => !open && setPendingAction(undefined)}>
      <DialogContent title="Confirm controlled ServiceNow action" description="A short-lived, one-time server confirmation will be issued for this exact command version.">
        {pendingAction && <div className="space-y-4 text-[11px]">
          <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-amber-800 dark:border-amber-900 dark:bg-amber-950/30">
            <p className="font-semibold">{pendingAction.action.replaceAll("_", " ")}</p>
            <p className="mt-1">Command: {pendingAction.command.commandType.replaceAll("_", " ")}</p>
            <p className="mt-1">Operation: {pendingAction.command.operationReference}</p>
            <p className="mt-1">Target: {pendingAction.command.targetNumber || pendingAction.command.targetSysId || "New ServiceNow Incident"}</p>
            {(pendingAction.action === "mark_succeeded_after_verification"
              || pendingAction.action === "mark_not_applied_after_verification")
              && <p className="mt-2 font-medium">This records a reviewed outcome and never resends the ServiceNow mutation.</p>}
            {pendingAction.action === "recover_stuck_attempt" && <p className="mt-2 font-semibold text-rose-700 dark:text-rose-300">
              This closes the executing Attempt as uncertain, records immutable recovery history, and performs no ServiceNow request. The command will require reconciliation.
            </p>}
            {pendingAction.command.mutationCandidate && <p className="mt-2 break-all font-mono text-[10px]">
              Current candidate event: {pendingAction.command.mutationCandidate.id}
            </p>}
            {pendingAction.action === "mark_not_applied_after_verification"
              && ["add_comment", "add_work_note"].includes(pendingAction.command.commandType)
              && <p className="mt-2 font-semibold text-rose-700 dark:text-rose-300">
                ServiceNow cannot prove that a journal entry is absent. An incorrect decision can create a duplicate comment or work note later. This action never replays the journal automatically and requires explicit independent verification.
              </p>}
            {pendingAction.action === "mark_not_applied_after_verification"
              && pendingAction.command.commandType === "create_incident"
              && pendingAction.command.mutationCandidate
              && <p className="mt-2 font-semibold text-rose-700 dark:text-rose-300">
                ServiceNow already returned candidate {pendingAction.command.mutationCandidate.number} ({pendingAction.command.mutationCandidate.sysId}). Marking it not applied can permit a later retry that creates a duplicate Incident.
              </p>}
          </div>
          {pendingAction.action === "mark_succeeded_after_verification" && <div className="grid gap-3 sm:grid-cols-2">
            <div><Label required>Verified ServiceNow sys_id</Label><Input value={verifiedTargetSysId} readOnly={Boolean(pendingAction.command.mutationCandidate)} onChange={(event) => setVerifiedTargetSysId(event.target.value)} placeholder="Lowercase 32-character sys_id" /></div>
            <div><Label required>Verified Incident number</Label><Input value={verifiedTargetNumber} readOnly={Boolean(pendingAction.command.mutationCandidate)} onChange={(event) => setVerifiedTargetNumber(event.target.value)} placeholder="INC..." /></div>
          </div>}
          {(pendingAction.action === "mark_succeeded_after_verification"
            || pendingAction.action === "mark_not_applied_after_verification") && <>
            <div><Label required>Bounded verification evidence</Label><Textarea value={verificationNote} onChange={(event) => setVerificationNote(event.target.value)} maxLength={500} placeholder="Describe the independent check without copying customer messages or provider responses." /></div>
            <label className="flex items-start gap-2 rounded-xl border border-sky-100 p-3 dark:border-slate-700">
              <input type="checkbox" className="mt-0.5" checked={verificationAcknowledged} onChange={(event) => setVerificationAcknowledged(event.target.checked)} />
              <span>I independently verified this target/outcome. No ServiceNow mutation will be replayed.</span>
            </label>
          </>}
          {pendingAction.action === "mark_not_applied_after_verification"
            && ["add_comment", "add_work_note"].includes(pendingAction.command.commandType)
            && <label className="flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 p-3 text-rose-800 dark:border-rose-900 dark:bg-rose-950/30 dark:text-rose-200">
              <input type="checkbox" className="mt-0.5" checked={duplicateJournalRiskAcknowledged} onChange={(event) => setDuplicateJournalRiskAcknowledged(event.target.checked)} />
              <span>I accept that ServiceNow cannot prove journal absence and a later manual retry may duplicate this comment or work note.</span>
            </label>}
          {pendingAction.action === "mark_not_applied_after_verification"
            && pendingAction.command.commandType === "create_incident"
            && pendingAction.command.mutationCandidate
            && <label className="flex items-start gap-2 rounded-xl border border-rose-300 bg-rose-50 p-3 font-semibold text-rose-900 dark:border-rose-800 dark:bg-rose-950/30 dark:text-rose-100">
              <input type="checkbox" className="mt-0.5" checked={mutationCandidateRiskAcknowledged} onChange={(event) => setMutationCandidateRiskAcknowledged(event.target.checked)} />
              <span>I acknowledge that ServiceNow returned this Incident candidate and that a later retry may create a duplicate.</span>
            </label>}
          <div className="flex justify-end gap-2"><Button variant="outline" onClick={() => setPendingAction(undefined)}>Cancel</Button><Button onClick={() => commandAction(pendingAction.command, pendingAction.action)} disabled={(pendingAction.action === "mark_succeeded_after_verification" && (!verifiedTargetSysId || !verifiedTargetNumber || !verificationNote || !verificationAcknowledged)) || (pendingAction.action === "mark_not_applied_after_verification" && (!verificationNote || !verificationAcknowledged || (["add_comment", "add_work_note"].includes(pendingAction.command.commandType) && !duplicateJournalRiskAcknowledged) || (pendingAction.command.commandType === "create_incident" && Boolean(pendingAction.command.mutationCandidate) && !mutationCandidateRiskAcknowledged)))}><Play size={14} />Confirm action</Button></div>
        </div>}
      </DialogContent>
    </Dialog>
  </div>;
}
