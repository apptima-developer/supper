import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
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

function psqlAsync(input) {
  return new Promise((resolve, reject) => {
    const child = spawn("psql", ["-X", "-v", "ON_ERROR_STOP=1", "-h", socketDirectory, "-p", port, "-U", "postgres", "-d", "postgres"], { cwd: root, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(`psql failed:\n${stderr || stdout}`)));
    child.stdin.end(input);
  });
}

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

const baseSchema = String.raw`
create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table public.support_users (id text primary key, username text not null, data jsonb not null default '{}'::jsonb);
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
  ('customer-inactive', 'customer-inactive', 'Inactive', 'I-001', false, '{"key":"customer-inactive"}');
insert into public.integration_channels (id, provider, channel_key, display_name, environment, enabled, configuration_status)
values ('channel-one', 'internal', 'sql-diagnostic-one', 'SQL diagnostic one', 'development', true, 'configured'),
       ('channel-two', 'internal', 'sql-diagnostic-two', 'SQL diagnostic two', 'development', true, 'configured');

create or replace function public.supper_test_intake_rehash(p_payload jsonb) returns jsonb language plpgsql as $$
declare v_result jsonb := p_payload;
begin
  v_result := jsonb_set(v_result, '{identity,externalSubjectHash}', to_jsonb(encode(digest(v_result#>>'{identity,externalSubjectId}', 'sha256'), 'hex')));
  v_result := jsonb_set(v_result, '{message,contentHash}', to_jsonb(encode(digest(public.support_intake_canonical_json(public.support_intake_message_material(v_result)), 'sha256'), 'hex')));
  v_result := jsonb_set(v_result, '{event,payloadHash}', to_jsonb(encode(digest(public.support_intake_canonical_json(public.support_intake_event_material(v_result)), 'sha256'), 'hex')));
  return v_result;
end;
$$;

create or replace function public.supper_test_intake_payload(
  p_suffix text, p_external_event text, p_external_conversation text,
  p_external_subject text, p_external_message text, p_external_attachment text,
  p_channel text default 'channel-one', p_channel_key text default 'sql-diagnostic-one'
) returns jsonb language plpgsql as $$
declare v_value jsonb;
begin
  v_value := jsonb_build_object(
    'channel', jsonb_build_object('id', p_channel, 'provider', 'internal', 'channelKey', p_channel_key),
    'event', jsonb_build_object('id', 'event-' || p_suffix, 'externalEventId', p_external_event, 'eventType', 'message.received',
      'correlationId', 'request-sql-intake-' || p_suffix, 'requestId', 'request-sql-intake-' || p_suffix,
      'receivedAt', '2026-07-22T00:00:00.000Z', 'metadata', jsonb_build_object('source', 'sql-verifier')),
    'identity', jsonb_build_object('id', 'identity-' || p_suffix, 'externalSubjectId', p_external_subject,
      'displayName', 'SQL identity', 'identityType', 'system', 'metadata', '{}'::jsonb),
    'conversation', jsonb_build_object('id', 'conversation-' || p_suffix, 'externalConversationId', p_external_conversation,
      'subject', 'SQL intake diagnostic', 'openedAt', '2026-07-22T00:00:00.000Z',
      'lastActivityAt', '2026-07-22T00:00:00.000Z', 'metadata', '{}'::jsonb),
    'message', jsonb_build_object('id', 'message-' || p_suffix, 'externalMessageId', p_external_message,
      'direction', 'internal', 'messageType', 'text', 'status', 'stored', 'bodyText', 'Internal diagnostic text',
      'bodyHtml', '<b>opaque</b>', 'structuredContent', '{}'::jsonb, 'receivedAt', '2026-07-22T00:00:00.000Z',
      'storedAt', '2026-07-22T00:00:00.000Z', 'metadata', '{}'::jsonb),
    'attachments', jsonb_build_array(jsonb_build_object('id', 'attachment-' || p_suffix,
      'externalAttachmentId', p_external_attachment, 'fileName', 'metadata.txt', 'contentType', 'text/plain',
      'declaredSize', 128, 'storageStatus', 'declared', 'scanStatus', 'not_scanned',
      'metadata', jsonb_build_object('ordinal', 0))),
    'initializeSession', jsonb_build_object('id', 'session-' || p_suffix, 'status', 'collecting',
      'stateData', jsonb_build_object('requestType', 'diagnostic'), 'missingFields', jsonb_build_array('description'),
      'startedAt', '2026-07-22T00:00:00.000Z', 'metadata', jsonb_build_object('source', 'sql-verifier'))
  );
  return public.supper_test_intake_rehash(v_value);
end;
$$;

do $$
declare
  v_payload jsonb := public.supper_test_intake_payload('one','external-event-one','external-conversation-one','external-subject-one','external-message-one','external-attachment-one');
  v_changed jsonb; v_first record; v_replay record; v_duplicate_message record; v_key text;
begin
  select * into v_first from public.support_accept_intake_event(v_payload);
  select * into v_replay from public.support_accept_intake_event(jsonb_set(v_payload, '{event,receivedAt}', '"2026-07-22T00:05:00.000Z"'));
  if v_first.action <> 'accepted' or v_replay.action <> 'duplicate' or v_replay.delivery_count <> 2 then raise exception 'Event replay result failed'; end if;
  if (select processing_status from public.intake_events where id = 'event-one') <> 'accepted'
    or (select duplicate_delivery_count from public.intake_events where id = 'event-one') <> 1 then raise exception 'Accepted Event status was overwritten by redelivery'; end if;
  if (select count(*) from public.intake_messages) <> 1 or (select count(*) from public.intake_attachments) <> 1 then raise exception 'Replay duplicated normalized records'; end if;

  v_changed := public.supper_test_intake_rehash(jsonb_set(v_payload, '{conversation,subject}', '"changed"'));
  begin perform * from public.support_accept_intake_event(v_changed); raise exception 'Event mismatch accepted';
  exception when unique_violation then if sqlerrm <> 'INTAKE_EVENT_REPLAY_MISMATCH' then raise; end if; end;

  v_changed := public.supper_test_intake_payload('message-exact','external-event-message-exact','external-conversation-one','external-subject-one','external-message-one','external-attachment-one');
  select * into v_duplicate_message from public.support_accept_intake_event(v_changed);
  if v_duplicate_message.action <> 'duplicate_message' or v_duplicate_message.conversation_id <> 'conversation-one'
    or v_duplicate_message.identity_id <> 'identity-one' then raise exception 'Exact Message replay did not reuse persisted identity'; end if;

  foreach v_key in array array['conversation','sender','direction','type','reply','structured','attachment'] loop
    v_changed := public.supper_test_intake_payload('mismatch-' || v_key, 'external-event-mismatch-' || v_key,
      case when v_key = 'conversation' then 'other-conversation' else 'external-conversation-one' end,
      case when v_key = 'sender' then 'other-subject' else 'external-subject-one' end,
      'external-message-one', 'external-attachment-one');
    if v_key = 'direction' then v_changed := jsonb_set(v_changed, '{message,direction}', '"inbound"'); end if;
    if v_key = 'type' then v_changed := jsonb_set(v_changed, '{message,messageType}', '"html"'); end if;
    if v_key = 'reply' then v_changed := jsonb_set(v_changed, '{message,replyToMessageId}', '"message-other"'); end if;
    if v_key = 'structured' then v_changed := jsonb_set(v_changed, '{message,structuredContent}', '{"kind":"changed"}'); end if;
    if v_key = 'attachment' then v_changed := jsonb_set(v_changed, '{attachments,0,declaredSize}', '129'); end if;
    v_changed := public.supper_test_intake_rehash(v_changed);
    begin perform * from public.support_accept_intake_event(v_changed); raise exception 'Message mismatch accepted: %', v_key;
    exception when unique_violation then if sqlerrm <> 'INTAKE_MESSAGE_REPLAY_MISMATCH' then raise; end if; end;
    if exists (select 1 from public.intake_events where id = 'event-mismatch-' || v_key) then raise exception 'Rejected replay left an Event row'; end if;
  end loop;

  v_changed := public.supper_test_intake_payload('attachment-conflict','external-event-attachment-conflict','new-conversation','external-subject-one','new-message','external-attachment-one');
  begin perform * from public.support_accept_intake_event(v_changed); raise exception 'Attachment mismatch accepted';
  exception when unique_violation then if sqlerrm <> 'INTAKE_ATTACHMENT_REPLAY_MISMATCH' then raise; end if; end;
  if exists (select 1 from public.intake_events where id = 'event-attachment-conflict') then raise exception 'Attachment conflict did not roll back'; end if;

  foreach v_key in array array['fileName','contentType','declaredSize','sha256'] loop
    v_changed := public.supper_test_intake_payload('attachment-' || lower(v_key), 'external-event-attachment-' || lower(v_key),
      'new-conversation-' || lower(v_key), 'external-subject-one', 'new-message-' || lower(v_key), 'external-attachment-one');
    if v_key = 'fileName' then v_changed := jsonb_set(v_changed, '{attachments,0,fileName}', '"other.txt"'); end if;
    if v_key = 'contentType' then v_changed := jsonb_set(v_changed, '{attachments,0,contentType}', '"application/pdf"'); end if;
    if v_key = 'declaredSize' then v_changed := jsonb_set(v_changed, '{attachments,0,declaredSize}', '129'); end if;
    if v_key = 'sha256' then v_changed := jsonb_set(v_changed, '{attachments,0,sha256}', to_jsonb(repeat('a',64))); end if;
    v_changed := public.supper_test_intake_rehash(v_changed);
    begin perform * from public.support_accept_intake_event(v_changed); raise exception 'Attachment material mismatch accepted: %', v_key;
    exception when unique_violation then if sqlerrm <> 'INTAKE_ATTACHMENT_REPLAY_MISMATCH' then raise; end if; end;
  end loop;

  foreach v_key in array array['clientSecret','channelAccessToken','serviceNowPassword','authorizationHeader','x-api-key','APIKey'] loop
    v_changed := public.supper_test_intake_payload('secret-' || replace(v_key,'-',''), 'external-event-secret-' || replace(v_key,'-',''),
      'conversation-secret-' || replace(v_key,'-',''), 'subject-secret-' || replace(v_key,'-',''),
      'message-secret-' || replace(v_key,'-',''), 'attachment-secret-' || replace(v_key,'-',''));
    v_changed := jsonb_set(v_changed, '{message,structuredContent}', jsonb_build_object(v_key, 'forbidden'));
    v_changed := public.supper_test_intake_rehash(v_changed);
    begin perform * from public.support_accept_intake_event(v_changed); raise exception 'Sensitive key accepted: %', v_key;
    exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_PAYLOAD_INVALID' then raise; end if; end;
  end loop;

  v_changed := public.supper_test_intake_rehash(jsonb_set(v_payload, '{event,receivedAt}', '"not-a-timestamp"'));
  begin perform * from public.support_accept_intake_event(v_changed); raise exception 'Malformed timestamp accepted';
  exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_PAYLOAD_INVALID' then raise; end if; end;
end;
$$;

do $$
declare v_created record; v_unchanged record; v_revoked record;
begin
  select * into v_created from public.support_apply_intake_identity_binding(jsonb_build_object(
    'bindingId','binding-one','eventId','binding-event-one','identityId','identity-one','customerKey','customer-a',
    'projectCode','A-001','allowedSystems',jsonb_build_array('servicenow'),'targetReferences',jsonb_build_object('servicenow','customer-a'),
    'actorUserId','admin','requestId','request-binding-one','correlationId','request-binding-one',
    'appliedAt','2026-07-22T00:00:30.000Z','metadata',jsonb_build_object('source','sql-verifier')));
  select * into v_unchanged from public.support_apply_intake_identity_binding(jsonb_build_object(
    'bindingId','unused-binding','eventId','unused-binding-event','identityId','identity-one','customerKey','customer-a',
    'projectCode','A-001','allowedSystems',jsonb_build_array('servicenow'),'targetReferences',jsonb_build_object('servicenow','customer-a'),
    'actorUserId','admin','correlationId','request-binding-repeat','appliedAt','2026-07-22T00:00:31.000Z','metadata',jsonb_build_object('source','sql-verifier')));
  select * into v_revoked from public.support_revoke_intake_identity_binding(jsonb_build_object(
    'eventId','binding-event-revoke','identityId','identity-one','actorUserId','admin','requestId','request-binding-revoke',
    'correlationId','request-binding-revoke','appliedAt','2026-07-22T00:00:32.000Z','metadata',jsonb_build_object('reason','verification')));
  if v_created.action <> 'created' or v_unchanged.action <> 'unchanged' or v_revoked.action <> 'revoked'
    or (select count(*) from public.integration_identity_binding_events where identity_id='identity-one') <> 2 then
    raise exception 'Identity binding regression';
  end if;
end;
$$;

do $$
declare v_closed record; v_reopened record; v_ticket_count integer; v_outbox_count integer;
begin
  select count(*) into v_ticket_count from public.support_tickets;
  select count(*) into v_outbox_count from public.integration_outbox;
  select * into v_closed from public.support_transition_intake_conversation(jsonb_build_object(
    'eventId','conversation-history-close','conversationId','conversation-one','expectedVersion',1,'targetStatus','closed',
    'explicitReopen',false,'actorUserId','admin','requestId','request-conversation-close','correlationId','request-conversation-close',
    'occurredAt','2026-07-22T00:01:00.000Z','metadata',jsonb_build_object('source','sql-verifier')));
  if v_closed.version <> 2 or (select count(*) from public.intake_conversation_events where conversation_id='conversation-one') <> 2 then raise exception 'Conversation history missing'; end if;
  begin perform * from public.support_transition_intake_conversation(jsonb_build_object(
    'eventId','conversation-stale','conversationId','conversation-one','expectedVersion',1,'targetStatus','archived','explicitReopen',false,
    'actorUserId','admin','correlationId','request-conversation-stale','occurredAt','2026-07-22T00:02:00.000Z','metadata','{}'::jsonb));
    raise exception 'Stale Conversation accepted'; exception when serialization_failure then if sqlerrm <> 'INTAKE_CONVERSATION_VERSION_CONFLICT' then raise; end if; end;
  begin perform * from public.support_transition_intake_conversation(jsonb_build_object(
    'eventId','conversation-no-reopen','conversationId','conversation-one','expectedVersion',2,'targetStatus','open','explicitReopen',false,
    'actorUserId','admin','correlationId','request-conversation-no-reopen','occurredAt','2026-07-22T00:03:00.000Z','metadata','{}'::jsonb));
    raise exception 'Implicit reopen accepted'; exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_CONVERSATION_TRANSITION_INVALID' then raise; end if; end;
  select * into v_reopened from public.support_transition_intake_conversation(jsonb_build_object(
    'eventId','conversation-reopen','conversationId','conversation-one','expectedVersion',2,'targetStatus','open','explicitReopen',true,
    'actorUserId','admin','correlationId','request-conversation-reopen','occurredAt','2026-07-22T00:04:00.000Z','metadata','{}'::jsonb));
  if v_reopened.version <> 3 or (select action from public.intake_conversation_events where id='conversation-reopen') <> 'reopened' then raise exception 'Explicit reopen history failed'; end if;

  perform * from public.support_transition_intake_session(jsonb_build_object('eventId','session-history-await','sessionId','session-one','expectedVersion',1,
    'targetStatus','awaiting_confirmation','statePatch',jsonb_build_object('description','Ready'),'missingFields','[]'::jsonb,
    'actorUserId','admin','requestId','request-session-await','correlationId','request-session-await','occurredAt','2026-07-22T00:05:00.000Z','metadata',jsonb_build_object('source','sql-verifier')));
  begin perform * from public.support_transition_intake_session(jsonb_build_object('eventId','session-stale','sessionId','session-one','expectedVersion',1,
    'targetStatus','confirmed','statePatch','{}'::jsonb,'missingFields','[]'::jsonb,'actorUserId','admin','correlationId','request-session-stale',
    'occurredAt','2026-07-22T00:06:00.000Z','metadata','{}'::jsonb)); raise exception 'Stale Session accepted';
    exception when serialization_failure then if sqlerrm <> 'INTAKE_SESSION_VERSION_CONFLICT' then raise; end if; end;
  perform * from public.support_transition_intake_session(jsonb_build_object('eventId','session-history-confirm','sessionId','session-one','expectedVersion',2,
    'targetStatus','confirmed','statePatch','{}'::jsonb,'missingFields','[]'::jsonb,'actorUserId','admin','requestId','request-session-confirm',
    'correlationId','request-session-confirm','occurredAt','2026-07-22T00:07:00.000Z','metadata','{}'::jsonb));
  if (select count(*) from public.intake_session_events where session_id='session-one') <> 3
    or (select actor_user_id from public.intake_session_events where id='session-history-confirm') <> 'admin'
    or (select count(*) from public.support_tickets) <> v_ticket_count
    or (select count(*) from public.integration_outbox) <> v_outbox_count then raise exception 'Session transition side effect or history failure'; end if;
end;
$$;

do $$
declare v_created record; v_same record;
begin
  select * into v_created from public.support_enqueue_integration_outbox(jsonb_build_object('id','outbox-one','targetProvider','internal',
    'commandType','notification.send','idempotencyKey','outbox-key-one','payload',jsonb_build_object('kind','diagnostic'),
    'availableAt','2026-07-22T00:08:00.000Z','maxAttempts',5,'correlationId','request-outbox-one','metadata',jsonb_build_object('source','sql-verifier')));
  update public.integration_outbox set status='succeeded', attempt_count=2 where id='outbox-one';
  select * into v_same from public.support_enqueue_integration_outbox(jsonb_build_object('id','unused-outbox','targetProvider','internal',
    'commandType','notification.send','idempotencyKey','outbox-key-one','payload',jsonb_build_object('kind','diagnostic'),
    'availableAt','2026-07-22T00:08:00.000Z','maxAttempts',5,'correlationId','request-outbox-two','metadata',jsonb_build_object('source','sql-verifier')));
  if v_created.action <> 'created' or v_same.action <> 'unchanged' or v_same.status <> 'succeeded' or v_same.attempt_count <> 2 then raise exception 'Existing outbox status was not returned safely'; end if;
  begin perform * from public.support_enqueue_integration_outbox(jsonb_build_object('id','bad-outbox','targetProvider','internal',
    'commandType','notification.send','idempotencyKey','bad-key','payload',jsonb_build_object('clientSecret','forbidden'),
    'availableAt','2026-07-22T00:08:00.000Z','maxAttempts',5,'correlationId','request-outbox-bad','metadata','{}'::jsonb));
    raise exception 'Sensitive outbox accepted'; exception when invalid_parameter_value then if sqlerrm <> 'INTEGRATION_OUTBOX_PAYLOAD_INVALID' then raise; end if; end;
  begin perform * from public.support_enqueue_integration_outbox(jsonb_build_object('id','bad-integer-outbox','targetProvider','internal',
    'commandType','notification.send','idempotencyKey','bad-integer-key','payload',jsonb_build_object('kind','diagnostic'),
    'availableAt','2026-07-22T00:08:00.000Z','maxAttempts','not-an-integer','correlationId','request-outbox-bad-integer','metadata','{}'::jsonb));
    raise exception 'Malformed integer accepted'; exception when invalid_parameter_value then if sqlerrm <> 'INTEGRATION_OUTBOX_PAYLOAD_INVALID' then raise; end if; end;
end;
$$;

do $$
declare v_count bigint;
begin
  select count(*) into v_count from public.support_list_intake_identities(1,1,null,'internal'); if v_count > 1 then raise exception 'Identity read is unbounded'; end if;
  select count(*) into v_count from public.support_list_intake_conversations(1,1,null,'internal'); if v_count > 1 then raise exception 'Conversation read is unbounded'; end if;
  select count(*) into v_count from public.support_list_intake_events(1,1,'accepted','internal'); if v_count > 1 then raise exception 'Event read is unbounded'; end if;
  if exists (select 1 from public.support_list_intake_events(1,100,null,'email')) then raise exception 'Provider filter was ignored'; end if;
end;
$$;
`;

async function verifyUnrelatedEventConcurrency() {
  psql([], String.raw`
create or replace function public.supper_test_intake_slow_event() returns trigger language plpgsql as $$
begin
  if new.id = 'event-concurrency-slow' then
    perform pg_advisory_lock(781322013);
    perform pg_sleep(2);
    perform pg_advisory_unlock(781322013);
  end if;
  return new;
end;
$$;
drop trigger if exists supper_test_intake_slow_event on public.intake_events;
create trigger supper_test_intake_slow_event before insert on public.intake_events
for each row execute function public.supper_test_intake_slow_event();
`);
  let slow;
  try {
    slow = psqlAsync(String.raw`select action from public.support_accept_intake_event(public.supper_test_intake_payload(
      'concurrency-slow','external-event-concurrency-slow','external-conversation-concurrency-slow',
      'external-subject-concurrency-slow','external-message-concurrency-slow','external-attachment-concurrency-slow'));
`);
    let entered = false;
    for (let attempt = 0; attempt < 40 && !entered; attempt += 1) {
      sleep(25);
      entered = psql(["-Atc", "select case when pg_try_advisory_lock(781322013) then not pg_advisory_unlock(781322013) else true end"]) === "t";
    }
    if (!entered) throw new Error("Could not establish the concurrency acceptance barrier");
    const startedAt = Date.now();
    const fastResult = psql(["-Atc", String.raw`select action from public.support_accept_intake_event(public.supper_test_intake_payload(
      'concurrency-fast','external-event-concurrency-fast','external-conversation-concurrency-fast',
      'external-subject-concurrency-fast','external-message-concurrency-fast','external-attachment-concurrency-fast'))`]);
    const elapsed = Date.now() - startedAt;
    await slow;
    if (fastResult !== "accepted") throw new Error(`Unrelated concurrency event was not accepted: ${fastResult}`);
    if (elapsed >= 1_200) throw new Error(`Unrelated events in one Channel were serialized (${elapsed}ms)`);
  } finally {
    if (slow) await slow.catch(() => undefined);
    psql([], "drop trigger if exists supper_test_intake_slow_event on public.intake_events; drop function if exists public.supper_test_intake_slow_event();");
  }
}

try {
  run("initdb", ["-A", "trust", "-U", "postgres", "-D", dataDirectory, "--no-locale"]);
  mkdirSync(socketDirectory, { recursive: true });
  run("pg_ctl", ["-D", dataDirectory, "-l", logPath, "-o", `-F -k ${socketDirectory} -p ${port}`, "-w", "start"]);
  started = true;
  psql([], baseSchema);
  const migrationDirectory = path.join(root, "supabase/migrations");
  const migrations = readdirSync(migrationDirectory).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const migration of migrations) psql(["-f", path.join(migrationDirectory, migration)]);
  psql(["-f", path.join(migrationDirectory, "202607220002_unified_intake_core_corrections.sql")]);
  psql([], acceptanceSql);
  await verifyUnrelatedEventConcurrency();

  const expectedTables = [
    "integration_channels", "integration_external_identities", "integration_identity_bindings", "integration_identity_binding_events",
    "intake_conversations", "intake_conversation_events", "intake_messages", "intake_attachments", "intake_sessions",
    "intake_session_events", "intake_events", "intake_ticket_links", "integration_outbox",
  ];
  const tables = psql(["-Atc", `select tablename from pg_tables where schemaname='public' and tablename in (${expectedTables.map((name) => `'${name}'`).join(",")}) order by tablename`]).split("\n").filter(Boolean);
  if (tables.length !== expectedTables.length) throw new Error(`Missing intake tables: ${expectedTables.filter((name) => !tables.includes(name)).join(", ")}`);
  const rlsCount = Number(psql(["-Atc", `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (${expectedTables.map((name) => `'${name}'`).join(",")}) and c.relrowsecurity`]));
  if (rlsCount !== expectedTables.length) throw new Error("RLS is not enabled on every intake table");
  const functions = [
    "support_get_intake_operations_summary", "support_list_intake_identities", "support_list_intake_conversations",
    "support_list_intake_events", "support_accept_intake_event", "support_apply_intake_identity_binding",
    "support_revoke_intake_identity_binding", "support_transition_intake_session", "support_transition_intake_conversation",
    "support_enqueue_integration_outbox",
  ];
  const unsafe = Number(psql(["-Atc", `select count(*) from information_schema.routine_privileges where routine_schema='public' and routine_name in (${functions.map((name) => `'${name}'`).join(",")}) and grantee in ('PUBLIC','anon','authenticated') and privilege_type='EXECUTE'`]));
  if (unsafe !== 0) throw new Error("A privileged intake RPC is executable by a browser role");
  const serviceGrants = Number(psql(["-Atc", `select count(distinct routine_name) from information_schema.routine_privileges where routine_schema='public' and routine_name in (${functions.map((name) => `'${name}'`).join(",")}) and grantee='service_role' and privilege_type='EXECUTE'`]));
  if (serviceGrants !== functions.length) throw new Error("service_role is missing an intake RPC grant");
  const versions = psql(["-Atc", "select string_agg(version, ',' order by version) from public.support_schema_migrations where version in ('202607220001','202607220002')"]);
  if (versions !== "202607220001,202607220002") throw new Error("Intake migration versions were not recorded");

  const migration = readFileSync(path.join(migrationDirectory, "202607220002_unified_intake_core_corrections.sql"), "utf8");
  if (/integration_channels[^;]{0,500}for update/is.test(migration)) throw new Error("Event acceptance still serializes the whole Channel row");
  for (const scope of ["intake-event:", "intake-message:", "intake-conversation:", "intake-identity:"]) {
    if (!migration.includes(scope)) throw new Error(`Missing scoped concurrency lock: ${scope}`);
  }
  const repository = readFileSync(path.join(root, "src/lib/intake-core/relational-repository.ts"), "utf8");
  if (!/listConversationMessages[\s\S]*?\.range\(from, to\)/.test(repository)
    || !/listConversationAttachments[\s\S]*?\.range\(from, to\)/.test(repository)) throw new Error("Child read pagination is not enforced at storage");
  if (/listConversationMessages[\s\S]*?body_html/.test(repository)) throw new Error("Conversation Messages expose raw HTML");
  if (/listConversationAttachments[\s\S]*?provider_locator/.test(repository)) throw new Error("Conversation Attachments expose provider locators");

  console.log("Unified intake correction applied twice safely; canonical replay, compound secret rejection, durable histories, bounded reads, scoped concurrency, provider filters, grants, and intent-only behavior passed.");
} finally {
  if (started) spawnSync("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"], { encoding: "utf8" });
  for (const target of [dataDirectory, socketDirectory, logPath]) if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}
