begin;

create table if not exists public.integration_customer_mappings (
  id text primary key,
  provider text not null,
  external_customer_key text not null,
  external_customer_id text,
  external_customer_name text not null default '',
  customer_key text not null,
  active boolean not null default true,
  created_by_user_id text,
  updated_by_user_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint integration_customer_mappings_provider_check check (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  constraint integration_customer_mappings_external_key_check check (length(external_customer_key) between 1 and 600),
  constraint integration_customer_mappings_external_id_check check (external_customer_id is null or length(external_customer_id) between 1 and 500),
  constraint integration_customer_mappings_external_name_check check (length(external_customer_name) <= 500),
  constraint integration_customer_mappings_customer_key_fk foreign key (customer_key)
    references public.support_customers(customer_key) on update cascade on delete restrict,
  constraint integration_customer_mappings_provider_external_key_key unique (provider, external_customer_key),
  constraint integration_customer_mappings_metadata_check check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 8192)
);

create table if not exists public.integration_customer_mapping_events (
  id text primary key,
  mapping_id text not null,
  provider text not null,
  external_customer_key text not null,
  action text not null,
  previous_customer_key text,
  new_customer_key text,
  affected_ticket_count integer not null default 0,
  actor_user_id text,
  request_id text,
  correlation_id text,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  constraint integration_customer_mapping_events_mapping_fk foreign key (mapping_id)
    references public.integration_customer_mappings(id) on update cascade on delete restrict,
  constraint integration_customer_mapping_events_provider_check check (provider ~ '^[a-z][a-z0-9_-]{0,39}$'),
  constraint integration_customer_mapping_events_external_key_check check (length(external_customer_key) between 1 and 600),
  constraint integration_customer_mapping_events_action_check check (action in ('created', 'changed', 'reactivated', 'deactivated')),
  constraint integration_customer_mapping_events_count_check check (affected_ticket_count >= 0),
  constraint integration_customer_mapping_events_metadata_check check (jsonb_typeof(metadata) = 'object' and octet_length(metadata::text) <= 8192)
);

-- Ticket JSON uses the same millisecond UTC representation as Date.toISOString().
create or replace function public.support_canonical_utc_iso(p_value timestamptz)
returns text
language sql
immutable
strict
set search_path = pg_catalog, pg_temp
as $$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
$$;

-- Keep the SQL identity algorithm byte-for-byte compatible with the TypeScript
-- ServiceNow customer identity helper, including its 500-character input bound.
create or replace function public.support_servicenow_external_customer_key(p_external_customer_id text)
returns text
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select case
    when coalesce(btrim(p_external_customer_id), '') = '' then 'servicenow-unmapped:unknown'
    when left(btrim(p_external_customer_id), 500) ~* '^[a-f0-9]{32}$'
      then 'servicenow-unmapped:' || lower(left(btrim(p_external_customer_id), 500))
    else 'servicenow-unmapped:ref-' || left(
      encode(sha256(convert_to(left(btrim(p_external_customer_id), 500), 'UTF8')), 'hex'),
      24
    )
  end
$$;

-- Identity precedence matches serviceNowCustomerIdentityFromTicket(): explicit
-- metadata key, relational unmapped key, externalCustomerId, companyExternalId.
create or replace function public.support_servicenow_ticket_customer_key(p_customer_key text, p_data jsonb)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_data#>>'{serviceNow,provider}' <> 'servicenow' then null
    when coalesce(p_data#>>'{serviceNow,externalCustomerKey}', '') ~ '^servicenow-unmapped:[a-z0-9-]+$'
      and length(p_data#>>'{serviceNow,externalCustomerKey}') <= 600
      then p_data#>>'{serviceNow,externalCustomerKey}'
    when coalesce(p_customer_key, '') ~ '^servicenow-unmapped:[a-z0-9-]+$'
      and length(p_customer_key) <= 600
      then p_customer_key
    else public.support_servicenow_external_customer_key(coalesce(
      nullif(p_data#>>'{serviceNow,externalCustomerId}', ''),
      nullif(p_data#>>'{serviceNow,companyExternalId}', '')
    ))
  end
$$;

create index if not exists integration_customer_mappings_provider_active_idx
  on public.integration_customer_mappings(provider, active);
create index if not exists integration_customer_mappings_customer_key_idx
  on public.integration_customer_mappings(customer_key);
create index if not exists integration_customer_mappings_updated_at_idx
  on public.integration_customer_mappings(updated_at desc);
create index if not exists integration_customer_mappings_external_id_idx
  on public.integration_customer_mappings(provider, external_customer_id)
  where external_customer_id is not null;
create index if not exists integration_customer_mapping_events_mapping_idx
  on public.integration_customer_mapping_events(mapping_id);
create index if not exists integration_customer_mapping_events_source_idx
  on public.integration_customer_mapping_events(provider, external_customer_key);
create index if not exists integration_customer_mapping_events_created_at_idx
  on public.integration_customer_mapping_events(created_at desc);
create index if not exists support_tickets_servicenow_external_customer_idx
  on public.support_tickets ((data#>>'{serviceNow,externalCustomerKey}'))
  where data#>>'{serviceNow,provider}' = 'servicenow';
create index if not exists support_tickets_servicenow_customer_identity_idx
  on public.support_tickets (public.support_servicenow_ticket_customer_key(customer_key, data))
  where data#>>'{serviceNow,provider}' = 'servicenow';

alter table public.integration_customer_mappings enable row level security;
alter table public.integration_customer_mapping_events enable row level security;

revoke all privileges on table public.integration_customer_mappings from public, anon, authenticated;
revoke all privileges on table public.integration_customer_mapping_events from public, anon, authenticated;
grant select, insert, update on table public.integration_customer_mappings to service_role;
grant select, insert on table public.integration_customer_mapping_events to service_role;

-- Exact source lookup avoids depending on the bounded operations candidate list
-- and returns only sanitized aggregate fields, never raw Ticket JSON.
create or replace function public.support_get_servicenow_customer_source(p_external_customer_key text)
returns table (
  mapping_id text,
  external_customer_key text,
  external_customer_id text,
  external_customer_name text,
  mappable boolean,
  mapped boolean,
  active_mapping boolean,
  mapped_customer_key text,
  mapped_customer_name text,
  ticket_count integer,
  open_ticket_count integer,
  first_seen_at text,
  last_seen_at text,
  example_incidents text[]
)
language plpgsql
security definer
stable
set search_path = public, pg_temp
as $$
begin
  if coalesce(p_external_customer_key, '') !~ '^servicenow-unmapped:[a-z0-9-]+$'
    or length(p_external_customer_key) > 600 then
    raise exception using errcode = '22023', message = 'INVALID_SERVICENOW_CUSTOMER_KEY';
  end if;
  if p_external_customer_key = 'servicenow-unmapped:unknown' then
    raise exception using errcode = '22023', message = 'SERVICENOW_UNKNOWN_CUSTOMER_NOT_MAPPABLE';
  end if;

  return query
  with mapping_source as (
    select source.*
    from public.integration_customer_mappings source
    where source.provider = 'servicenow'
      and source.external_customer_key = p_external_customer_key
    limit 1
  ), matching_tickets as (
    select ticket.*
    from public.support_tickets ticket
    where public.support_servicenow_ticket_customer_key(ticket.customer_key, ticket.data) = p_external_customer_key
  ), latest_ticket as (
    select ticket.data, ticket.updated_at
    from matching_tickets ticket
    order by ticket.updated_at desc, ticket.id
    limit 1
  ), ticket_summary as (
    select count(*)::integer as ticket_count,
      count(*) filter (where coalesce(ticket.kanban_status, '') not in ('resolved', 'closed', 'cancelled'))::integer as open_ticket_count,
      min(coalesce(nullif(ticket.data->>'createdAt', ''), nullif(ticket.data#>>'{serviceNow,externalCreatedAt}', ''))) as first_seen_at,
      max(coalesce(nullif(ticket.data#>>'{serviceNow,externalUpdatedAt}', ''), public.support_canonical_utc_iso(ticket.updated_at))) as last_seen_at
    from matching_tickets ticket
  )
  select source.id,
    p_external_customer_key,
    coalesce(source.external_customer_id, latest.data#>>'{serviceNow,externalCustomerId}', latest.data#>>'{serviceNow,companyExternalId}'),
    coalesce(nullif(source.external_customer_name, ''), nullif(latest.data#>>'{serviceNow,externalCustomerName}', ''), nullif(latest.data#>>'{serviceNow,companyReference}', ''), 'Unmapped ServiceNow customer'),
    true,
    source.id is not null,
    coalesce(source.active, false),
    source.customer_key,
    target.customer_name,
    summary.ticket_count,
    summary.open_ticket_count,
    summary.first_seen_at,
    summary.last_seen_at,
    array(
      select ticket.issue_id
      from matching_tickets ticket
      where coalesce(ticket.issue_id, '') <> ''
      order by ticket.updated_at desc, ticket.issue_id
      limit 3
    )
  from ticket_summary summary
  left join mapping_source source on true
  left join latest_ticket latest on true
  left join public.support_customers target on target.customer_key = source.customer_key
  where source.id is not null or summary.ticket_count > 0;
end;
$$;

create or replace function public.support_apply_integration_customer_mapping(p_payload jsonb)
returns table (
  mapping_id text,
  action text,
  previous_customer_key text,
  customer_key text,
  customer_name text,
  affected_ticket_count integer,
  active boolean
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz;
  v_now_iso text;
  v_mapping public.integration_customer_mappings%rowtype;
  v_target public.support_customers%rowtype;
  v_action text;
  v_previous text;
  v_count integer := 0;
  v_mapping_id text;
  v_allowed_keys text[] := array[
    'provider', 'externalCustomerKey', 'externalCustomerId', 'externalCustomerName',
    'targetCustomerKey', 'actorUserId', 'requestId', 'correlationId',
    'mappingId', 'eventId', 'appliedAt'
  ];
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 16384
    or exists (select 1 from jsonb_object_keys(p_payload) as keys(key) where not (key = any(v_allowed_keys)))
    or p_payload->>'provider' <> 'servicenow'
    or coalesce(p_payload->>'externalCustomerKey', '') !~ '^servicenow-unmapped:[a-z0-9-]+$'
    or length(coalesce(p_payload->>'externalCustomerKey', '')) > 600
    or p_payload->>'externalCustomerKey' = 'servicenow-unmapped:unknown'
    or length(coalesce(p_payload->>'externalCustomerName', '')) > 500
    or length(coalesce(p_payload->>'externalCustomerId', '')) > 500
    or length(coalesce(p_payload->>'targetCustomerKey', '')) not between 1 and 600
    or length(coalesce(p_payload->>'mappingId', '')) not between 16 and 200
    or length(coalesce(p_payload->>'eventId', '')) not between 16 and 200
    or length(coalesce(p_payload->>'actorUserId', '')) not between 1 and 200
    or length(coalesce(p_payload->>'requestId', '')) not between 8 and 200
    or length(coalesce(p_payload->>'correlationId', '')) not between 8 and 200
    or coalesce(p_payload->>'appliedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' then
    if p_payload->>'externalCustomerKey' = 'servicenow-unmapped:unknown' then
      raise exception using errcode = '22023', message = 'SERVICENOW_UNKNOWN_CUSTOMER_NOT_MAPPABLE';
    end if;
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_MAPPING_PAYLOAD';
  end if;

  v_now := (p_payload->>'appliedAt')::timestamptz;
  v_now_iso := public.support_canonical_utc_iso(v_now);
  perform pg_advisory_xact_lock(hashtextextended('integration-customer-mapping:servicenow:' || (p_payload->>'externalCustomerKey'), 0));

  select * into v_target
  from public.support_customers
  where support_customers.customer_key = p_payload->>'targetCustomerKey'
  for share;
  if v_target.id is null then
    raise exception using errcode = 'P0002', message = 'TARGET_CUSTOMER_NOT_FOUND';
  end if;
  if not v_target.active then
    raise exception using errcode = '23514', message = 'TARGET_CUSTOMER_INACTIVE';
  end if;

  select * into v_mapping
  from public.integration_customer_mappings
  where integration_customer_mappings.provider = 'servicenow'
    and integration_customer_mappings.external_customer_key = p_payload->>'externalCustomerKey'
  for update;

  v_previous := v_mapping.customer_key;
  if v_mapping.id is null then
    v_mapping_id := p_payload->>'mappingId';
    v_action := 'created';
    insert into public.integration_customer_mappings (
      id, provider, external_customer_key, external_customer_id, external_customer_name,
      customer_key, active, created_by_user_id, updated_by_user_id, created_at, updated_at, metadata
    ) values (
      v_mapping_id, 'servicenow', p_payload->>'externalCustomerKey', nullif(p_payload->>'externalCustomerId', ''),
      coalesce(p_payload->>'externalCustomerName', ''), v_target.customer_key, true,
      p_payload->>'actorUserId', p_payload->>'actorUserId', v_now, v_now, '{}'::jsonb
    );
  else
    v_mapping_id := v_mapping.id;
    if v_mapping.customer_key <> v_target.customer_key then
      v_action := 'changed';
    elsif not v_mapping.active then
      v_action := 'reactivated';
    else
      v_action := 'unchanged';
    end if;
    if v_action <> 'unchanged' then
      update public.integration_customer_mappings
      set external_customer_id = coalesce(nullif(p_payload->>'externalCustomerId', ''), external_customer_id),
          external_customer_name = coalesce(nullif(p_payload->>'externalCustomerName', ''), external_customer_name),
          customer_key = v_target.customer_key,
          active = true,
          updated_by_user_id = p_payload->>'actorUserId',
          updated_at = v_now
      where id = v_mapping.id;
    end if;
  end if;

  if v_action <> 'unchanged' then
    with matching as (
    select ticket.id
    from public.support_tickets ticket
    where public.support_servicenow_ticket_customer_key(ticket.customer_key, ticket.data)
      = p_payload->>'externalCustomerKey'
    for update
  ), updated as (
    update public.support_tickets ticket
    set customer_key = v_target.customer_key,
        customer_name = v_target.customer_name,
        data = ticket.data || jsonb_build_object(
          'customerKey', v_target.customer_key,
          'customerName', v_target.customer_name,
          'requiresCustomerMapping', false,
          'serviceNow', coalesce(ticket.data->'serviceNow', '{}'::jsonb) || jsonb_build_object(
            'externalCustomerKey', p_payload->>'externalCustomerKey',
            'externalCustomerName', coalesce(p_payload->>'externalCustomerName', ''),
            'customerMappingId', v_mapping_id,
            'customerMappingAppliedAt', v_now_iso
          ) || case when nullif(p_payload->>'externalCustomerId', '') is not null
            then jsonb_build_object('externalCustomerId', p_payload->>'externalCustomerId')
            else '{}'::jsonb end,
          'updatedAt', v_now_iso
        ),
        updated_at = v_now
    from matching
    where ticket.id = matching.id
    returning ticket.id
    ) select count(*)::integer into v_count from updated;
  end if;

  if v_action <> 'unchanged' then
    insert into public.integration_customer_mapping_events (
      id, mapping_id, provider, external_customer_key, action, previous_customer_key,
      new_customer_key, affected_ticket_count, actor_user_id, request_id, correlation_id, created_at, metadata
    ) values (
      p_payload->>'eventId', v_mapping_id, 'servicenow', p_payload->>'externalCustomerKey', v_action,
      v_previous, v_target.customer_key, v_count, p_payload->>'actorUserId', p_payload->>'requestId',
      p_payload->>'correlationId', v_now, '{}'::jsonb
    );
  end if;

  return query select v_mapping_id, v_action, v_previous, v_target.customer_key,
    v_target.customer_name, v_count, true;
end;
$$;

create or replace function public.support_deactivate_integration_customer_mapping(p_payload jsonb)
returns table (mapping_id text, action text, customer_key text, affected_ticket_count integer, active boolean)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mapping public.integration_customer_mappings%rowtype;
  v_now timestamptz;
  v_action text;
begin
  if p_payload is null
    or jsonb_typeof(p_payload) <> 'object'
    or octet_length(p_payload::text) > 8192
    or exists (select 1 from jsonb_object_keys(p_payload) as keys(key) where key not in ('mappingId', 'actorUserId', 'requestId', 'correlationId', 'eventId', 'appliedAt'))
    or length(coalesce(p_payload->>'mappingId', '')) not between 16 and 200
    or length(coalesce(p_payload->>'eventId', '')) not between 16 and 200
    or length(coalesce(p_payload->>'actorUserId', '')) not between 1 and 200
    or length(coalesce(p_payload->>'requestId', '')) not between 8 and 200
    or length(coalesce(p_payload->>'correlationId', '')) not between 8 and 200
    or coalesce(p_payload->>'appliedAt', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$' then
    raise exception using errcode = '22023', message = 'INVALID_MAPPING_DEACTIVATION_PAYLOAD';
  end if;
  v_now := (p_payload->>'appliedAt')::timestamptz;

  select * into v_mapping from public.integration_customer_mappings
  where id = p_payload->>'mappingId' and provider = 'servicenow';
  if v_mapping.id is null then
    raise exception using errcode = 'P0002', message = 'CUSTOMER_MAPPING_NOT_FOUND';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('integration-customer-mapping:servicenow:' || v_mapping.external_customer_key, 0));
  select * into v_mapping from public.integration_customer_mappings
  where id = p_payload->>'mappingId' and provider = 'servicenow' for update;

  if v_mapping.active then
    v_action := 'deactivated';
    update public.integration_customer_mappings set active = false,
      updated_by_user_id = p_payload->>'actorUserId', updated_at = v_now where id = v_mapping.id;
    insert into public.integration_customer_mapping_events (
      id, mapping_id, provider, external_customer_key, action, previous_customer_key,
      new_customer_key, affected_ticket_count, actor_user_id, request_id, correlation_id, created_at, metadata
    ) values (
      p_payload->>'eventId', v_mapping.id, 'servicenow', v_mapping.external_customer_key, 'deactivated',
      v_mapping.customer_key, v_mapping.customer_key, 0, p_payload->>'actorUserId', p_payload->>'requestId',
      p_payload->>'correlationId', v_now, '{}'::jsonb
    );
  else
    v_action := 'unchanged';
  end if;
  return query select v_mapping.id, v_action, v_mapping.customer_key, 0, false;
end;
$$;

-- This wrapper keeps the proven AI-1.1 reconciliation function intact while
-- applying a current active customer mapping in the same database transaction.
create or replace function public.support_upsert_servicenow_incident_with_mapping(p_payload jsonb)
returns table (outcome text, ticket_id text, warning_code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_result record;
  v_mapping public.integration_customer_mappings%rowtype;
  v_target public.support_customers%rowtype;
  v_external_key text;
  v_ticket public.support_tickets%rowtype;
  v_dry_run boolean;
  v_expected_external_id text;
  v_expected_external_name text;
  v_mapping_applied_iso text;
  v_requires_mapping_update boolean;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 32768 then
    raise exception using errcode = '22023', message = 'INVALID_SERVICENOW_INCIDENT_PAYLOAD';
  end if;
  v_external_key := public.support_servicenow_ticket_customer_key(
    p_payload#>>'{ticket,customerKey}', p_payload->'ticket'
  );
  v_dry_run := coalesce(p_payload->>'dryRun', 'false')::boolean;
  if not v_dry_run then
    perform pg_advisory_xact_lock(hashtextextended('integration-customer-mapping:servicenow:' || v_external_key, 0));
  end if;

  select * into v_mapping
  from public.integration_customer_mappings mapping
  where mapping.provider = 'servicenow' and mapping.external_customer_key = v_external_key and mapping.active
  for share;
  if v_mapping.id is not null then
    select * into v_target from public.support_customers where customer_key = v_mapping.customer_key and active for share;
    if v_target.id is null then v_mapping := null; end if;
  end if;

  select * into v_result from public.support_upsert_servicenow_incident(p_payload);
  if v_dry_run or v_result.ticket_id is null or v_mapping.id is null then
    return query select v_result.outcome::text, v_result.ticket_id::text, v_result.warning_code::text;
    return;
  end if;

  select * into v_ticket from public.support_tickets where id = v_result.ticket_id for update;
  if v_ticket.id is not null and (v_ticket.customer_key like 'servicenow-unmapped:%' or v_ticket.customer_key = v_target.customer_key) then
    v_expected_external_id := coalesce(
      nullif(p_payload#>>'{ticket,serviceNow,externalCustomerId}', ''),
      nullif(p_payload#>>'{ticket,serviceNow,companyExternalId}', ''),
      v_mapping.external_customer_id
    );
    v_expected_external_name := coalesce(
      nullif(p_payload#>>'{ticket,serviceNow,externalCustomerName}', ''),
      nullif(p_payload#>>'{ticket,serviceNow,companyReference}', ''),
      v_mapping.external_customer_name,
      ''
    );
    v_mapping_applied_iso := public.support_canonical_utc_iso(v_mapping.updated_at);
    v_requires_mapping_update := v_ticket.customer_key is distinct from v_target.customer_key
      or v_ticket.customer_name is distinct from v_target.customer_name
      or v_ticket.data->>'customerKey' is distinct from v_target.customer_key
      or v_ticket.data->>'customerName' is distinct from v_target.customer_name
      or v_ticket.data->>'requiresCustomerMapping' is distinct from 'false'
      or v_ticket.data#>>'{serviceNow,externalCustomerKey}' is distinct from v_external_key
      or (v_expected_external_id is not null
        and v_ticket.data#>>'{serviceNow,externalCustomerId}' is distinct from v_expected_external_id)
      or v_ticket.data#>>'{serviceNow,externalCustomerName}' is distinct from v_expected_external_name
      or v_ticket.data#>>'{serviceNow,customerMappingId}' is distinct from v_mapping.id
      or v_ticket.data#>>'{serviceNow,customerMappingAppliedAt}' is distinct from v_mapping_applied_iso;

    if v_requires_mapping_update then
      update public.support_tickets
      set customer_key = v_target.customer_key,
          customer_name = v_target.customer_name,
          data = v_ticket.data || jsonb_build_object(
            'customerKey', v_target.customer_key,
            'customerName', v_target.customer_name,
            'requiresCustomerMapping', false,
            'serviceNow', coalesce(v_ticket.data->'serviceNow', '{}'::jsonb) || jsonb_build_object(
              'externalCustomerKey', v_external_key,
              'externalCustomerName', v_expected_external_name,
              'customerMappingId', v_mapping.id,
              'customerMappingAppliedAt', v_mapping_applied_iso
            ) || case when v_expected_external_id is not null
              then jsonb_build_object('externalCustomerId', v_expected_external_id)
              else '{}'::jsonb end
          )
      where id = v_ticket.id;
    end if;
  end if;
  return query select v_result.outcome::text, v_result.ticket_id::text, v_result.warning_code::text;
end;
$$;

revoke all privileges on function public.support_canonical_utc_iso(timestamptz) from public;
revoke execute on function public.support_canonical_utc_iso(timestamptz) from anon, authenticated;
grant execute on function public.support_canonical_utc_iso(timestamptz) to service_role;
revoke all privileges on function public.support_servicenow_external_customer_key(text) from public;
revoke execute on function public.support_servicenow_external_customer_key(text) from anon, authenticated;
grant execute on function public.support_servicenow_external_customer_key(text) to service_role;
revoke all privileges on function public.support_servicenow_ticket_customer_key(text, jsonb) from public;
revoke execute on function public.support_servicenow_ticket_customer_key(text, jsonb) from anon, authenticated;
grant execute on function public.support_servicenow_ticket_customer_key(text, jsonb) to service_role;
revoke all privileges on function public.support_get_servicenow_customer_source(text) from public;
revoke execute on function public.support_get_servicenow_customer_source(text) from anon, authenticated;
grant execute on function public.support_get_servicenow_customer_source(text) to service_role;

revoke all privileges on function public.support_apply_integration_customer_mapping(jsonb) from public;
revoke execute on function public.support_apply_integration_customer_mapping(jsonb) from anon, authenticated;
grant execute on function public.support_apply_integration_customer_mapping(jsonb) to service_role;
revoke all privileges on function public.support_deactivate_integration_customer_mapping(jsonb) from public;
revoke execute on function public.support_deactivate_integration_customer_mapping(jsonb) from anon, authenticated;
grant execute on function public.support_deactivate_integration_customer_mapping(jsonb) to service_role;
revoke all privileges on function public.support_upsert_servicenow_incident_with_mapping(jsonb) from public;
revoke execute on function public.support_upsert_servicenow_incident_with_mapping(jsonb) from anon, authenticated;
grant execute on function public.support_upsert_servicenow_incident_with_mapping(jsonb) to service_role;

insert into public.support_schema_migrations (version, description, checksum, applied_by)
values ('202607210001', 'ServiceNow operations and customer mapping', null, current_user)
on conflict (version) do nothing;

commit;
