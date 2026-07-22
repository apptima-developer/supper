import "server-only";
import { z } from "zod";
import { getDataBackend } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { IntakeCoreError, intakeErrorFromUnknown } from "./errors";
import { plainTextPreview, presentIdentity, operationsSummarySchema } from "./presentation";
import type { IntakeCoreRepository, PageResult } from "./repository";
import {
  acceptInboundEventResultSchema, canonicalTimestampSchema, enqueueOutboxResultSchema,
  identityBindingResultSchema, sessionSummarySchema,
  type AcceptInboundEvent, type AcceptInboundEventResult, type EnqueueOutboxInput,
  type IdentityBindingInput, type ListQuery, type RevokeBindingInput, type SessionTransitionInput,
} from "./schemas";

type JsonRecord = Record<string, unknown>;
type QueryResult<T> = { data: T; error: { message?: string; code?: string } | null; count?: number | null };

const rawRecordSchema = z.record(z.string(), z.unknown());
const rawRecordsSchema = z.array(rawRecordSchema);

function requireRelational() {
  if (getDataBackend() !== "supabase-relational") {
    throw new IntakeCoreError("INTAKE_RELATIONAL_BACKEND_REQUIRED", "Unified intake requires the relational data backend", 503);
  }
}

async function must<T>(label: string, promise: PromiseLike<QueryResult<T>>) {
  const result = await promise;
  if (result.error) {
    const error = Object.assign(new Error(result.error.message || label), { cause: result.error, code: result.error.code });
    throw intakeErrorFromUnknown(error);
  }
  return result;
}

function canonical(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function pageRange(query: ListQuery) {
  const from = (query.page - 1) * query.limit;
  return { from, to: from + query.limit - 1 };
}

function page<T>(items: T[], total: number | null | undefined, query: ListQuery): PageResult<T> {
  return { items, total: total || 0, page: query.page, limit: query.limit };
}

function rpcRow(value: unknown) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return rawRecordSchema.parse(candidate);
}

function presentChannel(row: JsonRecord) {
  return {
    channelId: row.id, provider: row.provider, channelKey: row.channel_key, displayName: row.display_name,
    environment: row.environment, enabled: row.enabled, configurationStatus: row.configuration_status,
    createdAt: canonical(row.created_at), updatedAt: canonical(row.updated_at),
  };
}

export class RelationalIntakeCoreRepository implements IntakeCoreRepository {
  async getOperationsSummary() {
    requireRelational();
    const result = await must("Could not load intake operations summary", supabaseAdmin.rpc("support_get_intake_operations_summary"));
    const row = rpcRow(result.data);
    return operationsSummarySchema.parse({
      channels: row.channels, enabledChannels: row.enabled_channels,
      linkedIdentities: row.linked_identities, unlinkedIdentities: row.unlinked_identities,
      openConversations: row.open_conversations, activeSessions: row.active_sessions,
      acceptedEvents24h: row.accepted_events_24h, duplicateEvents24h: row.duplicate_events_24h,
      failedEvents24h: row.failed_events_24h, pendingOutbox: row.pending_outbox,
      retryingOutbox: row.retrying_outbox, deadLetterOutbox: row.dead_letter_outbox,
      attachmentStatuses: row.attachment_statuses, scanStatuses: row.scan_statuses,
      latestActivityAt: canonical(row.latest_activity_at),
    });
  }

  async listChannels(query: ListQuery) {
    requireRelational();
    const { from, to } = pageRange(query);
    let request = supabaseAdmin.from("integration_channels")
      .select("id,provider,channel_key,display_name,environment,enabled,configuration_status,created_at,updated_at", { count: "exact" });
    if (query.provider) request = request.eq("provider", query.provider);
    if (query.status) request = request.eq("configuration_status", query.status);
    const result = await must("Could not list intake channels", request.order("updated_at", { ascending: false }).order("id").range(from, to));
    const items = rawRecordsSchema.parse(result.data || []).map(presentChannel);
    return page(items, result.count, query);
  }

  async findChannel(id: string) {
    requireRelational();
    const result = await must("Could not find intake channel", supabaseAdmin.from("integration_channels")
      .select("id,provider,channel_key,display_name,environment,enabled,configuration_status,created_at,updated_at").eq("id", id).maybeSingle());
    if (!result.data) return undefined;
    return presentChannel(rawRecordSchema.parse(result.data));
  }

  async listIdentities(query: ListQuery) {
    requireRelational();
    const { from, to } = pageRange(query);
    let request = supabaseAdmin.from("integration_external_identities")
      .select("id,channel_id,external_subject_hash,display_name,status,last_seen_at", { count: "exact" });
    if (query.status) request = request.eq("status", query.status);
    const result = await must("Could not list intake identities", request.order("last_seen_at", { ascending: false }).order("id").range(from, to));
    const rows = rawRecordsSchema.parse(result.data || []);
    const ids = rows.map((row) => String(row.id));
    const channelIds = [...new Set(rows.map((row) => String(row.channel_id)))];
    const [channelsResult, bindingsResult, conversationsResult] = await Promise.all([
      channelIds.length ? must("Could not load identity channels", supabaseAdmin.from("integration_channels").select("id,provider,display_name").in("id", channelIds)) : Promise.resolve({ data: [], error: null }),
      ids.length ? must("Could not load identity bindings", supabaseAdmin.from("integration_identity_bindings").select("identity_id,customer_key,project_code").eq("status", "linked").in("identity_id", ids)) : Promise.resolve({ data: [], error: null }),
      ids.length ? must("Could not load identity conversation counts", supabaseAdmin.from("intake_conversations").select("id,primary_identity_id").in("primary_identity_id", ids)) : Promise.resolve({ data: [], error: null }),
    ]);
    const channels = new Map(rawRecordsSchema.parse(channelsResult.data || []).map((row) => [String(row.id), row]));
    const bindings = new Map(rawRecordsSchema.parse(bindingsResult.data || []).map((row) => [String(row.identity_id), row]));
    const customerKeys = [...new Set([...bindings.values()].map((row) => String(row.customer_key)))];
    const customersResult = customerKeys.length
      ? await must("Could not load bound customers", supabaseAdmin.from("support_customers").select("customer_key,customer_name").in("customer_key", customerKeys))
      : { data: [], error: null };
    const customerNames = new Map(rawRecordsSchema.parse(customersResult.data || []).map((row) => [String(row.customer_key), String(row.customer_name)]));
    const conversationCounts = new Map<string, number>();
    for (const row of rawRecordsSchema.parse(conversationsResult.data || [])) {
      const identityId = String(row.primary_identity_id || "");
      conversationCounts.set(identityId, (conversationCounts.get(identityId) || 0) + 1);
    }
    const items = rows.map((row) => {
      const channel = channels.get(String(row.channel_id));
      const binding = bindings.get(String(row.id));
      return presentIdentity({ ...row, last_seen_at: canonical(row.last_seen_at) }, {
        provider: String(channel?.provider || "unknown"), channelName: String(channel?.display_name || "Unknown channel"),
        customerName: binding ? customerNames.get(String(binding.customer_key)) : undefined,
        projectCode: binding ? String(binding.project_code || "") : "", conversationCount: conversationCounts.get(String(row.id)) || 0,
      });
    });
    return page(items, result.count, query);
  }

  async findIdentity(id: string) {
    requireRelational();
    const identityResult = await must("Could not find intake identity", supabaseAdmin.from("integration_external_identities")
      .select("id,channel_id,external_subject_hash,display_name,status,last_seen_at").eq("id", id).maybeSingle());
    if (!identityResult.data) return undefined;
    const identity = rawRecordSchema.parse(identityResult.data);
    const [channelResult, bindingResult, conversationsResult] = await Promise.all([
      must("Could not load identity channel", supabaseAdmin.from("integration_channels")
        .select("id,provider,display_name").eq("id", String(identity.channel_id)).maybeSingle()),
      must("Could not load identity binding", supabaseAdmin.from("integration_identity_bindings")
        .select("identity_id,customer_key,project_code").eq("identity_id", id).eq("status", "linked").maybeSingle()),
      must("Could not count identity conversations", supabaseAdmin.from("intake_conversations")
        .select("id", { count: "exact", head: true }).eq("primary_identity_id", id)),
    ]);
    const channel = channelResult.data ? rawRecordSchema.parse(channelResult.data) : undefined;
    const binding = bindingResult.data ? rawRecordSchema.parse(bindingResult.data) : undefined;
    let customerName: string | undefined;
    if (binding) {
      const customerResult = await must("Could not load bound customer", supabaseAdmin.from("support_customers")
        .select("customer_name").eq("customer_key", String(binding.customer_key)).maybeSingle());
      if (customerResult.data) customerName = String(rawRecordSchema.parse(customerResult.data).customer_name || "");
    }
    return presentIdentity({ ...identity, last_seen_at: canonical(identity.last_seen_at) }, {
      provider: String(channel?.provider || "unknown"), channelName: String(channel?.display_name || "Unknown channel"),
      customerName, projectCode: String(binding?.project_code || ""), conversationCount: conversationsResult.count || 0,
    });
  }

  async listConversations(query: ListQuery) {
    requireRelational();
    const { from, to } = pageRange(query);
    let request = supabaseAdmin.from("intake_conversations")
      .select("id,channel_id,primary_identity_id,status,subject,last_activity_at", { count: "exact" });
    if (query.status) request = request.eq("status", query.status);
    const result = await must("Could not list intake conversations", request.order("last_activity_at", { ascending: false }).order("id").range(from, to));
    const rows = rawRecordsSchema.parse(result.data || []);
    const conversationIds = rows.map((row) => String(row.id));
    const channelIds = [...new Set(rows.map((row) => String(row.channel_id)))];
    const identityIds = [...new Set(rows.flatMap((row) => row.primary_identity_id ? [String(row.primary_identity_id)] : []))];
    const [channelsResult, identitiesResult, messagesResult, attachmentsResult, sessionsResult, linksResult] = await Promise.all([
      channelIds.length ? must("Could not load conversation channels", supabaseAdmin.from("integration_channels").select("id,provider,display_name").in("id", channelIds)) : Promise.resolve({ data: [], error: null }),
      identityIds.length ? must("Could not load conversation identities", supabaseAdmin.from("integration_external_identities").select("id,external_subject_hash").in("id", identityIds)) : Promise.resolve({ data: [], error: null }),
      conversationIds.length ? must("Could not count conversation messages", supabaseAdmin.from("intake_messages").select("id,conversation_id").in("conversation_id", conversationIds)) : Promise.resolve({ data: [], error: null }),
      conversationIds.length ? must("Could not count conversation attachments", supabaseAdmin.from("intake_attachments").select("id,conversation_id").in("conversation_id", conversationIds)) : Promise.resolve({ data: [], error: null }),
      conversationIds.length ? must("Could not load conversation sessions", supabaseAdmin.from("intake_sessions").select("conversation_id,status,updated_at").in("conversation_id", conversationIds).order("updated_at", { ascending: false })) : Promise.resolve({ data: [], error: null }),
      conversationIds.length ? must("Could not load conversation ticket links", supabaseAdmin.from("intake_ticket_links").select("conversation_id,ticket_id,relationship").in("conversation_id", conversationIds)) : Promise.resolve({ data: [], error: null }),
    ]);
    const channels = new Map(rawRecordsSchema.parse(channelsResult.data || []).map((row) => [String(row.id), row]));
    const identities = new Map(rawRecordsSchema.parse(identitiesResult.data || []).map((row) => [String(row.id), row]));
    const countBy = (data: unknown, key: string) => {
      const counts = new Map<string, number>();
      for (const row of rawRecordsSchema.parse(data || [])) counts.set(String(row[key]), (counts.get(String(row[key])) || 0) + 1);
      return counts;
    };
    const messageCounts = countBy(messagesResult.data, "conversation_id");
    const attachmentCounts = countBy(attachmentsResult.data, "conversation_id");
    const sessions = new Map<string, string>();
    for (const row of rawRecordsSchema.parse(sessionsResult.data || [])) if (!sessions.has(String(row.conversation_id))) sessions.set(String(row.conversation_id), String(row.status));
    const links = new Map<string, Array<{ ticketId: string; relationship: string }>>();
    for (const row of rawRecordsSchema.parse(linksResult.data || [])) {
      const key = String(row.conversation_id); const list = links.get(key) || [];
      list.push({ ticketId: String(row.ticket_id), relationship: String(row.relationship) }); links.set(key, list);
    }
    const items = rows.map((row) => {
      const channel = channels.get(String(row.channel_id));
      const identity = identities.get(String(row.primary_identity_id || ""));
      return {
        conversationId: String(row.id), provider: String(channel?.provider || "unknown"), channelName: String(channel?.display_name || "Unknown channel"),
        maskedIdentity: identity ? presentIdentity(identity).maskedExternalIdentity : "-", subject: String(row.subject || ""),
        status: String(row.status), messageCount: messageCounts.get(String(row.id)) || 0,
        attachmentCount: attachmentCounts.get(String(row.id)) || 0, sessionStatus: sessions.get(String(row.id)),
        ticketLinks: links.get(String(row.id)) || [], lastActivityAt: canonical(row.last_activity_at),
      };
    });
    return page(items, result.count, query);
  }

  async findConversation(id: string) {
    requireRelational();
    const result = await must("Could not find intake conversation", supabaseAdmin.from("intake_conversations")
      .select("id,channel_id,primary_identity_id,status,version,subject,opened_at,last_activity_at,closed_at,created_at,updated_at").eq("id", id).maybeSingle());
    if (!result.data) return undefined;
    const row = rawRecordSchema.parse(result.data);
    const [sessionResult, linksResult] = await Promise.all([
      must("Could not load conversation session", supabaseAdmin.from("intake_sessions")
        .select("id,status,version,missing_fields,started_at,expires_at,confirmed_at,cancelled_at,failed_at,updated_at")
        .eq("conversation_id", id).order("updated_at", { ascending: false }).limit(1).maybeSingle()),
      must("Could not load conversation ticket links", supabaseAdmin.from("intake_ticket_links")
        .select("ticket_id,relationship,created_at").eq("conversation_id", id).order("created_at").order("ticket_id")),
    ]);
    const session = sessionResult.data ? rawRecordSchema.parse(sessionResult.data) : undefined;
    return {
      conversationId: row.id, status: row.status, version: row.version, subject: row.subject,
      openedAt: canonical(row.opened_at), lastActivityAt: canonical(row.last_activity_at), closedAt: canonical(row.closed_at),
      createdAt: canonical(row.created_at), updatedAt: canonical(row.updated_at),
      session: session ? {
        sessionId: session.id, status: session.status, version: session.version,
        missingFields: session.missing_fields, startedAt: canonical(session.started_at), expiresAt: canonical(session.expires_at),
        confirmedAt: canonical(session.confirmed_at), cancelledAt: canonical(session.cancelled_at),
        failedAt: canonical(session.failed_at), updatedAt: canonical(session.updated_at),
      } : null,
      ticketLinks: rawRecordsSchema.parse(linksResult.data || []).map((link) => ({
        ticketId: link.ticket_id, relationship: link.relationship, createdAt: canonical(link.created_at),
      })),
    };
  }

  async listConversationMessages(conversationId: string) {
    requireRelational();
    const result = await must("Could not list intake messages", supabaseAdmin.from("intake_messages")
      .select("id,reply_to_message_id,direction,message_type,status,body_text,provider_sent_at,received_at,stored_at")
      .eq("conversation_id", conversationId).order("received_at").order("id"));
    return rawRecordsSchema.parse(result.data || []).map((row) => ({
      messageId: row.id, replyToMessageId: row.reply_to_message_id || undefined, direction: row.direction,
      messageType: row.message_type, status: row.status, textPreview: plainTextPreview(row.body_text),
      providerSentAt: canonical(row.provider_sent_at), receivedAt: canonical(row.received_at), storedAt: canonical(row.stored_at),
    }));
  }

  async listConversationAttachments(conversationId: string) {
    requireRelational();
    const result = await must("Could not list intake attachment metadata", supabaseAdmin.from("intake_attachments")
      .select("id,message_id,file_name,content_type,declared_size,sha256,storage_status,scan_status,retention_until,created_at")
      .eq("conversation_id", conversationId).order("created_at").order("id"));
    return rawRecordsSchema.parse(result.data || []).map((row) => ({
      attachmentId: row.id, messageId: row.message_id, fileName: row.file_name, contentType: row.content_type,
      declaredSize: row.declared_size, sha256: row.sha256 || undefined, storageStatus: row.storage_status,
      scanStatus: row.scan_status, retentionUntil: canonical(row.retention_until), createdAt: canonical(row.created_at),
    }));
  }

  async listSessions(query: ListQuery) {
    requireRelational();
    const { from, to } = pageRange(query);
    let request = supabaseAdmin.from("intake_sessions").select("id,conversation_id,status,version,missing_fields,started_at,expires_at,updated_at", { count: "exact" });
    if (query.status) request = request.eq("status", query.status);
    const result = await must("Could not list intake sessions", request.order("updated_at", { ascending: false }).order("id").range(from, to));
    return page(rawRecordsSchema.parse(result.data || []).map((row) => ({ ...row, started_at: canonical(row.started_at), expires_at: canonical(row.expires_at), updated_at: canonical(row.updated_at) })), result.count, query);
  }

  async findSession(id: string) {
    requireRelational();
    const result = await must("Could not find intake session", supabaseAdmin.from("intake_sessions")
      .select("id,conversation_id,status,version,state_data,missing_fields,started_at,expires_at,confirmed_at,cancelled_at,failed_at,updated_at").eq("id", id).maybeSingle());
    if (!result.data) return undefined;
    const row = rawRecordSchema.parse(result.data);
    return sessionSummarySchema.parse({ ...row, started_at: canonical(row.started_at), expires_at: canonical(row.expires_at), confirmed_at: canonical(row.confirmed_at), cancelled_at: canonical(row.cancelled_at), failed_at: canonical(row.failed_at), updated_at: canonical(row.updated_at) });
  }

  async listInboundEvents(query: ListQuery) {
    requireRelational();
    const { from, to } = pageRange(query);
    let request = supabaseAdmin.from("intake_events")
      .select("id,channel_id,event_type,processing_status,redelivery,delivery_count,correlation_id,received_at,first_processed_at,last_seen_at,safe_error_code", { count: "exact" });
    if (query.status) request = request.eq("processing_status", query.status);
    const result = await must("Could not list intake events", request.order("received_at", { ascending: false }).order("id").range(from, to));
    return page(rawRecordsSchema.parse(result.data || []).map((row) => ({
      eventId: row.id, channelId: row.channel_id, eventType: row.event_type, status: row.processing_status,
      redelivery: row.redelivery, deliveryCount: row.delivery_count, correlationId: row.correlation_id,
      receivedAt: canonical(row.received_at), firstProcessedAt: canonical(row.first_processed_at), lastSeenAt: canonical(row.last_seen_at), safeErrorCode: row.safe_error_code || undefined,
    })), result.count, query);
  }

  async listOutboxCommands(query: ListQuery) {
    requireRelational();
    const { from, to } = pageRange(query);
    let request = supabaseAdmin.from("integration_outbox")
      .select("id,target_provider,command_type,channel_id,conversation_id,message_id,ticket_id,status,attempt_count,max_attempts,available_at,locked_until,last_error_code,completed_at,cancelled_at,created_at,updated_at", { count: "exact" });
    if (query.status) request = request.eq("status", query.status);
    if (query.provider) request = request.eq("target_provider", query.provider);
    const result = await must("Could not list intake outbox", request.order("created_at", { ascending: false }).order("id").range(from, to));
    return page(rawRecordsSchema.parse(result.data || []).map((row) => ({
      commandId: row.id, targetProvider: row.target_provider, commandType: row.command_type,
      channelId: row.channel_id || undefined, conversationId: row.conversation_id || undefined,
      messageId: row.message_id || undefined, ticketId: row.ticket_id || undefined, status: row.status,
      attemptCount: row.attempt_count, maxAttempts: row.max_attempts, availableAt: canonical(row.available_at),
      lockedUntil: canonical(row.locked_until), lastErrorCode: row.last_error_code || undefined,
      completedAt: canonical(row.completed_at), cancelledAt: canonical(row.cancelled_at),
      createdAt: canonical(row.created_at), updatedAt: canonical(row.updated_at),
    })), result.count, query);
  }

  async acceptInboundEvent(input: AcceptInboundEvent): Promise<AcceptInboundEventResult> {
    requireRelational();
    const result = await must("Could not accept normalized intake event", supabaseAdmin.rpc("support_accept_intake_event", { p_payload: input }));
    return acceptInboundEventResultSchema.parse(rpcRow(result.data));
  }

  async applyIdentityBinding(input: IdentityBindingInput) {
    requireRelational();
    const result = await must("Could not apply intake identity binding", supabaseAdmin.rpc("support_apply_intake_identity_binding", { p_payload: input }));
    return identityBindingResultSchema.parse(rpcRow(result.data));
  }

  async revokeIdentityBinding(input: RevokeBindingInput) {
    requireRelational();
    const result = await must("Could not revoke intake identity binding", supabaseAdmin.rpc("support_revoke_intake_identity_binding", { p_payload: input }));
    return identityBindingResultSchema.parse(rpcRow(result.data));
  }

  async transitionSession(input: SessionTransitionInput) {
    requireRelational();
    const result = await must("Could not transition intake session", supabaseAdmin.rpc("support_transition_intake_session", { p_payload: input }));
    const row = rpcRow(result.data);
    return sessionSummarySchema.parse({ ...row, started_at: canonical(row.started_at), expires_at: canonical(row.expires_at), confirmed_at: canonical(row.confirmed_at), cancelled_at: canonical(row.cancelled_at), failed_at: canonical(row.failed_at), updated_at: canonical(row.updated_at) });
  }

  async enqueueOutbox(input: EnqueueOutboxInput) {
    requireRelational();
    const result = await must("Could not enqueue integration command", supabaseAdmin.rpc("support_enqueue_integration_outbox", { p_payload: input }));
    return enqueueOutboxResultSchema.parse(rpcRow(result.data));
  }

  async linkConversationTicket(input: { id: string; conversationId: string; ticketId: string; relationship: "primary" | "related" | "duplicate" | "follow_up"; actorUserId?: string; correlationId?: string; metadata?: Record<string, unknown> }) {
    requireRelational();
    await must("Could not link intake conversation to ticket", supabaseAdmin.from("intake_ticket_links").insert({
      id: input.id, conversation_id: input.conversationId, ticket_id: input.ticketId,
      relationship: input.relationship, linked_by_user_id: input.actorUserId || null,
      correlation_id: input.correlationId || null, metadata: input.metadata || {},
    }));
  }

  async ensureDiagnosticChannel(input: { id: string; channelKey: string; displayName: string; now: string; actorUserId: string }) {
    requireRelational();
    canonicalTimestampSchema.parse(input.now);
    await must("Could not prepare diagnostic intake channel", supabaseAdmin.from("integration_channels").upsert({
      id: input.id, provider: "internal", channel_key: input.channelKey, display_name: input.displayName,
      environment: "development", enabled: true, configuration_status: "configured", metadata: { diagnostic: true },
      created_by_user_id: input.actorUserId, updated_by_user_id: input.actorUserId, updated_at: input.now,
    }, { onConflict: "provider,channel_key" }));
  }
}

export function createRelationalIntakeCoreRepository() {
  return new RelationalIntakeCoreRepository();
}
