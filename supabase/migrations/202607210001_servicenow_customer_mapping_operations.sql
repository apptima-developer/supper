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

alter table public.integration_customer_mappings enable row level security;
alter table public.integration_customer_mapping_events enable row level security;

revoke all privileges on table public.integration_customer_mappings from public, anon, authenticated;
revoke all privileges on table public.integration_customer_mapping_events from public, anon, authenticated;
grant select, insert, update on table public.integration_customer_mappings to service_role;
grant select, insert on table public.integration_customer_mapping_events to service_role;

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
    or p_payload->>'appliedAt' is null then
    if p_payload->>'externalCustomerKey' = 'servicenow-unmapped:unknown' then
      raise exception using errcode = '22023', message = 'SERVICENOW_UNKNOWN_CUSTOMER_NOT_MAPPABLE';
    end if;
    raise exception using errcode = '22023', message = 'INVALID_CUSTOMER_MAPPING_PAYLOAD';
  end if;

  v_now := (p_payload->>'appliedAt')::timestamptz;
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
    where ticket.data#>>'{serviceNow,provider}' = 'servicenow'
      and (
        ticket.data#>>'{serviceNow,externalCustomerKey}' = p_payload->>'externalCustomerKey'
        or ticket.customer_key = p_payload->>'externalCustomerKey'
        or (nullif(p_payload->>'externalCustomerId', '') is not null
          and ticket.data#>>'{serviceNow,companyExternalId}' = p_payload->>'externalCustomerId')
      )
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
            'externalCustomerId', nullif(p_payload->>'externalCustomerId', ''),
            'externalCustomerName', coalesce(p_payload->>'externalCustomerName', ''),
            'customerMappingId', v_mapping_id,
            'customerMappingAppliedAt', v_now
          ),
          'updatedAt', v_now
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
    or p_payload->>'appliedAt' is null then
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
  end if;
  return query select v_mapping.id, 'deactivated'::text, v_mapping.customer_key, 0, false;
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
  v_now timestamptz := now();
  v_dry_run boolean;
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' or octet_length(p_payload::text) > 32768 then
    raise exception using errcode = '22023', message = 'INVALID_SERVICENOW_INCIDENT_PAYLOAD';
  end if;
  v_external_key := coalesce(
    nullif(p_payload#>>'{ticket,serviceNow,externalCustomerKey}', ''),
    nullif(p_payload#>>'{ticket,customerKey}', ''),
    'servicenow-unmapped:unknown'
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
    update public.support_tickets
    set customer_key = v_target.customer_key,
        customer_name = v_target.customer_name,
        data = v_ticket.data || jsonb_build_object(
          'customerKey', v_target.customer_key,
          'customerName', v_target.customer_name,
          'requiresCustomerMapping', false,
          'serviceNow', coalesce(v_ticket.data->'serviceNow', '{}'::jsonb) || jsonb_build_object(
            'externalCustomerKey', v_external_key,
            'externalCustomerId', nullif(p_payload#>>'{ticket,serviceNow,externalCustomerId}', ''),
            'externalCustomerName', coalesce(p_payload#>>'{ticket,serviceNow,externalCustomerName}', ''),
            'customerMappingId', v_mapping.id,
            'customerMappingAppliedAt', v_now
          ),
          'updatedAt', v_now
        ),
        updated_at = v_now
    where id = v_ticket.id;
  end if;
  return query select v_result.outcome::text, v_result.ticket_id::text, v_result.warning_code::text;
end;
$$;

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
