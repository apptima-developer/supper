import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const suffix = `${process.pid}`;
const dataDirectory = `/tmp/supper-write-pg-data-${suffix}`;
const socketDirectory = `/tmp/supper-write-pg-socket-${suffix}`;
const logPath = `/tmp/supper-write-pg-${suffix}.log`;
const port = String(56_000 + (process.pid % 1_000));
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
create extension if not exists pgcrypto;

create table public.support_schema_migrations (
  version text primary key,
  description text not null,
  checksum text,
  applied_by text,
  applied_at timestamptz not null default now()
);

create table public.support_tickets (id text primary key);
create table public.intake_conversations (id text primary key);

create or replace function public.support_intake_json_has_unsafe_key(p_value jsonb)
returns boolean language sql immutable as $$ select false; $$;

create or replace function public.support_intake_sha256_hex(p_value text)
returns text language sql immutable as $$
  select encode(digest(p_value, 'sha256'), 'hex')
$$;
`;

const acceptanceSql = String.raw`
insert into public.servicenow_write_connections (
  id, name, active, auth_mode, instance_url, incident_table, timeout_ms, metadata
) values (
  'connection-test-00000001', 'Test PDI', true, 'basic',
  'https://example.service-now.com', 'incident', 15000, '{"source":"sql-test"}'::jsonb
);

do $$
declare
  v_result record;
  v_attempt record;
  v_command_payload jsonb := jsonb_build_object(
    'commandId', 'command-test-0000000001',
    'commandType', 'create_incident',
    'idempotencyKey', repeat('a', 64),
    'normalizedPayloadHash', repeat('b', 64),
    'connectionId', 'connection-test-00000001',
    'mappingId', '',
    'sourceType', 'manual',
    'sourceReference', 'manual:sql-test',
    'targetTable', 'incident',
    'targetSysId', '',
    'targetNumber', '',
    'payload', jsonb_build_object('shortDescription', 'SQL test', 'description', 'Safe test body'),
    'normalizedPayload', jsonb_build_object(
      'commandType', 'create_incident',
      'fields', jsonb_build_object('short_description', 'SQL test', 'description', 'Safe test body')
    ),
    'validationSummary', jsonb_build_object('valid', true, 'mappedFieldCount', 2),
    'maxAttempts', 2,
    'createdBy', 'admin-user',
    'requestId', 'request-write-sql-0001',
    'correlationId', 'correlation-write-sql-0001',
    'createdAt', '2026-07-23T01:00:00.000Z'
  );
begin
  begin
    perform * from public.support_create_servicenow_write_command(
      v_command_payload || jsonb_build_object(
        'commandId', 'command-invalid-source-001',
        'idempotencyKey', repeat('e', 64),
        'sourceType', 'supper_ticket',
        'sourceReference', 'missing-ticket-id'
      )
    );
    raise exception 'Missing linked source was accepted';
  exception when foreign_key_violation then
    if sqlerrm <> 'SERVICENOW_WRITE_SOURCE_NOT_FOUND' then raise; end if;
  end;
  if exists (
    select 1 from public.servicenow_write_commands
    where id = 'command-invalid-source-001'
  ) then raise exception 'Rejected linked source created a command'; end if;

  select * into v_result from public.support_create_servicenow_write_command(v_command_payload);
  if v_result.action <> 'created' or v_result.command_status <> 'validated' then
    raise exception 'Initial command creation failed';
  end if;

  select * into v_result from public.support_create_servicenow_write_command(
    jsonb_set(v_command_payload, '{commandId}', '"command-test-0000000002"'::jsonb)
  );
  if v_result.action <> 'unchanged' or v_result.command_id <> 'command-test-0000000001' then
    raise exception 'Identical command did not deduplicate';
  end if;

  begin
    perform * from public.support_create_servicenow_write_command(
      jsonb_set(
        jsonb_set(v_command_payload, '{commandId}', '"command-test-0000000003"'::jsonb),
        '{normalizedPayloadHash}', to_jsonb(repeat('c', 64))
      )
    );
    raise exception 'Changed idempotency material was accepted';
  exception when unique_violation then
    if sqlerrm <> 'SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT' then raise; end if;
  end;

  select * into v_attempt from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId', 'command-test-0000000001',
    'attemptId', 'attempt-dry-000000000001',
    'executionMode', 'dry_run',
    'retry', false,
    'requestId', 'request-write-sql-0002',
    'startedAt', '2026-07-23T01:01:00.000Z'
  ));
  if v_attempt.attempt_number <> 1 or v_attempt.live_attempt_count <> 0 then
    raise exception 'Dry-run consumed live attempt budget';
  end if;

  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId', 'command-test-0000000001',
    'attemptId', 'attempt-dry-000000000001',
    'outcome', 'dry_run',
    'retryable', false,
    'requestSummary', jsonb_build_object('method', 'POST', 'fieldNames', jsonb_build_array('description', 'short_description')),
    'responseSummary', jsonb_build_object('validated', true, 'providerWritePerformed', false),
    'targetSysId', '',
    'targetNumber', '',
    'errorCode', '',
    'errorMessage', '',
    'finishedAt', '2026-07-23T01:01:01.000Z'
  ));
  if (select status from public.servicenow_write_commands where id = 'command-test-0000000001') <> 'dry_run_ready' then
    raise exception 'Dry-run did not reach dry_run_ready';
  end if;

  select * into v_attempt from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId', 'command-test-0000000001',
    'attemptId', 'attempt-live-00000000001',
    'executionMode', 'live',
    'retry', false,
    'requestId', 'request-write-sql-0003',
    'startedAt', '2026-07-23T01:02:00.000Z'
  ));
  if v_attempt.attempt_number <> 2 or v_attempt.live_attempt_count <> 1 then
    raise exception 'Live attempt count was not bounded';
  end if;

  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId', 'command-test-0000000001',
    'attemptId', 'attempt-live-00000000001',
    'outcome', 'failed',
    'retryable', true,
    'requestSummary', jsonb_build_object('method', 'POST'),
    'responseSummary', '{}'::jsonb,
    'targetSysId', '',
    'targetNumber', '',
    'errorCode', 'SERVICENOW_WRITE_TIMEOUT',
    'errorMessage', 'ServiceNow write timed out',
    'nextRetryAt', '2026-07-23T01:03:00.000Z',
    'finishedAt', '2026-07-23T01:02:01.000Z'
  ));
  if not exists (
    select 1 from public.servicenow_write_commands
    where id = 'command-test-0000000001' and status = 'retry_scheduled'
      and attempt_count = 1 and next_retry_at is not null
  ) then raise exception 'Retry was not scheduled safely'; end if;

  select * into v_attempt from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId', 'command-test-0000000001',
    'attemptId', 'attempt-retry-0000000001',
    'executionMode', 'retry',
    'retry', true,
    'requestId', 'request-write-sql-0004',
    'startedAt', '2026-07-23T01:03:00.000Z'
  ));
  if v_attempt.live_attempt_count <> 2 then raise exception 'Retry budget did not advance'; end if;

  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId', 'command-test-0000000001',
    'attemptId', 'attempt-retry-0000000001',
    'outcome', 'succeeded',
    'retryable', false,
    'requestSummary', jsonb_build_object('method', 'POST'),
    'responseSummary', jsonb_build_object('httpStatus', 201, 'number', 'INC0001001', 'sysId', repeat('d', 32)),
    'targetSysId', repeat('d', 32),
    'targetNumber', 'INC0001001',
    'errorCode', '',
    'errorMessage', '',
    'finishedAt', '2026-07-23T01:03:01.000Z'
  ));
  if not exists (
    select 1 from public.servicenow_write_commands
    where id = 'command-test-0000000001' and status = 'succeeded'
      and attempt_count = 2 and target_number = 'INC0001001'
  ) then raise exception 'Successful retry was not finalized'; end if;

  select * into v_result from public.support_create_servicenow_write_command(
    jsonb_set(v_command_payload, '{commandId}', '"command-test-0000000004"'::jsonb)
  );
  if v_result.action <> 'unchanged' or v_result.command_status <> 'succeeded' then
    raise exception 'Completed create command no longer deduplicates';
  end if;
end;
$$;

do $$
begin
  if has_table_privilege('anon', 'public.servicenow_write_commands', 'select')
    or has_table_privilege('authenticated', 'public.servicenow_write_commands', 'select') then
    raise exception 'Browser roles can read write commands';
  end if;
  if has_function_privilege('public', 'public.support_create_servicenow_write_command(jsonb)', 'execute')
    or has_function_privilege('anon', 'public.support_begin_servicenow_write_attempt(jsonb)', 'execute')
    or has_function_privilege('authenticated', 'public.support_finish_servicenow_write_attempt(jsonb)', 'execute') then
    raise exception 'Privileged write RPC is browser executable';
  end if;
  if not has_function_privilege('service_role', 'public.support_create_servicenow_write_command(jsonb)', 'execute')
    or not has_function_privilege('service_role', 'public.support_begin_servicenow_write_attempt(jsonb)', 'execute')
    or not has_function_privilege('service_role', 'public.support_finish_servicenow_write_attempt(jsonb)', 'execute') then
    raise exception 'service_role cannot execute write RPCs';
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
  const migration = path.join(root, "supabase/migrations/202607230001_servicenow_write_kernel.sql");
  psql(["-f", migration]);
  psql(["-f", migration]);
  psql([], acceptanceSql);
  const version = psql(["-Atc", "select version from public.support_schema_migrations where version = '202607230001'"]);
  if (version !== "202607230001") throw new Error(`Unexpected write migration version: ${version}`);
  console.log("ServiceNow write migration executed twice safely; linked-source validation, idempotency, dry-run isolation, bounded retries, atomic attempts, and browser-role denial checks passed.");
} finally {
  if (started) spawnSync("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"], { encoding: "utf8" });
  for (const target of [dataDirectory, socketDirectory, logPath]) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
}
