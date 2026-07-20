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
`;

const acceptanceSql = String.raw`
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
      'serviceNow', jsonb_build_object('externalSysId', repeat('a', 32), 'externalUpdatedAt', '2026-07-20T02:00:00.000Z')
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
  psql([], acceptanceSql);
  const versions = psql(["-Atc", "select version from public.support_schema_migrations order by version"]);
  if (versions !== "202607200001\n202607200002") throw new Error(`Unexpected migration versions: ${versions}`);
  console.log("ServiceNow migrations executed twice safely where applicable; reconciliation and composite cursor SQL checks passed.");
} finally {
  if (started) spawnSync("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"], { encoding: "utf8" });
  for (const target of [dataDirectory, socketDirectory, logPath]) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
}
