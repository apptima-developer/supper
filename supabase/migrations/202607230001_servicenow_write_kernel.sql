-- SUPPER AI-2.0: controlled, manual ServiceNow write command persistence.
-- Credentials remain in server environment variables. These tables contain
-- normalized command material and bounded summaries only.

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
    default_assignment_group is null
    or length(default_assignment_group) between 1 and 500
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
  field_mapping jsonb not null default '{}'::jsonb check (
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
  command_type text not null check (command_type in ('create_incident', 'update_incident', 'add_comment', 'add_work_note')),
  status text not null check (status in ('pending', 'validated', 'dry_run_ready', 'executing', 'succeeded', 'failed', 'retry_scheduled', 'cancelled')),
  idempotency_key text not null unique check (idempotency_key ~ '^[a-f0-9]{64}$'),
  normalized_payload_hash text not null check (normalized_payload_hash ~ '^[a-f0-9]{64}$'),
  connection_id text not null references public.servicenow_write_connections(id) on delete restrict,
  mapping_id text references public.servicenow_write_mappings(id) on delete restrict,
  source_type text not null check (source_type in ('manual', 'supper_ticket', 'intake_conversation', 'integration_outbox')),
  source_reference text not null check (length(btrim(source_reference)) between 1 and 500),
  target_table text not null check (target_table ~ '^[a-z][a-z0-9_]{0,79}$'),
  target_sys_id text check (target_sys_id is null or target_sys_id ~ '^[a-f0-9]{32}$'),
  target_number text check (target_number is null or target_number ~ '^[A-Za-z0-9_-]{1,80}$'),
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
  error_code text check (error_code is null or error_code ~ '^[A-Z0-9_]{1,80}$'),
  error_message text check (error_message is null or length(error_message) between 1 and 240),
  attempt_count integer not null default 0 check (attempt_count between 0 and 10),
  max_attempts integer not null default 3 check (max_attempts between 1 and 10 and attempt_count <= max_attempts),
  next_retry_at timestamptz,
  last_attempt_at timestamptz,
  completed_at timestamptz,
  created_by text not null check (length(btrim(created_by)) between 1 and 200),
  request_id text check (request_id is null or length(request_id) between 8 and 100),
  correlation_id text not null check (length(correlation_id) between 8 and 100),
  created_at timestamptz not null,
  updated_at timestamptz not null,
  check (mapping_id is null or connection_id is not null),
  check ((status = 'retry_scheduled' and next_retry_at is not null) or status <> 'retry_scheduled'),
  check ((status in ('succeeded', 'failed', 'cancelled') and completed_at is not null) or status not in ('succeeded', 'failed', 'cancelled'))
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
  outcome text not null check (outcome in ('executing', 'dry_run', 'succeeded', 'failed')),
  safe_error_code text check (safe_error_code is null or safe_error_code ~ '^[A-Z0-9_]{1,80}$'),
  safe_error_message text check (safe_error_message is null or length(safe_error_message) between 1 and 240),
  request_id text check (request_id is null or length(request_id) between 8 and 100),
  started_at timestamptz not null,
  finished_at timestamptz,
  unique (command_id, attempt_number),
  check ((outcome = 'executing' and finished_at is null) or (outcome <> 'executing' and finished_at is not null))
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
  on public.servicenow_write_commands(next_retry_at)
  where status = 'retry_scheduled';
create index if not exists servicenow_write_attempts_command_idx
  on public.servicenow_write_attempts(command_id, attempt_number);
create index if not exists servicenow_ticket_links_ticket_idx
  on public.servicenow_ticket_links(supper_ticket_id)
  where supper_ticket_id is not null;
create index if not exists servicenow_ticket_links_conversation_idx
  on public.servicenow_ticket_links(intake_conversation_id)
  where intake_conversation_id is not null;

alter table public.servicenow_write_connections enable row level security;
alter table public.servicenow_write_mappings enable row level security;
alter table public.servicenow_write_commands enable row level security;
alter table public.servicenow_write_attempts enable row level security;
alter table public.servicenow_ticket_links enable row level security;

revoke all privileges on table public.servicenow_write_connections from public, anon, authenticated;
revoke all privileges on table public.servicenow_write_mappings from public, anon, authenticated;
revoke all privileges on table public.servicenow_write_commands from public, anon, authenticated;
revoke all privileges on table public.servicenow_write_attempts from public, anon, authenticated;
revoke all privileges on table public.servicenow_ticket_links from public, anon, authenticated;
grant select, insert, update on table public.servicenow_write_connections to service_role;
grant select, insert, update on table public.servicenow_write_mappings to service_role;
grant select, insert, update on table public.servicenow_write_commands to service_role;
grant select, insert, update on table public.servicenow_write_attempts to service_role;
grant select, insert, update on table public.servicenow_ticket_links to service_role;

-- Atomically establishes one logical command. Replaying identical material
-- returns the existing command; changing material behind the same logical key
-- is rejected before any provider call can occur.
create or replace function public.support_create_servicenow_write_command(p_payload jsonb)
returns table (
  action text,
  command_id text,
  command_status text,
  command_attempt_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.servicenow_write_commands%rowtype;
  v_connection public.servicenow_write_connections%rowtype;
  v_mapping public.servicenow_write_mappings%rowtype;
  v_allowed_keys text[] := array[
    'commandId', 'commandType', 'idempotencyKey', 'normalizedPayloadHash',
    'connectionId', 'mappingId', 'sourceType', 'sourceReference', 'targetTable',
    'targetSysId', 'targetNumber', 'payload', 'normalizedPayload',
    'validationSummary', 'maxAttempts', 'createdBy', 'requestId',
    'correlationId', 'createdAt'
  ];
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 180000
    or public.support_intake_json_has_unsafe_key(p_payload)
    or exists (
      select 1 from jsonb_object_keys(p_payload) as supplied(key)
      where not (supplied.key = any(v_allowed_keys))
    )
    or coalesce(p_payload->>'commandId', '') = ''
    or coalesce(p_payload->>'correlationId', '') = ''
    or coalesce(p_payload->>'createdBy', '') = ''
    or coalesce(p_payload->>'sourceReference', '') = '' then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_COMMAND_INVALID';
  end if;

  select * into v_connection
  from public.servicenow_write_connections
  where id = p_payload->>'connectionId'
  for share;
  if v_connection.id is null or not v_connection.active then
    raise exception using errcode = '23503', message = 'SERVICENOW_WRITE_CONNECTION_UNAVAILABLE';
  end if;
  if v_connection.incident_table <> p_payload->>'targetTable' then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_TARGET_TABLE_MISMATCH';
  end if;

  -- Validate linkable sources before any provider attempt can begin. Deferring
  -- this foreign-key failure until completion could leave a real provider write
  -- successful while its command ledger remained stuck in executing.
  if p_payload->>'sourceType' = 'supper_ticket'
    and not exists (
      select 1 from public.support_tickets
      where id = p_payload->>'sourceReference'
    ) then
    raise exception using errcode = '23503', message = 'SERVICENOW_WRITE_SOURCE_NOT_FOUND';
  elsif p_payload->>'sourceType' = 'intake_conversation'
    and not exists (
      select 1 from public.intake_conversations
      where id = p_payload->>'sourceReference'
    ) then
    raise exception using errcode = '23503', message = 'SERVICENOW_WRITE_SOURCE_NOT_FOUND';
  end if;

  if nullif(p_payload->>'mappingId', '') is not null then
    select * into v_mapping
    from public.servicenow_write_mappings
    where id = p_payload->>'mappingId'
    for share;
    if v_mapping.id is null
      or not v_mapping.active
      or v_mapping.connection_id <> v_connection.id
      or v_mapping.command_type <> p_payload->>'commandType' then
      raise exception using errcode = '23503', message = 'SERVICENOW_WRITE_MAPPING_UNAVAILABLE';
    end if;
  end if;

  insert into public.servicenow_write_commands (
    id, command_type, status, idempotency_key, normalized_payload_hash,
    connection_id, mapping_id, source_type, source_reference, target_table,
    target_sys_id, target_number, payload, normalized_payload,
    validation_summary, max_attempts, created_by, request_id, correlation_id,
    created_at, updated_at
  ) values (
    p_payload->>'commandId', p_payload->>'commandType', 'validated',
    p_payload->>'idempotencyKey', p_payload->>'normalizedPayloadHash',
    p_payload->>'connectionId', nullif(p_payload->>'mappingId', ''),
    p_payload->>'sourceType', p_payload->>'sourceReference',
    p_payload->>'targetTable', nullif(p_payload->>'targetSysId', ''),
    nullif(p_payload->>'targetNumber', ''), p_payload->'payload',
    p_payload->'normalizedPayload', coalesce(p_payload->'validationSummary', '{}'::jsonb),
    (p_payload->>'maxAttempts')::integer, p_payload->>'createdBy',
    nullif(p_payload->>'requestId', ''), p_payload->>'correlationId',
    (p_payload->>'createdAt')::timestamptz, (p_payload->>'createdAt')::timestamptz
  )
  on conflict (idempotency_key) do nothing;

  select * into v_existing
  from public.servicenow_write_commands
  where idempotency_key = p_payload->>'idempotencyKey'
  for update;

  if v_existing.normalized_payload_hash <> p_payload->>'normalizedPayloadHash'
    or v_existing.command_type <> p_payload->>'commandType'
    or v_existing.connection_id <> p_payload->>'connectionId'
    or v_existing.source_type <> p_payload->>'sourceType'
    or v_existing.source_reference <> p_payload->>'sourceReference'
    or v_existing.target_table <> p_payload->>'targetTable' then
    raise exception using errcode = '23505', message = 'SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT';
  end if;

  return query select
    case when v_existing.id = p_payload->>'commandId' then 'created' else 'unchanged' end,
    v_existing.id, v_existing.status, v_existing.attempt_count;
end;
$$;

-- Starts one ledgered attempt and moves the command to executing under a row
-- lock. Dry-runs never consume the bounded live attempt budget.
create or replace function public.support_begin_servicenow_write_attempt(p_payload jsonb)
returns table (
  attempt_number integer,
  command_type text,
  normalized_payload jsonb,
  target_table text,
  target_sys_id text,
  target_number text,
  max_attempts integer,
  live_attempt_count integer
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_command public.servicenow_write_commands%rowtype;
  v_attempt_number integer;
  v_mode text := p_payload->>'executionMode';
  v_retry boolean := coalesce((p_payload->>'retry')::boolean, false);
  v_started_at timestamptz := (p_payload->>'startedAt')::timestamptz;
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or public.support_intake_json_has_unsafe_key(p_payload)
    or v_mode not in ('dry_run', 'live', 'retry') then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_ATTEMPT_INVALID';
  end if;

  select * into v_command
  from public.servicenow_write_commands
  where id = p_payload->>'commandId'
  for update;
  if v_command.id is null then
    raise exception using errcode = 'P0002', message = 'SERVICENOW_WRITE_COMMAND_NOT_FOUND';
  end if;
  if v_command.status = 'executing' then
    raise exception using errcode = '55P03', message = 'SERVICENOW_WRITE_COMMAND_BUSY';
  end if;
  if v_mode = 'dry_run' and v_command.status not in ('validated', 'dry_run_ready') then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_DRY_RUN_NOT_ALLOWED';
  end if;
  if v_mode = 'live' and (v_retry or v_command.status not in ('validated', 'dry_run_ready')) then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_EXECUTION_NOT_ALLOWED';
  end if;
  if v_mode = 'retry' and (not v_retry or v_command.status not in ('failed', 'retry_scheduled')) then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_RETRY_NOT_ALLOWED';
  end if;
  if v_mode <> 'dry_run' and v_command.attempt_count >= v_command.max_attempts then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_ATTEMPTS_EXHAUSTED';
  end if;

  select coalesce(max(existing.attempt_number), 0) + 1 into v_attempt_number
  from public.servicenow_write_attempts existing
  where existing.command_id = v_command.id;

  insert into public.servicenow_write_attempts (
    id, command_id, attempt_number, execution_mode, outcome, request_id, started_at
  ) values (
    p_payload->>'attemptId', v_command.id, v_attempt_number, v_mode,
    'executing', nullif(p_payload->>'requestId', ''), v_started_at
  );

  update public.servicenow_write_commands command_record set
    status = 'executing',
    attempt_count = command_record.attempt_count + case when v_mode = 'dry_run' then 0 else 1 end,
    last_attempt_at = v_started_at,
    next_retry_at = null,
    error_code = null,
    error_message = null,
    updated_at = v_started_at
  where command_record.id = v_command.id
  returning * into v_command;

  return query select v_attempt_number, v_command.command_type,
    v_command.normalized_payload, v_command.target_table,
    v_command.target_sys_id, v_command.target_number,
    v_command.max_attempts, v_command.attempt_count;
end;
$$;

-- Finalizes both the attempt and command under one lock. Successful linked
-- SUPPER/intake sources receive a durable ServiceNow ticket link in the same
-- database transaction.
create or replace function public.support_finish_servicenow_write_attempt(p_payload jsonb)
returns table (
  command_id text,
  command_status text,
  command_attempt_count integer,
  command_next_retry_at timestamptz,
  command_target_sys_id text,
  command_target_number text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_command public.servicenow_write_commands%rowtype;
  v_attempt public.servicenow_write_attempts%rowtype;
  v_status text;
  v_finished_at timestamptz := (p_payload->>'finishedAt')::timestamptz;
  v_outcome text := p_payload->>'outcome';
  v_retryable boolean := coalesce((p_payload->>'retryable')::boolean, false);
  v_next_retry_at timestamptz;
  v_target_sys_id text := nullif(p_payload->>'targetSysId', '');
  v_target_number text := nullif(p_payload->>'targetNumber', '');
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or public.support_intake_json_has_unsafe_key(p_payload)
    or v_outcome not in ('dry_run', 'succeeded', 'failed')
    or jsonb_typeof(coalesce(p_payload->'requestSummary', '{}'::jsonb)) <> 'object'
    or jsonb_typeof(coalesce(p_payload->'responseSummary', '{}'::jsonb)) <> 'object'
    or octet_length(coalesce(p_payload->'requestSummary', '{}'::jsonb)::text) > 8192
    or octet_length(coalesce(p_payload->'responseSummary', '{}'::jsonb)::text) > 8192 then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_RESULT_INVALID';
  end if;

  select * into v_command
  from public.servicenow_write_commands
  where id = p_payload->>'commandId'
  for update;
  if v_command.id is null then
    raise exception using errcode = 'P0002', message = 'SERVICENOW_WRITE_COMMAND_NOT_FOUND';
  end if;

  select * into v_attempt
  from public.servicenow_write_attempts attempt_source
  where attempt_source.id = p_payload->>'attemptId'
    and attempt_source.command_id = v_command.id
  for update;
  if v_attempt.id is null or v_attempt.outcome <> 'executing' or v_command.status <> 'executing' then
    raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_ATTEMPT_NOT_EXECUTING';
  end if;

  if v_outcome = 'dry_run' then
    if v_attempt.execution_mode <> 'dry_run' then
      raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_RESULT_MODE_MISMATCH';
    end if;
    v_status := 'dry_run_ready';
  elsif v_outcome = 'succeeded' then
    if v_attempt.execution_mode = 'dry_run' or v_target_sys_id is null or v_target_number is null then
      raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_SUCCESS_TARGET_REQUIRED';
    end if;
    v_status := 'succeeded';
  elsif v_retryable and v_command.attempt_count < v_command.max_attempts then
    v_status := 'retry_scheduled';
    v_next_retry_at := (p_payload->>'nextRetryAt')::timestamptz;
    if v_next_retry_at is null or v_next_retry_at < v_finished_at then
      raise exception using errcode = '22023', message = 'SERVICENOW_WRITE_RETRY_TIME_INVALID';
    end if;
  else
    v_status := 'failed';
  end if;

  update public.servicenow_write_attempts attempt_record set
    request_summary = coalesce(p_payload->'requestSummary', '{}'::jsonb),
    response_summary = coalesce(p_payload->'responseSummary', '{}'::jsonb),
    outcome = v_outcome,
    safe_error_code = nullif(p_payload->>'errorCode', ''),
    safe_error_message = nullif(p_payload->>'errorMessage', ''),
    finished_at = v_finished_at
  where attempt_record.id = v_attempt.id;

  update public.servicenow_write_commands command_record set
    status = v_status,
    safe_request_summary = coalesce(p_payload->'requestSummary', '{}'::jsonb),
    safe_response_summary = coalesce(p_payload->'responseSummary', '{}'::jsonb),
    target_sys_id = coalesce(v_target_sys_id, command_record.target_sys_id),
    target_number = coalesce(v_target_number, command_record.target_number),
    error_code = case when v_outcome = 'failed' then nullif(p_payload->>'errorCode', '') else null end,
    error_message = case when v_outcome = 'failed' then nullif(p_payload->>'errorMessage', '') else null end,
    next_retry_at = v_next_retry_at,
    completed_at = case when v_status in ('succeeded', 'failed') then v_finished_at else null end,
    updated_at = v_finished_at
  where command_record.id = v_command.id
  returning * into v_command;

  if v_status = 'succeeded' and v_command.source_type in ('supper_ticket', 'intake_conversation') then
    insert into public.servicenow_ticket_links (
      id, supper_ticket_id, intake_conversation_id, servicenow_sys_id,
      servicenow_number, table_name, last_synced_at, created_at, updated_at
    ) values (
      'sn-link-' || public.support_intake_sha256_hex(
        v_command.target_table || ':' || v_command.target_sys_id),
      case when v_command.source_type = 'supper_ticket' then v_command.source_reference else null end,
      case when v_command.source_type = 'intake_conversation' then v_command.source_reference else null end,
      v_command.target_sys_id, v_command.target_number, v_command.target_table,
      v_finished_at, v_finished_at, v_finished_at
    )
    on conflict (table_name, servicenow_sys_id) do update set
      supper_ticket_id = coalesce(excluded.supper_ticket_id, servicenow_ticket_links.supper_ticket_id),
      intake_conversation_id = coalesce(excluded.intake_conversation_id, servicenow_ticket_links.intake_conversation_id),
      servicenow_number = excluded.servicenow_number,
      last_synced_at = excluded.last_synced_at,
      updated_at = excluded.updated_at;
  end if;

  return query select v_command.id, v_command.status, v_command.attempt_count,
    v_command.next_retry_at, v_command.target_sys_id, v_command.target_number;
end;
$$;

revoke all privileges on function public.support_create_servicenow_write_command(jsonb) from public;
revoke execute on function public.support_create_servicenow_write_command(jsonb) from anon, authenticated;
grant execute on function public.support_create_servicenow_write_command(jsonb) to service_role;

revoke all privileges on function public.support_begin_servicenow_write_attempt(jsonb) from public;
revoke execute on function public.support_begin_servicenow_write_attempt(jsonb) from anon, authenticated;
grant execute on function public.support_begin_servicenow_write_attempt(jsonb) to service_role;

revoke all privileges on function public.support_finish_servicenow_write_attempt(jsonb) from public;
revoke execute on function public.support_finish_servicenow_write_attempt(jsonb) from anon, authenticated;
grant execute on function public.support_finish_servicenow_write_attempt(jsonb) to service_role;

comment on function public.support_create_servicenow_write_command(jsonb) is
  'AI-2.0 atomic ServiceNow write command creation and idempotent replay guard.';
comment on function public.support_begin_servicenow_write_attempt(jsonb) is
  'AI-2.0 bounded ServiceNow write attempt transition and durable executing ledger.';
comment on function public.support_finish_servicenow_write_attempt(jsonb) is
  'AI-2.0 atomic ServiceNow write attempt completion, retry scheduling, and safe link update.';

insert into public.support_schema_migrations (version, description, checksum, applied_by)
values ('202607230001', 'AI-2.0 controlled ServiceNow write kernel', null, current_user)
on conflict (version) do nothing;

commit;
