-- SUPPER AI-1.3: provider-neutral intake persistence and atomic command intent.
-- This migration stores normalized records only. It creates no provider client,
-- webhook, ticket, object bytes, scheduler, worker, or outbound network behavior.

begin;

create extension if not exists pgcrypto;

create table if not exists public.integration_channels (
  id text primary key,
  provider text not null check (provider in ('email', 'line', 'web', 'internal')),
  channel_key text not null check (length(btrim(channel_key)) between 1 and 120),
  display_name text not null check (length(display_name) <= 200),
  environment text not null check (environment in ('development', 'preview', 'production')),
  enabled boolean not null default false,
  configuration_status text not null default 'unconfigured' check (configuration_status in ('unconfigured', 'configured', 'disabled', 'error')),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
  created_by_user_id text,
  updated_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, channel_key)
);

create table if not exists public.integration_external_identities (
  id text primary key,
  channel_id text not null references public.integration_channels(id) on delete restrict,
  external_subject_id text not null check (length(btrim(external_subject_id)) between 1 and 500),
  external_subject_hash text not null check (external_subject_hash ~ '^[a-f0-9]{64}$'),
  display_name text not null default '' check (length(display_name) <= 200),
  identity_type text not null check (identity_type in ('user', 'contact', 'mailbox', 'system', 'anonymous')),
  status text not null default 'unlinked' check (status in ('unlinked', 'pending', 'linked', 'revoked', 'blocked')),
  first_seen_at timestamptz not null,
  last_seen_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, external_subject_id),
  unique (channel_id, external_subject_hash),
  check (last_seen_at >= first_seen_at)
);

create table if not exists public.integration_identity_bindings (
  id text primary key,
  identity_id text not null references public.integration_external_identities(id) on delete restrict,
  customer_key text not null references public.support_customers(customer_key) on delete restrict,
  project_code text not null default '' check (length(project_code) <= 200),
  status text not null default 'linked' check (status in ('linked', 'revoked')),
  allowed_systems jsonb not null default '[]'::jsonb check (jsonb_typeof(allowed_systems) = 'array' and jsonb_array_length(allowed_systems) <= 50 and octet_length(allowed_systems::text) <= 16384),
  target_references jsonb not null default '{}'::jsonb check (jsonb_typeof(target_references) = 'object' and octet_length(target_references::text) <= 32768),
  linked_by_user_id text,
  linked_at timestamptz not null,
  revoked_by_user_id text,
  revoked_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((status = 'linked' and revoked_at is null) or status = 'revoked')
);

create table if not exists public.integration_identity_binding_events (
  id text primary key,
  binding_id text references public.integration_identity_bindings(id) on delete restrict,
  identity_id text not null references public.integration_external_identities(id) on delete restrict,
  action text not null check (action in ('linked', 'changed', 'revoked', 'reactivated')),
  previous_customer_key text,
  new_customer_key text,
  actor_user_id text,
  correlation_id text,
  request_id text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384)
);

create table if not exists public.intake_conversations (
  id text primary key,
  channel_id text not null references public.integration_channels(id) on delete restrict,
  external_conversation_id text not null check (length(btrim(external_conversation_id)) between 1 and 500),
  primary_identity_id text references public.integration_external_identities(id) on delete restrict,
  status text not null default 'open' check (status in ('open', 'awaiting_customer', 'awaiting_agent', 'linked', 'closed', 'archived')),
  version integer not null default 1 check (version > 0),
  subject text not null default '' check (length(subject) <= 500),
  opened_at timestamptz not null,
  last_activity_at timestamptz not null,
  closed_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, external_conversation_id),
  check (last_activity_at >= opened_at),
  check (closed_at is null or closed_at >= opened_at)
);

create table if not exists public.intake_messages (
  id text primary key,
  channel_id text not null references public.integration_channels(id) on delete restrict,
  conversation_id text not null references public.intake_conversations(id) on delete restrict,
  external_message_id text not null check (length(btrim(external_message_id)) between 1 and 500),
  sender_identity_id text references public.integration_external_identities(id) on delete restrict,
  reply_to_message_id text references public.intake_messages(id) on delete restrict,
  direction text not null check (direction in ('inbound', 'outbound', 'internal')),
  message_type text not null check (message_type in ('text', 'html', 'image', 'file', 'video', 'audio', 'location', 'sticker', 'structured', 'system')),
  status text not null check (status in ('received', 'validated', 'stored', 'rejected', 'failed')),
  body_text text not null default '' check (length(body_text) <= 200000),
  body_html text not null default '' check (length(body_html) <= 500000),
  structured_content jsonb not null default '{}'::jsonb check (jsonb_typeof(structured_content) = 'object' and octet_length(structured_content::text) <= 32768),
  content_hash text not null check (content_hash ~ '^[a-f0-9]{64}$'),
  provider_sent_at timestamptz,
  received_at timestamptz not null,
  stored_at timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, external_message_id),
  check (stored_at is null or stored_at >= received_at)
);

create table if not exists public.intake_attachments (
  id text primary key,
  channel_id text not null references public.integration_channels(id) on delete restrict,
  conversation_id text not null references public.intake_conversations(id) on delete restrict,
  message_id text not null references public.intake_messages(id) on delete restrict,
  external_attachment_id text,
  file_name text not null check (length(btrim(file_name)) between 1 and 255 and file_name !~ '[\\/]' and file_name not in ('.', '..')),
  content_type text not null check (length(content_type) between 3 and 150 and content_type ~ '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$'),
  declared_size bigint not null check (declared_size between 0 and 262144000),
  sha256 text check (sha256 is null or sha256 ~ '^[a-f0-9]{64}$'),
  provider_locator text check (provider_locator is null or (length(provider_locator) <= 1000 and provider_locator !~* '^(https?://|file://|/|[A-Za-z]:\\)')),
  storage_status text not null default 'declared' check (storage_status in ('declared', 'pending_download', 'stored', 'quarantined', 'rejected', 'failed', 'deleted')),
  storage_object_key text check (storage_object_key is null or (length(storage_object_key) <= 1000 and storage_object_key !~ '^(https?://|file://|/|[A-Za-z]:\\)')),
  scan_status text not null default 'not_scanned' check (scan_status in ('not_scanned', 'pending', 'clean', 'suspicious', 'infected', 'failed')),
  retention_until timestamptz,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384 and metadata::text !~* '(data:[^,]+;base64|file://|/var/|/tmp/)'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.intake_sessions (
  id text primary key,
  conversation_id text not null references public.intake_conversations(id) on delete restrict,
  session_type text not null default 'ticket_intake' check (session_type = 'ticket_intake'),
  status text not null default 'draft' check (status in ('draft', 'collecting', 'awaiting_confirmation', 'confirmed', 'cancelled', 'expired', 'failed')),
  version integer not null default 1 check (version > 0),
  state_data jsonb not null default '{}'::jsonb check (jsonb_typeof(state_data) = 'object' and octet_length(state_data::text) <= 32768),
  missing_fields jsonb not null default '[]'::jsonb check (jsonb_typeof(missing_fields) = 'array' and jsonb_array_length(missing_fields) <= 50 and octet_length(missing_fields::text) <= 16384),
  started_at timestamptz not null,
  expires_at timestamptz,
  confirmed_at timestamptz,
  cancelled_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at is null or expires_at >= started_at),
  check (confirmed_at is null or confirmed_at >= started_at),
  check (cancelled_at is null or cancelled_at >= started_at),
  check (failed_at is null or failed_at >= started_at)
);

create table if not exists public.intake_events (
  id text primary key,
  channel_id text not null references public.integration_channels(id) on delete restrict,
  external_event_id text not null check (length(btrim(external_event_id)) between 1 and 500),
  event_type text not null check (event_type in ('message.received', 'message.updated', 'conversation.started')),
  payload_hash text not null check (payload_hash ~ '^[a-f0-9]{64}$'),
  processing_status text not null check (processing_status in ('received', 'accepted', 'duplicate', 'rejected', 'failed')),
  redelivery boolean not null default false,
  delivery_count integer not null default 1 check (delivery_count > 0),
  duplicate_of_event_id text references public.intake_events(id) on delete restrict,
  correlation_id text not null check (length(btrim(correlation_id)) between 1 and 200),
  request_id text,
  received_at timestamptz not null,
  first_processed_at timestamptz,
  last_seen_at timestamptz not null,
  safe_error_code text check (safe_error_code is null or safe_error_code ~ '^[A-Z0-9_]{1,80}$'),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (channel_id, external_event_id),
  check (last_seen_at >= received_at),
  check (first_processed_at is null or first_processed_at >= received_at)
);

create table if not exists public.intake_ticket_links (
  id text primary key,
  conversation_id text not null references public.intake_conversations(id) on delete restrict,
  ticket_id text not null references public.support_tickets(id) on delete restrict,
  relationship text not null default 'primary' check (relationship in ('primary', 'related', 'duplicate', 'follow_up')),
  linked_by_user_id text,
  correlation_id text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
  unique (conversation_id, ticket_id, relationship)
);

create table if not exists public.integration_outbox (
  id text primary key,
  target_provider text not null check (target_provider in ('email', 'n8n', 'servicenow', 'internal', 'line', 'web', 'freshservice')),
  command_type text not null check (command_type in ('message.reply', 'message.push', 'ticket.create', 'ticket.update', 'attachment.upload', 'notification.send')),
  idempotency_key text not null unique check (length(btrim(idempotency_key)) between 1 and 300),
  channel_id text references public.integration_channels(id) on delete restrict,
  conversation_id text references public.intake_conversations(id) on delete restrict,
  message_id text references public.intake_messages(id) on delete restrict,
  ticket_id text references public.support_tickets(id) on delete restrict,
  status text not null default 'pending' check (status in ('pending', 'processing', 'retrying', 'succeeded', 'dead_letter', 'cancelled')),
  payload jsonb not null check (jsonb_typeof(payload) = 'object' and octet_length(payload::text) <= 65536),
  attempt_count integer not null default 0 check (attempt_count between 0 and 20),
  max_attempts integer not null default 5 check (max_attempts between 1 and 20 and attempt_count <= max_attempts),
  available_at timestamptz not null,
  locked_until timestamptz,
  lock_token text,
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Z0-9_]{1,80}$'),
  completed_at timestamptz,
  cancelled_at timestamptz,
  correlation_id text,
  request_id text,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (locked_until is null or locked_until >= available_at),
  check (completed_at is null or completed_at >= available_at),
  check (cancelled_at is null or cancelled_at >= available_at)
);

create index if not exists integration_channels_provider_enabled_idx on public.integration_channels(provider, enabled);
create index if not exists integration_external_identities_channel_status_idx on public.integration_external_identities(channel_id, status);
create index if not exists integration_external_identities_last_seen_idx on public.integration_external_identities(last_seen_at desc);
create unique index if not exists integration_identity_bindings_one_active_idx on public.integration_identity_bindings(identity_id) where status = 'linked';
create index if not exists integration_identity_bindings_customer_idx on public.integration_identity_bindings(customer_key) where status = 'linked';
create index if not exists integration_identity_binding_events_identity_idx on public.integration_identity_binding_events(identity_id, created_at desc);
create index if not exists intake_conversations_channel_activity_idx on public.intake_conversations(channel_id, last_activity_at desc);
create index if not exists intake_conversations_status_idx on public.intake_conversations(status);
create index if not exists intake_messages_conversation_received_idx on public.intake_messages(conversation_id, received_at, id);
create index if not exists intake_messages_content_hash_idx on public.intake_messages(content_hash);
create index if not exists intake_attachments_message_idx on public.intake_attachments(message_id);
create index if not exists intake_attachments_storage_scan_idx on public.intake_attachments(storage_status, scan_status);
create unique index if not exists intake_attachments_external_unique_idx on public.intake_attachments(channel_id, external_attachment_id) where external_attachment_id is not null;
create unique index if not exists intake_sessions_one_active_idx on public.intake_sessions(conversation_id) where status in ('draft', 'collecting', 'awaiting_confirmation', 'failed');
create index if not exists intake_events_channel_received_idx on public.intake_events(channel_id, received_at desc);
create index if not exists intake_events_processing_status_idx on public.intake_events(processing_status);
create index if not exists intake_ticket_links_ticket_idx on public.intake_ticket_links(ticket_id);
create index if not exists integration_outbox_status_available_idx on public.integration_outbox(status, available_at);
create index if not exists integration_outbox_provider_idx on public.integration_outbox(target_provider);
create index if not exists integration_outbox_created_idx on public.integration_outbox(created_at desc);

do $$
declare v_table text;
begin
  foreach v_table in array array[
    'integration_channels', 'integration_external_identities', 'integration_identity_bindings',
    'integration_identity_binding_events', 'intake_conversations', 'intake_messages',
    'intake_attachments', 'intake_sessions', 'intake_events', 'intake_ticket_links', 'integration_outbox'
  ] loop
    execute format('alter table public.%I enable row level security', v_table);
    execute format('revoke all privileges on table public.%I from public, anon, authenticated', v_table);
    execute format('grant select, insert, update on table public.%I to service_role', v_table);
  end loop;
end;
$$;

-- Binding events are authoritative append-only history. The application role
-- can append and read them but cannot rewrite a previous identity decision.
revoke update on table public.integration_identity_binding_events from service_role;

create or replace function public.support_intake_canonical_utc_iso(p_value timestamptz)
returns text language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$ select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

create or replace function public.support_get_intake_operations_summary()
returns table (
  channels integer, enabled_channels integer, linked_identities integer, unlinked_identities integer,
  open_conversations integer, active_sessions integer, accepted_events_24h integer,
  duplicate_events_24h integer, failed_events_24h integer, pending_outbox integer,
  retrying_outbox integer, dead_letter_outbox integer, attachment_statuses jsonb,
  scan_statuses jsonb, latest_activity_at text
)
language sql security definer stable set search_path = pg_catalog, public, pg_temp
as $$
  select
    (select count(*)::integer from public.integration_channels),
    (select count(*)::integer from public.integration_channels where enabled),
    (select count(*)::integer from public.integration_external_identities where status = 'linked'),
    (select count(*)::integer from public.integration_external_identities where status in ('unlinked', 'pending')),
    (select count(*)::integer from public.intake_conversations where status in ('open', 'awaiting_customer', 'awaiting_agent', 'linked')),
    (select count(*)::integer from public.intake_sessions where status in ('draft', 'collecting', 'awaiting_confirmation', 'failed')),
    (select count(*)::integer from public.intake_events where processing_status = 'accepted' and last_seen_at >= now() - interval '24 hours'),
    (select count(*)::integer from public.intake_events where processing_status = 'duplicate' and last_seen_at >= now() - interval '24 hours'),
    (select count(*)::integer from public.intake_events where processing_status = 'failed' and last_seen_at >= now() - interval '24 hours'),
    (select count(*)::integer from public.integration_outbox where status = 'pending'),
    (select count(*)::integer from public.integration_outbox where status = 'retrying'),
    (select count(*)::integer from public.integration_outbox where status = 'dead_letter'),
    coalesce((select jsonb_object_agg(storage_status, count_value) from (select storage_status, count(*)::integer count_value from public.intake_attachments group by storage_status) counts), '{}'::jsonb),
    coalesce((select jsonb_object_agg(scan_status, count_value) from (select scan_status, count(*)::integer count_value from public.intake_attachments group by scan_status) counts), '{}'::jsonb),
    public.support_intake_canonical_utc_iso((select max(last_activity_at) from public.intake_conversations));
$$;

create or replace function public.support_accept_intake_event(p_payload jsonb)
returns table (action text, event_id text, identity_id text, conversation_id text, message_id text, attachment_count integer, session_id text, delivery_count integer)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_channel public.integration_channels%rowtype;
  v_event public.intake_events%rowtype;
  v_identity public.integration_external_identities%rowtype;
  v_conversation public.intake_conversations%rowtype;
  v_message public.intake_messages%rowtype;
  v_session public.intake_sessions%rowtype;
  v_attachment jsonb;
  v_attachment_count integer := 0;
  v_inserted integer := 0;
  v_message_duplicate boolean := false;
  v_now timestamptz := (p_payload#>>'{event,receivedAt}')::timestamptz;
begin
  if jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 1000000
    or p_payload::text ~* '"(authorization|cookie|password|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|signed[_-]?url)"\s*:' then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;
  if coalesce(p_payload#>>'{event,receivedAt}', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    or coalesce(p_payload#>>'{event,payloadHash}', '') !~ '^[a-f0-9]{64}$'
    or coalesce(p_payload#>>'{message,contentHash}', '') !~ '^[a-f0-9]{64}$'
    or coalesce(p_payload#>>'{identity,externalSubjectHash}', '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;
  if encode(digest(p_payload#>>'{identity,externalSubjectId}', 'sha256'), 'hex') <> p_payload#>>'{identity,externalSubjectHash}' then
    raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_HASH_MISMATCH';
  end if;
  perform pg_advisory_xact_lock(hashtextextended((p_payload#>>'{channel,id}') || ':' || (p_payload#>>'{event,externalEventId}'), 0));

  select * into v_channel from public.integration_channels channel_record
  where channel_record.id = p_payload#>>'{channel,id}' and channel_record.provider = p_payload#>>'{channel,provider}'
    and channel_record.channel_key = p_payload#>>'{channel,channelKey}' and channel_record.enabled for update;
  if v_channel.id is null then raise exception using errcode = '22023', message = 'INTAKE_CHANNEL_UNAVAILABLE'; end if;

  select * into v_event from public.intake_events event_record
  where event_record.channel_id = v_channel.id and event_record.external_event_id = p_payload#>>'{event,externalEventId}' for update;
  if v_event.id is not null then
    if v_event.payload_hash <> p_payload#>>'{event,payloadHash}' then
      raise exception using errcode = '23505', message = 'INTAKE_EVENT_REPLAY_MISMATCH';
    end if;
    update public.intake_events as event_record set delivery_count = event_record.delivery_count + 1, redelivery = true,
      processing_status = 'duplicate', last_seen_at = greatest(event_record.last_seen_at, v_now), updated_at = v_now
    where event_record.id = v_event.id returning * into v_event;
    return query select 'duplicate', v_event.id, v_event.metadata->>'identityId',
      v_event.metadata->>'conversationId', v_event.metadata->>'messageId',
      coalesce((v_event.metadata->>'attachmentCount')::integer, 0), v_event.metadata->>'sessionId', v_event.delivery_count;
    return;
  end if;

  insert into public.intake_events (id, channel_id, external_event_id, event_type, payload_hash, processing_status,
    correlation_id, request_id, received_at, last_seen_at, metadata, created_at, updated_at)
  values (p_payload#>>'{event,id}', v_channel.id, p_payload#>>'{event,externalEventId}', p_payload#>>'{event,eventType}',
    p_payload#>>'{event,payloadHash}', 'received', p_payload#>>'{event,correlationId}', nullif(p_payload#>>'{event,requestId}', ''),
    v_now, v_now, coalesce(p_payload#>'{event,metadata}', '{}'::jsonb), v_now, v_now)
  returning * into v_event;

  select * into v_identity from public.integration_external_identities identity_record
  where identity_record.channel_id = v_channel.id and identity_record.external_subject_id = p_payload#>>'{identity,externalSubjectId}' for update;
  if v_identity.id is null then
    insert into public.integration_external_identities (id, channel_id, external_subject_id, external_subject_hash,
      display_name, identity_type, status, first_seen_at, last_seen_at, metadata, created_at, updated_at)
    values (p_payload#>>'{identity,id}', v_channel.id, p_payload#>>'{identity,externalSubjectId}',
      p_payload#>>'{identity,externalSubjectHash}', coalesce(p_payload#>>'{identity,displayName}', ''),
      p_payload#>>'{identity,identityType}', 'unlinked', v_now, v_now,
      coalesce(p_payload#>'{identity,metadata}', '{}'::jsonb), v_now, v_now) returning * into v_identity;
  else
    update public.integration_external_identities as identity_record set last_seen_at = greatest(identity_record.last_seen_at, v_now),
      display_name = coalesce(nullif(p_payload#>>'{identity,displayName}', ''), identity_record.display_name), updated_at = v_now
    where identity_record.id = v_identity.id returning * into v_identity;
  end if;

  select * into v_conversation from public.intake_conversations conversation_record
  where conversation_record.channel_id = v_channel.id and conversation_record.external_conversation_id = p_payload#>>'{conversation,externalConversationId}' for update;
  if v_conversation.id is null then
    insert into public.intake_conversations (id, channel_id, external_conversation_id, primary_identity_id, status,
      subject, opened_at, last_activity_at, metadata, created_at, updated_at)
    values (p_payload#>>'{conversation,id}', v_channel.id, p_payload#>>'{conversation,externalConversationId}', v_identity.id,
      'open', coalesce(p_payload#>>'{conversation,subject}', ''), (p_payload#>>'{conversation,openedAt}')::timestamptz,
      (p_payload#>>'{conversation,lastActivityAt}')::timestamptz, coalesce(p_payload#>'{conversation,metadata}', '{}'::jsonb), v_now, v_now)
    returning * into v_conversation;
  else
    update public.intake_conversations as conversation_record set
      last_activity_at = greatest(conversation_record.last_activity_at, (p_payload#>>'{conversation,lastActivityAt}')::timestamptz),
      updated_at = v_now where conversation_record.id = v_conversation.id returning * into v_conversation;
  end if;

  select * into v_message from public.intake_messages message_record
  where message_record.channel_id = v_channel.id and message_record.external_message_id = p_payload#>>'{message,externalMessageId}' for update;
  if v_message.id is not null then
    if v_message.content_hash <> p_payload#>>'{message,contentHash}' then
      raise exception using errcode = '23505', message = 'INTAKE_MESSAGE_REPLAY_MISMATCH';
    end if;
    v_message_duplicate := true;
  else
    if nullif(p_payload#>>'{message,replyToMessageId}', '') is not null and not exists (
      select 1 from public.intake_messages reply_message
      where reply_message.id = p_payload#>>'{message,replyToMessageId}' and reply_message.conversation_id = v_conversation.id
    ) then raise exception using errcode = '23503', message = 'INTAKE_REPLY_MESSAGE_INVALID'; end if;
    insert into public.intake_messages (id, channel_id, conversation_id, external_message_id, sender_identity_id,
      reply_to_message_id, direction, message_type, status, body_text, body_html, structured_content, content_hash,
      provider_sent_at, received_at, stored_at, metadata, created_at, updated_at)
    values (p_payload#>>'{message,id}', v_channel.id, v_conversation.id, p_payload#>>'{message,externalMessageId}', v_identity.id,
      nullif(p_payload#>>'{message,replyToMessageId}', ''), p_payload#>>'{message,direction}', p_payload#>>'{message,messageType}',
      p_payload#>>'{message,status}', coalesce(p_payload#>>'{message,bodyText}', ''), coalesce(p_payload#>>'{message,bodyHtml}', ''),
      coalesce(p_payload#>'{message,structuredContent}', '{}'::jsonb), p_payload#>>'{message,contentHash}',
      nullif(p_payload#>>'{message,providerSentAt}', '')::timestamptz, (p_payload#>>'{message,receivedAt}')::timestamptz,
      nullif(p_payload#>>'{message,storedAt}', '')::timestamptz, coalesce(p_payload#>'{message,metadata}', '{}'::jsonb), v_now, v_now)
    returning * into v_message;
  end if;

  if not v_message_duplicate then
    for v_attachment in select value from jsonb_array_elements(coalesce(p_payload->'attachments', '[]'::jsonb)) loop
      insert into public.intake_attachments (id, channel_id, conversation_id, message_id, external_attachment_id,
        file_name, content_type, declared_size, sha256, provider_locator, storage_status, scan_status,
        retention_until, metadata, created_at, updated_at)
      values (v_attachment->>'id', v_channel.id, v_conversation.id, v_message.id,
        nullif(v_attachment->>'externalAttachmentId', ''), v_attachment->>'fileName', v_attachment->>'contentType',
        (v_attachment->>'declaredSize')::bigint, nullif(v_attachment->>'sha256', ''), nullif(v_attachment->>'providerLocator', ''),
        coalesce(v_attachment->>'storageStatus', 'declared'), coalesce(v_attachment->>'scanStatus', 'not_scanned'),
        nullif(v_attachment->>'retentionUntil', '')::timestamptz, coalesce(v_attachment->'metadata', '{}'::jsonb), v_now, v_now)
      on conflict (channel_id, external_attachment_id) where external_attachment_id is not null do nothing;
      get diagnostics v_inserted = row_count;
      v_attachment_count := v_attachment_count + v_inserted;
    end loop;
    if p_payload ? 'initializeSession' then
      select * into v_session from public.intake_sessions existing_session where existing_session.conversation_id = v_conversation.id
        and existing_session.status in ('draft', 'collecting', 'awaiting_confirmation', 'failed') for update;
      if v_session.id is null then
        insert into public.intake_sessions (id, conversation_id, status, state_data, missing_fields, started_at,
          expires_at, created_at, updated_at)
        values (p_payload#>>'{initializeSession,id}', v_conversation.id, p_payload#>>'{initializeSession,status}',
          coalesce(p_payload#>'{initializeSession,stateData}', '{}'::jsonb), coalesce(p_payload#>'{initializeSession,missingFields}', '[]'::jsonb),
          (p_payload#>>'{initializeSession,startedAt}')::timestamptz, nullif(p_payload#>>'{initializeSession,expiresAt}', '')::timestamptz, v_now, v_now)
        returning * into v_session;
      end if;
    end if;
  else
    select count(*)::integer into v_attachment_count from public.intake_attachments existing_attachment where existing_attachment.message_id = v_message.id;
    select * into v_session from public.intake_sessions existing_session where existing_session.conversation_id = v_conversation.id
      and existing_session.status in ('draft', 'collecting', 'awaiting_confirmation', 'failed') order by existing_session.updated_at desc limit 1;
  end if;

  update public.intake_events as event_record set processing_status = 'accepted', first_processed_at = v_now, last_seen_at = v_now,
    metadata = event_record.metadata || jsonb_build_object('identityId', v_identity.id, 'conversationId', v_conversation.id,
      'messageId', v_message.id, 'attachmentCount', v_attachment_count) ||
      case when v_session.id is null then '{}'::jsonb else jsonb_build_object('sessionId', v_session.id) end,
    updated_at = v_now where event_record.id = v_event.id returning * into v_event;

  return query select case when v_message_duplicate then 'duplicate_message' else 'accepted' end,
    v_event.id, v_identity.id, v_conversation.id, v_message.id, v_attachment_count, v_session.id, v_event.delivery_count;
end;
$$;

create or replace function public.support_apply_intake_identity_binding(p_payload jsonb)
returns table (action text, binding_id text, identity_id text, customer_key text, project_code text, active boolean)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_identity public.integration_external_identities%rowtype;
  v_customer public.support_customers%rowtype;
  v_binding public.integration_identity_bindings%rowtype;
  v_action text;
  v_project text;
  v_previous_customer_key text;
  v_now timestamptz := (p_payload->>'appliedAt')::timestamptz;
begin
  if coalesce(p_payload->>'appliedAt', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    or jsonb_typeof(coalesce(p_payload->'allowedSystems', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_payload->'allowedSystems', '[]'::jsonb)) > 50
    or octet_length(coalesce(p_payload->'targetReferences', '{}'::jsonb)::text) > 32768 then
    raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_BINDING_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('intake-binding:' || (p_payload->>'identityId'), 0));
  select * into v_identity from public.integration_external_identities identity_record where identity_record.id = p_payload->>'identityId' for update;
  if v_identity.id is null or v_identity.status = 'blocked' then raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_BINDING_INVALID'; end if;
  select * into v_customer from public.support_customers customer_record where customer_record.customer_key = p_payload->>'customerKey' and customer_record.active for update;
  if v_customer.id is null then raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_BINDING_INVALID'; end if;
  v_project := coalesce(nullif(btrim(p_payload->>'projectCode'), ''), v_customer.project_code, '');
  if coalesce(v_customer.project_code, '') <> '' and coalesce(p_payload->>'projectCode', '') <> '' and v_customer.project_code <> p_payload->>'projectCode' then
    raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_BINDING_INVALID';
  end if;
  select * into v_binding from public.integration_identity_bindings binding_record where binding_record.identity_id = v_identity.id order by binding_record.updated_at desc limit 1 for update;
  if v_binding.id is null then
    insert into public.integration_identity_bindings (id, identity_id, customer_key, project_code, status, allowed_systems,
      target_references, linked_by_user_id, linked_at, metadata, created_at, updated_at)
    values (p_payload->>'bindingId', v_identity.id, v_customer.customer_key, v_project, 'linked',
      coalesce(p_payload->'allowedSystems', '[]'::jsonb), coalesce(p_payload->'targetReferences', '{}'::jsonb),
      p_payload->>'actorUserId', v_now, coalesce(p_payload->'metadata', '{}'::jsonb), v_now, v_now)
    returning * into v_binding; v_action := 'created';
  elsif v_binding.status = 'linked' and v_binding.customer_key = v_customer.customer_key and v_binding.project_code = v_project
    and v_binding.allowed_systems = coalesce(p_payload->'allowedSystems', '[]'::jsonb)
    and v_binding.target_references = coalesce(p_payload->'targetReferences', '{}'::jsonb) then
    return query select 'unchanged', v_binding.id, v_identity.id, v_binding.customer_key, v_binding.project_code, true; return;
  else
    v_action := case when v_binding.status = 'revoked' then 'reactivated' else 'changed' end;
    v_previous_customer_key := v_binding.customer_key;
    update public.integration_identity_bindings as binding_record set customer_key = v_customer.customer_key, project_code = v_project,
      status = 'linked', allowed_systems = coalesce(p_payload->'allowedSystems', '[]'::jsonb),
      target_references = coalesce(p_payload->'targetReferences', '{}'::jsonb), linked_by_user_id = p_payload->>'actorUserId',
      linked_at = v_now, revoked_by_user_id = null, revoked_at = null,
      metadata = coalesce(p_payload->'metadata', '{}'::jsonb), updated_at = v_now where binding_record.id = v_binding.id returning * into v_binding;
  end if;
  update public.integration_external_identities as identity_record set status = 'linked', updated_at = v_now where identity_record.id = v_identity.id;
  insert into public.integration_identity_binding_events (id, binding_id, identity_id, action, previous_customer_key,
    new_customer_key, actor_user_id, correlation_id, request_id, created_at, metadata)
  values (p_payload->>'eventId', v_binding.id, v_identity.id, case when v_action = 'created' then 'linked' else v_action end,
    case when v_action in ('changed', 'reactivated') then v_previous_customer_key else null end,
    v_customer.customer_key, p_payload->>'actorUserId', p_payload->>'correlationId', nullif(p_payload->>'requestId', ''),
    v_now, coalesce(p_payload->'metadata', '{}'::jsonb));
  return query select v_action, v_binding.id, v_identity.id, v_binding.customer_key, v_binding.project_code, true;
end;
$$;

create or replace function public.support_revoke_intake_identity_binding(p_payload jsonb)
returns table (action text, binding_id text, identity_id text, customer_key text, project_code text, active boolean)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_binding public.integration_identity_bindings%rowtype; v_now timestamptz := (p_payload->>'appliedAt')::timestamptz;
begin
  if coalesce(p_payload->>'appliedAt', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_BINDING_INVALID'; end if;
  perform pg_advisory_xact_lock(hashtextextended('intake-binding:' || (p_payload->>'identityId'), 0));
  select * into v_binding from public.integration_identity_bindings binding_record where binding_record.identity_id = p_payload->>'identityId' order by binding_record.updated_at desc limit 1 for update;
  if v_binding.id is null then raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_BINDING_INVALID'; end if;
  if v_binding.status = 'revoked' then return query select 'unchanged', v_binding.id, v_binding.identity_id, v_binding.customer_key, v_binding.project_code, false; return; end if;
  update public.integration_identity_bindings as binding_record set status = 'revoked', revoked_by_user_id = p_payload->>'actorUserId', revoked_at = v_now, updated_at = v_now where binding_record.id = v_binding.id returning * into v_binding;
  update public.integration_external_identities as identity_record set status = 'revoked', updated_at = v_now where identity_record.id = v_binding.identity_id;
  insert into public.integration_identity_binding_events (id, binding_id, identity_id, action, previous_customer_key,
    actor_user_id, correlation_id, request_id, created_at, metadata)
  values (p_payload->>'eventId', v_binding.id, v_binding.identity_id, 'revoked', v_binding.customer_key,
    p_payload->>'actorUserId', p_payload->>'correlationId', nullif(p_payload->>'requestId', ''), v_now, coalesce(p_payload->'metadata', '{}'::jsonb));
  return query select 'revoked', v_binding.id, v_binding.identity_id, v_binding.customer_key, v_binding.project_code, false;
end;
$$;

create or replace function public.support_transition_intake_session(p_payload jsonb)
returns table (id text, conversation_id text, status text, version integer, state_data jsonb, missing_fields jsonb,
  started_at text, expires_at text, confirmed_at text, cancelled_at text, failed_at text, updated_at text)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_session public.intake_sessions%rowtype; v_target text := p_payload->>'targetStatus'; v_now timestamptz := (p_payload->>'occurredAt')::timestamptz; v_key text;
begin
  if coalesce(p_payload->>'occurredAt', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    or jsonb_typeof(coalesce(p_payload->'statePatch', '{}'::jsonb)) <> 'object'
    or octet_length(coalesce(p_payload->'statePatch', '{}'::jsonb)::text) > 32768
    or jsonb_typeof(coalesce(p_payload->'missingFields', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_payload->'missingFields', '[]'::jsonb)) > 50 then
    raise exception using errcode = '22023', message = 'INTAKE_SESSION_TRANSITION_INVALID';
  end if;
  for v_key in select jsonb_object_keys(coalesce(p_payload->'statePatch', '{}'::jsonb)) loop
    if v_key not in ('selectedCustomerKey', 'projectCode', 'systemKey', 'requestType', 'description', 'impact', 'urgency', 'attachmentIds', 'summary') then
      raise exception using errcode = '22023', message = 'INTAKE_SESSION_TRANSITION_INVALID';
    end if;
  end loop;
  select * into v_session from public.intake_sessions session_record where session_record.id = p_payload->>'sessionId' for update;
  if v_session.id is null then raise exception using errcode = '22023', message = 'INTAKE_SESSION_NOT_FOUND'; end if;
  if v_session.version <> (p_payload->>'expectedVersion')::integer then raise exception using errcode = '40001', message = 'INTAKE_SESSION_VERSION_CONFLICT'; end if;
  if not ((v_session.status = 'draft' and v_target in ('collecting', 'cancelled'))
    or (v_session.status = 'collecting' and v_target in ('awaiting_confirmation', 'cancelled', 'expired', 'failed'))
    or (v_session.status = 'awaiting_confirmation' and v_target in ('collecting', 'confirmed', 'cancelled', 'expired', 'failed'))
    or (v_session.status = 'failed' and v_target = 'collecting')) then
    raise exception using errcode = '22023', message = 'INTAKE_SESSION_TRANSITION_INVALID';
  end if;
  update public.intake_sessions as session_record set status = v_target, version = session_record.version + 1,
    state_data = session_record.state_data || coalesce(p_payload->'statePatch', '{}'::jsonb), missing_fields = coalesce(p_payload->'missingFields', '[]'::jsonb),
    confirmed_at = case when v_target = 'confirmed' then v_now else session_record.confirmed_at end,
    cancelled_at = case when v_target = 'cancelled' then v_now else session_record.cancelled_at end,
    failed_at = case when v_target = 'failed' then v_now when v_target = 'collecting' then null else session_record.failed_at end,
    updated_at = v_now where session_record.id = v_session.id returning * into v_session;
  return query select v_session.id, v_session.conversation_id, v_session.status, v_session.version, v_session.state_data,
    v_session.missing_fields, public.support_intake_canonical_utc_iso(v_session.started_at), public.support_intake_canonical_utc_iso(v_session.expires_at),
    public.support_intake_canonical_utc_iso(v_session.confirmed_at), public.support_intake_canonical_utc_iso(v_session.cancelled_at),
    public.support_intake_canonical_utc_iso(v_session.failed_at), public.support_intake_canonical_utc_iso(v_session.updated_at);
end;
$$;

create or replace function public.support_enqueue_integration_outbox(p_payload jsonb)
returns table (action text, command_id text, status text, attempt_count integer)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_command public.integration_outbox%rowtype; v_payload jsonb := coalesce(p_payload->'payload', '{}'::jsonb); v_now timestamptz := (p_payload->>'availableAt')::timestamptz;
begin
  if coalesce(p_payload->>'availableAt', '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'
    or jsonb_typeof(v_payload) <> 'object' or octet_length(v_payload::text) > 65536
    or v_payload::text ~* '"(authorization|cookie|password|secret|token|access[_-]?token|refresh[_-]?token|api[_-]?key|signed[_-]?url)"\s*:' then
    raise exception using errcode = '22023', message = 'INTEGRATION_OUTBOX_PAYLOAD_INVALID';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('intake-outbox:' || (p_payload->>'idempotencyKey'), 0));
  select * into v_command from public.integration_outbox command_record where command_record.idempotency_key = p_payload->>'idempotencyKey' for update;
  if v_command.id is not null then
    if v_command.target_provider = p_payload->>'targetProvider' and v_command.command_type = p_payload->>'commandType'
      and coalesce(v_command.channel_id, '') = coalesce(p_payload->>'channelId', '')
      and coalesce(v_command.conversation_id, '') = coalesce(p_payload->>'conversationId', '')
      and coalesce(v_command.message_id, '') = coalesce(p_payload->>'messageId', '')
      and coalesce(v_command.ticket_id, '') = coalesce(p_payload->>'ticketId', '')
      and v_command.payload = v_payload and v_command.available_at = v_now
      and v_command.max_attempts = coalesce((p_payload->>'maxAttempts')::integer, 5) then
      return query select 'unchanged', v_command.id, v_command.status, v_command.attempt_count; return;
    end if;
    raise exception using errcode = '23505', message = 'INTEGRATION_OUTBOX_IDEMPOTENCY_CONFLICT';
  end if;
  insert into public.integration_outbox (id, target_provider, command_type, idempotency_key, channel_id,
    conversation_id, message_id, ticket_id, status, payload, attempt_count, max_attempts, available_at,
    correlation_id, request_id, metadata, created_at, updated_at)
  values (p_payload->>'id', p_payload->>'targetProvider', p_payload->>'commandType', p_payload->>'idempotencyKey',
    nullif(p_payload->>'channelId', ''), nullif(p_payload->>'conversationId', ''), nullif(p_payload->>'messageId', ''),
    nullif(p_payload->>'ticketId', ''), 'pending', v_payload, 0, coalesce((p_payload->>'maxAttempts')::integer, 5), v_now,
    p_payload->>'correlationId', nullif(p_payload->>'requestId', ''), coalesce(p_payload->'metadata', '{}'::jsonb), v_now, v_now)
  returning * into v_command;
  return query select 'created', v_command.id, v_command.status, v_command.attempt_count;
end;
$$;

revoke all privileges on function public.support_intake_canonical_utc_iso(timestamptz) from public;
revoke execute on function public.support_intake_canonical_utc_iso(timestamptz) from anon, authenticated;
grant execute on function public.support_intake_canonical_utc_iso(timestamptz) to service_role;

revoke all privileges on function public.support_get_intake_operations_summary() from public;
revoke execute on function public.support_get_intake_operations_summary() from anon, authenticated;
grant execute on function public.support_get_intake_operations_summary() to service_role;

revoke all privileges on function public.support_accept_intake_event(jsonb) from public;
revoke execute on function public.support_accept_intake_event(jsonb) from anon, authenticated;
grant execute on function public.support_accept_intake_event(jsonb) to service_role;

revoke all privileges on function public.support_apply_intake_identity_binding(jsonb) from public;
revoke execute on function public.support_apply_intake_identity_binding(jsonb) from anon, authenticated;
grant execute on function public.support_apply_intake_identity_binding(jsonb) to service_role;

revoke all privileges on function public.support_revoke_intake_identity_binding(jsonb) from public;
revoke execute on function public.support_revoke_intake_identity_binding(jsonb) from anon, authenticated;
grant execute on function public.support_revoke_intake_identity_binding(jsonb) to service_role;

revoke all privileges on function public.support_transition_intake_session(jsonb) from public;
revoke execute on function public.support_transition_intake_session(jsonb) from anon, authenticated;
grant execute on function public.support_transition_intake_session(jsonb) to service_role;

revoke all privileges on function public.support_enqueue_integration_outbox(jsonb) from public;
revoke execute on function public.support_enqueue_integration_outbox(jsonb) from anon, authenticated;
grant execute on function public.support_enqueue_integration_outbox(jsonb) to service_role;

comment on table public.integration_external_identities is 'Server-only external identity values. Browser APIs must expose masked representations only.';
comment on table public.intake_attachments is 'Attachment metadata only. AI-1.3 stores no bytes, Base64, signed URL, or local path.';
comment on table public.integration_outbox is 'Durable outbound command intent only. AI-1.3 has no processor or network execution.';

insert into public.support_schema_migrations (version, description, checksum, applied_by)
values ('202607220001', 'AI-1.3 unified intake core', null, current_user)
on conflict (version) do nothing;

commit;
