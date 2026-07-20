-- SUPPER AI-1.1: bounded, server-only ServiceNow Incident synchronization.
-- This migration is forward-only and does not delete or rewrite existing business data.

begin;

create table if not exists public.external_ticket_links (
  id text primary key,
  provider text not null check (length(trim(provider)) between 1 and 40),
  external_sys_id text not null check (length(trim(external_sys_id)) between 1 and 200),
  external_number text not null check (length(trim(external_number)) between 1 and 100),
  ticket_id text not null,
  external_url text,
  external_created_at timestamptz,
  external_updated_at timestamptz,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_synced_at timestamptz not null default now(),
  source_hash text not null check (source_hash ~ '^[a-f0-9]{64}$'),
  metadata jsonb not null default '{}'::jsonb,
  constraint external_ticket_links_provider_sys_id_key unique (provider, external_sys_id),
  constraint external_ticket_links_provider_number_key unique (provider, external_number),
  constraint external_ticket_links_ticket_id_fkey foreign key (ticket_id)
    references public.support_tickets(id) on delete restrict
);

create index if not exists external_ticket_links_ticket_id_idx
  on public.external_ticket_links (ticket_id);
create index if not exists external_ticket_links_external_updated_at_idx
  on public.external_ticket_links (external_updated_at);

create table if not exists public.integration_sync_state (
  provider text not null check (length(trim(provider)) between 1 and 40),
  stream text not null check (length(trim(stream)) between 1 and 80),
  watermark_at timestamptz,
  last_successful_sync_at timestamptz,
  last_attempt_at timestamptz,
  lock_token text,
  locked_until timestamptz,
  version integer not null default 1 check (version > 0),
  metadata jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (provider, stream),
  check ((lock_token is null and locked_until is null) or (lock_token is not null and locked_until is not null))
);

create table if not exists public.integration_sync_runs (
  id text primary key,
  provider text not null check (length(trim(provider)) between 1 and 40),
  stream text not null check (length(trim(stream)) between 1 and 80),
  mode text not null check (mode in ('initial', 'incremental')),
  trigger_type text not null check (trigger_type in ('manual', 'test')),
  status text not null check (status in ('running', 'succeeded', 'partial', 'failed', 'blocked')),
  dry_run boolean not null default false,
  requested_by_user_id text,
  request_id text,
  correlation_id text,
  started_at timestamptz not null,
  completed_at timestamptz,
  watermark_from timestamptz,
  watermark_to timestamptz,
  records_fetched integer not null default 0 check (records_fetched >= 0),
  records_created integer not null default 0 check (records_created >= 0),
  records_updated integer not null default 0 check (records_updated >= 0),
  records_unchanged integer not null default 0 check (records_unchanged >= 0),
  records_stale integer not null default 0 check (records_stale >= 0),
  records_skipped integer not null default 0 check (records_skipped >= 0),
  records_failed integer not null default 0 check (records_failed >= 0),
  pages_fetched integer not null default 0 check (pages_fetched >= 0),
  safe_error_code text,
  safe_error_message text,
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists integration_sync_runs_provider_stream_idx
  on public.integration_sync_runs (provider, stream, started_at desc);
create index if not exists integration_sync_runs_started_at_idx
  on public.integration_sync_runs (started_at desc);
create index if not exists integration_sync_runs_status_idx
  on public.integration_sync_runs (status);

create table if not exists public.integration_sync_run_items (
  id text primary key,
  run_id text not null references public.integration_sync_runs(id) on delete restrict,
  external_sys_id text,
  external_number text,
  ticket_id text,
  outcome text not null check (outcome in ('created', 'updated', 'unchanged', 'stale', 'skipped', 'failed')),
  source_updated_at timestamptz,
  safe_error_code text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create index if not exists integration_sync_run_items_run_id_idx
  on public.integration_sync_run_items (run_id);

alter table public.external_ticket_links enable row level security;
alter table public.integration_sync_state enable row level security;
alter table public.integration_sync_runs enable row level security;
alter table public.integration_sync_run_items enable row level security;

revoke all on table public.external_ticket_links from public, anon, authenticated;
revoke all on table public.integration_sync_state from public, anon, authenticated;
revoke all on table public.integration_sync_runs from public, anon, authenticated;
revoke all on table public.integration_sync_run_items from public, anon, authenticated;

grant select, insert, update on table public.external_ticket_links to service_role;
grant select, insert, update on table public.integration_sync_state to service_role;
grant select, insert, update on table public.integration_sync_runs to service_role;
grant select, insert on table public.integration_sync_run_items to service_role;

create or replace function public.support_acquire_integration_sync_lock(
  p_provider text,
  p_stream text,
  p_lock_token text,
  p_ttl_seconds integer,
  p_now timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_acquired boolean := false;
begin
  if length(trim(p_provider)) not between 1 and 40
    or length(trim(p_stream)) not between 1 and 80
    or length(trim(p_lock_token)) not between 16 and 200
    or p_ttl_seconds not between 30 and 1800
    or p_now is null then
    raise exception 'Invalid integration lock input';
  end if;

  insert into public.integration_sync_state as current_state (
    provider, stream, last_attempt_at, lock_token, locked_until, updated_at
  ) values (
    trim(p_provider), trim(p_stream), p_now, trim(p_lock_token),
    p_now + make_interval(secs => p_ttl_seconds), p_now
  )
  on conflict (provider, stream) do update set
    lock_token = excluded.lock_token,
    locked_until = excluded.locked_until,
    last_attempt_at = excluded.last_attempt_at,
    version = current_state.version + 1,
    updated_at = excluded.updated_at
  where current_state.lock_token is null
    or current_state.locked_until <= p_now
    or current_state.lock_token = p_lock_token
  returning true into v_acquired;

  if not coalesce(v_acquired, false) then
    update public.integration_sync_state
    set last_attempt_at = p_now,
        updated_at = p_now
    where provider = trim(p_provider)
      and stream = trim(p_stream);
  end if;

  return coalesce(v_acquired, false);
end;
$$;

create or replace function public.support_release_integration_sync_lock(
  p_provider text,
  p_stream text,
  p_lock_token text
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_released boolean := false;
begin
  if length(trim(p_provider)) not between 1 and 40
    or length(trim(p_stream)) not between 1 and 80
    or length(trim(p_lock_token)) not between 16 and 200 then
    raise exception 'Invalid integration lock input';
  end if;

  update public.integration_sync_state
  set lock_token = null,
      locked_until = null,
      version = version + 1,
      updated_at = now()
  where provider = trim(p_provider)
    and stream = trim(p_stream)
    and lock_token = trim(p_lock_token)
  returning true into v_released;

  return coalesce(v_released, false);
end;
$$;

create or replace function public.support_complete_integration_sync_run(
  p_run_id text,
  p_lock_token text,
  p_watermark timestamptz,
  p_completed_at timestamptz,
  p_summary jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_state_updated boolean := false;
  v_run_count integer := 0;
begin
  if length(trim(p_run_id)) not between 1 and 200
    or length(trim(p_lock_token)) not between 16 and 200
    or p_completed_at is null
    or p_summary is null
    or jsonb_typeof(p_summary) <> 'object'
    or octet_length(p_summary::text) > 8192
    or coalesce((p_summary->>'fetched')::integer, -1) < 0
    or coalesce((p_summary->>'created')::integer, -1) < 0
    or coalesce((p_summary->>'updated')::integer, -1) < 0
    or coalesce((p_summary->>'unchanged')::integer, -1) < 0
    or coalesce((p_summary->>'stale')::integer, -1) < 0
    or coalesce((p_summary->>'skipped')::integer, -1) < 0
    or coalesce((p_summary->>'failed')::integer, -1) < 0
    or coalesce((p_summary->>'pages')::integer, -1) < 0 then
    raise exception 'Invalid integration completion input';
  end if;

  update public.integration_sync_state
  set watermark_at = coalesce(p_watermark, watermark_at),
      last_successful_sync_at = p_completed_at,
      version = version + 1,
      updated_at = p_completed_at
  where provider = 'servicenow'
    and stream = 'incident'
    and lock_token = trim(p_lock_token)
    and locked_until > now()
  returning true into v_state_updated;

  if not coalesce(v_state_updated, false) then
    return false;
  end if;

  update public.integration_sync_runs
  set status = 'succeeded',
      completed_at = p_completed_at,
      watermark_to = p_watermark,
      records_fetched = (p_summary->>'fetched')::integer,
      records_created = (p_summary->>'created')::integer,
      records_updated = (p_summary->>'updated')::integer,
      records_unchanged = (p_summary->>'unchanged')::integer,
      records_stale = (p_summary->>'stale')::integer,
      records_skipped = (p_summary->>'skipped')::integer,
      records_failed = (p_summary->>'failed')::integer,
      pages_fetched = (p_summary->>'pages')::integer,
      safe_error_code = null,
      safe_error_message = null,
      metadata = jsonb_build_object('durationMs', coalesce((p_summary->>'durationMs')::integer, 0))
  where id = trim(p_run_id)
    and provider = 'servicenow'
    and stream = 'incident'
    and dry_run = false
    and status in ('running', 'succeeded');
  get diagnostics v_run_count = row_count;

  if v_run_count <> 1 then
    raise exception 'Integration run completion target is invalid';
  end if;
  return true;
end;
$$;

create or replace function public.support_upsert_servicenow_incident(p_payload jsonb)
returns table (outcome text, ticket_id text, warning_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_link public.external_ticket_links%rowtype;
  v_ticket public.support_tickets%rowtype;
  v_ticket_json jsonb;
  v_customer_key text;
  v_customer_name text;
  v_requires_mapping boolean;
  v_warning text;
  v_result text;
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 32768
    or p_payload->>'provider' <> 'servicenow'
    or coalesce(p_payload->>'externalSysId', '') !~ '^[a-fA-F0-9]{32}$'
    or length(coalesce(p_payload->>'externalNumber', '')) not between 1 and 100
    or coalesce(p_payload->>'sourceHash', '') !~ '^[a-f0-9]{64}$'
    or length(coalesce(p_payload->>'linkId', '')) not between 16 and 200
    or length(coalesce(p_payload->>'externalUrl', '')) not between 1 and 2000
    or jsonb_typeof(p_payload->'ticket') <> 'object'
    or coalesce(p_payload#>>'{ticket,id}', '') = ''
    or coalesce(p_payload#>>'{ticket,issueId}', '') <> p_payload->>'externalNumber'
    or coalesce(p_payload#>>'{ticket,issueType}', '') <> 'Incident'
    or length(coalesce(p_payload#>>'{ticket,issueTitle}', '')) not between 1 and 500
    or coalesce(p_payload#>>'{ticket,customerKey}', '') !~ '^servicenow-unmapped:'
    or (p_payload->>'externalUpdatedAt') is null then
    raise exception 'Invalid bounded ServiceNow incident payload';
  end if;

  perform (p_payload->>'externalUpdatedAt')::timestamptz;
  if p_payload->>'externalCreatedAt' is not null then
    perform (p_payload->>'externalCreatedAt')::timestamptz;
  end if;

  select * into v_link
  from public.external_ticket_links
  where provider = 'servicenow'
    and external_sys_id = p_payload->>'externalSysId'
  for update;

  if v_link.id is null and exists (
    select 1 from public.external_ticket_links
    where provider = 'servicenow'
      and external_number = p_payload->>'externalNumber'
  ) then
    raise exception 'SERVICENOW_EXTERNAL_NUMBER_CONFLICT';
  end if;

  if v_link.id is null then
    v_ticket_json := p_payload->'ticket';
    insert into public.support_tickets (
      id, issue_id, customer_key, customer_name, kanban_status, status,
      issue_type, severity, ticket_date, start_date, due_date, close_date,
      data, updated_at
    ) values (
      v_ticket_json->>'id',
      v_ticket_json->>'issueId',
      v_ticket_json->>'customerKey',
      v_ticket_json->>'customerName',
      v_ticket_json->>'kanbanStatus',
      v_ticket_json->>'status',
      v_ticket_json->>'issueType',
      v_ticket_json->>'severity',
      case when coalesce(v_ticket_json->>'date', '') = '' then null else ((v_ticket_json->>'date')::timestamptz at time zone 'Asia/Bangkok')::date end,
      case when coalesce(v_ticket_json->>'startDate', '') = '' then null else ((v_ticket_json->>'startDate')::timestamptz at time zone 'Asia/Bangkok')::date end,
      case when coalesce(v_ticket_json->>'dueDate', '') = '' then null else ((v_ticket_json->>'dueDate')::timestamptz at time zone 'Asia/Bangkok')::date end,
      case when coalesce(v_ticket_json->>'closeDate', '') = '' then null else ((v_ticket_json->>'closeDate')::timestamptz at time zone 'Asia/Bangkok')::date end,
      v_ticket_json,
      (v_ticket_json->>'updatedAt')::timestamptz
    );

    insert into public.external_ticket_links (
      id, provider, external_sys_id, external_number, ticket_id, external_url,
      external_created_at, external_updated_at, first_seen_at, last_seen_at,
      last_synced_at, source_hash, metadata
    ) values (
      p_payload->>'linkId', 'servicenow', p_payload->>'externalSysId',
      p_payload->>'externalNumber', v_ticket_json->>'id', p_payload->>'externalUrl',
      nullif(p_payload->>'externalCreatedAt', '')::timestamptz,
      (p_payload->>'externalUpdatedAt')::timestamptz,
      v_now, v_now, v_now, p_payload->>'sourceHash',
      coalesce(p_payload->'linkMetadata', '{}'::jsonb)
    );
    return query select 'created'::text, v_ticket_json->>'id', null::text;
    return;
  end if;

  select * into v_ticket
  from public.support_tickets
  where id = v_link.ticket_id
  for update;
  if v_ticket.id is null then
    raise exception 'SERVICENOW_LINKED_TICKET_MISSING';
  end if;

  if (p_payload->>'externalUpdatedAt')::timestamptz < v_link.external_updated_at then
    update public.external_ticket_links
    set last_seen_at = v_now, last_synced_at = v_now
    where id = v_link.id;
    return query select 'stale'::text, v_ticket.id, null::text;
    return;
  end if;

  if p_payload->>'sourceHash' = v_link.source_hash then
    update public.external_ticket_links
    set external_url = p_payload->>'externalUrl',
        external_created_at = coalesce(nullif(p_payload->>'externalCreatedAt', '')::timestamptz, external_created_at),
        external_updated_at = greatest((p_payload->>'externalUpdatedAt')::timestamptz, external_updated_at),
        last_seen_at = v_now,
        last_synced_at = v_now,
        metadata = coalesce(p_payload->'linkMetadata', metadata)
    where id = v_link.id;
    return query select 'unchanged'::text, v_ticket.id, null::text;
    return;
  end if;

  if (p_payload->>'externalUpdatedAt')::timestamptz = v_link.external_updated_at then
    v_warning := 'SAME_TIMESTAMP_CHANGED';
  end if;

  v_ticket_json := p_payload->'ticket';
  if v_ticket.customer_key like 'servicenow-unmapped:%' then
    v_customer_key := v_ticket_json->>'customerKey';
    v_customer_name := v_ticket_json->>'customerName';
    v_requires_mapping := true;
  else
    v_customer_key := v_ticket.customer_key;
    v_customer_name := v_ticket.customer_name;
    v_requires_mapping := false;
  end if;

  v_ticket_json := v_ticket.data || jsonb_build_object(
    'issueId', v_ticket_json->>'issueId',
    'customerKey', v_customer_key,
    'customerName', v_customer_name,
    'issueTitle', v_ticket_json->>'issueTitle',
    'issueType', 'Incident',
    'category', coalesce(v_ticket_json->>'category', ''),
    'severity', v_ticket_json->>'severity',
    'status', v_ticket_json->>'status',
    'kanbanStatus', v_ticket_json->>'kanbanStatus',
    'date', v_ticket_json->>'date',
    'startDate', v_ticket_json->>'startDate',
    'closeDate', v_ticket_json->>'closeDate',
    'serviceNow', v_ticket_json->'serviceNow',
    'requiresCustomerMapping', v_requires_mapping,
    'updatedAt', v_ticket_json->>'updatedAt'
  );

  update public.support_tickets
  set issue_id = v_ticket_json->>'issueId',
      customer_key = v_customer_key,
      customer_name = v_customer_name,
      kanban_status = v_ticket_json->>'kanbanStatus',
      status = v_ticket_json->>'status',
      issue_type = 'Incident',
      severity = v_ticket_json->>'severity',
      ticket_date = case when coalesce(v_ticket_json->>'date', '') = '' then null else ((v_ticket_json->>'date')::timestamptz at time zone 'Asia/Bangkok')::date end,
      start_date = case when coalesce(v_ticket_json->>'startDate', '') = '' then null else ((v_ticket_json->>'startDate')::timestamptz at time zone 'Asia/Bangkok')::date end,
      close_date = case when coalesce(v_ticket_json->>'closeDate', '') = '' then null else ((v_ticket_json->>'closeDate')::timestamptz at time zone 'Asia/Bangkok')::date end,
      data = v_ticket_json,
      updated_at = (v_ticket_json->>'updatedAt')::timestamptz
  where id = v_ticket.id;

  update public.external_ticket_links
  set external_number = p_payload->>'externalNumber',
      external_url = p_payload->>'externalUrl',
      external_created_at = coalesce(nullif(p_payload->>'externalCreatedAt', '')::timestamptz, external_created_at),
      external_updated_at = (p_payload->>'externalUpdatedAt')::timestamptz,
      last_seen_at = v_now,
      last_synced_at = v_now,
      source_hash = p_payload->>'sourceHash',
      metadata = coalesce(p_payload->'linkMetadata', metadata)
  where id = v_link.id;

  v_result := 'updated';
  return query select v_result, v_ticket.id, v_warning;
end;
$$;

-- SECURITY DEFINER functions execute with owner rights. PUBLIC execution would let
-- untrusted roles mutate lock state or canonical tickets through those owner rights.
revoke all privileges on function public.support_acquire_integration_sync_lock(text, text, text, integer, timestamptz) from public;
revoke execute on function public.support_acquire_integration_sync_lock(text, text, text, integer, timestamptz) from anon, authenticated;
grant execute on function public.support_acquire_integration_sync_lock(text, text, text, integer, timestamptz) to service_role;

revoke all privileges on function public.support_release_integration_sync_lock(text, text, text) from public;
revoke execute on function public.support_release_integration_sync_lock(text, text, text) from anon, authenticated;
grant execute on function public.support_release_integration_sync_lock(text, text, text) to service_role;

revoke all privileges on function public.support_complete_integration_sync_run(text, text, timestamptz, timestamptz, jsonb) from public;
revoke execute on function public.support_complete_integration_sync_run(text, text, timestamptz, timestamptz, jsonb) from anon, authenticated;
grant execute on function public.support_complete_integration_sync_run(text, text, timestamptz, timestamptz, jsonb) to service_role;

revoke all privileges on function public.support_upsert_servicenow_incident(jsonb) from public;
revoke execute on function public.support_upsert_servicenow_incident(jsonb) from anon, authenticated;
grant execute on function public.support_upsert_servicenow_incident(jsonb) to service_role;

insert into public.support_schema_migrations (version, description, checksum, applied_by)
values ('202607200001', 'ServiceNow incremental synchronization engine', null, current_user)
on conflict (version) do nothing;

commit;
