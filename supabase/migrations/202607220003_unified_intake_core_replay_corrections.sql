-- SUPPER AI-1.3.2: canonical replay, credential classification, and event metrics.
-- Forward-only correction for immutable migrations 202607220001 and 202607220002.
-- No provider transport, Ticket creation, object bytes, worker, or outbound call is added.

begin;

create or replace function public.support_intake_compact_key(p_value text)
returns text language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
  select regexp_replace(coalesce(public.support_intake_normalize_key(p_value), ''), '[^a-z0-9]', '', 'g');
$$;

create or replace function public.support_intake_classify_key(p_value text)
returns text language plpgsql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_normalized text;
  v_compact text;
  v_words text[];
begin
  if p_value is null or p_value = '' or p_value in ('__proto__','constructor','prototype')
    or p_value !~ '^[ -~]+$' or p_value ~ '[[:cntrl:]]' then return 'invalid'; end if;
  v_normalized := public.support_intake_normalize_key(p_value);
  v_compact := public.support_intake_compact_key(p_value);
  if v_normalized in ('raw payload','webhook body','raw headers','authorization headers','complete profile','raw event')
    or v_compact in ('rawpayload','webhookbody','rawheaders','authorizationheaders','completeprofile','rawevent') then
    return 'forbidden-provider-payload';
  end if;
  v_words := regexp_split_to_array(v_normalized, ' +');
  if v_words && array['authorization','authentication','credential','credentials','cookie','password','passphrase','secret','token','bearer']
    or ('signed' = any(v_words) and 'url' = any(v_words))
    or (' ' || v_normalized || ' ') like any (array[
      '% access token %','% refresh token %','% api key %','% private key %','% client secret %',
      '% channel secret %','% channel access token %','% signed url %','% signature secret %',
      '% webhook secret %','% session secret %','% service role key %','% authentication credential %'
    ]) then return 'sensitive'; end if;
  if v_compact = any(array[
      'authorization','authenticationcredential','cookie','password','passphrase','secret','token','bearer',
      'accesstoken','refreshtoken','bearertoken','apikey','privatekey','clientsecret','channelsecret',
      'channelaccesstoken','signedurl','signeddownloadurl','signaturesecret','webhooksecret','sessionsecret',
      'servicerolekey','supabaseservicerolekey'
    ]) or v_compact like any(array[
      '%authorization%','%authenticationcredential%','%credential%','%password%','%passphrase%',
      '%accesstoken%','%refreshtoken%','%bearertoken%','%apikey%','%privatekey%','%clientsecret%',
      '%channelsecret%','%channelaccesstoken%','%signeddownloadurl%','%signaturesecret%',
      '%webhooksecret%','%sessionsecret%','%servicerolekey%','%supabaseservicerolekey%','bearer%'
    ]) then return 'sensitive'; end if;
  return 'safe';
end;
$$;

create or replace function public.support_intake_key_is_unsafe(p_value text)
returns boolean language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$ select public.support_intake_classify_key(p_value) <> 'safe'; $$;

create or replace function public.support_intake_json_has_unsafe_key(p_value jsonb)
returns boolean language plpgsql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
declare v_key text; v_child jsonb; v_classification text;
begin
  if p_value is null then return false; end if;
  if jsonb_typeof(p_value) = 'object' then
    for v_key, v_child in select key, value from jsonb_each(p_value) loop
      v_classification := public.support_intake_classify_key(v_key);
      if v_classification = 'sensitive' then
        raise exception using errcode = '22023', message = 'INTAKE_SENSITIVE_DATA_REJECTED';
      end if;
      if v_classification <> 'safe' or public.support_intake_json_has_unsafe_key(v_child) then return true; end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value) loop
      if public.support_intake_json_has_unsafe_key(v_child) then return true; end if;
    end loop;
  end if;
  return false;
end;
$$;

create or replace function public.support_intake_json_has_invalid_number(p_value jsonb)
returns boolean language plpgsql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
declare v_child jsonb; v_number numeric;
begin
  if p_value is null then return false; end if;
  if jsonb_typeof(p_value) = 'number' then
    begin v_number := (p_value #>> '{}')::numeric;
    exception when others then return true; end;
    return v_number <> trunc(v_number)
      or v_number < -9007199254740991::numeric or v_number > 9007199254740991::numeric;
  elsif jsonb_typeof(p_value) = 'object' then
    for v_child in select value from jsonb_each(p_value) loop
      if public.support_intake_json_has_invalid_number(v_child) then return true; end if;
    end loop;
  elsif jsonb_typeof(p_value) = 'array' then
    for v_child in select value from jsonb_array_elements(p_value) loop
      if public.support_intake_json_has_invalid_number(v_child) then return true; end if;
    end loop;
  end if;
  return false;
end;
$$;

create or replace function public.support_intake_canonical_json(p_value jsonb)
returns text language plpgsql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
declare v_result text; v_number numeric;
begin
  case jsonb_typeof(p_value)
    when 'object' then
      select '{' || coalesce(string_agg(to_jsonb(key)::text || ':' || public.support_intake_canonical_json(value), ',' order by key collate "C"), '') || '}'
      into v_result from jsonb_each(p_value);
    when 'array' then
      select '[' || coalesce(string_agg(public.support_intake_canonical_json(value), ',' order by ordinal), '') || ']'
      into v_result from jsonb_array_elements(p_value) with ordinality element(value, ordinal);
    when 'number' then
      begin v_number := (p_value #>> '{}')::numeric;
      exception when others then raise exception using errcode = '22023', message = 'INTAKE_CANONICAL_NUMBER_INVALID'; end;
      if v_number <> trunc(v_number) or v_number < -9007199254740991::numeric or v_number > 9007199254740991::numeric then
        raise exception using errcode = '22023', message = 'INTAKE_CANONICAL_NUMBER_INVALID';
      end if;
      v_result := case when v_number = 0 then '0' else trunc(v_number)::text end;
    else v_result := p_value::text;
  end case;
  return v_result;
end;
$$;

-- These helpers preserve the 202607220002 Event hash contract only for a one-time,
-- full-material replay check before a legacy row is upgraded to canonical version 2.
create or replace function public.support_intake_legacy_attachment_material(p_attachment jsonb)
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

create or replace function public.support_intake_legacy_sorted_attachment_material(p_payload jsonb)
returns jsonb language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(jsonb_agg(material order by public.support_intake_canonical_json(material) collate "C"), '[]'::jsonb)
  from (select public.support_intake_legacy_attachment_material(value) material
    from jsonb_array_elements(coalesce(p_payload->'attachments', '[]'::jsonb))) items;
$$;

create or replace function public.support_intake_legacy_message_material(p_payload jsonb)
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
    'attachments', public.support_intake_legacy_sorted_attachment_material(p_payload)
  );
$$;

create or replace function public.support_intake_legacy_event_material(p_payload jsonb)
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
    'message', public.support_intake_legacy_message_material(p_payload),
    'attachments', public.support_intake_legacy_sorted_attachment_material(p_payload),
    'initializeSession', case when p_payload ? 'initializeSession' then jsonb_build_object(
      'status', p_payload#>>'{initializeSession,status}', 'stateData', coalesce(p_payload#>'{initializeSession,stateData}', '{}'::jsonb),
      'missingFields', coalesce(p_payload#>'{initializeSession,missingFields}', '[]'::jsonb),
      'startedAt', p_payload#>>'{initializeSession,startedAt}', 'expiresAt', nullif(p_payload#>>'{initializeSession,expiresAt}', ''),
      'metadata', coalesce(p_payload#>'{initializeSession,metadata}', '{}'::jsonb)) else null end
  );
$$;

create or replace function public.support_intake_target_references_valid(p_value jsonb)
returns boolean language plpgsql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
declare v_provider text; v_references jsonb; v_key text; v_value jsonb; v_text text;
begin
  if jsonb_typeof(p_value) <> 'object' or octet_length(p_value::text) > 16384
    or public.support_intake_json_has_unsafe_key(p_value)
    or exists (select 1 from jsonb_object_keys(p_value) key_name
      where key_name not in ('email','n8n','servicenow','internal','line','web','freshservice')) then return false; end if;
  for v_provider, v_references in select key, value from jsonb_each(p_value) loop
    if jsonb_typeof(v_references) <> 'object' or (select count(*) from jsonb_object_keys(v_references)) > 7
      or exists (select 1 from jsonb_object_keys(v_references) key_name
        where key_name not in ('userId','contactId','callerId','companyId','accountId','projectId','groupId')) then return false; end if;
    for v_key, v_value in select key, value from jsonb_each(v_references) loop
      if jsonb_typeof(v_value) <> 'string' then return false; end if;
      v_text := v_value #>> '{}';
      if length(v_text) < 1 or length(v_text) > 500 or v_text ~ '[[:cntrl:]]'
        or v_text ~* '^[a-z][a-z0-9+.-]*://' then return false; end if;
    end loop;
  end loop;
  return true;
end;
$$;

create or replace function public.support_intake_attachment_source_material(p_attachment jsonb)
returns jsonb language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
  select jsonb_build_object(
    'externalAttachmentId', nullif(p_attachment->>'externalAttachmentId', ''),
    'fileName', p_attachment->>'fileName', 'contentType', p_attachment->>'contentType',
    'declaredSize', p_attachment->'declaredSize', 'sha256', nullif(p_attachment->>'sha256', ''),
    'providerLocator', nullif(p_attachment->>'providerLocator', ''),
    'metadata', coalesce(p_attachment->'metadata', '{}'::jsonb)
  );
$$;

create or replace function public.support_intake_attachment_material(p_attachment jsonb)
returns jsonb language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$ select public.support_intake_attachment_source_material(p_attachment); $$;

create or replace function public.support_intake_attachment_source_hash(p_attachment jsonb)
returns text language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
  select encode(digest(public.support_intake_canonical_json(public.support_intake_attachment_source_material(p_attachment)), 'sha256'), 'hex');
$$;

create or replace function public.support_intake_sorted_attachment_material(p_payload jsonb)
returns jsonb language sql immutable parallel safe set search_path = pg_catalog, public, pg_temp
as $$
  select coalesce(jsonb_agg(source_hash order by source_hash collate "C"), '[]'::jsonb)
  from (select public.support_intake_attachment_source_hash(value) source_hash
    from jsonb_array_elements(coalesce(p_payload->'attachments', '[]'::jsonb))) items;
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

alter table public.intake_attachments add column if not exists source_material_hash text;
update public.intake_attachments attachment_record
set source_material_hash = public.support_intake_attachment_source_hash(jsonb_build_object(
  'externalAttachmentId', attachment_record.external_attachment_id, 'fileName', attachment_record.file_name,
  'contentType', attachment_record.content_type, 'declaredSize', attachment_record.declared_size,
  'sha256', attachment_record.sha256, 'providerLocator', attachment_record.provider_locator,
  'metadata', attachment_record.metadata
)) where source_material_hash is null;
alter table public.intake_attachments alter column source_material_hash set not null;
alter table public.intake_attachments drop constraint if exists intake_attachments_source_material_hash_check;
alter table public.intake_attachments add constraint intake_attachments_source_material_hash_check
  check (source_material_hash ~ '^[a-f0-9]{64}$');
update public.intake_attachments set canonical_hash = source_material_hash
where canonical_hash is distinct from source_material_hash;
comment on column public.intake_attachments.source_material_hash is
  'Immutable hash of provider-declared Attachment source material; local storage, scan, and retention state are excluded.';

create or replace function public.support_intake_set_attachment_source_hash()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp
as $$
declare v_hash text;
begin
  if tg_op = 'UPDATE' and (
    new.external_attachment_id is distinct from old.external_attachment_id
    or new.file_name is distinct from old.file_name
    or new.content_type is distinct from old.content_type
    or new.declared_size is distinct from old.declared_size
    or new.sha256 is distinct from old.sha256
    or new.provider_locator is distinct from old.provider_locator
    or new.metadata is distinct from old.metadata
  ) then raise exception using errcode = '23505', message = 'INTAKE_ATTACHMENT_REPLAY_MISMATCH'; end if;
  if tg_op = 'INSERT' then
    v_hash := public.support_intake_attachment_source_hash(jsonb_build_object(
      'externalAttachmentId', new.external_attachment_id, 'fileName', new.file_name,
      'contentType', new.content_type, 'declaredSize', new.declared_size,
      'sha256', new.sha256, 'providerLocator', new.provider_locator, 'metadata', new.metadata));
    new.source_material_hash := v_hash;
    new.canonical_hash := v_hash;
  end if;
  return new;
end;
$$;
drop trigger if exists support_intake_attachment_source_hash_guard on public.intake_attachments;
create trigger support_intake_attachment_source_hash_guard
before insert or update on public.intake_attachments
for each row execute function public.support_intake_set_attachment_source_hash();

create table if not exists public.intake_event_deliveries (
  id text primary key,
  event_id text not null references public.intake_events(id) on delete restrict,
  channel_id text not null references public.integration_channels(id) on delete restrict,
  delivery_number integer not null check (delivery_number > 0),
  delivery_type text not null check (delivery_type in ('initial','duplicate')),
  received_at timestamptz not null,
  request_id text,
  correlation_id text,
  metadata jsonb not null default '{}'::jsonb
    check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384),
  unique (event_id, delivery_number)
);
create index if not exists intake_event_deliveries_received_idx
  on public.intake_event_deliveries(delivery_type, received_at desc, event_id);
create index if not exists intake_event_deliveries_channel_idx
  on public.intake_event_deliveries(channel_id, received_at desc, id);
alter table public.intake_event_deliveries enable row level security;
revoke all privileges on table public.intake_event_deliveries from public, anon, authenticated;
grant select, insert on table public.intake_event_deliveries to service_role;
revoke update, delete on table public.intake_event_deliveries from service_role;
insert into public.intake_event_deliveries
  (id, event_id, channel_id, delivery_number, delivery_type, received_at, request_id, correlation_id, metadata)
select event_record.id || ':delivery:1', event_record.id, event_record.channel_id, 1, 'initial',
  coalesce(event_record.first_processed_at, event_record.received_at), event_record.request_id,
  event_record.correlation_id, '{}'::jsonb
from public.intake_events event_record
on conflict (event_id, delivery_number) do nothing;
comment on table public.intake_event_deliveries is
  'Append-only chronological delivery ledger. It stores no raw payload, message body, external identity value, or credential.';

create or replace function public.support_record_intake_event_delivery()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.intake_event_deliveries
      (id, event_id, channel_id, delivery_number, delivery_type, received_at, request_id, correlation_id, metadata)
    values (new.id || ':delivery:1', new.id, new.channel_id, 1, 'initial', new.received_at,
      new.request_id, new.correlation_id, '{}'::jsonb)
    on conflict (event_id, delivery_number) do nothing;
  elsif new.delivery_count > old.delivery_count then
    insert into public.intake_event_deliveries
      (id, event_id, channel_id, delivery_number, delivery_type, received_at, request_id, correlation_id, metadata)
    values (new.id || ':delivery:' || new.delivery_count::text, new.id, new.channel_id,
      new.delivery_count, 'duplicate', new.last_seen_at, null, null, '{}'::jsonb);
  end if;
  return new;
end;
$$;
drop trigger if exists support_intake_event_delivery_ledger on public.intake_events;
create trigger support_intake_event_delivery_ledger
after insert or update on public.intake_events
for each row execute function public.support_record_intake_event_delivery();

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
    select jsonb_agg(attachment.source_material_hash order by attachment.source_material_hash collate "C") items
    from public.intake_attachments attachment where attachment.message_id = message.id
  ) attachments on true
  where message.id = p_message_id;
$$;

update public.intake_messages message_record
set content_hash = encode(digest(public.support_intake_canonical_json(
  public.support_intake_persisted_message_material(message_record.id)), 'sha256'), 'hex')
where message_record.content_hash is distinct from encode(digest(public.support_intake_canonical_json(
  public.support_intake_persisted_message_material(message_record.id)), 'sha256'), 'hex');

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
    (select count(distinct delivery.event_id)::integer from public.intake_event_deliveries delivery
      join public.intake_events event_record on event_record.id = delivery.event_id
      where delivery.delivery_type = 'initial' and event_record.processing_status = 'accepted'
        and delivery.received_at >= now() - interval '24 hours'),
    (select count(*)::integer from public.intake_event_deliveries delivery
      where delivery.delivery_type = 'duplicate' and delivery.received_at >= now() - interval '24 hours'),
    (select count(distinct delivery.event_id)::integer from public.intake_event_deliveries delivery
      join public.intake_events event_record on event_record.id = delivery.event_id
      where delivery.delivery_type = 'initial' and event_record.processing_status = 'failed'
        and delivery.received_at >= now() - interval '24 hours'),
    (select count(*)::integer from public.integration_outbox where status = 'pending'),
    (select count(*)::integer from public.integration_outbox where status = 'retrying'),
    (select count(*)::integer from public.integration_outbox where status = 'dead_letter'),
    coalesce((select jsonb_object_agg(storage_status, count_value) from
      (select storage_status, count(*)::integer count_value from public.intake_attachments group by storage_status) counts), '{}'::jsonb),
    coalesce((select jsonb_object_agg(scan_status, count_value) from
      (select scan_status, count(*)::integer count_value from public.intake_attachments group by scan_status) counts), '{}'::jsonb),
    public.support_intake_canonical_utc_iso((select max(last_activity_at) from public.intake_conversations));
$$;

create or replace function public.support_accept_intake_event_v2(p_payload jsonb)
returns table (action text, event_id text, identity_id text, conversation_id text, message_id text, attachment_count integer, session_id text, delivery_count integer)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_channel public.integration_channels%rowtype;
  v_event public.intake_events%rowtype;
  v_attachment jsonb;
  v_existing_attachment public.intake_attachments%rowtype;
  v_incoming_hash text;
  v_event_hash text;
  v_legacy_event_hash text;
  v_result record;
begin
  if jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 1000000
    or public.support_intake_json_has_unsafe_key(p_payload) then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;
  if public.support_intake_json_has_invalid_number(p_payload) then
    raise exception using errcode = '22023', message = 'INTAKE_CANONICAL_NUMBER_INVALID';
  end if;
  select * into v_channel from public.integration_channels channel_record
  where channel_record.id = p_payload#>>'{channel,id}'
    and channel_record.provider = p_payload#>>'{channel,provider}'
    and channel_record.channel_key = p_payload#>>'{channel,channelKey}' and channel_record.enabled;
  if v_channel.id is null then raise exception using errcode = '22023', message = 'INTAKE_CHANNEL_UNAVAILABLE'; end if;

  for v_attachment in select value from jsonb_array_elements(coalesce(p_payload->'attachments', '[]'::jsonb)) loop
    v_incoming_hash := public.support_intake_attachment_source_hash(v_attachment);
    if nullif(v_attachment->>'externalAttachmentId','') is not null then
      perform pg_advisory_xact_lock(hashtextextended('intake-attachment:' || v_channel.id || ':' || (v_attachment->>'externalAttachmentId'), 0));
      select * into v_existing_attachment from public.intake_attachments attachment_record
      where attachment_record.channel_id = v_channel.id
        and attachment_record.external_attachment_id = v_attachment->>'externalAttachmentId' for update;
      if v_existing_attachment.id is not null and v_existing_attachment.source_material_hash <> v_incoming_hash then
        raise exception using errcode = '23505', message = 'INTAKE_ATTACHMENT_REPLAY_MISMATCH';
      end if;
    end if;
  end loop;

  v_event_hash := encode(digest(public.support_intake_canonical_json(public.support_intake_event_material(p_payload)), 'sha256'), 'hex');
  select * into v_event from public.intake_events event_record
  where event_record.channel_id = v_channel.id and event_record.external_event_id = p_payload#>>'{event,externalEventId}' for update;
  if v_event.id is not null and v_event.payload_hash <> v_event_hash
    and coalesce(v_event.metadata->>'_canonicalVersion', '') <> '2' then
    v_legacy_event_hash := encode(digest(public.support_intake_canonical_json(
      public.support_intake_legacy_event_material(p_payload)), 'sha256'), 'hex');
    if v_event.payload_hash <> v_legacy_event_hash then
      raise exception using errcode = '23505', message = 'INTAKE_EVENT_REPLAY_MISMATCH';
    end if;
    update public.intake_events event_record set payload_hash = v_event_hash,
      metadata = event_record.metadata || jsonb_build_object('_canonicalVersion', 2)
    where event_record.id = v_event.id;
  end if;

  select * into v_result from public.support_accept_intake_event(p_payload);
  update public.intake_events event_record set
    metadata = event_record.metadata || jsonb_build_object('_canonicalVersion', 2)
  where event_record.id = v_result.event_id and coalesce(event_record.metadata->>'_canonicalVersion', '') <> '2';
  return query select v_result.action, v_result.event_id, v_result.identity_id, v_result.conversation_id,
    v_result.message_id, v_result.attachment_count, v_result.session_id, v_result.delivery_count;
end;
$$;

create or replace function public.support_apply_intake_identity_binding_v2(p_payload jsonb)
returns table (action text, binding_id text, identity_id text, customer_key text, project_code text, active boolean)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
begin
  if jsonb_typeof(p_payload) <> 'object' or public.support_intake_json_has_unsafe_key(p_payload) then
    raise exception using errcode = '22023', message = 'INTAKE_IDENTITY_BINDING_INVALID';
  end if;
  if not public.support_intake_target_references_valid(coalesce(p_payload->'targetReferences','{}'::jsonb)) then
    raise exception using errcode = '22023', message = 'INTAKE_TARGET_REFERENCE_INVALID';
  end if;
  return query select * from public.support_apply_intake_identity_binding(p_payload);
end;
$$;

create or replace function public.support_validate_intake_binding_target_references()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp
as $$
begin
  if not public.support_intake_target_references_valid(new.target_references) then
    raise exception using errcode = '22023', message = 'INTAKE_TARGET_REFERENCE_INVALID';
  end if;
  return new;
end;
$$;
drop trigger if exists support_intake_binding_target_reference_guard on public.integration_identity_bindings;
create trigger support_intake_binding_target_reference_guard
before insert or update of target_references on public.integration_identity_bindings
for each row execute function public.support_validate_intake_binding_target_references();

create or replace function public.support_enqueue_integration_outbox_v2(p_payload jsonb)
returns table (action text, command_id text, status text, attempt_count integer)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
begin
  if jsonb_typeof(p_payload) <> 'object' or public.support_intake_json_has_unsafe_key(p_payload) then
    raise exception using errcode = '22023', message = 'INTEGRATION_OUTBOX_PAYLOAD_INVALID';
  end if;
  if public.support_intake_json_has_invalid_number(coalesce(p_payload->'payload','{}'::jsonb)) then
    raise exception using errcode = '22023', message = 'INTAKE_CANONICAL_NUMBER_INVALID';
  end if;
  return query select * from public.support_enqueue_integration_outbox(p_payload);
end;
$$;

create or replace function public.support_transition_intake_conversation_v2(p_payload jsonb)
returns table (action text, id text, status text, version integer, last_activity_at text, closed_at text, updated_at text)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_conversation public.intake_conversations%rowtype;
  v_target text;
  v_expected integer;
  v_now timestamptz;
  v_action text;
  v_explicit_reopen boolean;
  v_previous_status text;
begin
  if jsonb_typeof(p_payload) <> 'object' or public.support_intake_json_has_unsafe_key(p_payload)
    or coalesce(p_payload->>'eventId','') = '' or coalesce(p_payload->>'conversationId','') = ''
    or coalesce(p_payload->>'actorUserId','') = '' or coalesce(p_payload->>'correlationId','') = ''
    or not public.support_intake_json_keys_allowed(coalesce(p_payload->'metadata','{}'::jsonb), array['diagnostic','source']) then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;
  v_target := p_payload->>'targetStatus';
  if v_target not in ('open','awaiting_customer','awaiting_agent','linked','closed','archived') then
    raise exception using errcode = '22023', message = 'INTAKE_CONVERSATION_TRANSITION_INVALID';
  end if;
  v_expected := public.support_intake_parse_integer(p_payload->>'expectedVersion', 1, 2147483647, 'INTAKE_PAYLOAD_INVALID');
  v_now := public.support_intake_parse_timestamp(p_payload->>'occurredAt', 'INTAKE_PAYLOAD_INVALID');
  if jsonb_typeof(coalesce(p_payload->'explicitReopen','false'::jsonb)) <> 'boolean' then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;
  v_explicit_reopen := coalesce((p_payload->>'explicitReopen')::boolean, false);
  select * into v_conversation from public.intake_conversations conversation_record
  where conversation_record.id = p_payload->>'conversationId' for update;
  if v_conversation.id is null then raise exception using errcode = 'P0002', message = 'INTAKE_CONVERSATION_NOT_FOUND'; end if;
  if v_conversation.version <> v_expected then
    raise exception using errcode = '40001', message = 'INTAKE_CONVERSATION_VERSION_CONFLICT';
  end if;
  if v_conversation.status = v_target then
    return query select 'unchanged', v_conversation.id, v_conversation.status, v_conversation.version,
      public.support_intake_canonical_utc_iso(v_conversation.last_activity_at),
      public.support_intake_canonical_utc_iso(v_conversation.closed_at),
      public.support_intake_canonical_utc_iso(v_conversation.updated_at);
    return;
  end if;
  v_previous_status := v_conversation.status;
  if not ((v_previous_status = 'open' and v_target in ('awaiting_customer','awaiting_agent','linked','closed'))
    or (v_previous_status = 'awaiting_customer' and v_target in ('open','awaiting_agent','linked','closed'))
    or (v_previous_status = 'awaiting_agent' and v_target in ('open','awaiting_customer','linked','closed'))
    or (v_previous_status = 'linked' and v_target in ('open','awaiting_customer','awaiting_agent','closed'))
    or (v_previous_status = 'closed' and v_target = 'archived')
    or (v_previous_status = 'closed' and v_target = 'open' and v_explicit_reopen)) then
    raise exception using errcode = '22023', message = 'INTAKE_CONVERSATION_TRANSITION_INVALID';
  end if;
  v_action := case when v_previous_status = 'closed' and v_target = 'open' then 'reopened'
    when v_target = 'closed' then 'closed' when v_target = 'archived' then 'archived' else 'status_changed' end;
  update public.intake_conversations conversation_record set status = v_target,
    version = conversation_record.version + 1,
    closed_at = case when v_target = 'closed' then v_now when v_target = 'open' then null else conversation_record.closed_at end,
    last_activity_at = greatest(conversation_record.last_activity_at, v_now), updated_at = v_now
  where conversation_record.id = v_conversation.id returning * into v_conversation;
  insert into public.intake_conversation_events (id, conversation_id, action, previous_status, new_status,
    previous_version, new_version, actor_user_id, correlation_id, request_id, occurred_at, metadata)
  values (p_payload->>'eventId', v_conversation.id, v_action, v_previous_status, v_conversation.status,
    v_expected, v_conversation.version, p_payload->>'actorUserId', p_payload->>'correlationId',
    nullif(p_payload->>'requestId',''), v_now, coalesce(p_payload->'metadata','{}'::jsonb));
  return query select 'changed', v_conversation.id, v_conversation.status, v_conversation.version,
    public.support_intake_canonical_utc_iso(v_conversation.last_activity_at),
    public.support_intake_canonical_utc_iso(v_conversation.closed_at),
    public.support_intake_canonical_utc_iso(v_conversation.updated_at);
end;
$$;

create or replace function public.support_transition_intake_conversation(p_payload jsonb)
returns table (id text, status text, version integer, last_activity_at text, closed_at text, updated_at text)
language sql security definer set search_path = pg_catalog, public, pg_temp
as $$
  select result.id, result.status, result.version, result.last_activity_at, result.closed_at, result.updated_at
  from public.support_transition_intake_conversation_v2(p_payload) result;
$$;

do $$
declare v_signature regprocedure;
begin
  foreach v_signature in array array[
    'public.support_intake_compact_key(text)'::regprocedure,
    'public.support_intake_classify_key(text)'::regprocedure,
    'public.support_intake_key_is_unsafe(text)'::regprocedure,
    'public.support_intake_json_has_unsafe_key(jsonb)'::regprocedure,
    'public.support_intake_json_has_invalid_number(jsonb)'::regprocedure,
    'public.support_intake_canonical_json(jsonb)'::regprocedure,
    'public.support_intake_legacy_attachment_material(jsonb)'::regprocedure,
    'public.support_intake_legacy_sorted_attachment_material(jsonb)'::regprocedure,
    'public.support_intake_legacy_message_material(jsonb)'::regprocedure,
    'public.support_intake_legacy_event_material(jsonb)'::regprocedure,
    'public.support_intake_target_references_valid(jsonb)'::regprocedure,
    'public.support_intake_attachment_source_material(jsonb)'::regprocedure,
    'public.support_intake_attachment_material(jsonb)'::regprocedure,
    'public.support_intake_attachment_source_hash(jsonb)'::regprocedure,
    'public.support_intake_sorted_attachment_material(jsonb)'::regprocedure,
    'public.support_intake_message_material(jsonb)'::regprocedure,
    'public.support_intake_event_material(jsonb)'::regprocedure,
    'public.support_intake_persisted_message_material(text)'::regprocedure,
    'public.support_intake_set_attachment_source_hash()'::regprocedure,
    'public.support_record_intake_event_delivery()'::regprocedure,
    'public.support_validate_intake_binding_target_references()'::regprocedure
  ] loop
    execute format('revoke all privileges on function %s from public, anon, authenticated', v_signature);
  end loop;
end;
$$;

revoke all privileges on function public.support_accept_intake_event_v2(jsonb) from public;
revoke execute on function public.support_accept_intake_event_v2(jsonb) from anon, authenticated;
grant execute on function public.support_accept_intake_event_v2(jsonb) to service_role;
revoke all privileges on function public.support_apply_intake_identity_binding_v2(jsonb) from public;
revoke execute on function public.support_apply_intake_identity_binding_v2(jsonb) from anon, authenticated;
grant execute on function public.support_apply_intake_identity_binding_v2(jsonb) to service_role;
revoke all privileges on function public.support_enqueue_integration_outbox_v2(jsonb) from public;
revoke execute on function public.support_enqueue_integration_outbox_v2(jsonb) from anon, authenticated;
grant execute on function public.support_enqueue_integration_outbox_v2(jsonb) to service_role;
revoke all privileges on function public.support_transition_intake_conversation_v2(jsonb) from public;
revoke execute on function public.support_transition_intake_conversation_v2(jsonb) from anon, authenticated;
grant execute on function public.support_transition_intake_conversation_v2(jsonb) to service_role;

comment on function public.support_accept_intake_event_v2(jsonb) is
  'AI-1.3.2 canonical replay acceptance with immutable Attachment source identity and chronological delivery ledger.';
comment on function public.support_transition_intake_conversation_v2(jsonb) is
  'AI-1.3.2 compare-and-swap transition; current-version same-state requests are unchanged and create no history.';

insert into public.support_schema_migrations (version, description, checksum, applied_by)
values ('202607220003', 'AI-1.3.2 canonical replay and event metric corrections', null, current_user)
on conflict (version) do nothing;

commit;
