-- SUPPER AI-1.1.1: reliable cursor synchronization and existing-ticket reconciliation.
-- Forward-only correction: preserves all tickets, links, run history, and lock state.

begin;

alter table public.integration_sync_state
  add column if not exists watermark_sys_id text;

alter table public.integration_sync_runs
  add column if not exists watermark_from_sys_id text,
  add column if not exists watermark_to_sys_id text,
  add column if not exists window_start_at timestamptz,
  add column if not exists window_end_at timestamptz;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.integration_sync_state'::regclass
      and conname = 'integration_sync_state_watermark_sys_id_check'
  ) then
    alter table public.integration_sync_state
      add constraint integration_sync_state_watermark_sys_id_check
      check (watermark_sys_id is null or watermark_sys_id ~ '^[a-fA-F0-9]{32}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.integration_sync_runs'::regclass
      and conname = 'integration_sync_runs_watermark_from_sys_id_check'
  ) then
    alter table public.integration_sync_runs
      add constraint integration_sync_runs_watermark_from_sys_id_check
      check (watermark_from_sys_id is null or watermark_from_sys_id ~ '^[a-fA-F0-9]{32}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.integration_sync_runs'::regclass
      and conname = 'integration_sync_runs_watermark_to_sys_id_check'
  ) then
    alter table public.integration_sync_runs
      add constraint integration_sync_runs_watermark_to_sys_id_check
      check (watermark_to_sys_id is null or watermark_to_sys_id ~ '^[a-fA-F0-9]{32}$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.integration_sync_runs'::regclass
      and conname = 'integration_sync_runs_window_check'
  ) then
    alter table public.integration_sync_runs
      add constraint integration_sync_runs_window_check
      check (window_start_at is null or window_end_at is null or window_start_at <= window_end_at);
  end if;
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
  v_watermark_sys_id text := nullif(p_summary->>'watermarkSysId', '');
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
    or coalesce((p_summary->>'pages')::integer, -1) < 0
    or (p_watermark is null and v_watermark_sys_id is not null)
    or (p_watermark is not null and coalesce(v_watermark_sys_id, '') !~ '^[a-fA-F0-9]{32}$') then
    raise exception 'Invalid integration completion input';
  end if;

  update public.integration_sync_state
  set watermark_at = coalesce(p_watermark, watermark_at),
      watermark_sys_id = case when p_watermark is null then watermark_sys_id else lower(v_watermark_sys_id) end,
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
      watermark_to_sys_id = v_watermark_sys_id,
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
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'durationMs', coalesce((p_summary->>'durationMs')::integer, 0),
        'windowStart', p_summary->>'windowStart',
        'windowEnd', p_summary->>'windowEnd'
      )
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
  v_dry_run boolean;
  v_link public.external_ticket_links%rowtype;
  v_number_link public.external_ticket_links%rowtype;
  v_ticket public.support_tickets%rowtype;
  v_ticket_json jsonb;
  v_customer_key text;
  v_customer_name text;
  v_requires_mapping boolean;
  v_warning text;
  v_adopting boolean := false;
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 32768
    or coalesce(p_payload->>'dryRun', 'false') not in ('true', 'false')
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

  v_dry_run := coalesce((p_payload->>'dryRun')::boolean, false);
  perform (p_payload->>'externalUpdatedAt')::timestamptz;
  if p_payload->>'externalCreatedAt' is not null then
    perform (p_payload->>'externalCreatedAt')::timestamptz;
  end if;

  -- Serialize every committed reconciliation for one Incident number and sys_id.
  -- Dry-run executes the same decisions without acquiring a persistent or advisory lock.
  if not v_dry_run then
    perform pg_advisory_xact_lock(hashtextextended('servicenow:incident:number:' || (p_payload->>'externalNumber'), 0));
    perform pg_advisory_xact_lock(hashtextextended('servicenow:incident:sysid:' || lower(p_payload->>'externalSysId'), 0));
  end if;

  if v_dry_run then
    select * into v_link
    from public.external_ticket_links
    where provider = 'servicenow'
      and external_sys_id = p_payload->>'externalSysId';

    select * into v_number_link
    from public.external_ticket_links
    where provider = 'servicenow'
      and external_number = p_payload->>'externalNumber';
  else
    select * into v_link
    from public.external_ticket_links
    where provider = 'servicenow'
      and external_sys_id = p_payload->>'externalSysId'
    for update;

    select * into v_number_link
    from public.external_ticket_links
    where provider = 'servicenow'
      and external_number = p_payload->>'externalNumber'
    for update;
  end if;

  if v_number_link.id is not null
    and v_number_link.external_sys_id <> p_payload->>'externalSysId' then
    return query select 'failed'::text, null::text, 'SERVICENOW_EXTERNAL_NUMBER_CONFLICT'::text;
    return;
  end if;

  if v_link.id is not null
    and v_link.external_number <> p_payload->>'externalNumber' then
    return query select 'failed'::text, v_link.ticket_id, 'SERVICENOW_SYS_ID_NUMBER_CONFLICT'::text;
    return;
  end if;

  if v_link.id is null then
    if v_dry_run then
      select * into v_ticket
      from public.support_tickets
      where issue_id = p_payload->>'externalNumber';
    else
      select * into v_ticket
      from public.support_tickets
      where issue_id = p_payload->>'externalNumber'
      for update;
    end if;

    if v_ticket.id is not null and exists (
      select 1
      from public.external_ticket_links incompatible
      where incompatible.ticket_id = v_ticket.id
        and (incompatible.provider <> 'servicenow'
          or incompatible.external_sys_id <> p_payload->>'externalSysId')
    ) then
      return query select 'failed'::text, v_ticket.id, 'SERVICENOW_TICKET_LINK_CONFLICT'::text;
      return;
    end if;

    if v_ticket.id is null then
      if v_dry_run then
        return query select 'created'::text, p_payload#>>'{ticket,id}', null::text;
        return;
      end if;

      v_ticket_json := p_payload->'ticket';
      insert into public.support_tickets (
        id, issue_id, customer_key, customer_name, kanban_status, status,
        issue_type, severity, ticket_date, start_date, due_date, close_date,
        data, updated_at
      ) values (
        v_ticket_json->>'id', v_ticket_json->>'issueId', v_ticket_json->>'customerKey',
        v_ticket_json->>'customerName', v_ticket_json->>'kanbanStatus', v_ticket_json->>'status',
        v_ticket_json->>'issueType', v_ticket_json->>'severity',
        case when coalesce(v_ticket_json->>'date', '') = '' then null else ((v_ticket_json->>'date')::timestamptz at time zone 'Asia/Bangkok')::date end,
        case when coalesce(v_ticket_json->>'startDate', '') = '' then null else ((v_ticket_json->>'startDate')::timestamptz at time zone 'Asia/Bangkok')::date end,
        case when coalesce(v_ticket_json->>'dueDate', '') = '' then null else ((v_ticket_json->>'dueDate')::timestamptz at time zone 'Asia/Bangkok')::date end,
        case when coalesce(v_ticket_json->>'closeDate', '') = '' then null else ((v_ticket_json->>'closeDate')::timestamptz at time zone 'Asia/Bangkok')::date end,
        v_ticket_json, (v_ticket_json->>'updatedAt')::timestamptz
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
        v_now, v_now, v_now, p_payload->>'sourceHash', coalesce(p_payload->'linkMetadata', '{}'::jsonb)
      );
      return query select 'created'::text, v_ticket_json->>'id', null::text;
      return;
    end if;

    if v_dry_run then
      return query select 'updated'::text, v_ticket.id, 'ADOPTED_EXISTING_TICKET'::text;
      return;
    end if;
    v_adopting := true;
    v_warning := 'ADOPTED_EXISTING_TICKET';
  else
    if v_dry_run then
      select * into v_ticket
      from public.support_tickets
      where id = v_link.ticket_id;
    else
      select * into v_ticket
      from public.support_tickets
      where id = v_link.ticket_id
      for update;
    end if;
    if v_ticket.id is null then
      return query select 'failed'::text, v_link.ticket_id, 'SERVICENOW_LINKED_TICKET_MISSING'::text;
      return;
    end if;

    if (p_payload->>'externalUpdatedAt')::timestamptz < v_link.external_updated_at then
      if not v_dry_run then
        update public.external_ticket_links set last_seen_at = v_now, last_synced_at = v_now where id = v_link.id;
      end if;
      return query select 'stale'::text, v_ticket.id, null::text;
      return;
    end if;

    if p_payload->>'sourceHash' = v_link.source_hash then
      if not v_dry_run then
        update public.external_ticket_links
        set external_url = p_payload->>'externalUrl',
            external_created_at = coalesce(nullif(p_payload->>'externalCreatedAt', '')::timestamptz, external_created_at),
            external_updated_at = greatest((p_payload->>'externalUpdatedAt')::timestamptz, external_updated_at),
            last_seen_at = v_now,
            last_synced_at = v_now,
            metadata = coalesce(p_payload->'linkMetadata', metadata)
        where id = v_link.id;
      end if;
      return query select 'unchanged'::text, v_ticket.id, null::text;
      return;
    end if;

    if (p_payload->>'externalUpdatedAt')::timestamptz = v_link.external_updated_at then
      v_warning := 'SAME_TIMESTAMP_CHANGED';
    end if;
    if v_dry_run then
      return query select 'updated'::text, v_ticket.id, v_warning;
      return;
    end if;
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

  -- Overlay only ServiceNow-owned fields. Existing IDs, creation time, effort,
  -- billing, ownership, logs, notes, AI annotations, and unknown JSON remain intact.
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

  if v_adopting then
    insert into public.external_ticket_links (
      id, provider, external_sys_id, external_number, ticket_id, external_url,
      external_created_at, external_updated_at, first_seen_at, last_seen_at,
      last_synced_at, source_hash, metadata
    ) values (
      p_payload->>'linkId', 'servicenow', p_payload->>'externalSysId',
      p_payload->>'externalNumber', v_ticket.id, p_payload->>'externalUrl',
      nullif(p_payload->>'externalCreatedAt', '')::timestamptz,
      (p_payload->>'externalUpdatedAt')::timestamptz,
      v_now, v_now, v_now, p_payload->>'sourceHash', coalesce(p_payload->'linkMetadata', '{}'::jsonb)
    );
  else
    update public.external_ticket_links
    set external_url = p_payload->>'externalUrl',
        external_created_at = coalesce(nullif(p_payload->>'externalCreatedAt', '')::timestamptz, external_created_at),
        external_updated_at = (p_payload->>'externalUpdatedAt')::timestamptz,
        last_seen_at = v_now,
        last_synced_at = v_now,
        source_hash = p_payload->>'sourceHash',
        metadata = coalesce(p_payload->'linkMetadata', metadata)
    where id = v_link.id;
  end if;

  return query select 'updated'::text, v_ticket.id, v_warning;
end;
$$;

-- SECURITY DEFINER RPCs retain owner rights, so no untrusted role may execute them.
revoke all privileges on function public.support_complete_integration_sync_run(text, text, timestamptz, timestamptz, jsonb) from public;
revoke execute on function public.support_complete_integration_sync_run(text, text, timestamptz, timestamptz, jsonb) from anon, authenticated;
grant execute on function public.support_complete_integration_sync_run(text, text, timestamptz, timestamptz, jsonb) to service_role;

revoke all privileges on function public.support_upsert_servicenow_incident(jsonb) from public;
revoke execute on function public.support_upsert_servicenow_incident(jsonb) from anon, authenticated;
grant execute on function public.support_upsert_servicenow_incident(jsonb) to service_role;

insert into public.support_schema_migrations (version, description, checksum, applied_by)
values ('202607200002', 'ServiceNow reliable cursor and existing-ticket reconciliation', null, current_user)
on conflict (version) do nothing;

commit;
