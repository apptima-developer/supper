-- SUPPER AI-1.3.3: final replay, Attachment, delivery-ledger, and lock integrity.
-- Forward-only correction for immutable migrations 202607220001 through 202607220003.
-- No provider transport, Ticket creation, object bytes, worker, or outbound call is added.

begin;

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
    ]) or v_compact ~ '^(line|api|app|oauth|access|refresh|bearer|channel)token(value|string)?$'
      or v_compact ~ '^token(value|string)$'
      or v_compact ~ '^(app|oauth|client|channel|webhook|session|signing|signature)secret(value|string)?$'
      or v_compact ~ '^(pre)?signed(upload|asset|download)?url$'
      or v_compact in ('bearercredential','authorizationvalue') then return 'sensitive'; end if;
  return 'safe';
end;
$$;

create or replace function public.support_intake_set_attachment_source_hash()
returns trigger language plpgsql set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_expected_old text;
  v_new_hash text;
begin
  if tg_op = 'UPDATE' then
    v_expected_old := public.support_intake_attachment_source_hash(jsonb_build_object(
      'externalAttachmentId', old.external_attachment_id, 'fileName', old.file_name,
      'contentType', old.content_type, 'declaredSize', old.declared_size,
      'sha256', old.sha256, 'providerLocator', old.provider_locator, 'metadata', old.metadata));
    if old.source_material_hash is distinct from v_expected_old
      or old.canonical_hash is distinct from v_expected_old then
      raise exception using errcode = 'XX001', message = 'INTAKE_STORAGE_INTEGRITY_ERROR';
    end if;
    if new.external_attachment_id is distinct from old.external_attachment_id
      or new.file_name is distinct from old.file_name
      or new.content_type is distinct from old.content_type
      or new.declared_size is distinct from old.declared_size
      or new.sha256 is distinct from old.sha256
      or new.provider_locator is distinct from old.provider_locator
      or new.metadata is distinct from old.metadata
      or new.source_material_hash is distinct from old.source_material_hash
      or new.canonical_hash is distinct from old.canonical_hash then
      raise exception using errcode = '23505', message = 'INTAKE_ATTACHMENT_REPLAY_MISMATCH';
    end if;
    return new;
  end if;

  v_new_hash := public.support_intake_attachment_source_hash(jsonb_build_object(
    'externalAttachmentId', new.external_attachment_id, 'fileName', new.file_name,
    'contentType', new.content_type, 'declaredSize', new.declared_size,
    'sha256', new.sha256, 'providerLocator', new.provider_locator, 'metadata', new.metadata));
  new.source_material_hash := v_new_hash;
  new.canonical_hash := v_new_hash;
  return new;
end;
$$;

drop trigger if exists support_intake_attachment_source_hash_guard on public.intake_attachments;
create trigger support_intake_attachment_source_hash_guard
before insert or update on public.intake_attachments
for each row execute function public.support_intake_set_attachment_source_hash();

alter table public.intake_attachments drop constraint if exists intake_attachments_source_material_hash_check;
alter table public.intake_attachments add constraint intake_attachments_source_material_hash_check
  check (source_material_hash ~ '^[a-f0-9]{64}$');
alter table public.intake_attachments drop constraint if exists intake_attachments_canonical_hash_check;
alter table public.intake_attachments add constraint intake_attachments_canonical_hash_check
  check (canonical_hash ~ '^[a-f0-9]{64}$');
alter table public.intake_attachments drop constraint if exists intake_attachments_source_hashes_equal_check;
alter table public.intake_attachments add constraint intake_attachments_source_hashes_equal_check
  check (source_material_hash = canonical_hash);

drop trigger if exists support_intake_event_delivery_ledger on public.intake_events;
alter table public.intake_event_deliveries drop constraint if exists intake_event_deliveries_metadata_safe_check;
alter table public.intake_event_deliveries add constraint intake_event_deliveries_metadata_safe_check
  check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 16384
    and not public.support_intake_json_has_unsafe_key(metadata));

-- Preserve the proven 202607220002 write implementation under a private name. All
-- public generations delegate through one coordinator below, preventing mixed lock order.
do $$
begin
  if to_regprocedure('public.support_accept_intake_event_locked_write_impl(jsonb)') is null then
    alter function public.support_accept_intake_event(jsonb) rename to support_accept_intake_event_locked_write_impl;
  end if;
end;
$$;

revoke all privileges on function public.support_accept_intake_event_locked_write_impl(jsonb) from public;

create or replace function public.support_accept_intake_event_final_impl(p_payload jsonb)
returns table (action text, event_id text, identity_id text, conversation_id text, message_id text, attachment_count integer, session_id text, delivery_count integer)
language plpgsql security definer set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_channel public.integration_channels%rowtype;
  v_event public.intake_events%rowtype;
  v_existing_message public.intake_messages%rowtype;
  v_existing_conversation public.intake_conversations%rowtype;
  v_existing_identity public.integration_external_identities%rowtype;
  v_existing_attachment public.intake_attachments%rowtype;
  v_attachment jsonb;
  v_ordered_payload jsonb;
  v_external_attachment_id text;
  v_expected_attachment_hash text;
  v_incoming_attachment_hash text;
  v_event_hash text;
  v_legacy_event_hash text;
  v_persisted_message_hash text;
  v_persisted_content_hash text;
  v_received_at timestamptz;
  v_result record;
begin
  if jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 1000000
    or public.support_intake_json_has_unsafe_key(p_payload)
    or jsonb_typeof(coalesce(p_payload->'attachments', '[]'::jsonb)) <> 'array'
    or jsonb_array_length(coalesce(p_payload->'attachments', '[]'::jsonb)) > 50 then
    raise exception using errcode = '22023', message = 'INTAKE_PAYLOAD_INVALID';
  end if;
  if public.support_intake_json_has_invalid_number(p_payload) then
    raise exception using errcode = '22023', message = 'INTAKE_CANONICAL_NUMBER_INVALID';
  end if;

  if exists (
      select 1 from jsonb_array_elements(coalesce(p_payload->'attachments', '[]'::jsonb)) item
      where nullif(item->>'id','') is not null group by item->>'id' having count(*) > 1
    ) or exists (
      select 1 from jsonb_array_elements(coalesce(p_payload->'attachments', '[]'::jsonb)) item
      where nullif(item->>'externalAttachmentId','') is not null
      group by item->>'externalAttachmentId' having count(*) > 1
    ) then
    raise exception using errcode = '22023', message = 'INTAKE_ATTACHMENT_DUPLICATE_IN_EVENT';
  end if;

  select * into v_channel from public.integration_channels channel_record
  where channel_record.id = p_payload#>>'{channel,id}'
    and channel_record.provider = p_payload#>>'{channel,provider}'
    and channel_record.channel_key = p_payload#>>'{channel,channelKey}' and channel_record.enabled;
  if v_channel.id is null then
    raise exception using errcode = '22023', message = 'INTAKE_CHANNEL_UNAVAILABLE';
  end if;

  v_received_at := public.support_intake_parse_timestamp(p_payload#>>'{event,receivedAt}', 'INTAKE_PAYLOAD_INVALID');
  v_event_hash := encode(digest(public.support_intake_canonical_json(
    public.support_intake_event_material(p_payload)), 'sha256'), 'hex');

  -- Global lock order: Event, Message, Conversation, Identity, sorted Attachments.
  perform pg_advisory_xact_lock(hashtextextended('intake-event:' || v_channel.id || ':' || (p_payload#>>'{event,externalEventId}'), 0));
  select * into v_event from public.intake_events event_record
  where event_record.channel_id = v_channel.id
    and event_record.external_event_id = p_payload#>>'{event,externalEventId}' for update;
  if v_event.id is not null and v_event.payload_hash <> v_event_hash
    and coalesce(v_event.metadata->>'_canonicalVersion', '') <> '2' then
    v_legacy_event_hash := encode(digest(public.support_intake_canonical_json(
      public.support_intake_legacy_event_material(p_payload)), 'sha256'), 'hex');
    if v_event.payload_hash <> v_legacy_event_hash then
      raise exception using errcode = '23505', message = 'INTAKE_EVENT_REPLAY_MISMATCH';
    end if;
    update public.intake_events event_record set payload_hash = v_event_hash,
      metadata = event_record.metadata || jsonb_build_object('_canonicalVersion', 2)
    where event_record.id = v_event.id returning * into v_event;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('intake-message:' || v_channel.id || ':' || (p_payload#>>'{message,externalMessageId}'), 0));
  select * into v_existing_message from public.intake_messages message_record
  where message_record.channel_id = v_channel.id
    and message_record.external_message_id = p_payload#>>'{message,externalMessageId}' for update;

  perform pg_advisory_xact_lock(hashtextextended('intake-conversation:' || v_channel.id || ':' || (p_payload#>>'{conversation,externalConversationId}'), 0));
  select * into v_existing_conversation from public.intake_conversations conversation_record
  where conversation_record.channel_id = v_channel.id
    and conversation_record.external_conversation_id = p_payload#>>'{conversation,externalConversationId}' for update;

  perform pg_advisory_xact_lock(hashtextextended('intake-identity:' || v_channel.id || ':' || (p_payload#>>'{identity,externalSubjectId}'), 0));
  select * into v_existing_identity from public.integration_external_identities identity_record
  where identity_record.channel_id = v_channel.id
    and identity_record.external_subject_id = p_payload#>>'{identity,externalSubjectId}' for update;

  for v_external_attachment_id in
    select item->>'externalAttachmentId'
    from jsonb_array_elements(coalesce(p_payload->'attachments', '[]'::jsonb)) item
    where nullif(item->>'externalAttachmentId','') is not null
    order by item->>'externalAttachmentId' collate "C"
  loop
    perform pg_advisory_xact_lock(hashtextextended(
      'intake-attachment:' || v_channel.id || ':' || v_external_attachment_id, 0));
    select * into v_existing_attachment from public.intake_attachments attachment_record
    where attachment_record.channel_id = v_channel.id
      and attachment_record.external_attachment_id = v_external_attachment_id for update;
    if v_existing_attachment.id is not null then
      v_expected_attachment_hash := public.support_intake_attachment_source_hash(jsonb_build_object(
        'externalAttachmentId', v_existing_attachment.external_attachment_id,
        'fileName', v_existing_attachment.file_name, 'contentType', v_existing_attachment.content_type,
        'declaredSize', v_existing_attachment.declared_size, 'sha256', v_existing_attachment.sha256,
        'providerLocator', v_existing_attachment.provider_locator, 'metadata', v_existing_attachment.metadata));
      if v_existing_attachment.source_material_hash is distinct from v_expected_attachment_hash
        or v_existing_attachment.canonical_hash is distinct from v_expected_attachment_hash then
        raise exception using errcode = 'XX001', message = 'INTAKE_STORAGE_INTEGRITY_ERROR';
      end if;
      select item into v_attachment
      from jsonb_array_elements(coalesce(p_payload->'attachments', '[]'::jsonb)) item
      where item->>'externalAttachmentId' = v_external_attachment_id;
      v_incoming_attachment_hash := public.support_intake_attachment_source_hash(v_attachment);
      if v_incoming_attachment_hash <> v_expected_attachment_hash then
        raise exception using errcode = '23505', message = 'INTAKE_ATTACHMENT_REPLAY_MISMATCH';
      end if;
    end if;
  end loop;

  select jsonb_set(p_payload, '{attachments}', coalesce(jsonb_agg(item order by
    coalesce(item->>'externalAttachmentId','') collate "C", item->>'id' collate "C"), '[]'::jsonb))
  into v_ordered_payload
  from jsonb_array_elements(coalesce(p_payload->'attachments', '[]'::jsonb)) item;

  -- The private write primitive cannot be executed directly. Every lock it repeats
  -- is already held by this coordinator, and its Attachment input is deterministic.
  select * into v_result from public.support_accept_intake_event_locked_write_impl(v_ordered_payload);

  select message_record.content_hash,
    encode(digest(public.support_intake_canonical_json(
      public.support_intake_persisted_message_material(message_record.id)), 'sha256'), 'hex')
  into v_persisted_content_hash, v_persisted_message_hash
  from public.intake_messages message_record where message_record.id = v_result.message_id;
  if v_persisted_content_hash is null or v_persisted_message_hash is null
    or v_persisted_content_hash <> v_persisted_message_hash then
    raise exception using errcode = 'XX001', message = 'INTAKE_STORAGE_INTEGRITY_ERROR';
  end if;

  update public.intake_events event_record set
    metadata = event_record.metadata || jsonb_build_object('_canonicalVersion', 2)
  where event_record.id = v_result.event_id
    and coalesce(event_record.metadata->>'_canonicalVersion', '') <> '2';

  insert into public.intake_event_deliveries
    (id, event_id, channel_id, delivery_number, delivery_type, received_at,
      request_id, correlation_id, metadata)
  values (v_result.event_id || ':delivery:' || v_result.delivery_count::text,
    v_result.event_id, v_channel.id, v_result.delivery_count,
    case when v_result.action = 'duplicate' then 'duplicate' else 'initial' end,
    v_received_at, nullif(p_payload#>>'{event,requestId}', ''),
    p_payload#>>'{event,correlationId}', '{}'::jsonb);

  return query select v_result.action, v_result.event_id, v_result.identity_id,
    v_result.conversation_id, v_result.message_id, v_result.attachment_count,
    v_result.session_id, v_result.delivery_count;
end;
$$;

revoke all privileges on function public.support_accept_intake_event_final_impl(jsonb) from public;

create or replace function public.support_accept_intake_event(p_payload jsonb)
returns table (action text, event_id text, identity_id text, conversation_id text, message_id text, attachment_count integer, session_id text, delivery_count integer)
language sql security definer set search_path = pg_catalog, public, pg_temp
as $$ select * from public.support_accept_intake_event_final_impl(p_payload); $$;

create or replace function public.support_accept_intake_event_v2(p_payload jsonb)
returns table (action text, event_id text, identity_id text, conversation_id text, message_id text, attachment_count integer, session_id text, delivery_count integer)
language sql security definer set search_path = pg_catalog, public, pg_temp
as $$ select * from public.support_accept_intake_event_final_impl(p_payload); $$;

create or replace function public.support_accept_intake_event_v3(p_payload jsonb)
returns table (action text, event_id text, identity_id text, conversation_id text, message_id text, attachment_count integer, session_id text, delivery_count integer)
language sql security definer set search_path = pg_catalog, public, pg_temp
as $$ select * from public.support_accept_intake_event_final_impl(p_payload); $$;

do $$
declare v_signature regprocedure;
begin
  foreach v_signature in array array[
    'public.support_intake_classify_key(text)'::regprocedure,
    'public.support_intake_set_attachment_source_hash()'::regprocedure,
    'public.support_record_intake_event_delivery()'::regprocedure,
    'public.support_accept_intake_event_locked_write_impl(jsonb)'::regprocedure,
    'public.support_accept_intake_event_final_impl(jsonb)'::regprocedure
  ] loop
    execute format('revoke all privileges on function %s from public, anon, authenticated, service_role', v_signature);
  end loop;
end;
$$;

revoke all privileges on function public.support_accept_intake_event(jsonb) from public;
revoke execute on function public.support_accept_intake_event(jsonb) from anon, authenticated;
grant execute on function public.support_accept_intake_event(jsonb) to service_role;
revoke all privileges on function public.support_accept_intake_event_v2(jsonb) from public;
revoke execute on function public.support_accept_intake_event_v2(jsonb) from anon, authenticated;
grant execute on function public.support_accept_intake_event_v2(jsonb) to service_role;
revoke all privileges on function public.support_accept_intake_event_v3(jsonb) from public;
revoke execute on function public.support_accept_intake_event_v3(jsonb) from anon, authenticated;
grant execute on function public.support_accept_intake_event_v3(jsonb) to service_role;

comment on function public.support_accept_intake_event_v3(jsonb) is
  'AI-1.3.3 acceptance with one global lock order, duplicate-Attachment rejection, post-write Message integrity, and request-exact delivery ledger rows.';

insert into public.support_schema_migrations (version, description, checksum, applied_by)
values ('202607220004', 'AI-1.3.3 final intake replay attachment and lock integrity', null, current_user)
on conflict (version) do nothing;

commit;
