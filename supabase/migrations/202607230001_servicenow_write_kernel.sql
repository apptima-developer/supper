-- SUPPER AI-2.0.1: controlled ServiceNow write kernel.
-- This migration remained unapplied on the isolated development project and
-- is amended in place before first application. It performs no provider call.

begin;

create table if not exists public.servicenow_write_connections (
  id text primary key,
  name text not null check (length(btrim(name)) between 1 and 200),
  active boolean not null default true,
  auth_mode text not null check (auth_mode in ('basic', 'oauth_client_credentials')),
  instance_url text not null check (
    length(instance_url) <= 500
    and instance_url !~* '[@?#]'
    and (
      instance_url ~* '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'
      or instance_url ~* '^http://(localhost|127[.]0[.]0[.]1|[[]::1[]])(:[0-9]{1,5})?$'
    )
  ),
  incident_table text not null check (incident_table ~ '^[a-z][a-z0-9_]{0,79}$'),
  default_assignment_group text check (
    default_assignment_group is null or default_assignment_group ~ '^[a-f0-9]{32}$'
  ),
  timeout_ms integer not null check (timeout_ms between 1000 and 60000),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object'
    and octet_length(metadata::text) <= 8192
    and not public.support_intake_json_has_unsafe_key(metadata)
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.servicenow_write_mappings (
  id text primary key,
  connection_id text not null references public.servicenow_write_connections(id) on delete restrict,
  command_type text not null check (command_type in ('create_incident', 'update_incident', 'add_comment', 'add_work_note')),
  mapping_name text not null check (length(btrim(mapping_name)) between 1 and 200),
  active boolean not null default true,
  field_mapping jsonb not null check (
    jsonb_typeof(field_mapping) = 'object'
    and octet_length(field_mapping::text) <= 32768
    and not public.support_intake_json_has_unsafe_key(field_mapping)
  ),
  metadata jsonb not null default '{}'::jsonb check (
    jsonb_typeof(metadata) = 'object'
    and octet_length(metadata::text) <= 8192
    and not public.support_intake_json_has_unsafe_key(metadata)
  ),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, command_type, mapping_name)
);

create table if not exists public.servicenow_write_commands (
  id text primary key,
  version integer not null default 1 check (version >= 1),
  command_type text not null check (command_type in ('create_incident', 'update_incident', 'add_comment', 'add_work_note')),
  status text not null check (status in (
    'pending', 'validated', 'dry_run_ready', 'executing', 'succeeded',
    'failed', 'retry_scheduled', 'reconciliation_required', 'cancelled'
  )),
  idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'),
  normalized_payload_hash text not null check (normalized_payload_hash ~ '^[a-f0-9]{64}$'),
  connection_id text not null references public.servicenow_write_connections(id) on delete restrict,
  mapping_id text not null references public.servicenow_write_mappings(id) on delete restrict,
  source_type text not null check (source_type in ('manual', 'supper_ticket', 'intake_conversation', 'integration_outbox')),
  source_entity_reference text check (
    source_entity_reference is null or length(btrim(source_entity_reference)) between 1 and 500
  ),
  operation_reference text not null check (
    length(operation_reference) between 1 and 500
    and operation_reference ~ '^[A-Za-z0-9._:-]+$'
  ),
  target_table text not null check (target_table ~ '^[a-z][a-z0-9_]{0,79}$'),
  target_sys_id text check (target_sys_id is null or target_sys_id ~ '^[a-f0-9]{32}$'),
  target_number text check (target_number is null or target_number ~ '^[A-Za-z0-9_-]{1,80}$'),
  provider_correlation_marker text check (
    provider_correlation_marker is null or provider_correlation_marker ~ '^SUPPER:[a-f0-9]{64}$'
  ),
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and octet_length(payload::text) <= 65536
    and not public.support_intake_json_has_unsafe_key(payload)
  ),
  normalized_payload jsonb not null check (
    jsonb_typeof(normalized_payload) = 'object'
    and octet_length(normalized_payload::text) <= 65536
    and not public.support_intake_json_has_unsafe_key(normalized_payload)
  ),
  validation_summary jsonb not null default '{}'::jsonb check (
    jsonb_typeof(validation_summary) = 'object'
    and octet_length(validation_summary::text) <= 8192
    and not public.support_intake_json_has_unsafe_key(validation_summary)
  ),
  safe_request_summary jsonb not null default '{}'::jsonb check (
    jsonb_typeof(safe_request_summary) = 'object'
    and octet_length(safe_request_summary::text) <= 8192
    and not public.support_intake_json_has_unsafe_key(safe_request_summary)
  ),
  safe_response_summary jsonb not null default '{}'::jsonb check (
    jsonb_typeof(safe_response_summary) = 'object'
    and octet_length(safe_response_summary::text) <= 8192
    and not public.support_intake_json_has_unsafe_key(safe_response_summary)
  ),
  delivery_disposition text check (delivery_disposition is null or delivery_disposition in (
    'definitely_not_sent', 'definitely_rejected', 'safe_to_retry',
    'confirmed_succeeded', 'may_have_committed'
  )),
  failure_phase text check (failure_phase is null or failure_phase in (
    'configuration', 'authorization', 'number_lookup', 'mutation_dispatch',
    'mutation_response', 'response_parse', 'read_back'
  )),
  retry_allowed boolean not null default false,
  retry_reason text check (retry_reason is null or length(retry_reason) between 1 and 240),
  reconciliation_reason text check (reconciliation_reason is null or length(reconciliation_reason) between 1 and 240),
  reconciliation_checked_at timestamptz,
  reconciled_by_user_id text check (
    reconciled_by_user_id is null or length(btrim(reconciled_by_user_id)) between 1 and 200
  ),
  reconciliation_result text check (
    reconciliation_result is null or reconciliation_result ~ '^[a-z_]{1,100}$'
  ),
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,80}$'),
  error_message text check (error_message is null or length(error_message) between 1 and 240),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10 and attempt_count <= max_attempts),
  next_retry_at timestamptz,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  confirmation_nonce_hash text check (confirmation_nonce_hash is null or confirmation_nonce_hash ~ '^[a-f0-9]{64}$'),
  confirmation_action text check (confirmation_action is null or confirmation_action in (
    'execute', 'retry', 'reconcile_by_read_back',
    'mark_succeeded_after_verification', 'mark_not_applied_after_verification'
  )),
  confirmation_user_id text check (
    confirmation_user_id is null or length(btrim(confirmation_user_id)) between 1 and 200
  ),
  confirmation_expires_at timestamptz,
  created_by text not null check (length(btrim(created_by)) between 1 and 200),
  request_id text check (request_id is null or length(request_id) between 8 and 100),
  correlation_id text not null check (length(correlation_id) between 8 and 100),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  unique (
    connection_id, command_type, operation_reference, source_type,
    source_entity_reference, target_table
  ),
  check (
    (command_type = 'create_incident' and target_sys_id is null and target_number is null and provider_correlation_marker is not null)
    or
    (command_type <> 'create_incident' and ((target_sys_id is null) <> (target_number is null)) and provider_correlation_marker is null)
    or status = 'succeeded'
  ),
  check (
    (status = 'retry_scheduled' and next_retry_at is not null and retry_allowed)
    or status <> 'retry_scheduled'
  ),
  check (
    (status = 'reconciliation_required' and delivery_disposition = 'may_have_committed' and not retry_allowed)
    or status <> 'reconciliation_required'
  ),
  check (
    (confirmation_nonce_hash is null and confirmation_action is null and confirmation_user_id is null and confirmation_expires_at is null)
    or
    (confirmation_nonce_hash is not null and confirmation_action is not null and confirmation_user_id is not null and confirmation_expires_at is not null)
  )
);

create table if not exists public.servicenow_write_attempts (
  id text primary key,
  command_id text not null references public.servicenow_write_commands(id) on delete restrict,
  attempt_number integer not null check (attempt_number between 1 and 100),
  execution_mode text not null check (execution_mode in ('dry_run', 'live', 'retry')),
  request_summary jsonb not null default '{}'::jsonb check (
    jsonb_typeof(request_summary) = 'object'
    and octet_length(request_summary::text) <= 8192
    and not public.support_intake_json_has_unsafe_key(request_summary)
  ),
  response_summary jsonb not null default '{}'::jsonb check (
    jsonb_typeof(response_summary) = 'object'
    and octet_length(response_summary::text) <= 8192
    and not public.support_intake_json_has_unsafe_key(response_summary)
  ),
  outcome text not null check (outcome in ('executing', 'dry_run', 'succeeded', 'failed', 'uncertain')),
  delivery_disposition text check (delivery_disposition is null or delivery_disposition in (
    'definitely_not_sent', 'definitely_rejected', 'safe_to_retry',
    'confirmed_succeeded', 'may_have_committed'
  )),
  failure_phase text check (failure_phase is null or failure_phase in (
    'configuration', 'authorization', 'number_lookup', 'mutation_dispatch',
    'mutation_response', 'response_parse', 'read_back'
  )),
  retry_allowed boolean not null default false,
  retry_reason text check (retry_reason is null or length(retry_reason) between 1 and 240),
  reconciliation_reason text check (reconciliation_reason is null or length(reconciliation_reason) between 1 and 240),
  safe_error_code text check (safe_error_code is null or safe_error_code ~ '^[A-Z0-9_]{1,80}$'),
  safe_error_message text check (safe_error_message is null or length(safe_error_message) between 1 and 240),
  request_id text check (request_id is null or length(request_id) between 8 and 100),
  started_at timestamptz not null,
  finished_at timestamptz,
  unique (command_id, attempt_number),
  check ((outcome = 'executing' and finished_at is null) or (outcome <> 'executing' and finished_at is not null)),
  check ((outcome = 'uncertain' and delivery_disposition = 'may_have_committed' and not retry_allowed) or outcome <> 'uncertain')
);

create table if not exists public.servicenow_ticket_links (
  id text primary key,
  supper_ticket_id text references public.support_tickets(id) on delete restrict,
  intake_conversation_id text references public.intake_conversations(id) on delete restrict,
  servicenow_sys_id text not null check (servicenow_sys_id ~ '^[a-f0-9]{32}$'),
  servicenow_number text not null check (servicenow_number ~ '^[A-Za-z0-9_-]{1,80}$'),
  table_name text not null check (table_name ~ '^[a-z][a-z0-9_]{0,79}$'),
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (table_name, servicenow_sys_id),
  unique (table_name, servicenow_number),
  check (supper_ticket_id is not null or intake_conversation_id is not null)
);

create table if not exists public.servicenow_write_reconciliation_events (
  id text primary key,
  command_id text not null references public.servicenow_write_commands(id) on delete restrict,
  action text not null check (action in (
    'reconcile_by_read_back', 'mark_succeeded_after_verification',
    'mark_not_applied_after_verification'
  )),
  result text not null check (result ~ '^[a-z_]{1,100}$'),
  safe_read_back_summary jsonb not null default '{}'::jsonb check (
    jsonb_typeof(safe_read_back_summary) = 'object'
    and octet_length(safe_read_back_summary::text) <= 8192
    and not public.support_intake_json_has_unsafe_key(safe_read_back_summary)
  ),
  actor_user_id text not null check (length(btrim(actor_user_id)) between 1 and 200),
  request_id text check (request_id is null or length(request_id) between 8 and 100),
  command_version_before integer not null check (command_version_before >= 1),
  command_version_after integer not null check (command_version_after > command_version_before),
  created_at timestamptz not null
);

create unique index if not exists servicenow_write_mappings_one_active_idx
  on public.servicenow_write_mappings(connection_id, command_type) where active;
create index if not exists servicenow_write_connections_active_idx
  on public.servicenow_write_connections(active, updated_at desc);
create index if not exists servicenow_write_mappings_connection_idx
  on public.servicenow_write_mappings(connection_id, command_type, active);
create index if not exists servicenow_write_commands_status_idx
  on public.servicenow_write_commands(status, updated_at desc);
create index if not exists servicenow_write_commands_connection_idx
  on public.servicenow_write_commands(connection_id, created_at desc);
create index if not exists servicenow_write_commands_type_idx
  on public.servicenow_write_commands(command_type, created_at desc);
create index if not exists servicenow_write_commands_created_at_idx
  on public.servicenow_write_commands(created_at desc);
create index if not exists servicenow_write_commands_retry_idx
  on public.servicenow_write_commands(next_retry_at) where status = 'retry_scheduled';
create index if not exists servicenow_write_attempts_command_idx
  on public.servicenow_write_attempts(command_id, attempt_number);
create index if not exists servicenow_write_reconciliation_command_idx
  on public.servicenow_write_reconciliation_events(command_id, created_at desc);
create index if not exists servicenow_ticket_links_ticket_idx
  on public.servicenow_ticket_links(supper_ticket_id) where supper_ticket_id is not null;
create index if not exists servicenow_ticket_links_conversation_idx
  on public.servicenow_ticket_links(intake_conversation_id) where intake_conversation_id is not null;

alter table public.servicenow_write_connections enable row level security;
alter table public.servicenow_write_mappings enable row level security;
alter table public.servicenow_write_commands enable row level security;
alter table public.servicenow_write_attempts enable row level security;
alter table public.servicenow_ticket_links enable row level security;
alter table public.servicenow_write_reconciliation_events enable row level security;

revoke all privileges on table public.servicenow_write_connections from public, anon, authenticated;
revoke all privileges on table public.servicenow_write_mappings from public, anon, authenticated;
revoke all privileges on table public.servicenow_write_commands from public, anon, authenticated;
revoke all privileges on table public.servicenow_write_attempts from public, anon, authenticated;
revoke all privileges on table public.servicenow_ticket_links from public, anon, authenticated;
revoke all privileges on table public.servicenow_write_reconciliation_events from public, anon, authenticated;

-- The server may read configuration and ledgers directly, but all mutation is
-- constrained to the reviewed SECURITY DEFINER RPCs below.
grant select on table public.servicenow_write_connections to service_role;
grant select on table public.servicenow_write_mappings to service_role;
grant select on table public.servicenow_write_commands to service_role;
grant select on table public.servicenow_write_attempts to service_role;
grant select on table public.servicenow_ticket_links to service_role;
grant select on table public.servicenow_write_reconciliation_events to service_role;

create or replace function public.support_servicenow_write_segment(p_value text)
returns text
language sql
immutable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select octet_length(coalesce(p_value, ''))::text || ':' || coalesce(p_value, '');
$$;

create or replace function public.support_servicenow_write_validate_mapping(
  p_command_type text,
  p_mapping jsonb
)
returns void
language plpgsql
immutable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_expected jsonb;
begin
  v_expected := case p_command_type
    when 'create_incident' then '{
      "shortDescription":"short_description","description":"description",
      "callerId":"caller_id","category":"category","subcategory":"subcategory",
      "impact":"impact","urgency":"urgency","assignmentGroup":"assignment_group",
      "contactChannel":"contact_type","customer":"company","projectCode":"u_project_code"
    }'::jsonb
    when 'update_incident' then '{
      "shortDescription":"short_description","description":"description","state":"state",
      "impact":"impact","urgency":"urgency","assignmentGroup":"assignment_group",
      "customer":"company","projectCode":"u_project_code"
    }'::jsonb
    when 'add_comment' then '{"text":"comments"}'::jsonb
    when 'add_work_note' then '{"text":"work_notes"}'::jsonb
    else null
  end;
  if v_expected is null
    or p_mapping is null
    or jsonb_typeof(p_mapping) <> 'object'
    or p_mapping <> v_expected
    or exists (
      select 1
      from jsonb_each_text(p_mapping) mapped
      group by mapped.value
      having count(*) > 1
    )
    or p_mapping @> '{"correlation_id":"correlation_id"}'::jsonb
    or p_mapping ? 'correlationId' then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_MAPPING_INVALID';
  end if;
end;
$$;

create or replace function public.support_servicenow_write_idempotency_hash(
  p_connection_id text,
  p_command_type text,
  p_operation_reference text,
  p_source_type text,
  p_source_entity_reference text,
  p_target_table text
)
returns text
language sql
immutable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select public.support_intake_sha256_hex(
    'servicenow-write-v2'
    || '|' || public.support_servicenow_write_segment(p_connection_id)
    || '|' || public.support_servicenow_write_segment(p_command_type)
    || '|' || public.support_servicenow_write_segment(p_operation_reference)
    || '|' || public.support_servicenow_write_segment(p_source_type)
    || '|' || public.support_servicenow_write_segment(p_source_entity_reference)
    || '|' || public.support_servicenow_write_segment(p_target_table)
  );
$$;

create or replace function public.support_servicenow_write_normalize(
  p_command_type text,
  p_payload jsonb,
  p_mapping jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
immutable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_fields jsonb := '{}'::jsonb;
  v_allowed_keys text[];
  v_source text;
  v_target text;
  v_value text;
  v_target_sys_id text;
  v_target_number text;
  v_marker text;
begin
  perform public.support_servicenow_write_validate_mapping(p_command_type, p_mapping);
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 65536
    or public.support_intake_json_has_unsafe_key(p_payload) then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_PAYLOAD_INVALID';
  end if;

  v_allowed_keys := case p_command_type
    when 'create_incident' then array[
      'shortDescription','description','callerId','category','subcategory',
      'impact','urgency','assignmentGroup','contactChannel','customer',
      'projectCode','supperTicketNo','externalReferences'
    ]
    when 'update_incident' then array[
      'sysId','number','shortDescription','description','state','impact',
      'urgency','assignmentGroup','customer','projectCode'
    ]
    when 'add_comment' then array['sysId','number','text']
    when 'add_work_note' then array['sysId','number','text']
    else null
  end;
  if v_allowed_keys is null
    or exists (
      select 1 from jsonb_object_keys(p_payload) supplied(key)
      where not supplied.key = any(v_allowed_keys)
    )
    or exists (
      select 1 from jsonb_each(p_payload) supplied(key, value)
      where supplied.key <> 'externalReferences' and jsonb_typeof(supplied.value) <> 'string'
    )
    or (
      p_payload ? 'externalReferences'
      and (
        jsonb_typeof(p_payload->'externalReferences') <> 'object'
        or octet_length((p_payload->'externalReferences')::text) > 8192
      )
    ) then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_PAYLOAD_INVALID';
  end if;

  if p_command_type = 'create_incident' then
    if length(btrim(coalesce(p_payload->>'shortDescription', ''))) not between 1 and 160
      or length(btrim(coalesce(p_payload->>'description', ''))) not between 1 and 20000 then
      raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_PAYLOAD_INVALID';
    end if;
    v_marker := 'SUPPER:' || p_idempotency_key;
  else
    v_target_sys_id := nullif(p_payload->>'sysId', '');
    v_target_number := nullif(p_payload->>'number', '');
    if (v_target_sys_id is null) = (v_target_number is null)
      or (v_target_sys_id is not null and v_target_sys_id !~ '^[a-f0-9]{32}$')
      or (v_target_number is not null and v_target_number !~ '^[A-Za-z0-9_-]{1,80}$') then
      raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_TARGET_INVALID';
    end if;
  end if;

  if p_command_type in ('add_comment', 'add_work_note')
    and length(btrim(coalesce(p_payload->>'text', ''))) not between 1 and 20000 then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_PAYLOAD_INVALID';
  end if;

  if (p_payload ? 'callerId' and p_payload->>'callerId' !~ '^[a-f0-9]{32}$')
    or (p_payload ? 'assignmentGroup' and p_payload->>'assignmentGroup' !~ '^[a-f0-9]{32}$')
    or (p_payload ? 'customer' and p_payload->>'customer' !~ '^[a-f0-9]{32}$')
    or (p_payload ? 'impact' and p_payload->>'impact' not in ('1','2','3'))
    or (p_payload ? 'urgency' and p_payload->>'urgency' not in ('1','2','3'))
    or (p_payload ? 'state' and p_payload->>'state' not in ('1','2','3','6','7','8')) then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_PAYLOAD_INVALID';
  end if;

  for v_source, v_target in select key, value from jsonb_each_text(p_mapping)
  loop
    v_value := nullif(p_payload->>v_source, '');
    if v_value is not null then
      if length(v_value) > 20000 then
        raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_PAYLOAD_INVALID';
      end if;
      v_fields := v_fields || jsonb_build_object(v_target, v_value);
    end if;
  end loop;
  if p_command_type = 'create_incident' then
    v_fields := v_fields || jsonb_build_object('correlation_id', v_marker);
  end if;
  if v_fields = '{}'::jsonb then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_EMPTY_MAPPING';
  end if;
  if p_command_type = 'update_incident'
    and not exists (
      select 1 from jsonb_object_keys(v_fields)
    ) then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_EMPTY_MAPPING';
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'schemaVersion', 'servicenow-write-normalized-v2',
    'commandType', p_command_type,
    'targetSysId', v_target_sys_id,
    'targetNumber', v_target_number,
    'providerCorrelationMarker', v_marker,
    'fields', v_fields
  ));
end;
$$;

create or replace function public.support_servicenow_write_normalized_hash(p_normalized jsonb)
returns text
language plpgsql
immutable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_fields text;
begin
  select coalesce(string_agg(
    public.support_servicenow_write_segment(field.key)
    || public.support_servicenow_write_segment(field.value),
    '|' order by field.key
  ), '')
  into v_fields
  from jsonb_each_text(p_normalized->'fields') field;
  return public.support_intake_sha256_hex(
    'servicenow-write-normalized-v2'
    || '|' || public.support_servicenow_write_segment(p_normalized->>'commandType')
    || '|' || public.support_servicenow_write_segment(p_normalized->>'targetSysId')
    || '|' || public.support_servicenow_write_segment(p_normalized->>'targetNumber')
    || '|' || public.support_servicenow_write_segment(p_normalized->>'providerCorrelationMarker')
    || '|' || v_fields
  );
end;
$$;

create or replace function public.support_servicenow_write_confirmation_hash(p_nonce text)
returns text
language sql
immutable
set search_path = pg_catalog, public, extensions, pg_temp
as $$
  select public.support_intake_sha256_hex(
    'servicenow-write-confirmation-v1'
    || '|' || public.support_servicenow_write_segment(p_nonce)
  );
$$;

create or replace function public.support_upsert_servicenow_write_connection(p_payload jsonb)
returns table (id text)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_updated_at timestamptz;
  v_timeout integer;
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or public.support_intake_json_has_unsafe_key(p_payload)
    or exists (
      select 1 from jsonb_object_keys(p_payload) supplied(key)
      where supplied.key not in (
        'id','name','active','authMode','instanceUrl','incidentTable',
        'timeoutMs','metadata','updatedAt'
      )
    )
    or jsonb_typeof(p_payload->'active') <> 'boolean'
    or jsonb_typeof(p_payload->'timeoutMs') <> 'number'
    or p_payload->>'timeoutMs' !~ '^[0-9]+$'
    or p_payload->>'updatedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or length(btrim(coalesce(p_payload->>'id',''))) not between 1 and 200
    or length(btrim(coalesce(p_payload->>'name',''))) not between 1 and 200
    or p_payload->>'authMode' not in ('basic','oauth_client_credentials')
    or p_payload->>'incidentTable' !~ '^[a-z][a-z0-9_]{0,79}$'
    or jsonb_typeof(coalesce(p_payload->'metadata','{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_CONNECTION_INVALID';
  end if;
  v_timeout := (p_payload->>'timeoutMs')::integer;
  v_updated_at := (p_payload->>'updatedAt')::timestamptz;
  if v_timeout not between 1000 and 60000
    or (
      p_payload->>'instanceUrl' !~* '^https://[a-z0-9.-]+(:[0-9]{1,5})?$'
      and p_payload->>'instanceUrl' !~* '^http://(localhost|127[.]0[.]0[.]1|[[]::1[]])(:[0-9]{1,5})?$'
    ) then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_CONNECTION_INVALID';
  end if;
  insert into public.servicenow_write_connections (
    id,name,active,auth_mode,instance_url,incident_table,timeout_ms,metadata,created_at,updated_at
  ) values (
    p_payload->>'id',p_payload->>'name',(p_payload->>'active')::boolean,
    p_payload->>'authMode',p_payload->>'instanceUrl',p_payload->>'incidentTable',
    v_timeout,coalesce(p_payload->'metadata','{}'::jsonb),v_updated_at,v_updated_at
  )
  on conflict on constraint servicenow_write_connections_pkey do update set
    name=excluded.name,active=excluded.active,auth_mode=excluded.auth_mode,
    instance_url=excluded.instance_url,incident_table=excluded.incident_table,
    timeout_ms=excluded.timeout_ms,metadata=excluded.metadata,updated_at=excluded.updated_at;
  return query select p_payload->>'id';
end;
$$;

create or replace function public.support_upsert_servicenow_write_mapping(p_payload jsonb)
returns table (id text, field_mapping jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_updated_at timestamptz;
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or public.support_intake_json_has_unsafe_key(p_payload)
    or exists (
      select 1 from jsonb_object_keys(p_payload) supplied(key)
      where supplied.key not in (
        'id','connectionId','commandType','mappingName','active',
        'fieldMapping','metadata','updatedAt'
      )
    )
    or jsonb_typeof(p_payload->'active') <> 'boolean'
    or p_payload->>'updatedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or length(btrim(coalesce(p_payload->>'id',''))) not between 1 and 200
    or length(btrim(coalesce(p_payload->>'connectionId',''))) not between 1 and 200
    or length(btrim(coalesce(p_payload->>'mappingName',''))) not between 1 and 200
    or jsonb_typeof(coalesce(p_payload->'metadata','{}'::jsonb)) <> 'object' then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_MAPPING_INVALID';
  end if;
  perform public.support_servicenow_write_validate_mapping(
    p_payload->>'commandType', p_payload->'fieldMapping'
  );
  if not exists (
    select 1 from public.servicenow_write_connections
    where servicenow_write_connections.id = p_payload->>'connectionId' and active
  ) then
    raise exception using errcode = '23503', message = 'SERVICENOW_WRITE_CONNECTION_UNAVAILABLE';
  end if;
  v_updated_at := (p_payload->>'updatedAt')::timestamptz;
  if (p_payload->>'active')::boolean then
    update public.servicenow_write_mappings mapping_record set
      active=false,updated_at=v_updated_at
    where mapping_record.connection_id=p_payload->>'connectionId'
      and mapping_record.command_type=p_payload->>'commandType'
      and mapping_record.id<>p_payload->>'id'
      and mapping_record.active;
  end if;
  insert into public.servicenow_write_mappings (
    id,connection_id,command_type,mapping_name,active,field_mapping,
    metadata,created_at,updated_at
  ) values (
    p_payload->>'id',p_payload->>'connectionId',p_payload->>'commandType',
    p_payload->>'mappingName',(p_payload->>'active')::boolean,p_payload->'fieldMapping',
    coalesce(p_payload->'metadata','{}'::jsonb),v_updated_at,v_updated_at
  )
  on conflict on constraint servicenow_write_mappings_pkey do update set
    connection_id=excluded.connection_id,command_type=excluded.command_type,
    mapping_name=excluded.mapping_name,active=excluded.active,
    field_mapping=excluded.field_mapping,metadata=excluded.metadata,updated_at=excluded.updated_at;
  return query select p_payload->>'id', p_payload->'fieldMapping';
end;
$$;

create or replace function public.support_create_servicenow_write_command(p_payload jsonb)
returns table (
  action text,
  command_id text,
  command_status text,
  command_attempt_count integer,
  command_version integer,
  normalized_payload_hash text
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_existing public.servicenow_write_commands%rowtype;
  v_connection public.servicenow_write_connections%rowtype;
  v_mapping public.servicenow_write_mappings%rowtype;
  v_normalized jsonb;
  v_idempotency_key text;
  v_normalized_hash text;
  v_created_at timestamptz;
  v_max_attempts integer;
  v_source_entity_reference text;
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 180000
    or public.support_intake_json_has_unsafe_key(p_payload)
    or exists (
      select 1 from jsonb_object_keys(p_payload) supplied(key)
      where supplied.key not in (
        'commandId','commandType','idempotencyKey','normalizedPayloadHash',
        'connectionId','mappingId','sourceType','sourceEntityReference',
        'operationReference','targetTable','targetSysId','targetNumber',
        'providerCorrelationMarker','payload','normalizedPayload',
        'validationSummary','maxAttempts','createdBy','requestId',
        'correlationId','createdAt'
      )
    )
    or jsonb_typeof(p_payload->'maxAttempts') <> 'number'
    or p_payload->>'maxAttempts' !~ '^[0-9]+$'
    or p_payload->>'createdAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or length(btrim(coalesce(p_payload->>'commandId',''))) not between 16 and 200
    or length(btrim(coalesce(p_payload->>'operationReference',''))) not between 1 and 500
    or p_payload->>'operationReference' !~ '^[A-Za-z0-9._:-]+$'
    or (
      p_payload->>'sourceType'='manual'
      and p_payload->>'operationReference' !~ '^manual-op:[A-Za-z0-9._:-]+$'
    )
    or length(btrim(coalesce(p_payload->>'correlationId',''))) not between 8 and 100
    or length(btrim(coalesce(p_payload->>'createdBy',''))) not between 1 and 200
    or p_payload->>'sourceType' not in ('manual','supper_ticket','intake_conversation','integration_outbox')
    or p_payload->>'commandType' not in ('create_incident','update_incident','add_comment','add_work_note') then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_COMMAND_INVALID';
  end if;
  v_max_attempts := (p_payload->>'maxAttempts')::integer;
  v_created_at := (p_payload->>'createdAt')::timestamptz;
  v_source_entity_reference := nullif(p_payload->>'sourceEntityReference','');
  if v_max_attempts not between 1 and 10
    or (p_payload->>'sourceType' <> 'manual' and v_source_entity_reference is null) then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_COMMAND_INVALID';
  end if;

  select * into v_connection from public.servicenow_write_connections
  where servicenow_write_connections.id=p_payload->>'connectionId' for share;
  if v_connection.id is null or not v_connection.active then
    raise exception using errcode = '23503', message = 'SERVICENOW_WRITE_CONNECTION_UNAVAILABLE';
  end if;
  if v_connection.incident_table<>p_payload->>'targetTable' then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_TARGET_TABLE_MISMATCH';
  end if;

  select * into v_mapping from public.servicenow_write_mappings
  where servicenow_write_mappings.id=p_payload->>'mappingId' for share;
  if v_mapping.id is null or not v_mapping.active
    or v_mapping.connection_id<>v_connection.id
    or v_mapping.command_type<>p_payload->>'commandType' then
    raise exception using errcode = '23503', message = 'SERVICENOW_WRITE_MAPPING_UNAVAILABLE';
  end if;
  perform public.support_servicenow_write_validate_mapping(v_mapping.command_type,v_mapping.field_mapping);

  if p_payload->>'sourceType'='supper_ticket'
    and not exists (select 1 from public.support_tickets where support_tickets.id=v_source_entity_reference) then
    raise exception using errcode = '23503', message = 'SERVICENOW_WRITE_SOURCE_NOT_FOUND';
  elsif p_payload->>'sourceType'='intake_conversation'
    and not exists (select 1 from public.intake_conversations where intake_conversations.id=v_source_entity_reference) then
    raise exception using errcode = '23503', message = 'SERVICENOW_WRITE_SOURCE_NOT_FOUND';
  elsif p_payload->>'sourceType'='integration_outbox'
    and not exists (select 1 from public.integration_outbox where integration_outbox.id=v_source_entity_reference) then
    raise exception using errcode = '23503', message = 'SERVICENOW_WRITE_SOURCE_NOT_FOUND';
  end if;

  v_idempotency_key := public.support_servicenow_write_idempotency_hash(
    v_connection.id,p_payload->>'commandType',p_payload->>'operationReference',
    p_payload->>'sourceType',v_source_entity_reference,v_connection.incident_table
  );
  if p_payload->>'idempotencyKey'<>v_idempotency_key then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_IDEMPOTENCY_INVALID';
  end if;
  v_normalized := public.support_servicenow_write_normalize(
    p_payload->>'commandType',p_payload->'payload',v_mapping.field_mapping,v_idempotency_key
  );
  v_normalized_hash := public.support_servicenow_write_normalized_hash(v_normalized);
  if p_payload->'normalizedPayload'<>v_normalized
    or p_payload->>'normalizedPayloadHash'<>v_normalized_hash
    or coalesce(p_payload->>'providerCorrelationMarker','')<>coalesce(v_normalized->>'providerCorrelationMarker','')
    or coalesce(p_payload->>'targetSysId','')<>coalesce(v_normalized->>'targetSysId','')
    or coalesce(p_payload->>'targetNumber','')<>coalesce(v_normalized->>'targetNumber','') then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_NORMALIZATION_INVALID';
  end if;

  insert into public.servicenow_write_commands (
    id,version,command_type,status,idempotency_key,normalized_payload_hash,
    connection_id,mapping_id,source_type,source_entity_reference,operation_reference,
    target_table,target_sys_id,target_number,provider_correlation_marker,payload,
    normalized_payload,validation_summary,max_attempts,created_by,request_id,
    correlation_id,created_at,updated_at
  ) values (
    p_payload->>'commandId',1,p_payload->>'commandType','validated',
    v_idempotency_key,v_normalized_hash,v_connection.id,v_mapping.id,
    p_payload->>'sourceType',v_source_entity_reference,p_payload->>'operationReference',
    v_connection.incident_table,nullif(v_normalized->>'targetSysId',''),
    nullif(v_normalized->>'targetNumber',''),nullif(v_normalized->>'providerCorrelationMarker',''),
    p_payload->'payload',v_normalized,coalesce(p_payload->'validationSummary','{}'::jsonb),
    v_max_attempts,p_payload->>'createdBy',nullif(p_payload->>'requestId',''),
    p_payload->>'correlationId',v_created_at,v_created_at
  )
  on conflict (idempotency_key) do nothing;

  select * into v_existing from public.servicenow_write_commands
  where servicenow_write_commands.idempotency_key=v_idempotency_key for update;
  if v_existing.normalized_payload_hash<>v_normalized_hash
    or v_existing.command_type<>p_payload->>'commandType'
    or v_existing.connection_id<>v_connection.id
    or v_existing.source_type<>p_payload->>'sourceType'
    or v_existing.source_entity_reference is distinct from v_source_entity_reference
    or v_existing.operation_reference<>p_payload->>'operationReference'
    or v_existing.target_table<>v_connection.incident_table then
    raise exception using errcode = '23505', message = 'SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT';
  end if;
  return query select
    case when v_existing.id=p_payload->>'commandId' then 'created' else 'unchanged' end,
    v_existing.id,v_existing.status,v_existing.attempt_count,v_existing.version,
    v_existing.normalized_payload_hash;
end;
$$;

create or replace function public.support_issue_servicenow_write_confirmation(p_payload jsonb)
returns table (
  command_id text,
  command_version integer,
  normalized_payload_hash text,
  confirmation_expires_at timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_command public.servicenow_write_commands%rowtype;
  v_expected_version integer;
  v_issued_at timestamptz;
  v_expires_at timestamptz;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object'
    or public.support_intake_json_has_unsafe_key(p_payload)
    or exists (
      select 1 from jsonb_object_keys(p_payload) supplied(key)
      where supplied.key not in (
        'commandId','action','actorUserId','expectedVersion',
        'expectedNormalizedPayloadHash','confirmationNonceHash','expiresAt','issuedAt'
      )
    )
    or jsonb_typeof(p_payload->'expectedVersion')<>'number'
    or p_payload->>'expectedVersion' !~ '^[0-9]+$'
    or p_payload->>'issuedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or p_payload->>'expiresAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or p_payload->>'confirmationNonceHash' !~ '^[a-f0-9]{64}$'
    or p_payload->>'expectedNormalizedPayloadHash' !~ '^[a-f0-9]{64}$'
    or p_payload->>'action' not in (
      'execute','retry','reconcile_by_read_back',
      'mark_succeeded_after_verification','mark_not_applied_after_verification'
    ) then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_CONFIRMATION_INVALID';
  end if;
  v_expected_version := (p_payload->>'expectedVersion')::integer;
  v_issued_at := (p_payload->>'issuedAt')::timestamptz;
  v_expires_at := (p_payload->>'expiresAt')::timestamptz;
  if v_expires_at<=v_issued_at or v_expires_at>v_issued_at+interval '5 minutes' then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_CONFIRMATION_INVALID';
  end if;
  select * into v_command from public.servicenow_write_commands
  where servicenow_write_commands.id=p_payload->>'commandId' for update;
  if v_command.id is null then
    raise exception using errcode='P0002',message='SERVICENOW_WRITE_COMMAND_NOT_FOUND';
  end if;
  if v_command.version<>v_expected_version
    or v_command.normalized_payload_hash<>p_payload->>'expectedNormalizedPayloadHash' then
    raise exception using errcode='40001',message='SERVICENOW_WRITE_VERSION_CONFLICT';
  end if;
  if (p_payload->>'action'='execute' and v_command.status not in ('validated','dry_run_ready'))
    or (p_payload->>'action'='retry' and (
      v_command.status<>'retry_scheduled' or not v_command.retry_allowed
      or v_command.attempt_count>=v_command.max_attempts
    ))
    or (p_payload->>'action' like 'reconcile%' and v_command.status<>'reconciliation_required')
    or (p_payload->>'action' like 'mark_%' and v_command.status<>'reconciliation_required') then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_CONFIRMATION_INVALID';
  end if;
  update public.servicenow_write_commands command_record set
    confirmation_nonce_hash=p_payload->>'confirmationNonceHash',
    confirmation_action=p_payload->>'action',
    confirmation_user_id=p_payload->>'actorUserId',
    confirmation_expires_at=v_expires_at,
    updated_at=v_issued_at
  where command_record.id=v_command.id
  returning * into v_command;
  return query select v_command.id,v_command.version,v_command.normalized_payload_hash,v_command.confirmation_expires_at;
end;
$$;

create or replace function public.support_begin_servicenow_write_attempt(p_payload jsonb)
returns table (
  attempt_number integer,
  command_type text,
  normalized_payload jsonb,
  target_table text,
  target_sys_id text,
  target_number text,
  max_attempts integer,
  live_attempt_count integer,
  command_version integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_command public.servicenow_write_commands%rowtype;
  v_attempt_number integer;
  v_mode text;
  v_retry boolean;
  v_started_at timestamptz;
  v_expected_version integer;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object'
    or public.support_intake_json_has_unsafe_key(p_payload)
    or exists (
      select 1 from jsonb_object_keys(p_payload) supplied(key)
      where supplied.key not in (
        'commandId','attemptId','executionMode','retry','requestId','startedAt',
        'actorUserId','confirmed','expectedVersion',
        'expectedNormalizedPayloadHash','confirmationNonceHash'
      )
    )
    or jsonb_typeof(p_payload->'retry')<>'boolean'
    or p_payload->>'startedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or p_payload->>'executionMode' not in ('dry_run','live','retry')
    or length(coalesce(p_payload->>'attemptId','')) not between 16 and 200 then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_ATTEMPT_INVALID';
  end if;
  v_mode := p_payload->>'executionMode';
  v_retry := (p_payload->>'retry')::boolean;
  v_started_at := (p_payload->>'startedAt')::timestamptz;
  if v_mode<>'dry_run' and (
    jsonb_typeof(p_payload->'confirmed')<>'boolean'
    or p_payload->>'confirmed'<>'true'
    or jsonb_typeof(p_payload->'expectedVersion')<>'number'
    or p_payload->>'expectedVersion' !~ '^[0-9]+$'
    or p_payload->>'expectedNormalizedPayloadHash' !~ '^[a-f0-9]{64}$'
    or p_payload->>'confirmationNonceHash' !~ '^[a-f0-9]{64}$'
  ) then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_CONFIRMATION_INVALID';
  end if;
  if v_mode<>'dry_run' then v_expected_version := (p_payload->>'expectedVersion')::integer; end if;

  select * into v_command from public.servicenow_write_commands
  where servicenow_write_commands.id=p_payload->>'commandId' for update;
  if v_command.id is null then
    raise exception using errcode='P0002',message='SERVICENOW_WRITE_COMMAND_NOT_FOUND';
  end if;
  if v_command.status='executing' then
    raise exception using errcode='55P03',message='SERVICENOW_WRITE_COMMAND_BUSY';
  end if;
  if v_started_at<v_command.created_at then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_ATTEMPT_CHRONOLOGY_INVALID';
  end if;
  if v_mode='dry_run' and v_command.status not in ('validated','dry_run_ready') then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_DRY_RUN_NOT_ALLOWED';
  end if;
  if v_mode='live' and (v_retry or v_command.status not in ('validated','dry_run_ready')) then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_EXECUTION_NOT_ALLOWED';
  end if;
  if v_mode='retry' and (
    not v_retry or v_command.status<>'retry_scheduled' or not v_command.retry_allowed
    or v_command.next_retry_at is null or v_command.next_retry_at>v_started_at
  ) then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_RETRY_NOT_ALLOWED';
  end if;
  if v_mode<>'dry_run' and v_command.attempt_count>=v_command.max_attempts then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_ATTEMPTS_EXHAUSTED';
  end if;
  if v_mode<>'dry_run' and (
    v_command.version<>v_expected_version
    or v_command.normalized_payload_hash<>p_payload->>'expectedNormalizedPayloadHash'
    or v_command.confirmation_nonce_hash<>p_payload->>'confirmationNonceHash'
    or v_command.confirmation_action<>case when v_mode='retry' then 'retry' else 'execute' end
    or v_command.confirmation_user_id<>p_payload->>'actorUserId'
    or v_command.confirmation_expires_at<v_started_at
  ) then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_CONFIRMATION_INVALID';
  end if;

  select coalesce(max(existing.attempt_number),0)+1 into v_attempt_number
  from public.servicenow_write_attempts existing where existing.command_id=v_command.id;
  insert into public.servicenow_write_attempts (
    id,command_id,attempt_number,execution_mode,outcome,request_id,started_at
  ) values (
    p_payload->>'attemptId',v_command.id,v_attempt_number,v_mode,'executing',
    nullif(p_payload->>'requestId',''),v_started_at
  );
  update public.servicenow_write_commands command_record set
    version=command_record.version+1,status='executing',
    attempt_count=command_record.attempt_count+case when v_mode='dry_run' then 0 else 1 end,
    last_attempt_at=v_started_at,next_retry_at=null,retry_allowed=false,retry_reason=null,
    error_code=null,error_message=null,
    confirmation_nonce_hash=null,confirmation_action=null,confirmation_user_id=null,
    confirmation_expires_at=null,updated_at=v_started_at
  where command_record.id=v_command.id returning * into v_command;
  return query select v_attempt_number,v_command.command_type,v_command.normalized_payload,
    v_command.target_table,v_command.target_sys_id,v_command.target_number,
    v_command.max_attempts,v_command.attempt_count,v_command.version;
end;
$$;

create or replace function public.support_finish_servicenow_write_attempt(p_payload jsonb)
returns table (
  command_id text,
  command_status text,
  command_attempt_count integer,
  command_next_retry_at timestamptz,
  command_target_sys_id text,
  command_target_number text,
  command_version integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_command public.servicenow_write_commands%rowtype;
  v_attempt public.servicenow_write_attempts%rowtype;
  v_status text;
  v_finished_at timestamptz;
  v_next_retry_at timestamptz;
  v_outcome text;
  v_disposition text;
  v_failure_phase text;
  v_retry_allowed boolean;
  v_target_sys_id text;
  v_target_number text;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object'
    or public.support_intake_json_has_unsafe_key(p_payload)
    or exists (
      select 1 from jsonb_object_keys(p_payload) supplied(key)
      where supplied.key not in (
        'commandId','attemptId','outcome','deliveryDisposition','failurePhase',
        'retryAllowed','retryReason','reconciliationReason','requestSummary',
        'responseSummary','targetSysId','targetNumber','errorCode','errorMessage',
        'nextRetryAt','finishedAt'
      )
    )
    or jsonb_typeof(p_payload->'retryAllowed')<>'boolean'
    or p_payload->>'finishedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or p_payload->>'outcome' not in ('dry_run','succeeded','failed','uncertain')
    or p_payload->>'deliveryDisposition' not in (
      'definitely_not_sent','definitely_rejected','safe_to_retry',
      'confirmed_succeeded','may_have_committed'
    )
    or (
      coalesce(p_payload->>'failurePhase','')<>''
      and p_payload->>'failurePhase' not in (
        'configuration','authorization','number_lookup','mutation_dispatch',
        'mutation_response','response_parse','read_back'
      )
    )
    or jsonb_typeof(coalesce(p_payload->'requestSummary','{}'::jsonb))<>'object'
    or jsonb_typeof(coalesce(p_payload->'responseSummary','{}'::jsonb))<>'object'
    or octet_length(coalesce(p_payload->'requestSummary','{}'::jsonb)::text)>8192
    or octet_length(coalesce(p_payload->'responseSummary','{}'::jsonb)::text)>8192 then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_RESULT_INVALID';
  end if;
  v_finished_at := (p_payload->>'finishedAt')::timestamptz;
  v_outcome := p_payload->>'outcome';
  v_disposition := p_payload->>'deliveryDisposition';
  v_failure_phase := nullif(p_payload->>'failurePhase','');
  v_retry_allowed := (p_payload->>'retryAllowed')::boolean;
  v_target_sys_id := nullif(p_payload->>'targetSysId','');
  v_target_number := nullif(p_payload->>'targetNumber','');
  if (v_target_sys_id is not null and v_target_sys_id !~ '^[a-f0-9]{32}$')
    or (v_target_number is not null and v_target_number !~ '^[A-Za-z0-9_-]{1,80}$')
    or (nullif(p_payload->>'errorCode','') is not null and p_payload->>'errorCode' !~ '^[A-Z0-9_]{1,80}$')
    or length(coalesce(p_payload->>'errorMessage',''))>240 then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_RESULT_INVALID';
  end if;
  if v_outcome='uncertain' and (v_disposition<>'may_have_committed' or v_retry_allowed)
    or v_outcome='succeeded' and v_disposition<>'confirmed_succeeded'
    or v_outcome='dry_run' and v_disposition<>'definitely_not_sent'
    or v_outcome='failed' and v_disposition in ('may_have_committed','confirmed_succeeded')
    or (v_retry_allowed and v_disposition<>'safe_to_retry') then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_RESULT_INVALID';
  end if;
  if nullif(p_payload->>'nextRetryAt','') is not null then
    if p_payload->>'nextRetryAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' then
      raise exception using errcode='22023',message='SERVICENOW_WRITE_RETRY_TIME_INVALID';
    end if;
    v_next_retry_at := (p_payload->>'nextRetryAt')::timestamptz;
  end if;

  select * into v_command from public.servicenow_write_commands
  where servicenow_write_commands.id=p_payload->>'commandId' for update;
  if v_command.id is null then
    raise exception using errcode='P0002',message='SERVICENOW_WRITE_COMMAND_NOT_FOUND';
  end if;
  select * into v_attempt from public.servicenow_write_attempts
  where servicenow_write_attempts.id=p_payload->>'attemptId'
    and servicenow_write_attempts.command_id=v_command.id for update;
  if v_attempt.id is null or v_attempt.outcome<>'executing' or v_command.status<>'executing'
    or v_finished_at<v_attempt.started_at then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_ATTEMPT_NOT_EXECUTING';
  end if;

  if v_outcome='dry_run' then
    if v_attempt.execution_mode<>'dry_run' then
      raise exception using errcode='22023',message='SERVICENOW_WRITE_RESULT_MODE_MISMATCH';
    end if;
    v_status := 'dry_run_ready';
  elsif v_outcome='succeeded' then
    if v_attempt.execution_mode='dry_run' or v_target_sys_id is null or v_target_number is null then
      raise exception using errcode='22023',message='SERVICENOW_WRITE_SUCCESS_TARGET_REQUIRED';
    end if;
    v_status := 'succeeded';
  elsif v_outcome='uncertain' then
    v_status := 'reconciliation_required';
    v_next_retry_at := null;
    v_retry_allowed := false;
  elsif v_retry_allowed and v_command.attempt_count<v_command.max_attempts then
    if v_next_retry_at is null or v_next_retry_at<v_finished_at then
      raise exception using errcode='22023',message='SERVICENOW_WRITE_RETRY_TIME_INVALID';
    end if;
    v_status := 'retry_scheduled';
  else
    v_status := 'failed';
    v_next_retry_at := null;
    v_retry_allowed := false;
  end if;

  update public.servicenow_write_attempts attempt_record set
    request_summary=coalesce(p_payload->'requestSummary','{}'::jsonb),
    response_summary=coalesce(p_payload->'responseSummary','{}'::jsonb),
    outcome=v_outcome,delivery_disposition=v_disposition,failure_phase=v_failure_phase,
    retry_allowed=v_retry_allowed,retry_reason=nullif(p_payload->>'retryReason',''),
    reconciliation_reason=nullif(p_payload->>'reconciliationReason',''),
    safe_error_code=nullif(p_payload->>'errorCode',''),
    safe_error_message=nullif(p_payload->>'errorMessage',''),finished_at=v_finished_at
  where attempt_record.id=v_attempt.id;
  update public.servicenow_write_commands command_record set
    version=command_record.version+1,status=v_status,
    safe_request_summary=coalesce(p_payload->'requestSummary','{}'::jsonb),
    safe_response_summary=coalesce(p_payload->'responseSummary','{}'::jsonb),
    target_sys_id=coalesce(v_target_sys_id,command_record.target_sys_id),
    target_number=coalesce(v_target_number,command_record.target_number),
    delivery_disposition=v_disposition,failure_phase=v_failure_phase,
    retry_allowed=v_retry_allowed,retry_reason=nullif(p_payload->>'retryReason',''),
    reconciliation_reason=nullif(p_payload->>'reconciliationReason',''),
    error_code=case when v_outcome in ('failed','uncertain') then nullif(p_payload->>'errorCode','') else null end,
    error_message=case when v_outcome in ('failed','uncertain') then nullif(p_payload->>'errorMessage','') else null end,
    next_retry_at=v_next_retry_at,
    completed_at=case when v_status in ('succeeded','failed','cancelled') then v_finished_at else null end,
    updated_at=v_finished_at
  where command_record.id=v_command.id returning * into v_command;

  if v_status='succeeded' and v_command.source_type in ('supper_ticket','intake_conversation') then
    insert into public.servicenow_ticket_links (
      id,supper_ticket_id,intake_conversation_id,servicenow_sys_id,
      servicenow_number,table_name,last_synced_at,created_at,updated_at
    ) values (
      'sn-link-'||public.support_intake_sha256_hex(v_command.target_table||':'||v_command.target_sys_id),
      case when v_command.source_type='supper_ticket' then v_command.source_entity_reference else null end,
      case when v_command.source_type='intake_conversation' then v_command.source_entity_reference else null end,
      v_command.target_sys_id,v_command.target_number,v_command.target_table,
      v_finished_at,v_finished_at,v_finished_at
    )
    on conflict (table_name,servicenow_sys_id) do update set
      servicenow_number=excluded.servicenow_number,last_synced_at=excluded.last_synced_at,
      updated_at=excluded.updated_at;
  end if;
  return query select v_command.id,v_command.status,v_command.attempt_count,
    v_command.next_retry_at,v_command.target_sys_id,v_command.target_number,v_command.version;
end;
$$;

create or replace function public.support_reconcile_servicenow_write_command(p_payload jsonb)
returns table (
  command_id text,
  command_status text,
  command_version integer,
  reconciliation_result text
)
language plpgsql
security definer
set search_path = pg_catalog, public, extensions, pg_temp
as $$
declare
  v_command public.servicenow_write_commands%rowtype;
  v_action text;
  v_result text;
  v_checked_at timestamptz;
  v_expected_version integer;
  v_status text;
  v_version_before integer;
  v_target_sys_id text;
  v_target_number text;
begin
  if p_payload is null or jsonb_typeof(p_payload)<>'object'
    or public.support_intake_json_has_unsafe_key(p_payload)
    or exists (
      select 1 from jsonb_object_keys(p_payload) supplied(key)
      where supplied.key not in (
        'commandId','action','result','safeReadBackSummary','targetSysId','targetNumber',
        'actorUserId','requestId','checkedAt','confirmed','expectedVersion',
        'expectedNormalizedPayloadHash','confirmationNonceHash'
      )
    )
    or jsonb_typeof(p_payload->'confirmed')<>'boolean'
    or p_payload->>'confirmed'<>'true'
    or jsonb_typeof(p_payload->'expectedVersion')<>'number'
    or p_payload->>'expectedVersion' !~ '^[0-9]+$'
    or p_payload->>'checkedAt' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
    or p_payload->>'expectedNormalizedPayloadHash' !~ '^[a-f0-9]{64}$'
    or p_payload->>'confirmationNonceHash' !~ '^[a-f0-9]{64}$'
    or p_payload->>'action' not in (
      'reconcile_by_read_back','mark_succeeded_after_verification',
      'mark_not_applied_after_verification'
    )
    or p_payload->>'result' !~ '^[a-z_]{1,100}$'
    or jsonb_typeof(coalesce(p_payload->'safeReadBackSummary','{}'::jsonb))<>'object'
    or octet_length(coalesce(p_payload->'safeReadBackSummary','{}'::jsonb)::text)>8192 then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_RECONCILIATION_INVALID';
  end if;
  v_action := p_payload->>'action';
  v_result := p_payload->>'result';
  v_checked_at := (p_payload->>'checkedAt')::timestamptz;
  v_expected_version := (p_payload->>'expectedVersion')::integer;
  v_target_sys_id := nullif(p_payload->>'targetSysId','');
  v_target_number := nullif(p_payload->>'targetNumber','');
  if (v_target_sys_id is not null and v_target_sys_id !~ '^[a-f0-9]{32}$')
    or (v_target_number is not null and v_target_number !~ '^[A-Za-z0-9_-]{1,80}$') then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_RECONCILIATION_INVALID';
  end if;
  select * into v_command from public.servicenow_write_commands
  where servicenow_write_commands.id=p_payload->>'commandId' for update;
  if v_command.id is null then
    raise exception using errcode='P0002',message='SERVICENOW_WRITE_COMMAND_NOT_FOUND';
  end if;
  if v_command.status<>'reconciliation_required' then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_RECONCILIATION_NOT_ALLOWED';
  end if;
  if v_command.version<>v_expected_version
    or v_command.normalized_payload_hash<>p_payload->>'expectedNormalizedPayloadHash'
    or v_command.confirmation_nonce_hash<>p_payload->>'confirmationNonceHash'
    or v_command.confirmation_action<>v_action
    or v_command.confirmation_user_id<>p_payload->>'actorUserId'
    or v_command.confirmation_expires_at<v_checked_at
    or (v_command.last_attempt_at is not null and v_checked_at<v_command.last_attempt_at) then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_CONFIRMATION_INVALID';
  end if;
  if v_action='mark_succeeded_after_verification' and v_result<>'confirmed_succeeded'
    or v_action='mark_not_applied_after_verification' and v_result<>'confirmed_not_applied'
    or v_action='reconcile_by_read_back' and v_result not in (
      'confirmed_succeeded','not_found','ambiguous','inconclusive','read_back_failed'
    ) then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_RECONCILIATION_INVALID';
  end if;
  if v_result='confirmed_succeeded' then
    v_status := 'succeeded';
    v_target_sys_id := coalesce(v_target_sys_id,v_command.target_sys_id);
    v_target_number := coalesce(v_target_number,v_command.target_number);
    if v_target_sys_id is null or v_target_number is null then
      raise exception using errcode='22023',message='SERVICENOW_WRITE_SUCCESS_TARGET_REQUIRED';
    end if;
  elsif v_result='confirmed_not_applied' then
    if v_command.attempt_count>=v_command.max_attempts then
      raise exception using errcode='22023',message='SERVICENOW_WRITE_ATTEMPTS_EXHAUSTED';
    end if;
    v_status := 'retry_scheduled';
  else
    v_status := 'reconciliation_required';
  end if;
  v_version_before := v_command.version;
  update public.servicenow_write_commands command_record set
    version=command_record.version+1,status=v_status,
    target_sys_id=coalesce(v_target_sys_id,command_record.target_sys_id),
    target_number=coalesce(v_target_number,command_record.target_number),
    delivery_disposition=case
      when v_result='confirmed_succeeded' then 'confirmed_succeeded'
      when v_result='confirmed_not_applied' then 'safe_to_retry'
      else command_record.delivery_disposition end,
    failure_phase=case when v_result='confirmed_succeeded' then null else 'read_back' end,
    retry_allowed=(v_result='confirmed_not_applied'),
    retry_reason=case when v_result='confirmed_not_applied' then 'Administrator verified the mutation was not applied' else null end,
    next_retry_at=case when v_result='confirmed_not_applied' then v_checked_at else null end,
    reconciliation_checked_at=v_checked_at,reconciled_by_user_id=p_payload->>'actorUserId',
    reconciliation_result=v_result,
    completed_at=case when v_result='confirmed_succeeded' then v_checked_at else null end,
    confirmation_nonce_hash=null,confirmation_action=null,confirmation_user_id=null,
    confirmation_expires_at=null,updated_at=v_checked_at
  where command_record.id=v_command.id returning * into v_command;
  insert into public.servicenow_write_reconciliation_events (
    id,command_id,action,result,safe_read_back_summary,actor_user_id,request_id,
    command_version_before,command_version_after,created_at
  ) values (
    'sn-reconcile-'||public.support_intake_sha256_hex(
      v_command.id||':'||v_command.version::text||':'||v_action||':'||v_checked_at::text
    ),
    v_command.id,v_action,v_result,coalesce(p_payload->'safeReadBackSummary','{}'::jsonb),
    p_payload->>'actorUserId',nullif(p_payload->>'requestId',''),
    v_version_before,v_command.version,v_checked_at
  );
  return query select v_command.id,v_command.status,v_command.version,v_command.reconciliation_result;
end;
$$;

create or replace function public.support_servicenow_write_protect_command_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  if new.id<>old.id
    or new.command_type<>old.command_type
    or new.idempotency_key<>old.idempotency_key
    or new.normalized_payload_hash<>old.normalized_payload_hash
    or new.connection_id<>old.connection_id
    or new.mapping_id<>old.mapping_id
    or new.source_type<>old.source_type
    or new.source_entity_reference is distinct from old.source_entity_reference
    or new.operation_reference<>old.operation_reference
    or new.target_table<>old.target_table
    or new.provider_correlation_marker is distinct from old.provider_correlation_marker
    or new.payload<>old.payload
    or new.normalized_payload<>old.normalized_payload
    or new.created_by<>old.created_by
    or new.correlation_id<>old.correlation_id
    or new.created_at<>old.created_at then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_COMMAND_IDENTITY_IMMUTABLE';
  end if;
  return new;
end;
$$;

drop trigger if exists servicenow_write_commands_identity_guard on public.servicenow_write_commands;
create trigger servicenow_write_commands_identity_guard
before update on public.servicenow_write_commands
for each row execute function public.support_servicenow_write_protect_command_identity();

create or replace function public.support_servicenow_write_protect_attempt_identity()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  if new.id<>old.id or new.command_id<>old.command_id
    or new.attempt_number<>old.attempt_number or new.execution_mode<>old.execution_mode
    or new.request_id is distinct from old.request_id or new.started_at<>old.started_at then
    raise exception using errcode='22023',message='SERVICENOW_WRITE_ATTEMPT_IDENTITY_IMMUTABLE';
  end if;
  return new;
end;
$$;

drop trigger if exists servicenow_write_attempts_identity_guard on public.servicenow_write_attempts;
create trigger servicenow_write_attempts_identity_guard
before update on public.servicenow_write_attempts
for each row execute function public.support_servicenow_write_protect_attempt_identity();

create or replace function public.support_servicenow_write_block_reconciliation_change()
returns trigger
language plpgsql
set search_path = pg_catalog, public, extensions, pg_temp
as $$
begin
  raise exception using errcode='22023',message='SERVICENOW_WRITE_RECONCILIATION_IMMUTABLE';
end;
$$;

drop trigger if exists servicenow_write_reconciliation_append_only on public.servicenow_write_reconciliation_events;
create trigger servicenow_write_reconciliation_append_only
before update or delete on public.servicenow_write_reconciliation_events
for each row execute function public.support_servicenow_write_block_reconciliation_change();

revoke all privileges on function public.support_servicenow_write_segment(text) from public, anon, authenticated, service_role;
revoke all privileges on function public.support_servicenow_write_validate_mapping(text,jsonb) from public, anon, authenticated, service_role;
revoke all privileges on function public.support_servicenow_write_idempotency_hash(text,text,text,text,text,text) from public, anon, authenticated, service_role;
revoke all privileges on function public.support_servicenow_write_normalize(text,jsonb,jsonb,text) from public, anon, authenticated, service_role;
revoke all privileges on function public.support_servicenow_write_normalized_hash(jsonb) from public, anon, authenticated, service_role;
revoke all privileges on function public.support_servicenow_write_confirmation_hash(text) from public, anon, authenticated, service_role;
revoke all privileges on function public.support_servicenow_write_protect_command_identity() from public, anon, authenticated, service_role;
revoke all privileges on function public.support_servicenow_write_protect_attempt_identity() from public, anon, authenticated, service_role;
revoke all privileges on function public.support_servicenow_write_block_reconciliation_change() from public, anon, authenticated, service_role;

revoke all privileges on function public.support_upsert_servicenow_write_connection(jsonb) from public;
revoke execute on function public.support_upsert_servicenow_write_connection(jsonb) from anon, authenticated;
grant execute on function public.support_upsert_servicenow_write_connection(jsonb) to service_role;
revoke all privileges on function public.support_upsert_servicenow_write_mapping(jsonb) from public;
revoke execute on function public.support_upsert_servicenow_write_mapping(jsonb) from anon, authenticated;
grant execute on function public.support_upsert_servicenow_write_mapping(jsonb) to service_role;
revoke all privileges on function public.support_create_servicenow_write_command(jsonb) from public;
revoke execute on function public.support_create_servicenow_write_command(jsonb) from anon, authenticated;
grant execute on function public.support_create_servicenow_write_command(jsonb) to service_role;
revoke all privileges on function public.support_issue_servicenow_write_confirmation(jsonb) from public;
revoke execute on function public.support_issue_servicenow_write_confirmation(jsonb) from anon, authenticated;
grant execute on function public.support_issue_servicenow_write_confirmation(jsonb) to service_role;
revoke all privileges on function public.support_begin_servicenow_write_attempt(jsonb) from public;
revoke execute on function public.support_begin_servicenow_write_attempt(jsonb) from anon, authenticated;
grant execute on function public.support_begin_servicenow_write_attempt(jsonb) to service_role;
revoke all privileges on function public.support_finish_servicenow_write_attempt(jsonb) from public;
revoke execute on function public.support_finish_servicenow_write_attempt(jsonb) from anon, authenticated;
grant execute on function public.support_finish_servicenow_write_attempt(jsonb) to service_role;
revoke all privileges on function public.support_reconcile_servicenow_write_command(jsonb) from public;
revoke execute on function public.support_reconcile_servicenow_write_command(jsonb) from anon, authenticated;
grant execute on function public.support_reconcile_servicenow_write_command(jsonb) to service_role;

comment on table public.servicenow_write_commands is
  'AI-2.0.1 authoritative command ledger. Direct service-role mutation is denied.';
comment on table public.servicenow_write_attempts is
  'AI-2.0.1 attempt ledger with explicit delivery disposition and uncertain outcome.';
comment on table public.servicenow_write_reconciliation_events is
  'AI-2.0.1 immutable administrator reconciliation history.';
comment on function public.support_create_servicenow_write_command(jsonb) is
  'AI-2.0.1 validates payload/mapping and recomputes command identity before persistence.';
comment on function public.support_reconcile_servicenow_write_command(jsonb) is
  'AI-2.0.1 consumes one-time confirmation and records mutation-free reconciliation.';

insert into public.support_schema_migrations (version,description,checksum,applied_by)
values ('202607230001','AI-2.0.1 controlled ServiceNow write kernel',null,current_user)
on conflict (version) do nothing;

commit;
