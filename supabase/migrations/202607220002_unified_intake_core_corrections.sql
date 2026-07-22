-- SUPPER AI-1.3.1: replay integrity, bounded operations, and durable transition history.
-- This immutable correction assumes 202607220001 may already be applied. It adds
-- no provider transport, Ticket creation, object bytes, worker, or outbound call.

begin;

create or replace function public.support_intake_normalize_key(p_value text)
returns text language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
  select btrim(regexp_replace(regexp_replace(lower(regexp_replace(regexp_replace(p_value,
    '([A-Z]+)([A-Z][a-z])', '\1 \2', 'g'), '([a-z0-9])([A-Z])', '\1 \2', 'g')),
    '[[:space:]_.:\-]+', ' ', 'g'), '[^a-z0-9 ]', ' ', 'g'));
$$;

create or replace function public.support_intake_key_is_unsafe(p_value text)
returns boolean language plpgsql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_normalized text;
  v_words text[];
begin
  if p_value is null or p_value = '' or p_value in ('__proto__','constructor','prototype')
    or p_value !~ '^[ -~]+$' or p_value ~ '[[:cntrl:]]' then return true; end if;
  v_normalized := public.support_intake_normalize_key(p_value);
  if v_normalized in ('raw payload', 'webhook body', 'raw headers', 'authorization headers', 'complete profile', 'raw event') then return true; end if;
  v_words := regexp_split_to_array(v_normalized, ' +');
  if v_words && array['authorization','authentication','credential','credentials','cookie','password','passphrase','secret','token','bearer'] then return true; end if;
  if 'signed' = any(v_words) and 'url' = any(v_words) then return true; end if;
  return (' ' || v_normalized || ' ') like any (array[
    '% access token %','% refresh token %','% api key %','% private key %','% client secret %',
    '% channel secret %','% channel access token %','% signed url %','% signature secret %',
    '% webhook secret %','% session secret %','% service role key %','% authentication credential %'
  ]);
end;
$$;

create or replace function public.support_intake_json_has_unsafe_key(p_value jsonb)
returns boolean language plpgsql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
declare v_key text; v_child jsonb;
begin
  if p_value is null then return false; end if;
  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select key, value from jsonb_each(p_value) loop
      if public.support_intake_key_is_unsafe(v_key) or public.support_intake_json_has_unsafe_key(v_child) then return true; end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value) loop
      if public.support_intake_json_has_unsafe_key(v_child) then return true; end if;
    end loop;
  end if;
  return false;
end;
$$;

create or replace function public.support_intake_json_keys_allowed(p_value jsonb, p_allowed text[])
returns boolean language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_typeof(p_value) = 'object'
    and not public.support_intake_json_has_unsafe_key(p_value)
    and not exists (select 1 from jsonb_object_keys(p_value) key_name where not (key_name = any(p_allowed)));
$$;

create or replace function public.support_intake_parse_timestamp(p_value text, p_code text)
returns timestamptz language plpgsql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
declare v_result timestamptz;
begin
  if coalesce(p_value, '') !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' then
    raise exception using errcode = '22023', message = p_code;
  end if;
  begin v_result := p_value::timestamptz;
  exception when others then raise exception using errcode = '22023', message = p_code; end;
  return v_result;
end;
$$;

create or replace function public.support_intake_parse_integer(p_value text, p_min integer, p_max integer, p_code text)
returns integer language plpgsql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
declare v_result integer;
begin
  if coalesce(p_value, '') !~ '^\d{1,10}$' then raise exception using errcode = '22023', message = p_code; end if;
  begin v_result := p_value::integer;
  exception when others then raise exception using errcode = '22023', message = p_code; end;
  if v_result < p_min or v_result > p_max then raise exception using errcode = '22023', message = p_code; end if;
  return v_result;
end;
$$;

create or replace function public.support_intake_parse_bigint(p_value text, p_min bigint, p_max bigint, p_code text)
returns bigint language plpgsql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
declare v_result bigint;
begin
  if coalesce(p_value, '') !~ '^\d{1,20}$' then raise exception using errcode = '22023', message = p_code; end if;
  begin v_result := p_value::bigint;
  exception when others then raise exception using errcode = '22023', message = p_code; end;
  if v_result < p_min or v_result > p_max then raise exception using errcode = '22023', message = p_code; end if;
  return v_result;
end;
$$;

create or replace function public.support_intake_canonical_json(p_value jsonb)
returns text language plpgsql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
declare v_result text;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || public.support_intake_canonical_json(value), ',' order by key collate "C"), '') || '}'
      into v_result from jsonb_each(p_value);
    when 'array' then
      select '[' || coalesce(string_agg(public.support_intake_canonical_json(value), ',' order by ordinal), '') || ']'
      into v_result from jsonb_array_elements(p_value) with ordinality element(value, ordinal);
    else v_result := p_value::text;
  end case;
  return v_result;
end;
$$;

create or replace function public.support_intake_attachment_material(p_attachment jsonb)
returns jsonb language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'externalAttachmentId', nullif(p_attachment->>'externalAttachmentId', ''),
    'fileName', p_attachment->>'fileName', 'contentType', p_attachment->>'contentType',
    'declaredSize', p_attachment->'declaredSize', 'sha256', nullif(p_attachment->>'sha256', ''),
    'providerLocator', nullif(p_attachment->>'providerLocator', ''),
    'storageStatus', coalesce(p_attachment->>'storageStatus', 'declared'),
    'scanStatus', coalesce(p_attachment->>'scanStatus', 'not_scanned'),
    'retentionUntil', nullif(p_attachment->>'retentionUntil', ''),
    'metadata', coalesce(p_attachment->'metadata', '{}'::jsonb)
  );
$$;

create or replace function public.support_intake_sorted_attachment_material(p_payload jsonb)
returns jsonb language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(jsonb_agg(material order by public.support_intake_canonical_json(material) collate "C"), '[]'::jsonb)
  from (select public.support_intake_attachment_material(value) material from jsonb_array_elements(coalesce(p_payload->'attachments', '[]'::jsonb))) items;
$$;

create or replace function public.support_intake_message_material(p_payload jsonb)
returns jsonb language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'channel', jsonb_build_object('id', p_payload#>>'{channel,id}', 'provider', p_payload#>>'{channel,provider}', 'channelKey', p_payload#>>'{channel,channelKey}'),
    'externalConversationId', p_payload#>>'{conversation,externalConversationId}',
    'externalMessageId', p_payload#>>'{message,externalMessageId}',
    'senderExternalSubjectId', p_payload#>>'{identity,externalSubjectId}',
    'direction', p_payload#>>'{message,direction}', 'messageType', p_payload#>>'{message,messageType}',
    'replyToMessageId', nullif(p_payload#>>'{message,replyToMessageId}', ''),
    'bodyText', coalesce(p_payload#>>'{message,bodyText}', ''), 'bodyHtml', coalesce(p_payload#>>'{message,bodyHtml}', ''),
    'structuredContent', coalesce(p_payload#>'{message,structuredContent}', '{}'::jsonb),
    'providerSentAt', nullif(p_payload#>>'{message,providerSentAt}', ''),
    'attachments', public.support_intake_sorted_attachment_material(p_payload)
  );
$$;

create or replace function public.support_intake_event_material(p_payload jsonb)
returns jsonb language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'channel', jsonb_build_object('id', p_payload#>>'{channel,id}', 'provider', p_payload#>>'{channel,provider}', 'channelKey', p_payload#>>'{channel,channelKey}'),
    'externalEventId', p_payload#>>'{event,externalEventId}', 'eventType', p_payload#>>'{event,eventType}',
    'eventMetadata', coalesce(p_payload#>'{event,metadata}', '{}'::jsonb),
    'externalIdentity', jsonb_build_object('externalSubjectId', p_payload#>>'{identity,externalSubjectId}',
      'displayName', coalesce(p_payload#>>'{identity,displayName}', ''), 'identityType', p_payload#>>'{identity,identityType}',
      'metadata', coalesce(p_payload#>'{identity,metadata}', '{}'::jsonb)),
    'conversation', jsonb_build_object('externalConversationId', p_payload#>>'{conversation,externalConversationId}',
      'subject', coalesce(p_payload#>>'{conversation,subject}', ''), 'openedAt', p_payload#>>'{conversation,openedAt}',
      'lastActivityAt', p_payload#>>'{conversation,lastActivityAt}', 'metadata', coalesce(p_payload#>'{conversation,metadata}', '{}'::jsonb)),
    'message', public.support_intake_message_material(p_payload),
    'attachments', public.support_intake_sorted_attachment_material(p_payload),
    'initializeSession', case when p_payload ? 'initializeSession' then jsonb_build_object(
      'status', p_payload#>>'{initializeSession,status}', 'stateData', coalesce(p_payload#>'{initializeSession,stateData}', '{}'::jsonb),
      'missingFields', coalesce(p_payload#>'{initializeSession,missingFields}', '[]'::jsonb),
      'startedAt', p_payload#>>'{initializeSession,startedAt}', 'expiresAt', nullif(p_payload#>>'{initializeSession,expiresAt}', ''),
      'metadata', coalesce(p_payload#>'{initializeSession,metadata}', '{}'::jsonb)) else null end
  );
$$;

alter table public.intake_events add column if not exists duplicate_delivery_count integer not null default 0 check (duplicate_delivery_count >= 0);
alter table public.intake_attachments add column if not exists canonical_hash text;

update public.intake_attachments attachment_record set canonical_hash = encode(digest(public.support_intake_canonical_json(jsonb_build_object(
  'externalAttachmentId', attachment_record.external_attachment_id, 'fileName', attachment_record.file_name,
  'contentType', attachment_record.content_type, 'declaredSize', attachment_record.declared_size,
  'sha256', attachment_record.sha256, 'providerLocator', attachment_record.provider_locator,
  'storageStatus', attachment_record.storage_status, 'scanStatus', attachment_record.scan_status,
  'retentionUntil', case when attachment_record.retention_until is null then null else public.support_intake_canonical_utc_iso(attachment_record.retention_until) end,
  'metadata', attachment_record.metadata
)), 'sha256'), 'hex') where canonical_hash is null;

alter table public.intake_attachments alter column canonical_hash set not null;
alter table public.intake_attachments drop constraint if exists intake_attachments_canonical_hash_check;
alter table public.intake_attachments add constraint intake_attachments_canonical_hash_check check (canonical_hash ~ '^[a-f0-9]{64}$');

create table if not exists public.intake_conversation_events (
  id text primary key,
  conversation_id text not null references public.intake_conversations(id) on delete restrict,
  action text not null check (action in ('created','status_changed','reopened','message_activity','linked','closed','archived')),
  previous_status text, new_status text,
  previous_version integer, new_version integer,
  actor_user_id text, correlation_id text, request_id text,
  occurred_at timestamptz not null,
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384)
);

create table if not exists public.intake_session_events (
  id text primary key,
  session_id text not null references public.intake_sessions(id) on delete restrict,
  action text not null check (action in ('created','status_changed')),
  previous_status text, new_status text,
  previous_version integer, new_version integer,
  actor_user_id text, correlation_id text, request_id text,
  occurred_at timestamptz not null,
  changed_fields jsonb not null default '[]'::jsonb check (jsonb_typeof(changed_fields) = 'array' and jsonb_array_length(changed_fields) <= 16),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384)
);

create index if not exists intake_conversation_events_conversation_idx on public.intake_conversation_events(conversation_id, occurred_at, id);
create index if not exists intake_session_events_session_idx on public.intake_session_events(session_id, occurred_at, id);
create index if not exists intake_events_channel_duplicates_idx on public.intake_events(channel_id, last_seen_at desc) where duplicate_delivery_count > 0;

alter table public.intake_conversation_events enable row level security;
alter table public.intake_session_events enable row level security;
revoke all privileges on table public.intake_conversation_events, public.intake_session_events from public, anon, authenticated;
grant select, insert on table public.intake_conversation_events, public.intake_session_events to service_role;
revoke update, delete on table public.intake_conversation_events, public.intake_session_events from service_role;

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
    (select count(*)::integer from public.intake_events where processing_status = 'accepted' and first_processed_at >= now() - interval '24 hours'),
    (select coalesce(sum(duplicate_delivery_count), 0)::integer from public.intake_events where last_seen_at >= now() - interval '24 hours'),
    (select count(*)::integer from public.intake_events where processing_status = 'failed' and last_seen_at >= now() - interval '24 hours'),
    (select count(*)::integer from public.integration_outbox where status = 'pending'),
    (select count(*)::integer from public.integration_outbox where status = 'retrying'),
    (select count(*)::integer from public.integration_outbox where status = 'dead_letter'),
    coalesce((select jsonb_object_agg(storage_status, count_value) from (select storage_status, count(*)::integer count_value from public.intake_attachments group by storage_status) counts), '{}'::jsonb),
    coalesce((select jsonb_object_agg(scan_status, count_value) from (select scan_status, count(*)::integer count_value from public.intake_attachments group by scan_status) counts), '{}'::jsonb),
    public.support_intake_canonical_utc_iso((select max(last_activity_at) from public.intake_conversations));
$$;

create or replace function public.support_list_intake_identities(p_page integer, p_limit integer, p_status text default null, p_provider text default null)
returns table (identity_id text, external_subject_hash text, display_name text, identity_status text, last_seen_at text,
  provider text, channel_name text, customer_name text, project_code text, conversation_count bigint, total_count bigint)
language plpgsql security definer stable set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_page < 1 or p_page > 100000 or p_limit < 1 or p_limit > 100
    or (p_provider is not null and p_provider not in ('email','line','web','internal'))
    or (p_status is not null and p_status not in ('unlinked','pending','linked','revoked','blocked')) then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;
  return query
  select i.id, i.external_subject_hash, i.display_name, i.status, public.support_intake_canonical_utc_iso(i.last_seen_at),
    c.provider, c.display_name, customer.customer_name, coalesce(binding.project_code, ''),
    coalesce(conversations.conversation_count, 0), count(*) over()
  from public.integration_external_identities i
  join public.integration_channels c on c.id = i.channel_id
  left join public.integration_identity_bindings binding on binding.identity_id = i.id and binding.status = 'linked'
  left join public.support_customers customer on customer.customer_key = binding.customer_key
  left join lateral (select count(*)::bigint conversation_count from public.intake_conversations conversation where conversation.primary_identity_id = i.id) conversations on true
  where (p_status is null or i.status = p_status) and (p_provider is null or c.provider = p_provider)
  order by i.last_seen_at desc, i.id
  limit p_limit offset ((p_page - 1) * p_limit);
end;
$$;

create or replace function public.support_list_intake_conversations(p_page integer, p_limit integer, p_status text default null, p_provider text default null)
returns table (conversation_id text, provider text, channel_name text, external_subject_hash text, subject text,
  conversation_status text, message_count bigint, attachment_count bigint, session_status text,
  ticket_links jsonb, last_activity_at text, total_count bigint)
language plpgsql security definer stable set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_page < 1 or p_page > 100000 or p_limit < 1 or p_limit > 100
    or (p_provider is not null and p_provider not in ('email','line','web','internal'))
    or (p_status is not null and p_status not in ('open','awaiting_customer','awaiting_agent','linked','closed','archived')) then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;
  return query
  select conversation.id, channel.provider, channel.display_name, identity.external_subject_hash, conversation.subject,
    conversation.status, coalesce(messages.message_count, 0), coalesce(attachments.attachment_count, 0), latest_session.status,
    coalesce(links.items, '[]'::jsonb), public.support_intake_canonical_utc_iso(conversation.last_activity_at), count(*) over()
  from public.intake_conversations conversation
  join public.integration_channels channel on channel.id = conversation.channel_id
  left join public.integration_external_identities identity on identity.id = conversation.primary_identity_id
  left join lateral (select count(*)::bigint message_count from public.intake_messages message where message.conversation_id = conversation.id) messages on true
  left join lateral (select count(*)::bigint attachment_count from public.intake_attachments attachment where attachment.conversation_id = conversation.id) attachments on true
  left join lateral (select session.status from public.intake_sessions session where session.conversation_id = conversation.id order by session.updated_at desc, session.id limit 1) latest_session on true
  left join lateral (select jsonb_agg(jsonb_build_object('ticketId', bounded.ticket_id, 'relationship', bounded.relationship) order by bounded.created_at, bounded.ticket_id) items
    from (select link.ticket_id, link.relationship, link.created_at from public.intake_ticket_links link where link.conversation_id = conversation.id order by link.created_at, link.ticket_id limit 10) bounded) links on true
  where (p_status is null or conversation.status = p_status) and (p_provider is null or channel.provider = p_provider)
  order by conversation.last_activity_at desc, conversation.id
  limit p_limit offset ((p_page - 1) * p_limit);
end;
$$;

create or replace function public.support_list_intake_events(p_page integer, p_limit integer, p_status text default null, p_provider text default null)
returns table (event_id text, channel_id text, provider text, event_type text, processing_status text, redelivery boolean,
  delivery_count integer, duplicate_delivery_count integer, correlation_id text, received_at text,
  first_processed_at text, last_seen_at text, safe_error_code text, total_count bigint)
language plpgsql security definer stable set search_path = pg_catalog, public, pg_temp
as $$
begin
  if p_page < 1 or p_page > 100000 or p_limit < 1 or p_limit > 100
    or (p_provider is not null and p_provider not in ('email','line','web','internal'))
    or (p_status is not null and p_status not in ('received','accepted','rejected','failed')) then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;
  return query select event.id, event.channel_id, channel.provider, event.event_type, event.processing_status,
    event.redelivery, event.delivery_count, event.duplicate_delivery_count, event.correlation_id,
    public.support_intake_canonical_utc_iso(event.received_at), public.support_intake_canonical_utc_iso(event.first_processed_at),
    public.support_intake_canonical_utc_iso(event.last_seen_at), event.safe_error_code, count(*) over()
  from public.intake_events event join public.integration_channels channel on channel.id = event.channel_id
  where (p_status is null or event.processing_status = p_status) and (p_provider is null or channel.provider = p_provider)
  order by event.received_at desc, event.id limit p_limit offset ((p_page - 1) * p_limit);
end;
$$;

create or replace function public.support_intake_persisted_message_material(p_message_id text)
returns jsonb language sql stable set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'channel', jsonb_build_object('id', channel.id, 'provider', channel.provider, 'channelKey', channel.channel_key),
    'externalConversationId', conversation.external_conversation_id,
    'externalMessageId', message.external_message_id,
    'senderExternalSubjectId', identity.external_subject_id,
    'direction', message.direction, 'messageType', message.message_type,
    'replyToMessageId', message.reply_to_message_id,
    'bodyText', message.body_text, 'bodyHtml', message.body_html,
    'structuredContent', message.structured_content,
    'providerSentAt', case when message.provider_sent_at is null then null else public.support_intake_canonical_utc_iso(message.provider_sent_at) end,
    'attachments', coalesce(attachments.items, '[]'::jsonb)
  )
  from public.intake_messages message
  join public.integration_channels channel on channel.id = message.channel_id
  join public.intake_conversations conversation on conversation.id = message.conversation_id
  left join public.integration_external_identities identity on identity.id = message.sender_identity_id
  left join lateral (
    select jsonb_agg(material order by public.support_intake_canonical_json(material) collate "C") items
    from (
      select jsonb_build_object(
        'externalAttachmentId', attachment.external_attachment_id, 'fileName', attachment.file_name,
        'contentType', attachment.content_type, 'declaredSize', attachment.declared_size,
        'sha256', attachment.sha256, 'providerLocator', attachment.provider_locator,
        'storageStatus', attachment.storage_status, 'scanStatus', attachment.scan_status,
        'retentionUntil', case when attachment.retention_until is null then null else public.support_intake_canonical_utc_iso(attachment.retention_until) end,
        'metadata', attachment.metadata
      ) material
      from public.intake_attachments attachment where attachment.message_id = message.id
    ) stored_attachments
  ) attachments on true
  where message.id = p_message_id;
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
  v_existing_attachment public.intake_attachments%rowtype;
  v_attachment jsonb;
  v_attachment_count integer := 0;
  v_now timestamptz;
  v_opened_at timestamptz;
  v_last_activity_at timestamptz;
  v_message_received_at timestamptz;
  v_message_stored_at timestamptz;
  v_message_provider_sent_at timestamptz;
  v_attachment_retention_until timestamptz;
  v_attachment_size bigint;
  v_message_hash text;
  v_event_hash text;
  v_identity_hash text;
  v_attachment_hash text;
  v_stored_message_hash text;
  v_previous_status text;
  v_new_status text;
  v_previous_version integer;
  v_metadata jsonb;
begin
  if jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 1000000
    or public.support_intake_json_has_unsafe_key(p_payload)
    or not public.support_intake_json_keys_allowed(coalesce(p_payload#>'{event,metadata}', '{}'::jsonb), array['diagnostic','source','compatibilitySource','adapterVersion'])
    or not public.support_intake_json_keys_allowed(coalesce(p_payload#>'{identity,metadata}', '{}'::jsonb), array['diagnostic','source'])
    or not public.support_intake_json_keys_allowed(coalesce(p_payload#>'{conversation,metadata}', '{}'::jsonb), array['diagnostic','source'])
    or not public.support_intake_json_keys_allowed(coalesce(p_payload#>'{message,metadata}', '{}'::jsonb), array['diagnostic','source'])
    or jsonb_typeof(coalesce(p_payload#>'{message,structuredContent}', '{}'::jsonb)) <> 'object'
    or octet_length(coalesce(p_payload#>'{message,structuredContent}', '{}'::jsonb)::text) > 32768
    or jsonb_typeof(coalesce(p_payload->'attachments', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_payload->'attachments', '[]'::jsonb)) > 50 then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;
  if coalesce(p_payload#>>'{channel,id}', '') = '' or p_payload#>>'{channel,provider}' not in ('email','line','web','internal')
    or coalesce(p_payload#>>'{channel,channelKey}', '') = '' or coalesce(p_payload#>>'{event,id}', '') = ''
    or coalesce(p_payload#>>'{event,externalEventId}', '') = ''
    or p_payload#>>'{event,eventType}' not in ('message.received','message.updated','conversation.started')
    or coalesce(p_payload#>>'{identity,id}', '') = '' or coalesce(p_payload#>>'{identity,externalSubjectId}', '') = ''
    or p_payload#>>'{identity,identityType}' not in ('user','contact','mailbox','system','anonymous')
    or coalesce(p_payload#>>'{conversation,id}', '') = '' or coalesce(p_payload#>>'{conversation,externalConversationId}', '') = ''
    or coalesce(p_payload#>>'{message,id}', '') = '' or coalesce(p_payload#>>'{message,externalMessageId}', '') = ''
    or p_payload#>>'{message,direction}' not in ('inbound','outbound','internal')
    or p_payload#>>'{message,messageType}' not in ('text','html','image','file','video','audio','location','sticker','structured','system')
    or p_payload#>>'{message,status}' not in ('received','validated','stored','rejected','failed')
    or coalesce(p_payload#>>'{event,payloadHash}', '') !~ '^[a-f0-9]{64}$'
    or coalesce(p_payload#>>'{message,contentHash}', '') !~ '^[a-f0-9]{64}$'
    or coalesce(p_payload#>>'{identity,externalSubjectHash}', '') !~ '^[a-f0-9]{64}$' then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;
  if p_payload ? 'initializeSession' then
    if p_payload#>>'{initializeSession,status}' not in ('draft','collecting')
      or jsonb_typeof(coalesce(p_payload#>'{initializeSession,stateData}', '{}'::jsonb)) <> 'object'
      or not public.support_intake_json_keys_allowed(coalesce(p_payload#>'{initializeSession,stateData}', '{}'::jsonb), array['selectedCustomerKey','projectCode','systemKey','requestType','description','impact','urgency','attachmentIds','summary'])
      or jsonb_typeof(coalesce(p_payload#>'{initializeSession,missingFields}', '[]'::jsonb)) <> 'array'
      or jsonb_array_length(coalesce(p_payload#>'{initializeSession,missingFields}', '[]'::jsonb)) > 50
      or not public.support_intake_json_keys_allowed(coalesce(p_payload#>'{initializeSession,metadata}', '{}'::jsonb), array['diagnostic','source']) then
      raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
    end if;
  end if;
  for v_attachment in select value from jsonb_array_elements(coalesce(p_payload->'attachments', '[]'::jsonb)) loop
    if jsonb_typeof(v_attachment) <> 'object' or coalesce(v_attachment->>'id', '') = ''
      or coalesce(v_attachment->>'fileName', '') = '' or v_attachment->>'fileName' ~ '[\\/]'
      or coalesce(v_attachment->>'contentType', '') !~ '^[A-Za-z0-9!#$&^_.+-]+/[A-Za-z0-9!#$&^_.+-]+$'
      or (nullif(v_attachment->>'sha256','') is not null and v_attachment->>'sha256' !~ '^[a-f0-9]{64}$')
      or not public.support_intake_json_keys_allowed(coalesce(v_attachment->'metadata', '{}'::jsonb), array['diagnostic','source','disposition','ordinal']) then
      raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
    end if;
    v_attachment_size := public.support_intake_parse_bigint(v_attachment->>'declaredSize', 0, 262144000, 'INTAKE_PAYLOAD_INVALID');
    if nullif(v_attachment->>'retentionUntil','') is not null then
      v_attachment_retention_until := public.support_intake_parse_timestamp(v_attachment->>'retentionUntil', 'INTAKE_PAYLOAD_INVALID');
    end if;
  end loop;

  v_now := public.support_intake_parse_timestamp(p_payload#>>'{event,receivedAt}', 'INTAKE_PAYLOAD_INVALID');
  v_opened_at := public.support_intake_parse_timestamp(p_payload#>>'{conversation,openedAt}', 'INTAKE_PAYLOAD_INVALID');
  v_last_activity_at := public.support_intake_parse_timestamp(p_payload#>>'{conversation,lastActivityAt}', 'INTAKE_PAYLOAD_INVALID');
  v_message_received_at := public.support_intake_parse_timestamp(p_payload#>>'{message,receivedAt}', 'INTAKE_PAYLOAD_INVALID');
  if nullif(p_payload#>>'{message,storedAt}','') is not null then v_message_stored_at := public.support_intake_parse_timestamp(p_payload#>>'{message,storedAt}', 'INTAKE_PAYLOAD_INVALID'); end if;
  if nullif(p_payload#>>'{message,providerSentAt}','') is not null then v_message_provider_sent_at := public.support_intake_parse_timestamp(p_payload#>>'{message,providerSentAt}', 'INTAKE_PAYLOAD_INVALID'); end if;
  if p_payload ? 'initializeSession' then
    perform public.support_intake_parse_timestamp(p_payload#>>'{initializeSession,startedAt}', 'INTAKE_PAYLOAD_INVALID');
    if nullif(p_payload#>>'{initializeSession,expiresAt}','') is not null then perform public.support_intake_parse_timestamp(p_payload#>>'{initializeSession,expiresAt}', 'INTAKE_PAYLOAD_INVALID'); end if;
  end if;

  v_identity_hash := encode(digest(p_payload#>>'{identity,externalSubjectId}', 'sha256'), 'hex');
  v_message_hash := encode(digest(public.support_intake_canonical_json(public.support_intake_message_material(p_payload)), 'sha256'), 'hex');
  v_event_hash := encode(digest(public.support_intake_canonical_json(public.support_intake_event_material(p_payload)), 'sha256'), 'hex');
  if v_identity_hash <> p_payload#>>'{identity,externalSubjectHash}' then raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_HASH_MISMATCH'; end if;
  if v_message_hash <> p_payload#>>'{message,contentHash}' or v_event_hash <> p_payload#>>'{event,payloadHash}' then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;

  select * into v_channel from public.integration_channels channel_record
  where channel_record.id = p_payload#>>'{channel,id}' and channel_record.provider = p_payload#>>'{channel,provider}'
    and channel_record.channel_key = p_payload#>>'{channel,channelKey}' and channel_record.enabled;
  if v_channel.id is null then raise exception using errcode = '22023', message = 'INTAKE_CHANNEL_UNAVAILABLE'; end if;

  perform pg_advisory_xact_lock(hashtextextended('intake-event:' || v_channel.id || ':' || (p_payload#>>'{event,externalEventId}'), 0));
  select * into v_event from public.intake_events event_record
  where event_record.channel_id = v_channel.id and event_record.external_event_id = p_payload#>>'{event,externalEventId}' for update;
  if v_event.id is not null then
    if v_event.payload_hash <> v_event_hash then raise exception using errcode = '23505', message = 'INTAKE_EVENT_REPLAY_MISMATCH'; end if;
    update public.intake_events event_record set delivery_count = event_record.delivery_count + 1,
      duplicate_delivery_count = event_record.duplicate_delivery_count + 1, redelivery = true,
      last_seen_at = greatest(event_record.last_seen_at, v_now), updated_at = greatest(event_record.updated_at, v_now)
    where event_record.id = v_event.id returning * into v_event;
    return query select 'duplicate', v_event.id, v_event.metadata->>'identityId', v_event.metadata->>'conversationId',
      v_event.metadata->>'messageId', coalesce(public.support_intake_parse_integer(v_event.metadata->>'attachmentCount', 0, 50, 'INTAKE_STORAGE_ERROR'), 0),
      v_event.metadata->>'sessionId', v_event.delivery_count;
    return;
  end if;

  insert into public.intake_events (id, channel_id, external_event_id, event_type, payload_hash, processing_status,
    correlation_id, request_id, received_at, last_seen_at, metadata, created_at, updated_at)
  values (p_payload#>>'{event,id}', v_channel.id, p_payload#>>'{event,externalEventId}', p_payload#>>'{event,eventType}',
    v_event_hash, 'received', p_payload#>>'{event,correlationId}', nullif(p_payload#>>'{event,requestId}', ''),
    v_now, v_now, coalesce(p_payload#>'{event,metadata}', '{}'::jsonb), v_now, v_now) returning * into v_event;

  perform pg_advisory_xact_lock(hashtextextended('intake-message:' || v_channel.id || ':' || (p_payload#>>'{message,externalMessageId}'), 0));
  select * into v_message from public.intake_messages message_record
  where message_record.channel_id = v_channel.id and message_record.external_message_id = p_payload#>>'{message,externalMessageId}' for update;
  if v_message.id is not null then
    select * into v_conversation from public.intake_conversations conversation_record where conversation_record.id = v_message.conversation_id;
    select * into v_identity from public.integration_external_identities identity_record where identity_record.id = v_message.sender_identity_id;
    v_stored_message_hash := encode(digest(public.support_intake_canonical_json(public.support_intake_persisted_message_material(v_message.id)), 'sha256'), 'hex');
    if v_stored_message_hash <> v_message_hash or v_conversation.external_conversation_id <> p_payload#>>'{conversation,externalConversationId}'
      or v_identity.external_subject_id <> p_payload#>>'{identity,externalSubjectId}' or v_message.direction <> p_payload#>>'{message,direction}'
      or v_message.message_type <> p_payload#>>'{message,messageType}'
      or coalesce(v_message.reply_to_message_id, '') <> coalesce(p_payload#>>'{message,replyToMessageId}', '')
      or v_message.body_text <> coalesce(p_payload#>>'{message,bodyText}', '') or v_message.body_html <> coalesce(p_payload#>>'{message,bodyHtml}', '')
      or v_message.structured_content <> coalesce(p_payload#>'{message,structuredContent}', '{}'::jsonb)
      or coalesce(public.support_intake_canonical_utc_iso(v_message.provider_sent_at), '') <> coalesce(p_payload#>>'{message,providerSentAt}', '') then
      raise exception using errcode = '23505', message = 'INTAKE_MESSAGE_REPLAY_MISMATCH';
    end if;
    select count(*)::integer into v_attachment_count from public.intake_attachments attachment where attachment.message_id = v_message.id;
    select * into v_session from public.intake_sessions session_record where session_record.conversation_id = v_conversation.id
      and session_record.status in ('draft','collecting','awaiting_confirmation','failed') order by session_record.updated_at desc, session_record.id limit 1;
    update public.intake_events event_record set processing_status = 'accepted', first_processed_at = v_now,
      metadata = event_record.metadata || jsonb_build_object('identityId', v_identity.id, 'conversationId', v_conversation.id,
        'messageId', v_message.id, 'attachmentCount', v_attachment_count) || case when v_session.id is null then '{}'::jsonb else jsonb_build_object('sessionId', v_session.id) end,
      updated_at = v_now where event_record.id = v_event.id returning * into v_event;
    return query select 'duplicate_message', v_event.id, v_identity.id, v_conversation.id, v_message.id,
      v_attachment_count, v_session.id, v_event.delivery_count;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('intake-conversation:' || v_channel.id || ':' || (p_payload#>>'{conversation,externalConversationId}'), 0));
  perform pg_advisory_xact_lock(hashtextextended('intake-identity:' || v_channel.id || ':' || (p_payload#>>'{identity,externalSubjectId}'), 0));

  select * into v_identity from public.integration_external_identities identity_record
  where identity_record.channel_id = v_channel.id and identity_record.external_subject_id = p_payload#>>'{identity,externalSubjectId}' for update;
  if v_identity.id is null then
    insert into public.integration_external_identities (id, channel_id, external_subject_id, external_subject_hash,
      display_name, identity_type, status, first_seen_at, last_seen_at, metadata, created_at, updated_at)
    values (p_payload#>>'{identity,id}', v_channel.id, p_payload#>>'{identity,externalSubjectId}', v_identity_hash,
      coalesce(p_payload#>>'{identity,displayName}', ''), p_payload#>>'{identity,identityType}', 'unlinked', v_now, v_now,
      coalesce(p_payload#>'{identity,metadata}', '{}'::jsonb), v_now, v_now) returning * into v_identity;
  else
    if v_identity.external_subject_hash <> v_identity_hash or v_identity.identity_type <> p_payload#>>'{identity,identityType}' then
      raise exception using errcode = '23505', message = 'INTAKE_IDENTITY_HASH_MISMATCH';
    end if;
    update public.integration_external_identities identity_record set last_seen_at = greatest(identity_record.last_seen_at, v_now),
      display_name = coalesce(nullif(p_payload#>>'{identity,displayName}', ''), identity_record.display_name), updated_at = greatest(identity_record.updated_at, v_now)
    where identity_record.id = v_identity.id returning * into v_identity;
  end if;

  select * into v_conversation from public.intake_conversations conversation_record
  where conversation_record.channel_id = v_channel.id and conversation_record.external_conversation_id = p_payload#>>'{conversation,externalConversationId}' for update;
  if v_conversation.id is null then
    insert into public.intake_conversations (id, channel_id, external_conversation_id, primary_identity_id, status,
      subject, opened_at, last_activity_at, metadata, created_at, updated_at)
    values (p_payload#>>'{conversation,id}', v_channel.id, p_payload#>>'{conversation,externalConversationId}', v_identity.id,
      'open', coalesce(p_payload#>>'{conversation,subject}', ''), v_opened_at, v_last_activity_at,
      coalesce(p_payload#>'{conversation,metadata}', '{}'::jsonb), v_now, v_now) returning * into v_conversation;
    insert into public.intake_conversation_events (id, conversation_id, action, new_status, new_version, correlation_id, request_id, occurred_at, metadata)
    values ((p_payload#>>'{event,id}') || ':conversation-created', v_conversation.id, 'created', v_conversation.status,
      v_conversation.version, p_payload#>>'{event,correlationId}', nullif(p_payload#>>'{event,requestId}', ''), v_now, '{}'::jsonb);
  else
    v_previous_status := v_conversation.status; v_previous_version := v_conversation.version;
    v_new_status := case when v_conversation.status in ('closed','archived') then v_conversation.status
      when p_payload#>>'{message,direction}' = 'inbound' then 'awaiting_agent'
      when p_payload#>>'{message,direction}' = 'outbound' then 'awaiting_customer' else v_conversation.status end;
    update public.intake_conversations conversation_record set status = v_new_status,
      version = conversation_record.version + 1, last_activity_at = greatest(conversation_record.last_activity_at, v_last_activity_at),
      updated_at = greatest(conversation_record.updated_at, v_now)
    where conversation_record.id = v_conversation.id returning * into v_conversation;
    insert into public.intake_conversation_events (id, conversation_id, action, previous_status, new_status,
      previous_version, new_version, correlation_id, request_id, occurred_at, metadata)
    values ((p_payload#>>'{event,id}') || ':conversation-activity', v_conversation.id, 'message_activity',
      v_previous_status, v_conversation.status, v_previous_version, v_conversation.version,
      p_payload#>>'{event,correlationId}', nullif(p_payload#>>'{event,requestId}', ''), v_now, '{}'::jsonb);
  end if;

  if nullif(p_payload#>>'{message,replyToMessageId}', '') is not null and not exists (
    select 1 from public.intake_messages reply_message where reply_message.id = p_payload#>>'{message,replyToMessageId}' and reply_message.conversation_id = v_conversation.id
  ) then raise exception using errcode = '23503', message = 'INTAKE_REPLY_MESSAGE_INVALID'; end if;

  insert into public.intake_messages (id, channel_id, conversation_id, external_message_id, sender_identity_id,
    reply_to_message_id, direction, message_type, status, body_text, body_html, structured_content, content_hash,
    provider_sent_at, received_at, stored_at, metadata, created_at, updated_at)
  values (p_payload#>>'{message,id}', v_channel.id, v_conversation.id, p_payload#>>'{message,externalMessageId}', v_identity.id,
    nullif(p_payload#>>'{message,replyToMessageId}', ''), p_payload#>>'{message,direction}', p_payload#>>'{message,messageType}',
    p_payload#>>'{message,status}', coalesce(p_payload#>>'{message,bodyText}', ''), coalesce(p_payload#>>'{message,bodyHtml}', ''),
    coalesce(p_payload#>'{message,structuredContent}', '{}'::jsonb), v_message_hash, v_message_provider_sent_at,
    v_message_received_at, v_message_stored_at, coalesce(p_payload#>'{message,metadata}', '{}'::jsonb), v_now, v_now)
  returning * into v_message;

  for v_attachment in select value from jsonb_array_elements(coalesce(p_payload->'attachments', '[]'::jsonb)) loop
    v_attachment_size := public.support_intake_parse_bigint(v_attachment->>'declaredSize', 0, 262144000, 'INTAKE_PAYLOAD_INVALID');
    v_attachment_retention_until := case when nullif(v_attachment->>'retentionUntil','') is null then null else public.support_intake_parse_timestamp(v_attachment->>'retentionUntil', 'INTAKE_PAYLOAD_INVALID') end;
    v_attachment_hash := encode(digest(public.support_intake_canonical_json(public.support_intake_attachment_material(v_attachment)), 'sha256'), 'hex');
    if nullif(v_attachment->>'externalAttachmentId','') is not null then
      perform pg_advisory_xact_lock(hashtextextended('intake-attachment:' || v_channel.id || ':' || (v_attachment->>'externalAttachmentId'), 0));
      select * into v_existing_attachment from public.intake_attachments attachment_record
      where attachment_record.channel_id = v_channel.id and attachment_record.external_attachment_id = v_attachment->>'externalAttachmentId' for update;
      if v_existing_attachment.id is not null then
        if v_existing_attachment.message_id <> v_message.id or v_existing_attachment.conversation_id <> v_conversation.id
          or v_existing_attachment.canonical_hash <> v_attachment_hash then
          raise exception using errcode = '23505', message = 'INTAKE_ATTACHMENT_REPLAY_MISMATCH';
        end if;
        continue;
      end if;
    end if;
    insert into public.intake_attachments (id, channel_id, conversation_id, message_id, external_attachment_id,
      file_name, content_type, declared_size, sha256, provider_locator, storage_status, scan_status,
      retention_until, metadata, canonical_hash, created_at, updated_at)
    values (v_attachment->>'id', v_channel.id, v_conversation.id, v_message.id,
      nullif(v_attachment->>'externalAttachmentId', ''), v_attachment->>'fileName', v_attachment->>'contentType',
      v_attachment_size, nullif(v_attachment->>'sha256', ''), nullif(v_attachment->>'providerLocator', ''),
      coalesce(v_attachment->>'storageStatus', 'declared'), coalesce(v_attachment->>'scanStatus', 'not_scanned'),
      v_attachment_retention_until, coalesce(v_attachment->'metadata', '{}'::jsonb), v_attachment_hash, v_now, v_now);
    v_attachment_count := v_attachment_count + 1;
  end loop;

  if p_payload ? 'initializeSession' then
    select * into v_session from public.intake_sessions session_record where session_record.conversation_id = v_conversation.id
      and session_record.status in ('draft','collecting','awaiting_confirmation','failed') order by session_record.updated_at desc, session_record.id limit 1 for update;
    if v_session.id is null then
      insert into public.intake_sessions (id, conversation_id, status, state_data, missing_fields, started_at,
        expires_at, created_at, updated_at)
      values (p_payload#>>'{initializeSession,id}', v_conversation.id, p_payload#>>'{initializeSession,status}',
        coalesce(p_payload#>'{initializeSession,stateData}', '{}'::jsonb), coalesce(p_payload#>'{initializeSession,missingFields}', '[]'::jsonb),
        public.support_intake_parse_timestamp(p_payload#>>'{initializeSession,startedAt}', 'INTAKE_PAYLOAD_INVALID'),
        case when nullif(p_payload#>>'{initializeSession,expiresAt}','') is null then null else public.support_intake_parse_timestamp(p_payload#>>'{initializeSession,expiresAt}', 'INTAKE_PAYLOAD_INVALID') end,
        v_now, v_now) returning * into v_session;
      insert into public.intake_session_events (id, session_id, action, new_status, new_version, correlation_id, request_id,
        occurred_at, changed_fields, metadata)
      values (v_session.id || ':created', v_session.id, 'created', v_session.status, v_session.version,
        p_payload#>>'{event,correlationId}', nullif(p_payload#>>'{event,requestId}', ''), v_now,
        '["status","stateData","missingFields"]'::jsonb, coalesce(p_payload#>'{initializeSession,metadata}', '{}'::jsonb));
    end if;
  end if;

  update public.intake_events event_record set processing_status = 'accepted', first_processed_at = v_now, last_seen_at = v_now,
    metadata = event_record.metadata || jsonb_build_object('identityId', v_identity.id, 'conversationId', v_conversation.id,
      'messageId', v_message.id, 'attachmentCount', v_attachment_count) || case when v_session.id is null then '{}'::jsonb else jsonb_build_object('sessionId', v_session.id) end,
    updated_at = v_now where event_record.id = v_event.id returning * into v_event;

  return query select 'accepted', v_event.id, v_identity.id, v_conversation.id, v_message.id,
    v_attachment_count, v_session.id, v_event.delivery_count;
end;
$$;

create or replace function public.support_transition_intake_conversation(p_payload jsonb)
returns table (id text, status text, version integer, last_activity_at text, closed_at text, updated_at text)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_conversation public.intake_conversations%rowtype; v_target text; v_expected integer; v_now timestamptz;
  v_action text; v_explicit_reopen boolean; v_previous_status text;
begin
  if jsonb_typeof(p_payload) <> 'object' or public.support_intake_json_has_unsafe_key(p_payload)
    or coalesce(p_payload->>'eventId','') = '' or coalesce(p_payload->>'conversationId','') = ''
    or coalesce(p_payload->>'actorUserId','') = '' or coalesce(p_payload->>'correlationId','') = ''
    or not public.support_intake_json_keys_allowed(coalesce(p_payload->'metadata','{}'::jsonb), array['diagnostic','source']) then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;
  v_target := p_payload->>'targetStatus';
  if v_target not in ('open','awaiting_customer','awaiting_agent','linked','closed','archived') then raise exception using errcode = '22023', message = 'INTAKE_CONVERSATION_TRANSITION_INVALID'; end if;
  v_expected := public.support_intake_parse_integer(p_payload->>'expectedVersion', 1, 2147483647, 'INTAKE_PAYLOAD_INVALID');
  v_now := public.support_intake_parse_timestamp(p_payload->>'occurredAt', 'INTAKE_PAYLOAD_INVALID');
  if jsonb_typeof(coalesce(p_payload->'explicitReopen','false'::jsonb)) <> 'boolean' then raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID'; end if;
  v_explicit_reopen := coalesce((p_payload->>'explicitReopen')::boolean, false);
  perform pg_advisory_xact_lock(hashtextextended('intake-conversation-id:' || (p_payload->>'conversationId'), 0));
  select * into v_conversation from public.intake_conversations conversation_record where conversation_record.id = p_payload->>'conversationId' for update;
  if v_conversation.id is null then raise exception using errcode = 'P0002', message = 'INTAKE_CONVERSATION_NOT_FOUND'; end if;
  if v_conversation.version <> v_expected then raise exception using errcode = '40001', message = 'INTAKE_CONVERSATION_VERSION_CONFLICT'; end if;
  v_previous_status := v_conversation.status;
  if v_previous_status = v_target then raise exception using errcode = '22023', message = 'INTAKE_CONVERSATION_TRANSITION_INVALID'; end if;
  if not ((v_previous_status = 'open' and v_target in ('awaiting_customer','awaiting_agent','linked','closed'))
    or (v_previous_status = 'awaiting_customer' and v_target in ('open','awaiting_agent','linked','closed'))
    or (v_previous_status = 'awaiting_agent' and v_target in ('open','awaiting_customer','linked','closed'))
    or (v_previous_status = 'linked' and v_target in ('open','awaiting_customer','awaiting_agent','closed'))
    or (v_previous_status = 'closed' and v_target = 'archived')
    or (v_previous_status = 'closed' and v_target = 'open' and v_explicit_reopen)) then
    raise exception using errcode = '22023', message = 'INTAKE_CONVERSATION_TRANSITION_INVALID';
  end if;
  v_action := case when v_previous_status = 'closed' and v_target = 'open' then 'reopened'
    when v_target = 'closed' then 'closed' when v_target = 'archived' then 'archived'
    when v_target = 'linked' then 'linked' else 'status_changed' end;
  update public.intake_conversations conversation_record set status = v_target, version = conversation_record.version + 1,
    closed_at = case when v_target in ('closed','archived') then coalesce(conversation_record.closed_at, v_now)
      when v_previous_status = 'closed' and v_target = 'open' then null else conversation_record.closed_at end,
    updated_at = v_now where conversation_record.id = v_conversation.id returning * into v_conversation;
  insert into public.intake_conversation_events (id, conversation_id, action, previous_status, new_status,
    previous_version, new_version, actor_user_id, correlation_id, request_id, occurred_at, metadata)
  values (p_payload->>'eventId', v_conversation.id, v_action, v_previous_status, v_conversation.status,
    v_expected, v_conversation.version, p_payload->>'actorUserId', p_payload->>'correlationId',
    nullif(p_payload->>'requestId',''), v_now, coalesce(p_payload->'metadata','{}'::jsonb));
  return query select v_conversation.id, v_conversation.status, v_conversation.version,
    public.support_intake_canonical_utc_iso(v_conversation.last_activity_at),
    public.support_intake_canonical_utc_iso(v_conversation.closed_at), public.support_intake_canonical_utc_iso(v_conversation.updated_at);
end;
$$;

create or replace function public.support_transition_intake_session(p_payload jsonb)
returns table (id text, conversation_id text, status text, version integer, state_data jsonb, missing_fields jsonb,
  started_at text, expires_at text, confirmed_at text, cancelled_at text, failed_at text, updated_at text)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_session public.intake_sessions%rowtype; v_target text; v_now timestamptz; v_expected integer;
  v_previous_status text; v_changed_fields jsonb;
begin
  if jsonb_typeof(p_payload) <> 'object' or public.support_intake_json_has_unsafe_key(p_payload)
    or coalesce(p_payload->>'eventId','') = '' or coalesce(p_payload->>'sessionId','') = ''
    or coalesce(p_payload->>'actorUserId','') = '' or coalesce(p_payload->>'correlationId','') = ''
    or jsonb_typeof(coalesce(p_payload->'statePatch','{}'::jsonb)) <> 'object'
    or not public.support_intake_json_keys_allowed(coalesce(p_payload->'statePatch','{}'::jsonb), array['selectedCustomerKey','projectCode','systemKey','requestType','description','impact','urgency','attachmentIds','summary'])
    or jsonb_typeof(coalesce(p_payload->'missingFields','[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_payload->'missingFields','[]'::jsonb)) > 50
    or not public.support_intake_json_keys_allowed(coalesce(p_payload->'metadata','{}'::jsonb), array['diagnostic','source']) then
    raise exception using errcode = '22023', message = 'INTAKE_SESSION_TRANSITION_INVALID';
  end if;
  v_target := p_payload->>'targetStatus';
  if v_target not in ('draft','collecting','awaiting_confirmation','confirmed','cancelled','expired','failed') then raise exception using errcode = '22023', message = 'INTAKE_SESSION_TRANSITION_INVALID'; end if;
  v_expected := public.support_intake_parse_integer(p_payload->>'expectedVersion', 1, 2147483647, 'INTAKE_PAYLOAD_INVALID');
  v_now := public.support_intake_parse_timestamp(p_payload->>'occurredAt', 'INTAKE_PAYLOAD_INVALID');
  select * into v_session from public.intake_sessions session_record where session_record.id = p_payload->>'sessionId' for update;
  if v_session.id is null then raise exception using errcode = 'P0002', message = 'INTAKE_SESSION_NOT_FOUND'; end if;
  if v_session.version <> v_expected then raise exception using errcode = '40001', message = 'INTAKE_SESSION_VERSION_CONFLICT'; end if;
  v_previous_status := v_session.status;
  if not ((v_previous_status = 'draft' and v_target in ('collecting','cancelled'))
    or (v_previous_status = 'collecting' and v_target in ('awaiting_confirmation','cancelled','expired','failed'))
    or (v_previous_status = 'awaiting_confirmation' and v_target in ('collecting','confirmed','cancelled','expired','failed'))
    or (v_previous_status = 'failed' and v_target = 'collecting')) then
    raise exception using errcode = '22023', message = 'INTAKE_SESSION_TRANSITION_INVALID';
  end if;
  select coalesce(jsonb_agg(field order by field), '[]'::jsonb) into v_changed_fields from (
    select key field from jsonb_object_keys(coalesce(p_payload->'statePatch','{}'::jsonb)) key
    union select 'missingFields' union select 'status'
  ) changed;
  update public.intake_sessions session_record set status = v_target, version = session_record.version + 1,
    state_data = session_record.state_data || coalesce(p_payload->'statePatch','{}'::jsonb),
    missing_fields = coalesce(p_payload->'missingFields','[]'::jsonb),
    confirmed_at = case when v_target = 'confirmed' then v_now else session_record.confirmed_at end,
    cancelled_at = case when v_target = 'cancelled' then v_now else session_record.cancelled_at end,
    failed_at = case when v_target = 'failed' then v_now when v_target = 'collecting' then null else session_record.failed_at end,
    updated_at = v_now where session_record.id = v_session.id returning * into v_session;
  insert into public.intake_session_events (id, session_id, action, previous_status, new_status, previous_version,
    new_version, actor_user_id, correlation_id, request_id, occurred_at, changed_fields, metadata)
  values (p_payload->>'eventId', v_session.id, 'status_changed', v_previous_status, v_session.status, v_expected,
    v_session.version, p_payload->>'actorUserId', p_payload->>'correlationId', nullif(p_payload->>'requestId',''),
    v_now, v_changed_fields, coalesce(p_payload->'metadata','{}'::jsonb));
  return query select v_session.id, v_session.conversation_id, v_session.status, v_session.version, v_session.state_data,
    v_session.missing_fields, public.support_intake_canonical_utc_iso(v_session.started_at), public.support_intake_canonical_utc_iso(v_session.expires_at),
    public.support_intake_canonical_utc_iso(v_session.confirmed_at), public.support_intake_canonical_utc_iso(v_session.cancelled_at),
    public.support_intake_canonical_utc_iso(v_session.failed_at), public.support_intake_canonical_utc_iso(v_session.updated_at);
end;
$$;

create or replace function public.support_apply_intake_identity_binding(p_payload jsonb)
returns table (action text, binding_id text, identity_id text, customer_key text, project_code text, active boolean)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_identity public.integration_external_identities%rowtype; v_customer public.support_customers%rowtype;
  v_binding public.integration_identity_bindings%rowtype; v_action text; v_project text;
  v_previous_customer_key text; v_now timestamptz;
begin
  if jsonb_typeof(p_payload) <> 'object' or public.support_intake_json_has_unsafe_key(p_payload)
    or coalesce(p_payload->>'bindingId','') = '' or coalesce(p_payload->>'eventId','') = ''
    or coalesce(p_payload->>'identityId','') = '' or coalesce(p_payload->>'customerKey','') = ''
    or coalesce(p_payload->>'actorUserId','') = '' or coalesce(p_payload->>'correlationId','') = ''
    or jsonb_typeof(coalesce(p_payload->'allowedSystems','[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_payload->'allowedSystems','[]'::jsonb)) > 50
    or exists (select 1 from jsonb_array_elements(coalesce(p_payload->'allowedSystems','[]'::jsonb)) system_value where jsonb_typeof(system_value) <> 'string')
    or not public.support_intake_json_keys_allowed(coalesce(p_payload->'targetReferences','{}'::jsonb), array['email','n8n','servicenow','internal','line','web','freshservice'])
    or not public.support_intake_json_keys_allowed(coalesce(p_payload->'metadata','{}'::jsonb), array['source','reason']) then
    raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_BINDING_INVALID';
  end if;
  v_now := public.support_intake_parse_timestamp(p_payload->>'appliedAt', 'INTAKE_IDENTITY_BINDING_INVALID');
  perform pg_advisory_xact_lock(hashtextextended('intake-binding:' || (p_payload->>'identityId'), 0));
  select * into v_identity from public.integration_external_identities identity_record where identity_record.id = p_payload->>'identityId' for update;
  if v_identity.id is null or v_identity.status = 'blocked' then raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_BINDING_INVALID'; end if;
  select * into v_customer from public.support_customers customer_record where customer_record.customer_key = p_payload->>'customerKey' and customer_record.active;
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
      coalesce(p_payload->'allowedSystems','[]'::jsonb), coalesce(p_payload->'targetReferences','{}'::jsonb),
      p_payload->>'actorUserId', v_now, coalesce(p_payload->'metadata','{}'::jsonb), v_now, v_now)
    returning * into v_binding; v_action := 'created';
  elsif v_binding.status = 'linked' and v_binding.customer_key = v_customer.customer_key and v_binding.project_code = v_project
    and v_binding.allowed_systems = coalesce(p_payload->'allowedSystems','[]'::jsonb)
    and v_binding.target_references = coalesce(p_payload->'targetReferences','{}'::jsonb) then
    return query select 'unchanged', v_binding.id, v_identity.id, v_binding.customer_key, v_binding.project_code, true; return;
  else
    v_action := case when v_binding.status = 'revoked' then 'reactivated' else 'changed' end;
    v_previous_customer_key := v_binding.customer_key;
    update public.integration_identity_bindings binding_record set customer_key = v_customer.customer_key, project_code = v_project,
      status = 'linked', allowed_systems = coalesce(p_payload->'allowedSystems','[]'::jsonb),
      target_references = coalesce(p_payload->'targetReferences','{}'::jsonb), linked_by_user_id = p_payload->>'actorUserId',
      linked_at = v_now, revoked_by_user_id = null, revoked_at = null, metadata = coalesce(p_payload->'metadata','{}'::jsonb),
      updated_at = v_now where binding_record.id = v_binding.id returning * into v_binding;
  end if;
  update public.integration_external_identities identity_record set status = 'linked', updated_at = v_now where identity_record.id = v_identity.id;
  insert into public.integration_identity_binding_events (id, binding_id, identity_id, action, previous_customer_key,
    new_customer_key, actor_user_id, correlation_id, request_id, created_at, metadata)
  values (p_payload->>'eventId', v_binding.id, v_identity.id, case when v_action = 'created' then 'linked' else v_action end,
    case when v_action in ('changed','reactivated') then v_previous_customer_key else null end, v_customer.customer_key,
    p_payload->>'actorUserId', p_payload->>'correlationId', nullif(p_payload->>'requestId',''), v_now,
    coalesce(p_payload->'metadata','{}'::jsonb));
  return query select v_action, v_binding.id, v_identity.id, v_binding.customer_key, v_binding.project_code, true;
end;
$$;

create or replace function public.support_revoke_intake_identity_binding(p_payload jsonb)
returns table (action text, binding_id text, identity_id text, customer_key text, project_code text, active boolean)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare v_binding public.integration_identity_bindings%rowtype; v_now timestamptz;
begin
  if jsonb_typeof(p_payload) <> 'object' or public.support_intake_json_has_unsafe_key(p_payload)
    or coalesce(p_payload->>'eventId','') = '' or coalesce(p_payload->>'identityId','') = ''
    or coalesce(p_payload->>'actorUserId','') = '' or coalesce(p_payload->>'correlationId','') = ''
    or not public.support_intake_json_keys_allowed(coalesce(p_payload->'metadata','{}'::jsonb), array['source','reason']) then
    raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_BINDING_INVALID';
  end if;
  v_now := public.support_intake_parse_timestamp(p_payload->>'appliedAt', 'INTAKE_IDENTITY_BINDING_INVALID');
  perform pg_advisory_xact_lock(hashtextextended('intake-binding:' || (p_payload->>'identityId'), 0));
  select * into v_binding from public.integration_identity_bindings binding_record where binding_record.identity_id = p_payload->>'identityId' order by binding_record.updated_at desc limit 1 for update;
  if v_binding.id is null then raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_BINDING_INVALID'; end if;
  if v_binding.status = 'revoked' then return query select 'unchanged', v_binding.id, v_binding.identity_id, v_binding.customer_key, v_binding.project_code, false; return; end if;
  update public.integration_identity_bindings binding_record set status = 'revoked', revoked_by_user_id = p_payload->>'actorUserId',
    revoked_at = v_now, updated_at = v_now where binding_record.id = v_binding.id returning * into v_binding;
  update public.integration_external_identities identity_record set status = 'revoked', updated_at = v_now where identity_record.id = v_binding.identity_id;
  insert into public.integration_identity_binding_events (id, binding_id, identity_id, action, previous_customer_key,
    actor_user_id, correlation_id, request_id, created_at, metadata)
  values (p_payload->>'eventId', v_binding.id, v_binding.identity_id, 'revoked', v_binding.customer_key,
    p_payload->>'actorUserId', p_payload->>'correlationId', nullif(p_payload->>'requestId',''), v_now,
    coalesce(p_payload->'metadata','{}'::jsonb));
  return query select 'revoked', v_binding.id, v_binding.identity_id, v_binding.customer_key, v_binding.project_code, false;
end;
$$;

create or replace function public.support_enqueue_integration_outbox(p_payload jsonb)
returns table (action text, command_id text, status text, attempt_count integer)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_command public.integration_outbox%rowtype; v_payload jsonb; v_now timestamptz; v_max_attempts integer;
begin
  v_payload := coalesce(p_payload->'payload','{}'::jsonb);
  if jsonb_typeof(p_payload) <> 'object' or public.support_intake_json_has_unsafe_key(p_payload)
    or jsonb_typeof(v_payload) <> 'object' or octet_length(v_payload::text) > 65536
    or coalesce(p_payload->>'id','') = '' or coalesce(p_payload->>'idempotencyKey','') = ''
    or p_payload->>'targetProvider' not in ('email','n8n','servicenow','internal','line','web','freshservice')
    or p_payload->>'commandType' not in ('message.reply','message.push','ticket.create','ticket.update','attachment.upload','notification.send')
    or coalesce(p_payload->>'correlationId','') = ''
    or not public.support_intake_json_keys_allowed(coalesce(p_payload->'metadata','{}'::jsonb), array['source','diagnostic']) then
    raise exception using errcode = '22023', message = 'INTEGRATION_OUTBOX_PAYLOAD_INVALID';
  end if;
  v_now := public.support_intake_parse_timestamp(p_payload->>'availableAt', 'INTEGRATION_OUTBOX_PAYLOAD_INVALID');
  v_max_attempts := public.support_intake_parse_integer(coalesce(p_payload->>'maxAttempts','5'), 1, 20, 'INTEGRATION_OUTBOX_PAYLOAD_INVALID');
  perform pg_advisory_xact_lock(hashtextextended('intake-outbox:' || (p_payload->>'idempotencyKey'), 0));
  select * into v_command from public.integration_outbox command_record where command_record.idempotency_key = p_payload->>'idempotencyKey' for update;
  if v_command.id is not null then
    if v_command.target_provider = p_payload->>'targetProvider' and v_command.command_type = p_payload->>'commandType'
      and coalesce(v_command.channel_id,'') = coalesce(p_payload->>'channelId','')
      and coalesce(v_command.conversation_id,'') = coalesce(p_payload->>'conversationId','')
      and coalesce(v_command.message_id,'') = coalesce(p_payload->>'messageId','')
      and coalesce(v_command.ticket_id,'') = coalesce(p_payload->>'ticketId','')
      and v_command.payload = v_payload and v_command.available_at = v_now and v_command.max_attempts = v_max_attempts then
      return query select 'unchanged', v_command.id, v_command.status, v_command.attempt_count; return;
    end if;
    raise exception using errcode = '23505', message = 'INTEGRATION_OUTBOX_IDEMPOTENCY_CONFLICT';
  end if;
  insert into public.integration_outbox (id, target_provider, command_type, idempotency_key, channel_id,
    conversation_id, message_id, ticket_id, status, payload, attempt_count, max_attempts, available_at,
    correlation_id, request_id, metadata, created_at, updated_at)
  values (p_payload->>'id', p_payload->>'targetProvider', p_payload->>'commandType', p_payload->>'idempotencyKey',
    nullif(p_payload->>'channelId',''), nullif(p_payload->>'conversationId',''), nullif(p_payload->>'messageId',''),
    nullif(p_payload->>'ticketId',''), 'pending', v_payload, 0, v_max_attempts, v_now,
    p_payload->>'correlationId', nullif(p_payload->>'requestId',''), coalesce(p_payload->'metadata','{}'::jsonb), v_now, v_now)
  returning * into v_command;
  return query select 'created', v_command.id, v_command.status, v_command.attempt_count;
end;
$$;

do $$
declare v_signature regprocedure;
begin
  foreach v_signature in array array[
    'public.support_intake_normalize_key(text)'::regprocedure,
    'public.support_intake_key_is_unsafe(text)'::regprocedure,
    'public.support_intake_json_has_unsafe_key(jsonb)'::regprocedure,
    'public.support_intake_json_keys_allowed(jsonb,text[])'::regprocedure,
    'public.support_intake_parse_timestamp(text,text)'::regprocedure,
    'public.support_intake_parse_integer(text,integer,integer,text)'::regprocedure,
    'public.support_intake_parse_bigint(text,bigint,bigint,text)'::regprocedure,
    'public.support_intake_canonical_json(jsonb)'::regprocedure,
    'public.support_intake_attachment_material(jsonb)'::regprocedure,
    'public.support_intake_sorted_attachment_material(jsonb)'::regprocedure,
    'public.support_intake_message_material(jsonb)'::regprocedure,
    'public.support_intake_event_material(jsonb)'::regprocedure,
    'public.support_intake_persisted_message_material(text)'::regprocedure
  ] loop
    execute format('revoke all privileges on function %s from public, anon, authenticated', v_signature);
  end loop;
end;
$$;

revoke all privileges on function public.support_get_intake_operations_summary() from public;
revoke execute on function public.support_get_intake_operations_summary() from anon, authenticated;
grant execute on function public.support_get_intake_operations_summary() to service_role;

revoke all privileges on function public.support_list_intake_identities(integer,integer,text,text) from public;
revoke execute on function public.support_list_intake_identities(integer,integer,text,text) from anon, authenticated;
grant execute on function public.support_list_intake_identities(integer,integer,text,text) to service_role;

revoke all privileges on function public.support_list_intake_conversations(integer,integer,text,text) from public;
revoke execute on function public.support_list_intake_conversations(integer,integer,text,text) from anon, authenticated;
grant execute on function public.support_list_intake_conversations(integer,integer,text,text) to service_role;

revoke all privileges on function public.support_list_intake_events(integer,integer,text,text) from public;
revoke execute on function public.support_list_intake_events(integer,integer,text,text) from anon, authenticated;
grant execute on function public.support_list_intake_events(integer,integer,text,text) to service_role;

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

revoke all privileges on function public.support_transition_intake_conversation(jsonb) from public;
revoke execute on function public.support_transition_intake_conversation(jsonb) from anon, authenticated;
grant execute on function public.support_transition_intake_conversation(jsonb) to service_role;

revoke all privileges on function public.support_enqueue_integration_outbox(jsonb) from public;
revoke execute on function public.support_enqueue_integration_outbox(jsonb) from anon, authenticated;
grant execute on function public.support_enqueue_integration_outbox(jsonb) to service_role;

comment on function public.support_accept_intake_event(jsonb) is 'AI-1.3.1 canonical replay enforcement with event/message/conversation/identity scoped locks; no provider call.';
comment on table public.intake_conversation_events is 'Append-only authoritative Conversation lifecycle history.';
comment on table public.intake_session_events is 'Append-only bounded Session transition history without message bodies or complete state.';

insert into public.support_schema_migrations (version, description, checksum, applied_by)
values ('202607220002', 'AI-1.3.1 unified intake integrity corrections', null, current_user)
on conflict (version) do nothing;

commit;
