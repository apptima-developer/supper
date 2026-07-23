import "server-only";
import { z } from "zod";
import { getDataBackend } from "@/lib/env";
import { supabaseAdmin } from "@/lib/supabaseAdmin";
import { IntakeCoreError, intakeErrorFromUnknown } from "./errors";
import { operationsSummarySchema, plainTextPreview, presentIdentity } from "./presentation";
import type { IntakeCoreRepository, PageResult } from "./repository";
import {
  acceptInboundEventResultSchema, bindingMetadataSchema, canonicalTimestampSchema,
  conversationSummarySchema, enqueueOutboxResultSchema, identityBindingResultSchema,
  sessionStateSchema, sessionSummarySchema,
  type AcceptInboundEvent, type AcceptInboundEventResult, type ChannelListQuery, type ChildListQuery,
  type ConversationListQuery, type ConversationTransitionInput, type EnqueueOutboxInput,
  type EventListQuery, type IdentityBindingInput, type IdentityListQuery, type OutboxListQuery,
  type RevokeBindingInput, type SessionListQuery, type SessionTransitionInput,
} from "./schemas";

type QueryResult<T> = { data: T; error: { message?: string; code?: string } | null; count?: number | null };

const nullableString = z.string().nullable();
const channelRowSchema = z.object({
  id: z.string(), provider: z.string(), channel_key: z.string(), display_name: z.string(), environment: z.string(),
  enabled: z.boolean(), configuration_status: z.string(), created_at: z.string(), updated_at: z.string(),
}).strict();
const identityRowSchema = z.object({ id: z.string(), channel_id: z.string(), external_subject_hash: z.string(), display_name: z.string(), status: z.string(), last_seen_at: z.string() }).strict();
const identityListRowSchema = z.object({
  identity_id: z.string(), external_subject_hash: z.string(), display_name: z.string(), identity_status: z.string(),
  last_seen_at: z.string(), provider: z.string(), channel_name: z.string(), customer_name: nullableString,
  project_code: z.string(), conversation_count: z.coerce.number().int().nonnegative(), total_count: z.coerce.number().int().nonnegative(),
}).strict();
const channelIdentityRowSchema = z.object({ id: z.string(), provider: z.string(), display_name: z.string() }).strict();
const bindingRowSchema = z.object({ identity_id: z.string(), customer_key: z.string(), project_code: z.string() }).strict();
const customerNameRowSchema = z.object({ customer_name: z.string() }).strict();
const conversationListRowSchema = z.object({
  conversation_id: z.string(), provider: z.string(), channel_name: z.string(), external_subject_hash: nullableString,
  subject: z.string(), conversation_status: z.string(), message_count: z.coerce.number().int().nonnegative(),
  attachment_count: z.coerce.number().int().nonnegative(), session_status: nullableString,
  ticket_links: z.array(z.object({ ticketId: z.string(), relationship: z.string() }).strict()).max(10),
  last_activity_at: z.string(), total_count: z.coerce.number().int().nonnegative(),
}).strict();
const conversationRowSchema = z.object({
  id: z.string(), channel_id: z.string(), primary_identity_id: nullableString, status: z.string(), version: z.number().int().positive(),
  subject: z.string(), opened_at: z.string(), last_activity_at: z.string(), closed_at: nullableString,
  created_at: z.string(), updated_at: z.string(),
}).strict();
const sessionDetailRowSchema = z.object({
  id: z.string(), status: z.string(), version: z.number().int().positive(), missing_fields: z.array(z.string()),
  started_at: z.string(), expires_at: nullableString, confirmed_at: nullableString, cancelled_at: nullableString,
  failed_at: nullableString, updated_at: z.string(),
}).strict();
const ticketLinkRowSchema = z.object({ ticket_id: z.string(), relationship: z.string(), created_at: z.string() }).strict();
const messageRowSchema = z.object({
  id: z.string(), reply_to_message_id: nullableString, direction: z.string(), message_type: z.string(), status: z.string(),
  body_text: z.string(), provider_sent_at: nullableString, received_at: z.string(), stored_at: nullableString,
}).strict();
const attachmentRowSchema = z.object({
  id: z.string(), message_id: z.string(), file_name: z.string(), content_type: z.string(), declared_size: z.coerce.number().int().nonnegative(),
  sha256: nullableString, storage_status: z.string(), scan_status: z.string(), retention_until: nullableString, created_at: z.string(),
}).strict();
const sessionListRowSchema = z.object({
  id: z.string(), conversation_id: z.string(), status: z.string(), version: z.number().int().positive(),
  missing_fields: z.array(z.string()), started_at: z.string(), expires_at: nullableString, updated_at: z.string(),
}).strict();
const sessionRowSchema = z.object({
  id: z.string(), conversation_id: z.string(), status: z.string(), version: z.number().int().positive(), state_data: sessionStateSchema,
  missing_fields: z.array(z.string()), started_at: z.string(), expires_at: nullableString, confirmed_at: nullableString,
  cancelled_at: nullableString, failed_at: nullableString, updated_at: z.string(),
}).strict();
const eventListRowSchema = z.object({
  event_id: z.string(), channel_id: z.string(), provider: z.string(), event_type: z.string(), processing_status: z.string(),
  redelivery: z.boolean(), delivery_count: z.number().int().positive(), duplicate_delivery_count: z.number().int().nonnegative(),
  correlation_id: z.string(), received_at: z.string(), first_processed_at: nullableString, last_seen_at: z.string(),
  safe_error_code: nullableString, total_count: z.coerce.number().int().nonnegative(),
}).strict();
const outboxRowSchema = z.object({
  id: z.string(), target_provider: z.string(), command_type: z.string(), channel_id: nullableString,
  conversation_id: nullableString, message_id: nullableString, ticket_id: nullableString, status: z.string(),
  attempt_count: z.number().int().nonnegative(), max_attempts: z.number().int().positive(), available_at: z.string(),
  locked_until: nullableString, last_error_code: nullableString, completed_at: nullableString, cancelled_at: nullableString,
  created_at: z.string(), updated_at: z.string(),
}).strict();

function requireRelational() {
  if (getDataBackend() !== "supabase-relational") throw new IntakeCoreError("INTAKE_RELATIONAL_BACKEND_REQUIRED");
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

function pageRange(query: { page: number; limit: number }) {
  const from = (query.page - 1) * query.limit;
  return { from, to: from + query.limit - 1 };
}

function page<T>(items: T[], total: number | null | undefined, query: { page: number; limit: number }): PageResult<T> {
  const boundedTotal = total || 0;
  return { items, total: boundedTotal, page: query.page, limit: query.limit, hasNext: query.page * query.limit < boundedTotal };
}

function rpcRow(value: unknown) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return z.record(z.string(), z.unknown()).parse(candidate);
}

function presentChannel(row: z.infer<typeof channelRowSchema>) {
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

  async listChannels(query: ChannelListQuery) {
    requireRelational();
    const { from, to } = pageRange(query);
    let request = supabaseAdmin.from("integration_channels")
      .select("id,provider,channel_key,display_name,environment,enabled,configuration_status,created_at,updated_at", { count: "exact" });
    if (query.provider) request = request.eq("provider", query.provider);
    if (query.status) request = request.eq("configuration_status", query.status);
    const result = await must("Could not list intake channels", request.order("updated_at", { ascending: false }).order("id").range(from, to));
    return page(z.array(channelRowSchema).parse(result.data || []).map(presentChannel), result.count, query);
  }

  async findChannel(id: string) {
    requireRelational();
    const result = await must("Could not find intake channel", supabaseAdmin.from("integration_channels")
      .select("id,provider,channel_key,display_name,environment,enabled,configuration_status,created_at,updated_at").eq("id", id).maybeSingle());
    return result.data ? presentChannel(channelRowSchema.parse(result.data)) : undefined;
  }

  async listIdentities(query: IdentityListQuery) {
    requireRelational();
    const result = await must("Could not list intake identities", supabaseAdmin.rpc("support_list_intake_identities", {
      p_page: query.page, p_limit: query.limit, p_status: query.status || null, p_provider: query.provider || null,
    }));
    const rows = z.array(identityListRowSchema).parse(result.data || []);
    const items = rows.map((row) => presentIdentity({
      id: row.identity_id, external_subject_hash: row.external_subject_hash, display_name: row.display_name,
      status: row.identity_status, last_seen_at: canonical(row.last_seen_at),
    }, {
      provider: row.provider, channelName: row.channel_name, customerName: row.customer_name || undefined,
      projectCode: row.project_code, conversationCount: row.conversation_count,
    }));
    return page(items, rows[0]?.total_count || 0, query);
  }

  async findIdentity(id: string) {
    requireRelational();
    const identityResult = await must("Could not find intake identity", supabaseAdmin.from("integration_external_identities")
      .select("id,channel_id,external_subject_hash,display_name,status,last_seen_at").eq("id", id).maybeSingle());
    if (!identityResult.data) return undefined;
    const identity = identityRowSchema.parse(identityResult.data);
    const [channelResult, bindingResult, conversationsResult] = await Promise.all([
      must("Could not load identity channel", supabaseAdmin.from("integration_channels").select("id,provider,display_name").eq("id", identity.channel_id).maybeSingle()),
      must("Could not load identity binding", supabaseAdmin.from("integration_identity_bindings").select("identity_id,customer_key,project_code").eq("identity_id", id).eq("status", "linked").maybeSingle()),
      must("Could not count identity conversations", supabaseAdmin.from("intake_conversations").select("id", { count: "exact", head: true }).eq("primary_identity_id", id)),
    ]);
    const channel = channelResult.data ? channelIdentityRowSchema.parse(channelResult.data) : undefined;
    const binding = bindingResult.data ? bindingRowSchema.parse(bindingResult.data) : undefined;
    let customerName: string | undefined;
    if (binding) {
      const customerResult = await must("Could not load bound customer", supabaseAdmin.from("support_customers").select("customer_name").eq("customer_key", binding.customer_key).maybeSingle());
      if (customerResult.data) customerName = customerNameRowSchema.parse(customerResult.data).customer_name;
    }
    return presentIdentity({ ...identity, last_seen_at: canonical(identity.last_seen_at) }, {
      provider: channel?.provider || "unknown", channelName: channel?.display_name || "Unknown channel", customerName,
      projectCode: binding?.project_code || "", conversationCount: conversationsResult.count || 0,
    });
  }

  async listConversations(query: ConversationListQuery) {
    requireRelational();
    const result = await must("Could not list intake conversations", supabaseAdmin.rpc("support_list_intake_conversations", {
      p_page: query.page, p_limit: query.limit, p_status: query.status || null, p_provider: query.provider || null,
    }));
    const rows = z.array(conversationListRowSchema).parse(result.data || []);
    const items = rows.map((row) => ({
      conversationId: row.conversation_id, provider: row.provider, channelName: row.channel_name,
      maskedIdentity: row.external_subject_hash ? presentIdentity({ external_subject_hash: row.external_subject_hash }).maskedExternalIdentity : "-",
      subject: row.subject, status: row.conversation_status, messageCount: row.message_count,
      attachmentCount: row.attachment_count, sessionStatus: row.session_status || undefined,
      ticketLinks: row.ticket_links, lastActivityAt: canonical(row.last_activity_at),
    }));
    return page(items, rows[0]?.total_count || 0, query);
  }

  async findConversation(id: string) {
    requireRelational();
    const result = await must("Could not find intake conversation", supabaseAdmin.from("intake_conversations")
      .select("id,channel_id,primary_identity_id,status,version,subject,opened_at,last_activity_at,closed_at,created_at,updated_at").eq("id", id).maybeSingle());
    if (!result.data) return undefined;
    const row = conversationRowSchema.parse(result.data);
    const [sessionResult, linksResult] = await Promise.all([
      must("Could not load conversation session", supabaseAdmin.from("intake_sessions")
        .select("id,status,version,missing_fields,started_at,expires_at,confirmed_at,cancelled_at,failed_at,updated_at")
        .eq("conversation_id", id).order("updated_at", { ascending: false }).limit(1).maybeSingle()),
      must("Could not load bounded conversation ticket links", supabaseAdmin.from("intake_ticket_links")
        .select("ticket_id,relationship,created_at").eq("conversation_id", id).order("created_at").order("ticket_id").limit(10)),
    ]);
    const session = sessionResult.data ? sessionDetailRowSchema.parse(sessionResult.data) : undefined;
    return {
      conversationId: row.id, status: row.status, version: row.version, subject: row.subject,
      openedAt: canonical(row.opened_at), lastActivityAt: canonical(row.last_activity_at), closedAt: canonical(row.closed_at),
      createdAt: canonical(row.created_at), updatedAt: canonical(row.updated_at),
      session: session ? {
        sessionId: session.id, status: session.status, version: session.version, missingFields: session.missing_fields,
        startedAt: canonical(session.started_at), expiresAt: canonical(session.expires_at), confirmedAt: canonical(session.confirmed_at),
        cancelledAt: canonical(session.cancelled_at), failedAt: canonical(session.failed_at), updatedAt: canonical(session.updated_at),
      } : null,
      ticketLinks: z.array(ticketLinkRowSchema).parse(linksResult.data || []).map((link) => ({
        ticketId: link.ticket_id, relationship: link.relationship, createdAt: canonical(link.created_at),
      })),
    };
  }

  async listConversationMessages(conversationId: string, query: ChildListQuery) {
    requireRelational();
    const { from, to } = pageRange(query);
    const result = await must("Could not list intake messages", supabaseAdmin.from("intake_messages")
      .select("id,reply_to_message_id,direction,message_type,status,body_text,provider_sent_at,received_at,stored_at", { count: "exact" })
      .eq("conversation_id", conversationId).order("received_at").order("id").range(from, to));
    return page(z.array(messageRowSchema).parse(result.data || []).map((row) => ({
      messageId: row.id, replyToMessageId: row.reply_to_message_id || undefined, direction: row.direction,
      messageType: row.message_type, status: row.status, textPreview: plainTextPreview(row.body_text),
      providerSentAt: canonical(row.provider_sent_at), receivedAt: canonical(row.received_at), storedAt: canonical(row.stored_at),
    })), result.count, query);
  }

  async listConversationAttachments(conversationId: string, query: ChildListQuery) {
    requireRelational();
    const { from, to } = pageRange(query);
    const result = await must("Could not list intake attachment metadata", supabaseAdmin.from("intake_attachments")
      .select("id,message_id,file_name,content_type,declared_size,sha256,storage_status,scan_status,retention_until,created_at", { count: "exact" })
      .eq("conversation_id", conversationId).order("created_at").order("id").range(from, to));
    return page(z.array(attachmentRowSchema).parse(result.data || []).map((row) => ({
      attachmentId: row.id, messageId: row.message_id, fileName: row.file_name, contentType: row.content_type,
      declaredSize: row.declared_size, sha256: row.sha256 || undefined, storageStatus: row.storage_status,
      scanStatus: row.scan_status, retentionUntil: canonical(row.retention_until), createdAt: canonical(row.created_at),
    })), result.count, query);
  }

  async listSessions(query: SessionListQuery) {
    requireRelational();
    const { from, to } = pageRange(query);
    let request = supabaseAdmin.from("intake_sessions").select("id,conversation_id,status,version,missing_fields,started_at,expires_at,updated_at", { count: "exact" });
    if (query.status) request = request.eq("status", query.status);
    const result = await must("Could not list intake sessions", request.order("updated_at", { ascending: false }).order("id").range(from, to));
    const items = z.array(sessionListRowSchema).parse(result.data || []).map((row) => ({
      ...row, started_at: canonical(row.started_at), expires_at: canonical(row.expires_at), updated_at: canonical(row.updated_at),
    }));
    return page(items, result.count, query);
  }

  async findSession(id: string) {
    requireRelational();
    const result = await must("Could not find intake session", supabaseAdmin.from("intake_sessions")
      .select("id,conversation_id,status,version,state_data,missing_fields,started_at,expires_at,confirmed_at,cancelled_at,failed_at,updated_at").eq("id", id).maybeSingle());
    if (!result.data) return undefined;
    const row = sessionRowSchema.parse(result.data);
    return sessionSummarySchema.parse({ ...row, started_at: canonical(row.started_at), expires_at: canonical(row.expires_at), confirmed_at: canonical(row.confirmed_at), cancelled_at: canonical(row.cancelled_at), failed_at: canonical(row.failed_at), updated_at: canonical(row.updated_at) });
  }

  async listInboundEvents(query: EventListQuery) {
    requireRelational();
    const result = await must("Could not list intake events", supabaseAdmin.rpc("support_list_intake_events", {
      p_page: query.page, p_limit: query.limit, p_status: query.status || null, p_provider: query.provider || null,
    }));
    const rows = z.array(eventListRowSchema).parse(result.data || []);
    const items = rows.map((row) => ({
      eventId: row.event_id, channelId: row.channel_id, provider: row.provider, eventType: row.event_type,
      status: row.processing_status, redelivery: row.redelivery, deliveryCount: row.delivery_count,
      duplicateDeliveryCount: row.duplicate_delivery_count, correlationId: row.correlation_id,
      receivedAt: canonical(row.received_at), firstProcessedAt: canonical(row.first_processed_at),
      lastSeenAt: canonical(row.last_seen_at), safeErrorCode: row.safe_error_code || undefined,
    }));
    return page(items, rows[0]?.total_count || 0, query);
  }

  async listOutboxCommands(query: OutboxListQuery) {
    requireRelational();
    const { from, to } = pageRange(query);
    let request = supabaseAdmin.from("integration_outbox")
      .select("id,target_provider,command_type,channel_id,conversation_id,message_id,ticket_id,status,attempt_count,max_attempts,available_at,locked_until,last_error_code,completed_at,cancelled_at,created_at,updated_at", { count: "exact" });
    if (query.status) request = request.eq("status", query.status);
    if (query.provider) request = request.eq("target_provider", query.provider);
    const result = await must("Could not list intake outbox", request.order("created_at", { ascending: false }).order("id").range(from, to));
    const items = z.array(outboxRowSchema).parse(result.data || []).map((row) => ({
      commandId: row.id, targetProvider: row.target_provider, commandType: row.command_type,
      channelId: row.channel_id || undefined, conversationId: row.conversation_id || undefined,
      messageId: row.message_id || undefined, ticketId: row.ticket_id || undefined, status: row.status,
      attemptCount: row.attempt_count, maxAttempts: row.max_attempts, availableAt: canonical(row.available_at),
      lockedUntil: canonical(row.locked_until), lastErrorCode: row.last_error_code || undefined,
      completedAt: canonical(row.completed_at), cancelledAt: canonical(row.cancelled_at),
      createdAt: canonical(row.created_at), updatedAt: canonical(row.updated_at),
    }));
    return page(items, result.count, query);
  }

  async acceptInboundEvent(input: AcceptInboundEvent): Promise<AcceptInboundEventResult> {
    requireRelational();
    const result = await must("Could not accept normalized intake event", supabaseAdmin.rpc("support_accept_intake_event_v3", { p_payload: input }));
    return acceptInboundEventResultSchema.parse(rpcRow(result.data));
  }

  async applyIdentityBinding(input: IdentityBindingInput) {
    requireRelational();
    const result = await must("Could not apply intake identity binding", supabaseAdmin.rpc("support_apply_intake_identity_binding_v2", { p_payload: input }));
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

  async transitionConversation(input: ConversationTransitionInput) {
    requireRelational();
    const result = await must("Could not transition intake conversation", supabaseAdmin.rpc("support_transition_intake_conversation_v2", { p_payload: input }));
    const row = rpcRow(result.data);
    return conversationSummarySchema.parse({ ...row, last_activity_at: canonical(row.last_activity_at), closed_at: canonical(row.closed_at), updated_at: canonical(row.updated_at) });
  }

  async enqueueOutbox(input: EnqueueOutboxInput) {
    requireRelational();
    const result = await must("Could not enqueue integration command", supabaseAdmin.rpc("support_enqueue_integration_outbox_v2", { p_payload: input }));
    return enqueueOutboxResultSchema.parse(rpcRow(result.data));
  }

  async linkConversationTicket(input: { id: string; conversationId: string; ticketId: string; relationship: "primary" | "related" | "duplicate" | "follow_up"; actorUserId?: string; correlationId?: string; metadata?: Record<string, unknown> }) {
    requireRelational();
    const metadata = bindingMetadataSchema.parse(input.metadata || {});
    await must("Could not link intake conversation to ticket", supabaseAdmin.from("intake_ticket_links").insert({
      id: input.id, conversation_id: input.conversationId, ticket_id: input.ticketId,
      relationship: input.relationship, linked_by_user_id: input.actorUserId || null,
      correlation_id: input.correlationId || null, metadata,
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
