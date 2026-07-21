import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const suffix = `${process.pid}`;
const dataDirectory = `/tmp/supper-sync-pg-data-${suffix}`;
const socketDirectory = `/tmp/supper-sync-pg-socket-${suffix}`;
const logPath = `/tmp/supper-sync-pg-${suffix}.log`;
const port = String(55_000 + (process.pid % 1_000));
let started = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", ...options });
  if (result.error || result.status !== 0) {
    const detail = [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${command} failed${detail ? `:\n${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function psql(args = [], input) {
  return run("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-h", socketDirectory, "-p", port, "-U", "postgres", "-d", "postgres", ...args], { input });
}

const baseSchema = String.raw`
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;

create table public.support_schema_migrations (
  version text primary key,
  description text not null,
  checksum text,
  applied_by text,
  applied_at timestamptz not null default now()
);

create table public.support_tickets (
  id text primary key,
  issue_id text not null unique,
  customer_key text not null,
  customer_name text not null,
  kanban_status text not null,
  status text not null,
  issue_type text not null,
  severity text not null,
  ticket_date date,
  start_date date,
  due_date date,
  close_date date,
  data jsonb not null,
  updated_at timestamptz not null
);

create table public.support_customers (
  id text primary key,
  customer_key text not null unique,
  customer_name text not null,
  project_code text not null default '',
  active boolean not null default true,
  end_period date,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
`;

const acceptanceSql = String.raw`
insert into public.support_customers (id, customer_key, customer_name, project_code, active, data)
values
  ('customer-a', 'customer-a', 'Customer A', 'A-001', true, '{"key":"customer-a"}'::jsonb),
  ('customer-b', 'customer-b', 'Customer B', 'B-001', true, '{"key":"customer-b"}'::jsonb),
  ('customer-inactive', 'customer-inactive', 'Inactive Customer', 'I-001', false, '{"key":"customer-inactive"}'::jsonb);

insert into public.support_tickets (
  id, issue_id, customer_key, customer_name, kanban_status, status,
  issue_type, severity, ticket_date, start_date, due_date, close_date, data, updated_at
) values (
  'historical-ticket-id', 'INC0010001', 'confirmed-project', 'Confirmed customer', 'open', '00 - Open',
  'Incident', 'Medium', date '2026-07-19', date '2026-07-19', null, null,
  jsonb_build_object(
    'id', 'historical-ticket-id', 'issueId', 'INC0010001', 'createdAt', '2026-01-01T00:00:00.000Z',
    'customerKey', 'confirmed-project', 'customerName', 'Confirmed customer', 'owner', 'support-agent',
    'ownerEfforts', jsonb_build_array(jsonb_build_object('owner', 'support-agent', 'hours', 2.5)),
    'mdUsed', 0.3125, 'chargeable', true, 'nonChargeReason', 'manual decision',
    'projectMapping', 'legacy-project', 'remark', 'manual note',
    'ticketLogs', jsonb_build_array(jsonb_build_object('message', 'manual log')),
    'aiClassification', 'manual-ai-value', 'unknownOperationalValue', jsonb_build_object('preserve', true)
  ),
  '2026-07-19T00:00:00.000Z'
);

do $$
declare
  v_payload jsonb := jsonb_build_object(
    'provider', 'servicenow', 'linkId', 'link-id-0000000000000001',
    'externalSysId', repeat('a', 32), 'externalNumber', 'INC0010001',
    'externalUrl', 'https://dev.example.service-now.com/incident',
    'externalCreatedAt', '2026-07-19T00:00:00.000Z',
    'externalUpdatedAt', '2026-07-20T02:00:00.000Z', 'sourceHash', repeat('b', 64),
    'linkMetadata', jsonb_build_object('requiresCustomerMapping', true),
    'ticket', jsonb_build_object(
      'id', 'generated-ticket-id', 'issueId', 'INC0010001', 'issueType', 'Incident',
      'issueTitle', 'ServiceNow title', 'customerKey', 'servicenow-unmapped:unknown',
      'customerName', 'Unmapped', 'kanbanStatus', 'in_progress', 'status', '04 - Func Inprogress',
      'severity', 'High', 'category', 'software', 'date', '2026-07-19T00:00:00.000Z',
      'startDate', '2026-07-19T00:00:00.000Z', 'dueDate', '', 'closeDate', '',
      'updatedAt', '2026-07-20T02:00:00.000Z',
      'serviceNow', jsonb_build_object(
        'provider', 'servicenow', 'externalSysId', repeat('a', 32),
        'externalCustomerKey', 'servicenow-unmapped:' || repeat('1', 32),
        'externalCustomerId', repeat('1', 32), 'externalCustomerName', 'ServiceNow Company',
        'externalUpdatedAt', '2026-07-20T02:00:00.000Z'
      )
    )
  );
  v_result record;
  v_before jsonb;
  v_after jsonb;
begin
  select * into v_result from public.support_upsert_servicenow_incident(v_payload || jsonb_build_object('dryRun', true));
  if v_result.outcome <> 'updated' or v_result.ticket_id <> 'historical-ticket-id' or v_result.warning_code <> 'ADOPTED_EXISTING_TICKET' then
    raise exception 'Dry-run adoption parity failed';
  end if;
  if exists (select 1 from public.external_ticket_links) then raise exception 'Dry-run mutated external links'; end if;

  select * into v_result from public.support_upsert_servicenow_incident(v_payload || jsonb_build_object('dryRun', false));
  if v_result.outcome <> 'updated' or v_result.ticket_id <> 'historical-ticket-id' or v_result.warning_code <> 'ADOPTED_EXISTING_TICKET' then
    raise exception 'Committed adoption failed';
  end if;
  if (select count(*) from public.support_tickets where issue_id = 'INC0010001') <> 1 then raise exception 'Duplicate ticket created'; end if;
  if (select count(*) from public.external_ticket_links where external_sys_id = repeat('a', 32)) <> 1 then raise exception 'External link missing'; end if;

  select data into v_before from public.support_tickets where id = 'historical-ticket-id';
  if v_before->>'owner' <> 'support-agent'
    or v_before->>'id' <> 'historical-ticket-id'
    or v_before->>'customerKey' <> 'confirmed-project'
    or jsonb_array_length(v_before->'ownerEfforts') <> 1
    or jsonb_array_length(v_before->'ticketLogs') <> 1
    or (v_before->>'mdUsed')::numeric <> 0.3125
    or (v_before->>'chargeable')::boolean is not true
    or v_before->>'nonChargeReason' <> 'manual decision'
    or v_before->>'projectMapping' <> 'legacy-project'
    or v_before->>'remark' <> 'manual note'
    or v_before->>'aiClassification' <> 'manual-ai-value'
    or v_before->>'createdAt' <> '2026-01-01T00:00:00.000Z'
    or v_before#>>'{unknownOperationalValue,preserve}' <> 'true' then
    raise exception 'SUPPER-owned ticket data was not preserved';
  end if;

  v_payload := jsonb_set(v_payload, '{externalUpdatedAt}', '"2026-07-20T03:00:00.000Z"'::jsonb);
  select * into v_result from public.support_upsert_servicenow_incident(v_payload || jsonb_build_object('dryRun', false));
  if v_result.outcome <> 'unchanged' then raise exception 'Timestamp-only touch was not unchanged'; end if;
  select data into v_after from public.support_tickets where id = 'historical-ticket-id';
  if v_after <> v_before then raise exception 'Timestamp-only touch rewrote ticket JSON'; end if;
  if (select external_updated_at from public.external_ticket_links where external_sys_id = repeat('a', 32)) <> '2026-07-20T03:00:00.000Z'::timestamptz then
    raise exception 'Timestamp-only touch did not advance link timestamp';
  end if;

  select * into v_result from public.support_upsert_servicenow_incident(
    v_payload || jsonb_build_object('dryRun', false, 'externalSysId', repeat('c', 32), 'linkId', 'link-id-0000000000000002')
  );
  if v_result.outcome <> 'failed' or v_result.warning_code <> 'SERVICENOW_EXTERNAL_NUMBER_CONFLICT' then
    raise exception 'Conflicting ServiceNow number was not rejected';
  end if;

  insert into public.support_tickets (
    id, issue_id, customer_key, customer_name, kanban_status, status, issue_type, severity, data, updated_at
  ) values (
    'provider-linked-ticket', 'INC0020002', 'confirmed-project', 'Confirmed customer', 'open', '00 - Open', 'Incident', 'Medium',
    jsonb_build_object('id', 'provider-linked-ticket', 'issueId', 'INC0020002', 'customerKey', 'confirmed-project'), now()
  );
  insert into public.external_ticket_links (
    id, provider, external_sys_id, external_number, ticket_id, external_url,
    external_updated_at, source_hash, metadata
  ) values (
    'jira-link-00000000000001', 'jira', repeat('d', 32), 'JIRA-1', 'provider-linked-ticket',
    'https://jira.example.test/1', now(), repeat('e', 64), '{}'::jsonb
  );
  v_payload := v_payload || jsonb_build_object(
    'externalSysId', repeat('f', 32), 'externalNumber', 'INC0020002', 'linkId', 'link-id-0000000000000003',
    'ticket', (v_payload->'ticket') || jsonb_build_object('issueId', 'INC0020002')
  );
  select * into v_result from public.support_upsert_servicenow_incident(v_payload || jsonb_build_object('dryRun', false));
  if v_result.outcome <> 'failed' or v_result.warning_code <> 'SERVICENOW_TICKET_LINK_CONFLICT' then
    raise exception 'Incompatible provider link was not rejected';
  end if;
end;
$$;

do $$
declare
  v_payload jsonb := jsonb_build_object(
    'provider', 'servicenow', 'linkId', 'mapping-link-000000000001',
    'externalSysId', repeat('9', 32), 'externalNumber', 'INC0030003',
    'externalUrl', 'https://dev.example.service-now.com/incident',
    'externalCreatedAt', '2026-07-20T01:00:00.000Z',
    'externalUpdatedAt', '2026-07-20T02:00:00.000Z', 'sourceHash', repeat('8', 64),
    'linkMetadata', jsonb_build_object('requiresCustomerMapping', true),
    'ticket', jsonb_build_object(
      'id', 'mapping-ticket-id', 'issueId', 'INC0030003', 'issueType', 'Incident',
      'issueTitle', 'Mapping test', 'customerKey', 'servicenow-unmapped:' || repeat('1', 32),
      'customerName', 'ServiceNow Company', 'kanbanStatus', 'open', 'status', '00 - Open',
      'severity', 'High', 'category', 'software', 'date', '2026-07-20T01:00:00.000Z',
      'startDate', '2026-07-20T01:00:00.000Z', 'dueDate', '', 'closeDate', '',
      'owner', 'support-agent', 'ownerEfforts', jsonb_build_array(jsonb_build_object('owner', 'support-agent', 'hours', 3.5)),
      'mdUsed', 0.4375, 'chargeable', true, 'remark', 'preserve me',
      'ticketLogs', jsonb_build_array(jsonb_build_object('message', 'preserve log')),
      'slaPauses', jsonb_build_array(jsonb_build_object('reason', 'waiting')),
      'createdAt', '2026-07-20T01:00:00.000Z', 'updatedAt', '2026-07-20T02:00:00.000Z',
      'requiresCustomerMapping', true,
      'serviceNow', jsonb_build_object(
        'provider', 'servicenow', 'externalSysId', repeat('9', 32),
        'externalCustomerKey', 'servicenow-unmapped:' || repeat('1', 32),
        'externalCustomerId', repeat('1', 32), 'externalCustomerName', 'ServiceNow Company',
        'externalUpdatedAt', '2026-07-20T02:00:00.000Z', 'sourceHash', repeat('8', 64)
      ),
      'unknownOperationalValue', jsonb_build_object('preserve', true)
    )
  );
  v_result record;
  v_mapping_result record;
  v_before jsonb;
  v_after jsonb;
begin
  select * into v_result from public.support_upsert_servicenow_incident_with_mapping(v_payload || jsonb_build_object('dryRun', false));
  if v_result.outcome <> 'created' then raise exception 'Mapping fixture ticket was not created'; end if;
  select data into v_before from public.support_tickets where id = 'mapping-ticket-id';

  select * into v_mapping_result from public.support_apply_integration_customer_mapping(jsonb_build_object(
    'provider', 'servicenow', 'externalCustomerKey', 'servicenow-unmapped:' || repeat('1', 32),
    'externalCustomerId', repeat('1', 32), 'externalCustomerName', 'ServiceNow Company',
    'targetCustomerKey', 'customer-a', 'actorUserId', 'admin-user',
    'requestId', 'request-00000001', 'correlationId', 'correlation-0001',
    'mappingId', 'mapping-id-000000000001', 'eventId', 'mapping-event-000000001',
    'appliedAt', '2026-07-20T03:00:00.000Z'
  ));
  if v_mapping_result.action <> 'created' or v_mapping_result.affected_ticket_count <> 2 then
    raise exception 'Mapping creation or affected count failed: action %, count %', v_mapping_result.action, v_mapping_result.affected_ticket_count;
  end if;
  select data into v_after from public.support_tickets where id = 'mapping-ticket-id';
  if v_after->>'customerKey' <> 'customer-a'
    or v_after->>'id' <> v_before->>'id'
    or v_after->>'createdAt' <> v_before->>'createdAt'
    or v_after->>'owner' <> v_before->>'owner'
    or v_after->'ownerEfforts' <> v_before->'ownerEfforts'
    or v_after->>'mdUsed' <> v_before->>'mdUsed'
    or v_after->>'chargeable' <> v_before->>'chargeable'
    or v_after->>'remark' <> v_before->>'remark'
    or v_after->'ticketLogs' <> v_before->'ticketLogs'
    or v_after->'slaPauses' <> v_before->'slaPauses'
    or v_after#>>'{unknownOperationalValue,preserve}' <> 'true'
    or v_after#>>'{serviceNow,customerMappingId}' <> 'mapping-id-000000000001' then
    raise exception 'Mapping did not preserve SUPPER ticket fields';
  end if;

  select * into v_mapping_result from public.support_apply_integration_customer_mapping(jsonb_build_object(
    'provider', 'servicenow', 'externalCustomerKey', 'servicenow-unmapped:' || repeat('1', 32),
    'externalCustomerId', repeat('1', 32), 'externalCustomerName', 'ServiceNow Company',
    'targetCustomerKey', 'customer-a', 'actorUserId', 'admin-user',
    'requestId', 'request-idempotent', 'correlationId', 'correlation-idempotent',
    'mappingId', 'unused-mapping-id-000000', 'eventId', 'unused-event-id-00000000',
    'appliedAt', '2026-07-20T03:30:00.000Z'
  ));
  if v_mapping_result.action <> 'unchanged' or v_mapping_result.affected_ticket_count <> 0
    or (select count(*) from public.integration_customer_mapping_events where mapping_id = 'mapping-id-000000000001') <> 1 then
    raise exception 'Identical mapping operation was not idempotent';
  end if;

  select * into v_result from public.support_upsert_servicenow_incident_with_mapping(
    v_payload || jsonb_build_object(
      'linkId', 'mapping-link-000000000002', 'externalSysId', repeat('7', 32),
      'externalNumber', 'INC0040004', 'sourceHash', repeat('6', 64),
      'ticket', (v_payload->'ticket') || jsonb_build_object(
        'id', 'future-mapped-ticket', 'issueId', 'INC0040004',
        'serviceNow', (v_payload#>'{ticket,serviceNow}') || jsonb_build_object(
          'externalSysId', repeat('7', 32), 'externalNumber', 'INC0040004', 'sourceHash', repeat('6', 64)
        )
      )
    ) || jsonb_build_object('dryRun', false)
  );
  if v_result.outcome <> 'created'
    or (select customer_key from public.support_tickets where id = 'future-mapped-ticket') <> 'customer-a'
    or (select data->>'requiresCustomerMapping' from public.support_tickets where id = 'future-mapped-ticket') <> 'false' then
    raise exception 'Future Incident did not apply its active mapping';
  end if;

  select * into v_mapping_result from public.support_apply_integration_customer_mapping(jsonb_build_object(
    'provider', 'servicenow', 'externalCustomerKey', 'servicenow-unmapped:' || repeat('1', 32),
    'externalCustomerId', repeat('1', 32), 'externalCustomerName', 'ServiceNow Company renamed',
    'targetCustomerKey', 'customer-b', 'actorUserId', 'admin-user',
    'requestId', 'request-00000002', 'correlationId', 'correlation-0002',
    'mappingId', 'unused-mapping-id-000001', 'eventId', 'mapping-event-000000002',
    'appliedAt', '2026-07-20T04:00:00.000Z'
  ));
  if v_mapping_result.action <> 'changed' or (select customer_key from public.support_tickets where id = 'mapping-ticket-id') <> 'customer-b' then
    raise exception 'Mapping change failed';
  end if;

  select * into v_mapping_result from public.support_deactivate_integration_customer_mapping(jsonb_build_object(
    'mappingId', 'mapping-id-000000000001', 'actorUserId', 'admin-user',
    'requestId', 'request-00000003', 'correlationId', 'correlation-0003',
    'eventId', 'mapping-event-000000003', 'appliedAt', '2026-07-20T05:00:00.000Z'
  ));
  if v_mapping_result.active or not exists (select 1 from public.integration_customer_mappings where id = 'mapping-id-000000000001' and not active) then
    raise exception 'Mapping deactivation failed';
  end if;
  if (select customer_key from public.support_tickets where id = 'mapping-ticket-id') <> 'customer-b' then
    raise exception 'Deactivation changed an existing ticket';
  end if;

  select * into v_result from public.support_upsert_servicenow_incident_with_mapping(
    v_payload || jsonb_build_object(
      'linkId', 'mapping-link-000000000003', 'externalSysId', repeat('5', 32),
      'externalNumber', 'INC0050005', 'sourceHash', repeat('4', 64),
      'ticket', (v_payload->'ticket') || jsonb_build_object(
        'id', 'future-unmapped-ticket', 'issueId', 'INC0050005',
        'serviceNow', (v_payload#>'{ticket,serviceNow}') || jsonb_build_object(
          'externalSysId', repeat('5', 32), 'externalNumber', 'INC0050005', 'sourceHash', repeat('4', 64)
        )
      )
    ) || jsonb_build_object('dryRun', false)
  );
  if v_result.outcome <> 'created'
    or (select customer_key from public.support_tickets where id = 'future-unmapped-ticket') <> 'servicenow-unmapped:' || repeat('1', 32) then
    raise exception 'Inactive mapping was used for a future Incident';
  end if;

  begin
    perform * from public.support_apply_integration_customer_mapping(jsonb_build_object(
      'provider', 'servicenow', 'externalCustomerKey', 'servicenow-unmapped:unknown',
      'externalCustomerId', '', 'externalCustomerName', 'Unknown', 'targetCustomerKey', 'customer-a',
      'actorUserId', 'admin-user', 'requestId', 'request-00000004', 'correlationId', 'correlation-0004',
      'mappingId', 'unknown-mapping-id-00001', 'eventId', 'mapping-event-000000004',
      'appliedAt', '2026-07-20T06:00:00.000Z'
    ));
    raise exception 'Unknown ServiceNow customer mapping was accepted';
  exception when sqlstate '22023' then
    if sqlerrm <> 'SERVICENOW_UNKNOWN_CUSTOMER_NOT_MAPPABLE' then raise; end if;
  end;
end;
$$;

insert into public.integration_sync_runs (
  id, provider, stream, mode, trigger_type, status, dry_run, started_at, window_start_at, window_end_at
) values (
  'sql-run-1', 'servicenow', 'incident', 'incremental', 'manual', 'running', false,
  now(), '2026-07-20T03:00:00.000Z', now()
);

select public.support_acquire_integration_sync_lock(
  'servicenow', 'incident', 'sql-lock-token-00000001', 300, now()
);

select public.support_complete_integration_sync_run(
  'sql-run-1', 'sql-lock-token-00000001', '2026-07-20T03:00:00.000Z', now(),
  jsonb_build_object(
    'fetched', 1, 'created', 0, 'updated', 0, 'unchanged', 1, 'stale', 0,
    'skipped', 0, 'failed', 0, 'pages', 1, 'durationMs', 1000,
    'watermarkSysId', repeat('a', 32),
    'windowStart', '2026-07-20T03:00:00.000Z', 'windowEnd', '2026-07-20T04:00:00.000Z'
  )
);

do $$
begin
  if not exists (
    select 1 from public.integration_sync_state
    where provider = 'servicenow' and stream = 'incident'
      and watermark_at = '2026-07-20T03:00:00.000Z'::timestamptz
      and watermark_sys_id = repeat('a', 32)
  ) then raise exception 'Composite watermark was not persisted'; end if;
  if not exists (select 1 from public.integration_sync_runs where id = 'sql-run-1' and status = 'succeeded') then
    raise exception 'Successful run was not completed';
  end if;
end;
$$;
`;

try {
  run("initdb", ["-A", "trust", "-U", "postgres", "-D", dataDirectory, "--no-locale"]);
  mkdirSync(socketDirectory, { recursive: true });
  run("pg_ctl", ["-D", dataDirectory, "-l", logPath, "-o", `-F -k ${socketDirectory} -p ${port}`, "-w", "start"]);
  started = true;
  psql([], baseSchema);
  psql(["-f", path.join(root, "supabase/migrations/202607200001_servicenow_incremental_sync.sql")]);
  psql(["-f", path.join(root, "supabase/migrations/202607200002_servicenow_sync_reliability_corrections.sql")]);
  psql(["-f", path.join(root, "supabase/migrations/202607200002_servicenow_sync_reliability_corrections.sql")]);
  psql(["-f", path.join(root, "supabase/migrations/202607210001_servicenow_customer_mapping_operations.sql")]);
  psql(["-f", path.join(root, "supabase/migrations/202607210001_servicenow_customer_mapping_operations.sql")]);
  psql([], acceptanceSql);
  const versions = psql(["-Atc", "select version from public.support_schema_migrations order by version"]);
  if (versions !== "202607200001\n202607200002\n202607210001") throw new Error(`Unexpected migration versions: ${versions}`);
  console.log("ServiceNow migrations executed twice safely; synchronization, mapping, preservation, idempotency, future sync, remapping, and deactivation SQL checks passed.");
} finally {
  if (started) spawnSync("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"], { encoding: "utf8" });
  for (const target of [dataDirectory, socketDirectory, logPath]) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
}
