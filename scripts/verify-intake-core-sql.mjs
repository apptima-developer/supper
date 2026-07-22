import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const suffix = `${process.pid}`;
const dataDirectory = `/tmp/supper-intake-pg-data-${suffix}`;
const socketDirectory = `/tmp/supper-intake-pg-socket-${suffix}`;
const logPath = `/tmp/supper-intake-pg-${suffix}.log`;
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

create table public.support_users (
  id text primary key, username text not null, data jsonb not null default '{}'::jsonb
);
create table public.support_tickets (
  id text primary key, issue_id text not null unique, customer_key text not null, customer_name text not null,
  kanban_status text not null, status text not null, issue_type text not null, severity text not null,
  ticket_date date, start_date date, due_date date, close_date date, data jsonb not null, updated_at timestamptz not null
);
create table public.support_customers (
  id text primary key, customer_key text not null unique, customer_name text not null, project_code text not null default '',
  active boolean not null default true, end_period date, data jsonb not null default '{}'::jsonb, updated_at timestamptz not null default now()
);
`;

const acceptanceSql = String.raw`
insert into public.support_customers (id, customer_key, customer_name, project_code, active, data) values
  ('customer-a', 'customer-a', 'Customer A', 'A-001', true, '{"key":"customer-a"}'),
  ('customer-b', 'customer-b', 'Customer B', 'B-001', true, '{"key":"customer-b"}'),
  ('customer-inactive', 'customer-inactive', 'Inactive', 'I-001', false, '{"key":"customer-inactive"}');

insert into public.integration_channels (id, provider, channel_key, display_name, environment, enabled, configuration_status)
values ('channel-one', 'internal', 'sql-diagnostic-one', 'SQL diagnostic one', 'development', true, 'configured'),
       ('channel-two', 'internal', 'sql-diagnostic-two', 'SQL diagnostic two', 'development', true, 'configured');

do $$
declare
  v_payload jsonb := jsonb_build_object(
    'channel', jsonb_build_object('id', 'channel-one', 'provider', 'internal', 'channelKey', 'sql-diagnostic-one'),
    'event', jsonb_build_object('id', 'event-one', 'externalEventId', 'external-event-one', 'eventType', 'message.received',
      'payloadHash', repeat('a', 64), 'correlationId', 'request-sql-intake-0001', 'requestId', 'request-sql-intake-0001',
      'receivedAt', '2026-07-22T00:00:00.000Z', 'metadata', jsonb_build_object('safe', true)),
    'identity', jsonb_build_object('id', 'identity-one', 'externalSubjectId', 'external-subject-one',
      'externalSubjectHash', encode(digest('external-subject-one', 'sha256'), 'hex'), 'displayName', 'SQL identity',
      'identityType', 'system', 'metadata', '{}'::jsonb),
    'conversation', jsonb_build_object('id', 'conversation-one', 'externalConversationId', 'external-conversation-one',
      'subject', 'SQL intake diagnostic', 'openedAt', '2026-07-22T00:00:00.000Z',
      'lastActivityAt', '2026-07-22T00:00:00.000Z', 'metadata', '{}'::jsonb),
    'message', jsonb_build_object('id', 'message-one', 'externalMessageId', 'external-message-one', 'direction', 'internal',
      'messageType', 'text', 'status', 'stored', 'bodyText', 'Internal diagnostic text', 'bodyHtml', '<b>opaque</b>',
      'structuredContent', '{}'::jsonb, 'contentHash', repeat('b', 64), 'receivedAt', '2026-07-22T00:00:00.000Z',
      'storedAt', '2026-07-22T00:00:00.000Z', 'metadata', '{}'::jsonb),
    'attachments', jsonb_build_array(jsonb_build_object('id', 'attachment-one', 'externalAttachmentId', 'external-attachment-one',
      'fileName', 'metadata.txt', 'contentType', 'text/plain', 'declaredSize', 128, 'storageStatus', 'declared',
      'scanStatus', 'not_scanned', 'metadata', '{}'::jsonb)),
    'initializeSession', jsonb_build_object('id', 'session-one', 'status', 'collecting', 'stateData', jsonb_build_object('requestType', 'diagnostic'),
      'missingFields', jsonb_build_array('description'), 'startedAt', '2026-07-22T00:00:00.000Z')
  );
  v_first record; v_replay record; v_other record; v_ticket_count integer;
begin
  select * into v_first from public.support_accept_intake_event(v_payload);
  select * into v_replay from public.support_accept_intake_event(v_payload);
  if v_first.action <> 'accepted' or v_replay.action <> 'duplicate' or v_replay.delivery_count <> 2 then raise exception 'Event replay result failed'; end if;
  if (select count(*) from public.intake_events where channel_id = 'channel-one') <> 1
    or (select count(*) from public.integration_external_identities where channel_id = 'channel-one') <> 1
    or (select count(*) from public.intake_conversations where channel_id = 'channel-one') <> 1
    or (select count(*) from public.intake_messages where channel_id = 'channel-one') <> 1
    or (select count(*) from public.intake_attachments where channel_id = 'channel-one') <> 1
    or (select count(*) from public.intake_sessions where conversation_id = 'conversation-one') <> 1 then
    raise exception 'Replay duplicated normalized records';
  end if;
  begin
    perform * from public.support_accept_intake_event(jsonb_set(v_payload, '{event,payloadHash}', to_jsonb(repeat('c', 64))));
    raise exception 'Event replay mismatch accepted';
  exception when unique_violation then if sqlerrm <> 'INTAKE_EVENT_REPLAY_MISMATCH' then raise; end if; end;
  begin
    perform * from public.support_accept_intake_event(
      jsonb_set(jsonb_set(jsonb_set(v_payload, '{event,id}', '"event-message-mismatch"'), '{event,externalEventId}', '"external-event-message-mismatch"'), '{message,contentHash}', to_jsonb(repeat('d', 64)))
    );
    raise exception 'Message replay mismatch accepted';
  exception when unique_violation then if sqlerrm <> 'INTAKE_MESSAGE_REPLAY_MISMATCH' then raise; end if; end;
  if exists (select 1 from public.intake_events where id = 'event-message-mismatch') then raise exception 'Rejected message replay left an event row'; end if;

  select * into v_other from public.support_accept_intake_event(
    jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(v_payload,
      '{channel,id}', '"channel-two"'), '{channel,channelKey}', '"sql-diagnostic-two"'), '{event,id}', '"event-two"'),
      '{identity,id}', '"identity-two"'), '{conversation,id}', '"conversation-two"'), '{message,id}', '"message-two"'),
      '{initializeSession,id}', '"session-two"'), '{attachments,0,id}', '"attachment-two"'),
      '{attachments,0,externalAttachmentId}', '"external-attachment-two"')
  );
  if v_other.action <> 'accepted' or (select count(*) from public.intake_events where external_event_id = 'external-event-one') <> 2 then raise exception 'Channel-scoped event identity collided'; end if;

  select count(*) into v_ticket_count from public.support_tickets;
  perform * from public.support_transition_intake_session(jsonb_build_object('sessionId', 'session-one', 'expectedVersion', 1,
    'targetStatus', 'awaiting_confirmation', 'statePatch', jsonb_build_object('description', 'Ready'), 'missingFields', '[]'::jsonb,
    'actorUserId', 'admin', 'requestId', 'request-session-1', 'correlationId', 'request-session-1', 'occurredAt', '2026-07-22T00:01:00.000Z'));
  begin
    perform * from public.support_transition_intake_session(jsonb_build_object('sessionId', 'session-one', 'expectedVersion', 1,
      'targetStatus', 'confirmed', 'statePatch', '{}'::jsonb, 'missingFields', '[]'::jsonb, 'actorUserId', 'admin',
      'correlationId', 'request-session-stale', 'occurredAt', '2026-07-22T00:02:00.000Z'));
    raise exception 'Stale session version accepted';
  exception when serialization_failure then if sqlerrm <> 'INTAKE_SESSION_VERSION_CONFLICT' then raise; end if; end;
  perform * from public.support_transition_intake_session(jsonb_build_object('sessionId', 'session-one', 'expectedVersion', 2,
    'targetStatus', 'confirmed', 'statePatch', '{}'::jsonb, 'missingFields', '[]'::jsonb, 'actorUserId', 'admin',
    'correlationId', 'request-session-confirm', 'occurredAt', '2026-07-22T00:03:00.000Z'));
  if (select count(*) from public.support_tickets) <> v_ticket_count or (select version from public.intake_sessions where id = 'session-one') <> 3 then raise exception 'Session confirmation created a Ticket or wrong version'; end if;
end;
$$;

do $$
declare v_binding record; v_repeat record; v_revoked record; v_again record;
begin
  select * into v_binding from public.support_apply_intake_identity_binding(jsonb_build_object(
    'bindingId', 'binding-one', 'eventId', 'binding-event-one', 'identityId', 'identity-one', 'customerKey', 'customer-a',
    'projectCode', 'A-001', 'allowedSystems', jsonb_build_array('system-a'), 'targetReferences', '{}'::jsonb,
    'actorUserId', 'admin', 'requestId', 'request-binding-1', 'correlationId', 'request-binding-1',
    'appliedAt', '2026-07-22T00:04:00.000Z', 'metadata', '{}'::jsonb));
  select * into v_repeat from public.support_apply_intake_identity_binding(jsonb_build_object(
    'bindingId', 'unused-binding', 'eventId', 'unused-binding-event', 'identityId', 'identity-one', 'customerKey', 'customer-a',
    'projectCode', 'A-001', 'allowedSystems', jsonb_build_array('system-a'), 'targetReferences', '{}'::jsonb,
    'actorUserId', 'admin', 'correlationId', 'request-binding-2', 'appliedAt', '2026-07-22T00:05:00.000Z', 'metadata', '{}'::jsonb));
  if v_binding.action <> 'created' or v_repeat.action <> 'unchanged' or (select count(*) from public.integration_identity_binding_events where identity_id = 'identity-one') <> 1 then raise exception 'Identity binding idempotency failed'; end if;
  begin
    perform * from public.support_apply_intake_identity_binding(jsonb_build_object('bindingId', 'bad-binding', 'eventId', 'bad-event',
      'identityId', 'identity-two', 'customerKey', 'customer-inactive', 'projectCode', 'I-001', 'allowedSystems', '[]'::jsonb,
      'targetReferences', '{}'::jsonb, 'actorUserId', 'admin', 'correlationId', 'request-bad', 'appliedAt', '2026-07-22T00:05:00.000Z'));
    raise exception 'Inactive customer binding accepted';
  exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_IDENTITY_BINDING_INVALID' then raise; end if; end;
  select * into v_revoked from public.support_revoke_intake_identity_binding(jsonb_build_object('identityId', 'identity-one',
    'actorUserId', 'admin', 'eventId', 'binding-event-revoke', 'correlationId', 'request-revoke-1', 'appliedAt', '2026-07-22T00:06:00.000Z', 'metadata', '{}'::jsonb));
  select * into v_again from public.support_revoke_intake_identity_binding(jsonb_build_object('identityId', 'identity-one',
    'actorUserId', 'admin', 'eventId', 'unused-revoke-event', 'correlationId', 'request-revoke-2', 'appliedAt', '2026-07-22T00:07:00.000Z', 'metadata', '{}'::jsonb));
  if v_revoked.action <> 'revoked' or v_again.action <> 'unchanged'
    or (select count(*) from public.integration_identity_binding_events where identity_id = 'identity-one' and action = 'revoked') <> 1 then raise exception 'Repeated revoke was not idempotent'; end if;
end;
$$;

do $$
declare v_created record; v_same record;
begin
  select * into v_created from public.support_enqueue_integration_outbox(jsonb_build_object('id', 'outbox-one', 'targetProvider', 'internal',
    'commandType', 'notification.send', 'idempotencyKey', 'outbox-key-one', 'payload', jsonb_build_object('kind', 'diagnostic'),
    'availableAt', '2026-07-22T00:08:00.000Z', 'maxAttempts', 5, 'correlationId', 'request-outbox-1', 'metadata', '{}'::jsonb));
  select * into v_same from public.support_enqueue_integration_outbox(jsonb_build_object('id', 'unused-outbox', 'targetProvider', 'internal',
    'commandType', 'notification.send', 'idempotencyKey', 'outbox-key-one', 'payload', jsonb_build_object('kind', 'diagnostic'),
    'availableAt', '2026-07-22T00:08:00.000Z', 'maxAttempts', 5, 'correlationId', 'request-outbox-2', 'metadata', '{}'::jsonb));
  if v_created.action <> 'created' or v_same.action <> 'unchanged' or v_created.status <> 'pending' or v_created.attempt_count <> 0 then raise exception 'Outbox idempotency failed'; end if;
  begin
    perform * from public.support_enqueue_integration_outbox(jsonb_build_object('id', 'conflict-outbox', 'targetProvider', 'internal',
      'commandType', 'notification.send', 'idempotencyKey', 'outbox-key-one', 'payload', jsonb_build_object('kind', 'changed'),
      'availableAt', '2026-07-22T00:08:00.000Z', 'maxAttempts', 5, 'correlationId', 'request-outbox-3', 'metadata', '{}'::jsonb));
    raise exception 'Conflicting outbox command accepted';
  exception when unique_violation then if sqlerrm <> 'INTEGRATION_OUTBOX_IDEMPOTENCY_CONFLICT' then raise; end if; end;
  if exists (select 1 from public.integration_outbox where status <> 'pending' or attempt_count <> 0) then raise exception 'Outbox command was executed'; end if;
end;
$$;
`;

try {
  run("initdb", ["-A", "trust", "-U", "postgres", "-D", dataDirectory, "--no-locale"]);
  mkdirSync(socketDirectory, { recursive: true });
  run("pg_ctl", ["-D", dataDirectory, "-l", logPath, "-o", `-F -k ${socketDirectory} -p ${port}`, "-w", "start"]);
  started = true;
  psql([], baseSchema);
  const migrationDirectory = path.join(root, "supabase/migrations");
  const migrations = readdirSync(migrationDirectory).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const migration of migrations) psql(["-f", path.join(migrationDirectory, migration)]);
  psql(["-f", path.join(migrationDirectory, "202607220001_unified_intake_core.sql")]);
  psql([], acceptanceSql);

  const expectedTables = ["integration_channels", "integration_external_identities", "integration_identity_bindings", "integration_identity_binding_events", "intake_conversations", "intake_messages", "intake_attachments", "intake_sessions", "intake_events", "intake_ticket_links", "integration_outbox"];
  const tables = psql(["-Atc", `select tablename from pg_tables where schemaname='public' and tablename in (${expectedTables.map((name) => `'${name}'`).join(",")}) order by tablename`]).split("\n").filter(Boolean);
  if (tables.length !== expectedTables.length) throw new Error(`Missing intake tables: ${expectedTables.filter((name) => !tables.includes(name)).join(", ")}`);
  const rlsCount = Number(psql(["-Atc", `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (${expectedTables.map((name) => `'${name}'`).join(",")}) and c.relrowsecurity`]));
  if (rlsCount !== expectedTables.length) throw new Error("RLS is not enabled on every intake table");
  const functions = ["support_get_intake_operations_summary", "support_accept_intake_event", "support_apply_intake_identity_binding", "support_revoke_intake_identity_binding", "support_transition_intake_session", "support_enqueue_integration_outbox"];
  const unsafe = Number(psql(["-Atc", `select count(*) from information_schema.routine_privileges where routine_schema='public' and routine_name in (${functions.map((name) => `'${name}'`).join(",")}) and grantee in ('PUBLIC','anon','authenticated') and privilege_type='EXECUTE'`]));
  if (unsafe !== 0) throw new Error("A privileged intake RPC is executable by a browser role");
  const serviceGrants = Number(psql(["-Atc", `select count(distinct routine_name) from information_schema.routine_privileges where routine_schema='public' and routine_name in (${functions.map((name) => `'${name}'`).join(",")}) and grantee='service_role' and privilege_type='EXECUTE'`]));
  if (serviceGrants !== functions.length) throw new Error("service_role is missing an intake RPC grant");
  const version = psql(["-Atc", "select version from public.support_schema_migrations where version='202607220001'"]);
  if (version !== "202607220001") throw new Error("Intake migration version was not recorded");
  const sensitiveHistory = Number(psql(["-Atc", "select count(*) from public.integration_identity_binding_events where metadata::text ~* '(external-subject-one|Internal diagnostic text|<b>)'"]));
  if (sensitiveHistory !== 0) throw new Error("Sensitive intake content leaked into binding history");
  console.log("Unified intake migration applied twice safely; RLS/grants, replay isolation, binding history, session CAS, metadata-only attachments, and intent-only outbox checks passed.");
} finally {
  if (started) spawnSync("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"], { encoding: "utf8" });
  for (const target of [dataDirectory, socketDirectory, logPath]) if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}
