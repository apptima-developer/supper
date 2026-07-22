"use client";

import { Activity, Boxes, Inbox, Loader2, MessageSquareText, Network, RefreshCw, Send, ShieldCheck, UserRoundCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { IntakeOperationsSummary } from "@/lib/intake-core/presentation";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Dialog, DialogContent } from "./ui/dialog";
import { PaginationControls } from "./ui/pagination-controls";

type Tab = "overview" | "channels" | "identities" | "conversations" | "events" | "outbox" | "diagnostics";
type Item = Record<string, unknown>;
type PageResult = { items: Item[]; total: number; page: number; limit: number };
type ConversationDetail = { conversation: Item & { session?: Item | null; ticketLinks?: Item[] }; messages: Item[]; attachments: Item[] };
type DiagnosticResult = { firstAction: string; replayAction: string; duplicateReplayProtected: boolean; conversationId: string; messageCount: number; attachmentMetadataCount: number; sessionStatus: string | null; deliveryCount: number };

const tabs: Array<{ id: Tab; label: string }> = [
  { id: "overview", label: "Overview" }, { id: "channels", label: "Channels" },
  { id: "identities", label: "Identities" }, { id: "conversations", label: "Conversations" },
  { id: "events", label: "Inbound Events" }, { id: "outbox", label: "Outbox" },
  { id: "diagnostics", label: "Diagnostics" },
];

function text(value: unknown, fallback = "-") { return typeof value === "string" && value ? value : fallback; }
function number(value: unknown) { return typeof value === "number" ? value : 0; }
function timestamp(value: unknown) {
  if (typeof value !== "string") return "-";
  const date = new Date(value); return Number.isNaN(date.getTime()) ? "-" : date.toLocaleString("en-GB", { hour12: false });
}
async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(body && typeof body === "object" && typeof (body as Item).error === "string" ? String((body as Item).error) : "Request failed");
  return body as T;
}

function Stat({ label, value, detail }: { label: string; value: number | string; detail?: string }) {
  return <div className="rounded-xl border border-sky-100/80 bg-white/55 p-3 dark:border-slate-700 dark:bg-slate-900/55">
    <p className="text-[10px] font-semibold uppercase tracking-[.12em] text-slate-400">{label}</p>
    <p className="mt-1 text-xl font-semibold text-[#173b57] dark:text-slate-100">{value}</p>
    {detail && <p className="mt-1 text-[10px] text-slate-400">{detail}</p>}
  </div>;
}

function MobileCard({ title, subtitle, fields, onOpen }: { title: string; subtitle?: string; fields: Array<[string, string | number]>; onOpen?: () => void }) {
  return <button type="button" onClick={onOpen} disabled={!onOpen} className="w-full rounded-xl border border-sky-100 bg-white/65 p-3 text-left shadow-sm disabled:cursor-default dark:border-slate-700 dark:bg-slate-900/60">
    <p className="font-semibold text-[#173b57] dark:text-slate-100">{title}</p>{subtitle && <p className="mt-0.5 text-[10px] text-slate-400">{subtitle}</p>}
    <dl className="mt-3 grid grid-cols-2 gap-2">{fields.map(([label, value]) => <div key={label}><dt className="text-[9px] font-semibold uppercase text-slate-400">{label}</dt><dd className="mt-0.5 text-[11px] text-slate-600 dark:text-slate-300">{value}</dd></div>)}</dl>
  </button>;
}

export function IntakeOperations({ diagnosticsAvailable }: { diagnosticsAvailable: boolean }) {
  const [tab, setTab] = useState<Tab>("overview");
  const [summary, setSummary] = useState<IntakeOperationsSummary>();
  const [pages, setPages] = useState<Partial<Record<Tab, PageResult>>>({});
  const [busy, setBusy] = useState("");
  const [detail, setDetail] = useState<ConversationDetail>();
  const [diagnostic, setDiagnostic] = useState<DiagnosticResult>();

  const loadSummary = useCallback(async () => setSummary(await api<IntakeOperationsSummary>("/api/integrations/intake/operations")), []);
  const loadPage = useCallback(async (target: Exclude<Tab, "overview" | "diagnostics">, page = 1) => {
    const result = await api<PageResult>(`/api/integrations/intake/${target}?page=${page}&limit=25`);
    setPages((current) => ({ ...current, [target]: result }));
  }, []);

  useEffect(() => {
    let active = true;
    void api<IntakeOperationsSummary>("/api/integrations/intake/operations")
      .then((result) => { if (active) setSummary(result); })
      .catch((error) => toast.error(error instanceof Error ? error.message : "Could not load intake operations"));
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (tab === "overview" || tab === "diagnostics" || pages[tab]) return;
    let active = true;
    const target = tab;
    void api<PageResult>(`/api/integrations/intake/${target}?page=1&limit=25`)
      .then((result) => { if (active) setPages((currentPages) => ({ ...currentPages, [target]: result })); })
      .catch((error) => toast.error(error instanceof Error ? error.message : "Could not load intake data"));
    return () => { active = false; };
  }, [pages, tab]);

  async function refresh() {
    setBusy("refresh");
    try {
      await loadSummary();
      if (tab !== "overview" && tab !== "diagnostics") await loadPage(tab, pages[tab]?.page || 1);
      toast.success("Unified intake operations refreshed");
    } catch (error) { toast.error(error instanceof Error ? error.message : "Could not refresh intake operations"); }
    finally { setBusy(""); }
  }

  async function openConversation(id: string) {
    setBusy("detail");
    try { setDetail(await api<ConversationDetail>(`/api/integrations/intake/conversations/${encodeURIComponent(id)}`)); }
    catch (error) { toast.error(error instanceof Error ? error.message : "Could not load conversation"); }
    finally { setBusy(""); }
  }

  async function runDiagnostic() {
    setBusy("diagnostic");
    try {
      const result = await api<DiagnosticResult>("/api/integrations/intake/diagnostic-sample", { method: "POST" });
      setDiagnostic(result); toast.success("Diagnostic event accepted and replay protection verified"); await loadSummary();
    } catch (error) { toast.error(error instanceof Error ? error.message : "Diagnostic ingestion failed"); }
    finally { setBusy(""); }
  }

  const current = pages[tab];
  return <div className="space-y-4">
    <Card><CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex items-start gap-3"><div className="rounded-xl bg-sky-50 p-2 text-sky-600 dark:bg-slate-800"><Network size={18} /></div><div><p className="text-sm font-semibold">Unified Intake Core only</p><p className="mt-1 text-[11px] text-slate-500">No live LINE, email, or outbound provider is connected in AI-1.3. No Ticket or ServiceNow record is created.</p></div></div>
      <Button variant="outline" size="sm" onClick={refresh} disabled={!!busy}>{busy === "refresh" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}Refresh</Button>
    </CardContent></Card>
    <div className="flex gap-1 overflow-x-auto rounded-xl border border-sky-100 bg-white/55 p-1 dark:border-slate-700 dark:bg-slate-900/55">{tabs.map((item) => <button type="button" key={item.id} onClick={() => setTab(item.id)} className={`shrink-0 rounded-lg px-3 py-2 text-[11px] font-semibold ${tab === item.id ? "bg-sky-600 text-white shadow-sm" : "text-slate-500 hover:bg-sky-50 dark:hover:bg-slate-800"}`}>{item.label}</button>)}</div>

    {tab === "overview" && <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <Stat label="Channels" value={summary?.channels || 0} detail={`${summary?.enabledChannels || 0} enabled`} />
      <Stat label="Identities" value={(summary?.linkedIdentities || 0) + (summary?.unlinkedIdentities || 0)} detail={`${summary?.linkedIdentities || 0} linked`} />
      <Stat label="Open conversations" value={summary?.openConversations || 0} detail={`${summary?.activeSessions || 0} active sessions`} />
      <Stat label="Events (24h)" value={(summary?.acceptedEvents24h || 0) + (summary?.duplicateEvents24h || 0)} detail={`${summary?.duplicateEvents24h || 0} protected replays`} />
      <Stat label="Pending outbox" value={summary?.pendingOutbox || 0} detail="Intent only, no worker" />
      <Stat label="Retrying" value={summary?.retryingOutbox || 0} /><Stat label="Dead letter" value={summary?.deadLetterOutbox || 0} />
      <Stat label="Latest activity" value={timestamp(summary?.latestActivityAt)} />
    </div>}

    {tab === "channels" && <DataSection title="Integration channels" icon={<Boxes size={16} />} page={current} onPage={(value) => loadPage("channels", value)} columns={["Provider", "Channel", "Environment", "Enabled", "Configuration", "Updated"]} rows={(current?.items || []).map((item) => [text(item.provider), text(item.displayName), text(item.environment), item.enabled === true ? "Yes" : "No", text(item.configurationStatus), timestamp(item.updatedAt)])} mobile={(item) => <MobileCard title={text(item.displayName)} subtitle={text(item.provider)} fields={[["Environment", text(item.environment)], ["Enabled", item.enabled === true ? "Yes" : "No"], ["Configuration", text(item.configurationStatus)], ["Updated", timestamp(item.updatedAt)]]} />} />}
    {tab === "identities" && <DataSection title="External identities" icon={<UserRoundCheck size={16} />} page={current} onPage={(value) => loadPage("identities", value)} columns={["Masked identity", "Provider / Channel", "Status", "Customer / Project", "Conversations", "Last seen"]} rows={(current?.items || []).map((item) => [text(item.maskedExternalIdentity), `${text(item.provider)} / ${text(item.channelName)}`, text(item.linkedStatus), `${text(item.customerName)} / ${text(item.projectCode)}`, number(item.conversationCount), timestamp(item.lastSeenAt)])} mobile={(item) => <MobileCard title={text(item.maskedExternalIdentity)} subtitle={`${text(item.provider)} · ${text(item.channelName)}`} fields={[["Status", text(item.linkedStatus)], ["Customer", text(item.customerName)], ["Project", text(item.projectCode)], ["Conversations", number(item.conversationCount)]]} />} />}
    {tab === "conversations" && <DataSection title="Conversations" icon={<MessageSquareText size={16} />} page={current} onPage={(value) => loadPage("conversations", value)} columns={["Subject", "Provider / Channel", "Identity", "Status", "Messages", "Attachments", "Last activity"]} rows={(current?.items || []).map((item) => [text(item.subject, "(No subject)"), `${text(item.provider)} / ${text(item.channelName)}`, text(item.maskedIdentity), text(item.status), number(item.messageCount), number(item.attachmentCount), timestamp(item.lastActivityAt)])} rowAction={(item) => openConversation(text(item.conversationId))} mobile={(item) => <MobileCard title={text(item.subject, "(No subject)")} subtitle={`${text(item.provider)} · ${text(item.maskedIdentity)}`} onOpen={() => openConversation(text(item.conversationId))} fields={[["Status", text(item.status)], ["Messages", number(item.messageCount)], ["Attachments", number(item.attachmentCount)], ["Last activity", timestamp(item.lastActivityAt)]]} />} />}
    {tab === "events" && <DataSection title="Inbound event ledger" icon={<Inbox size={16} />} page={current} onPage={(value) => loadPage("events", value)} columns={["Event", "Type", "Status", "Redelivery", "Deliveries", "Last seen", "Safe error"]} rows={(current?.items || []).map((item) => [text(item.eventId), text(item.eventType), text(item.status), item.redelivery === true ? "Yes" : "No", number(item.deliveryCount), timestamp(item.lastSeenAt), text(item.safeErrorCode)])} mobile={(item) => <MobileCard title={text(item.eventType)} subtitle={text(item.eventId)} fields={[["Status", text(item.status)], ["Redelivery", item.redelivery === true ? "Yes" : "No"], ["Deliveries", number(item.deliveryCount)], ["Last seen", timestamp(item.lastSeenAt)]]} />} />}
    {tab === "outbox" && <><Card><CardContent className="flex items-start gap-3 p-4"><Send size={18} className="mt-0.5 text-amber-500" /><div><p className="text-sm font-semibold">Durable command intent</p><p className="mt-1 text-[11px] text-slate-500">No worker is active in AI-1.3. Commands are not being sent.</p></div></CardContent></Card><DataSection title="Outbox commands" icon={<Send size={16} />} page={current} onPage={(value) => loadPage("outbox", value)} columns={["Command", "Provider", "Type", "Status", "Attempts", "Available", "Created"]} rows={(current?.items || []).map((item) => [text(item.commandId), text(item.targetProvider), text(item.commandType), text(item.status), `${number(item.attemptCount)} / ${number(item.maxAttempts)}`, timestamp(item.availableAt), timestamp(item.createdAt)])} mobile={(item) => <MobileCard title={text(item.commandType)} subtitle={text(item.targetProvider)} fields={[["Status", text(item.status)], ["Attempts", `${number(item.attemptCount)} / ${number(item.maxAttempts)}`], ["Available", timestamp(item.availableAt)], ["Created", timestamp(item.createdAt)]]} />} /></>}
    {tab === "diagnostics" && <Card><CardHeader><div className="flex items-center gap-2"><ShieldCheck size={17} className="text-sky-600" /><CardTitle>AI-development diagnostic ingestion</CardTitle></div></CardHeader><CardContent className="space-y-4">
      <p className="text-[11px] leading-5 text-slate-500">Creates normalized internal metadata through the same atomic RPC, immediately replays it, and makes no external call.</p>
      <Button onClick={runDiagnostic} disabled={!diagnosticsAvailable || busy === "diagnostic"}>{busy === "diagnostic" ? <Loader2 size={14} className="animate-spin" /> : <Activity size={14} />}Create / Replay Diagnostic Intake</Button>
      {!diagnosticsAvailable && <p className="text-[11px] text-amber-600">Available only on the relational AI-development Preview.</p>}
      {diagnostic && <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"><Stat label="Initial action" value={diagnostic.firstAction} /><Stat label="Immediate replay" value={diagnostic.replayAction} detail={diagnostic.duplicateReplayProtected ? "Duplicate protected" : "Review required"} /><Stat label="Records" value={`${diagnostic.messageCount} message`} detail={`${diagnostic.attachmentMetadataCount} attachment metadata`} /><Stat label="Session" value={diagnostic.sessionStatus || "-"} detail={`${diagnostic.deliveryCount} deliveries`} /></div>}
    </CardContent></Card>}

    <Dialog open={Boolean(detail)} onOpenChange={(open) => !open && setDetail(undefined)}><DialogContent title="Sanitized conversation detail" description="Plain-text previews and safe attachment metadata only." className="max-w-4xl"><div className="max-h-[65vh] space-y-4 overflow-y-auto pr-1 text-[11px]">
      <div className="grid gap-2 sm:grid-cols-3"><Stat label="Status" value={text(detail?.conversation.status)} /><Stat label="Version" value={number(detail?.conversation.version)} /><Stat label="Last activity" value={timestamp(detail?.conversation.lastActivityAt)} /></div>
      <section className="grid gap-2 sm:grid-cols-2"><div className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><p className="font-semibold">Guided intake session</p><p className="mt-1 text-slate-500 dark:text-slate-300">{detail?.conversation.session ? `${text(detail.conversation.session.status)} · version ${number(detail.conversation.session.version)}` : "No session"}</p></div><div className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><p className="font-semibold">Ticket links</p><p className="mt-1 text-slate-500 dark:text-slate-300">{Array.isArray(detail?.conversation.ticketLinks) && detail.conversation.ticketLinks.length ? detail.conversation.ticketLinks.map((link) => `${text(link.ticketId)} (${text(link.relationship)})`).join(", ") : "No Ticket linked"}</p></div></section>
      <section><p className="mb-2 font-semibold">Messages</p><div className="space-y-2">{detail?.messages.map((message) => <div key={text(message.messageId)} className="rounded-xl border border-sky-100 bg-white/65 p-3 dark:border-slate-700 dark:bg-slate-900/60"><div className="flex justify-between gap-3"><Badge tone="blue">{text(message.direction)}</Badge><span className="text-slate-400">{timestamp(message.receivedAt)}</span></div><p className="mt-2 whitespace-pre-wrap leading-5 text-slate-600 dark:text-slate-300">{text(message.textPreview, "No plain-text content")}</p></div>) || <p className="text-slate-400">No messages.</p>}</div></section>
      <section><p className="mb-2 font-semibold">Attachment metadata</p><div className="grid gap-2 sm:grid-cols-2">{detail?.attachments.map((attachment) => <div key={text(attachment.attachmentId)} className="rounded-xl border border-sky-100 p-3 dark:border-slate-700"><p className="font-semibold">{text(attachment.fileName)}</p><p className="mt-1 text-slate-400">{text(attachment.contentType)} · {number(attachment.declaredSize)} bytes</p><p className="mt-1">{text(attachment.storageStatus)} / {text(attachment.scanStatus)}</p></div>) || <p className="text-slate-400">No attachment metadata.</p>}</div></section>
    </div></DialogContent></Dialog>
  </div>;
}

function DataSection({ title, icon, page, columns, rows, mobile, onPage, rowAction }: { title: string; icon: React.ReactNode; page?: PageResult; columns: string[]; rows: Array<Array<string | number>>; mobile: (item: Item) => React.ReactNode; onPage: (page: number) => void; rowAction?: (item: Item) => void }) {
  return <Card><CardHeader><div className="flex items-center gap-2">{icon}<CardTitle>{title}</CardTitle></div><span className="text-[10px] text-slate-400">{page?.total || 0} records</span></CardHeader><CardContent className="p-0">
    {!page ? <div className="p-10 text-center text-slate-400"><Loader2 size={18} className="mx-auto animate-spin" /></div> : page.items.length === 0 ? <div className="p-10 text-center text-[11px] text-slate-400">No records found.</div> : <>
      <div className="hidden overflow-x-auto md:block"><table className="w-full min-w-[760px] text-left text-[10px]"><thead className="bg-sky-50/70 text-slate-500 dark:bg-slate-900"><tr>{columns.map((column) => <th key={column} className="px-3 py-2.5 font-semibold uppercase">{column}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={String(page.items[rowIndex]?.id || page.items[rowIndex]?.conversationId || rowIndex)} onClick={() => rowAction?.(page.items[rowIndex])} className={`border-t border-sky-50 dark:border-slate-800 ${rowAction ? "cursor-pointer hover:bg-sky-50/50 dark:hover:bg-slate-800/50" : ""}`}>{row.map((cell, index) => <td key={`${index}-${cell}`} className="max-w-[260px] truncate px-3 py-3 text-slate-600 dark:text-slate-300">{cell}</td>)}</tr>)}</tbody></table></div>
      <div className="space-y-2 p-3 md:hidden">{page.items.map((item, index) => <div key={String(item.id || item.conversationId || index)}>{mobile(item)}</div>)}</div>
      <div className="border-t border-sky-100 p-3 dark:border-slate-700"><PaginationControls page={page.page} pageSize={page.limit} total={page.total} itemLabel="records" onPageChange={onPage} /></div>
    </>}
  </CardContent></Card>;
}
