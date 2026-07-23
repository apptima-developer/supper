import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const canonicalVectors = JSON.parse(readFileSync(path.join(root, "src/lib/intake-core/canonical-vectors.json"), "utf8"));
const sensitiveKeyVectors = JSON.parse(readFileSync(path.join(root, "src/lib/intake-core/sensitive-key-vectors.json"), "utf8"));

function canonicalVectorSql() {
  const validChecks = canonicalVectors.filter((vector) => vector.valid).map((vector, index) => {
    const input = vector.sqlInput ?? JSON.stringify(vector.input);
    return String.raw`
do $vector_${index}$
declare v_actual text;
begin
  v_actual := public.support_intake_canonical_json($input_${index}$${input}$input_${index}$::jsonb);
  if v_actual <> $serialized_${index}$${vector.serialized}$serialized_${index}$ then
    raise exception 'Canonical serialization mismatch: ${vector.name}';
  end if;
  if public.support_intake_sha256_hex(v_actual) <> '${vector.sha256}' then
    raise exception 'Canonical hash mismatch: ${vector.name}';
  end if;
end;
$vector_${index}$;`;
  }).join("\n");
  const invalidChecks = canonicalVectors.filter((vector) => !vector.valid).map((vector, index) => String.raw`
do $invalid_vector_${index}$
begin
  perform public.support_intake_canonical_json($input_invalid_${index}$${JSON.stringify(vector.input)}$input_invalid_${index}$::jsonb);
  raise exception 'Invalid canonical number accepted: ${vector.name}';
exception when invalid_parameter_value then
  if sqlerrm <> 'INTAKE_CANONICAL_NUMBER_INVALID' then raise; end if;
end;
$invalid_vector_${index}$;`).join("\n");
  return `${validChecks}\n${invalidChecks}`;
}

function sensitiveKeyVectorSql() {
  const checks = [
    ...sensitiveKeyVectors.reject.map((key) => ({ key, expected: "sensitive" })),
    ...sensitiveKeyVectors.accept.map((key) => ({ key, expected: "safe" })),
  ];
  return checks.map(({ key, expected }, index) => String.raw`
do $key_vector_${index}$
begin
  if public.support_intake_classify_key('${key.replaceAll("'", "''")}') <> '${expected}' then
    raise exception 'Sensitive-key classification mismatch: ${key}';
  end if;
end;
$key_vector_${index}$;`).join("\n");
}

const baseSchema = String.raw`
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
alter database postgres set search_path = pg_catalog, public, extensions;
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

const fixtureSql = String.raw`
insert into public.support_customers (id, customer_key, customer_name, project_code, active, data) values
  ('customer-a', 'customer-a', 'Customer A', 'A-001', true, '{"key":"customer-a"}'),
  ('customer-inactive', 'customer-inactive', 'Inactive', 'I-001', false, '{"key":"customer-inactive"}');
insert into public.integration_channels (id, provider, channel_key, display_name, environment, enabled, configuration_status)
values ('channel-one', 'internal', 'sql-diagnostic-one', 'SQL diagnostic one', 'development', true, 'configured'),
       ('channel-two', 'internal', 'sql-diagnostic-two', 'SQL diagnostic two', 'development', true, 'configured');

create or replace function public.supper_test_intake_rehash(p_payload jsonb) returns jsonb language plpgsql as $$
declare v_result jsonb := p_payload;
begin
  v_result := jsonb_set(v_result, '{identity,externalSubjectHash}', to_jsonb(encode(extensions.digest(v_result#>>'{identity,externalSubjectId}', 'sha256'), 'hex')));
  v_result := jsonb_set(v_result, '{message,contentHash}', to_jsonb(encode(extensions.digest(public.support_intake_canonical_json(public.support_intake_message_material(v_result)), 'sha256'), 'hex')));
  v_result := jsonb_set(v_result, '{event,payloadHash}', to_jsonb(encode(extensions.digest(public.support_intake_canonical_json(public.support_intake_event_material(v_result)), 'sha256'), 'hex')));
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

create or replace function public.supper_test_intake_two_attachment_payload(
  p_suffix text, p_external_event text, p_external_conversation text,
  p_external_subject text, p_external_message text,
  p_external_attachment_a text, p_external_attachment_b text,
  p_reverse boolean default false
) returns jsonb language plpgsql as $$
declare v_value jsonb; v_first jsonb; v_second jsonb;
begin
  v_value := public.supper_test_intake_payload(p_suffix, p_external_event, p_external_conversation,
    p_external_subject, p_external_message, p_external_attachment_a);
  v_first := (v_value#>'{attachments,0}') || jsonb_build_object(
    'id','attachment-' || p_suffix || '-a','externalAttachmentId',p_external_attachment_a);
  v_second := (v_value#>'{attachments,0}') || jsonb_build_object(
    'id','attachment-' || p_suffix || '-b','externalAttachmentId',p_external_attachment_b);
  v_value := jsonb_set(v_value, '{attachments}', case when p_reverse
    then jsonb_build_array(v_second, v_first) else jsonb_build_array(v_first, v_second) end);
  return public.supper_test_intake_rehash(v_value);
end;
$$;

`;

const pgcryptoCompatibilityValue = "supper-supabase-pgcrypto-schema";
const pgcryptoCompatibilityHash = createHash("sha256").update(pgcryptoCompatibilityValue).digest("hex");
const pgcryptoCompatibilitySql = String.raw`
do $pgcrypto_compatibility$
declare
  v_result record;
  v_attachment_hash text;
begin
  if public.support_intake_sha256_hex('${pgcryptoCompatibilityValue}') <> '${pgcryptoCompatibilityHash}' then
    raise exception 'Portable SHA-256 helper returned the wrong digest';
  end if;

  v_attachment_hash := public.support_intake_attachment_source_hash(jsonb_build_object(
    'externalAttachmentId', 'external-attachment-pgcrypto',
    'fileName', 'pgcrypto.txt',
    'contentType', 'text/plain',
    'declaredSize', 128,
    'sha256', null,
    'providerLocator', null,
    'metadata', '{}'::jsonb
  ));
  if v_attachment_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'Attachment source hash did not execute in the extensions pgcrypto layout';
  end if;

  select * into v_result from public.support_accept_intake_event(
    public.supper_test_intake_payload('pgcrypto-old', 'external-event-pgcrypto-old',
      'external-conversation-pgcrypto-old', 'external-subject-pgcrypto-old',
      'external-message-pgcrypto-old', 'external-attachment-pgcrypto-old'));
  if v_result.action <> 'accepted' then raise exception 'Legacy acceptance RPC failed in the extensions pgcrypto layout'; end if;

  select * into v_result from public.support_accept_intake_event_v2(
    public.supper_test_intake_payload('pgcrypto-v2', 'external-event-pgcrypto-v2',
      'external-conversation-pgcrypto-v2', 'external-subject-pgcrypto-v2',
      'external-message-pgcrypto-v2', 'external-attachment-pgcrypto-v2'));
  if v_result.action <> 'accepted' then raise exception 'V2 acceptance RPC failed in the extensions pgcrypto layout'; end if;

  select * into v_result from public.support_accept_intake_event_v3(
    public.supper_test_intake_payload('pgcrypto-v3', 'external-event-pgcrypto-v3',
      'external-conversation-pgcrypto-v3', 'external-subject-pgcrypto-v3',
      'external-message-pgcrypto-v3', 'external-attachment-pgcrypto-v3'));
  if v_result.action <> 'accepted' then raise exception 'V3 acceptance RPC failed in the extensions pgcrypto layout'; end if;
end;
$pgcrypto_compatibility$;
`;

const legacySeedSql = String.raw`
-- Migration 002 is already immutable on the target. Its acceptance function
-- predates the portable helper, so expose the hosted extension only while the
-- verifier creates representative 002 state, then restore its stored definition.
alter function public.support_accept_intake_event(jsonb)
  set search_path = pg_catalog, public, extensions, pg_temp;
do $$
declare v_result record;
begin
  select * into v_result from public.support_accept_intake_event(public.supper_test_intake_payload(
    'upgrade','external-event-upgrade','external-conversation-upgrade','external-subject-upgrade',
    'external-message-upgrade','external-attachment-upgrade'));
  if v_result.action <> 'accepted' then raise exception 'Legacy intake seed was not accepted'; end if;
  update public.intake_attachments set storage_status='stored', storage_object_key='upgrade-object-key',
    scan_status='clean', retention_until='2027-07-22T00:00:00.000Z' where id='attachment-upgrade';
  if (select count(*) from public.intake_events where id='event-upgrade') <> 1
    or (select count(*) from public.integration_external_identities where id='identity-upgrade') <> 1
    or (select count(*) from public.intake_conversations where id='conversation-upgrade') <> 1
    or (select count(*) from public.intake_messages where id='message-upgrade') <> 1
    or (select count(*) from public.intake_attachments where id='attachment-upgrade') <> 1
    or (select count(*) from public.intake_sessions where id='session-upgrade') <> 1 then
    raise exception 'Legacy representative state was incomplete';
  end if;
end;
$$;
alter function public.support_accept_intake_event(jsonb)
  set search_path = pg_catalog, public, pg_temp;
`;

const upgradeVerificationSql = String.raw`
do $$
declare v_replay record; v_payload jsonb;
begin
  if (select storage_status from public.intake_attachments where id='attachment-upgrade') <> 'stored'
    or (select scan_status from public.intake_attachments where id='attachment-upgrade') <> 'clean'
    or (select storage_object_key from public.intake_attachments where id='attachment-upgrade') <> 'upgrade-object-key'
    or (select source_material_hash = canonical_hash from public.intake_attachments where id='attachment-upgrade') is not true
    or (select content_hash = public.support_intake_sha256_hex(public.support_intake_canonical_json(
      public.support_intake_persisted_message_material(id)))
      from public.intake_messages where id='message-upgrade') is not true
    or (select count(*) from public.intake_event_deliveries where event_id='event-upgrade' and delivery_number=1) <> 1 then
    raise exception 'Forward migration lost or failed to backfill representative state';
  end if;

  v_payload := public.supper_test_intake_payload(
    'upgrade','external-event-upgrade','external-conversation-upgrade','external-subject-upgrade',
    'external-message-upgrade','external-attachment-upgrade');
  v_payload := jsonb_set(v_payload, '{event,receivedAt}', '"2026-07-22T00:11:00.000Z"');
  v_payload := jsonb_set(v_payload, '{event,requestId}', '"request-upgrade-current"');
  v_payload := jsonb_set(v_payload, '{event,correlationId}', '"correlation-upgrade-current"');
  v_payload := public.supper_test_intake_rehash(v_payload);
  select * into v_replay from public.support_accept_intake_event_v3(v_payload);
  if v_replay.action <> 'duplicate' or v_replay.delivery_count <> 2
    or (select request_id from public.intake_event_deliveries where event_id='event-upgrade' and delivery_number=2) <> 'request-upgrade-current'
    or (select correlation_id from public.intake_event_deliveries where event_id='event-upgrade' and delivery_number=2) <> 'correlation-upgrade-current'
    or (select received_at from public.intake_event_deliveries where event_id='event-upgrade' and delivery_number=2) <> '2026-07-22T00:11:00.000Z'::timestamptz then
    raise exception 'Upgraded replay or current delivery context failed';
  end if;
end;
$$;
`;

const acceptanceSql = String.raw`

do $$
declare
  v_payload jsonb := public.supper_test_intake_payload('one','external-event-one','external-conversation-one','external-subject-one','external-message-one','external-attachment-one');
  v_changed jsonb; v_first record; v_replay record; v_duplicate_message record; v_key text; v_source_hash text;
begin
  select * into v_first from public.support_accept_intake_event_v3(v_payload);
  select source_material_hash into v_source_hash from public.intake_attachments where id = 'attachment-one';
  update public.intake_events set
    payload_hash = public.support_intake_sha256_hex(
      public.support_intake_canonical_json(public.support_intake_legacy_event_material(v_payload))),
    metadata = metadata - '_canonicalVersion' where id='event-one';
  v_changed := jsonb_set(v_payload, '{conversation,subject}', '"changed-before-upgrade"');
  begin perform * from public.support_accept_intake_event_v3(v_changed); raise exception 'Changed legacy Event material was accepted during upgrade';
  exception when unique_violation then if sqlerrm <> 'INTAKE_EVENT_REPLAY_MISMATCH' then raise; end if; end;
  select * into v_replay from public.support_accept_intake_event_v3(jsonb_set(v_payload, '{event,receivedAt}', '"2026-07-22T00:05:00.000Z"'));
  if v_first.action <> 'accepted' or v_replay.action <> 'duplicate' or v_replay.delivery_count <> 2 then raise exception 'Event replay result failed'; end if;
  if (select processing_status from public.intake_events where id = 'event-one') <> 'accepted'
    or (select duplicate_delivery_count from public.intake_events where id = 'event-one') <> 1 then raise exception 'Accepted Event status was overwritten by redelivery'; end if;
  if (select count(*) from public.intake_messages where id='message-one') <> 1
    or (select count(*) from public.intake_attachments where id='attachment-one') <> 1 then
    raise exception 'Replay duplicated normalized records';
  end if;
  update public.intake_attachments set storage_status='stored', storage_object_key='opaque-diagnostic-key',
    scan_status='clean', retention_until='2027-07-22T00:00:00.000Z' where id='attachment-one';
  select * into v_replay from public.support_accept_intake_event_v3(jsonb_set(v_payload, '{event,receivedAt}', '"2026-07-22T00:10:00.000Z"'));
  if v_replay.action <> 'duplicate' or v_replay.delivery_count <> 3
    or (select source_material_hash from public.intake_attachments where id='attachment-one') <> v_source_hash
    or (select canonical_hash from public.intake_attachments where id='attachment-one') <> v_source_hash
    or (select storage_status from public.intake_attachments where id='attachment-one') <> 'stored'
    or (select scan_status from public.intake_attachments where id='attachment-one') <> 'clean' then
    raise exception 'Attachment lifecycle-only change broke canonical replay';
  end if;
  if (select delivery_count from public.intake_events where id='event-one') <> 3
    or (select duplicate_delivery_count from public.intake_events where id='event-one') <> 2
    or (select count(*) from public.intake_event_deliveries where event_id='event-one') <> 3
    or (select count(*) from public.intake_event_deliveries where event_id='event-one' and delivery_type='initial') <> 1
    or (select count(*) from public.intake_event_deliveries where event_id='event-one' and delivery_type='duplicate') <> 2 then
    raise exception 'Delivery ledger and lifetime counters diverged';
  end if;

  v_changed := public.supper_test_intake_rehash(jsonb_set(v_payload, '{conversation,subject}', '"changed"'));
  begin perform * from public.support_accept_intake_event_v3(v_changed); raise exception 'Event mismatch accepted';
  exception when unique_violation then if sqlerrm <> 'INTAKE_EVENT_REPLAY_MISMATCH' then raise; end if; end;

  v_changed := public.supper_test_intake_payload('message-exact','external-event-message-exact','external-conversation-one','external-subject-one','external-message-one','external-attachment-one');
  select * into v_duplicate_message from public.support_accept_intake_event_v3(v_changed);
  if v_duplicate_message.action <> 'duplicate_message' or v_duplicate_message.conversation_id <> 'conversation-one'
    or v_duplicate_message.identity_id <> 'identity-one' then raise exception 'Exact Message replay did not reuse persisted identity'; end if;

  foreach v_key in array array['conversation','sender','direction','type','reply','structured'] loop
    v_changed := public.supper_test_intake_payload('mismatch-' || v_key, 'external-event-mismatch-' || v_key,
      case when v_key = 'conversation' then 'other-conversation' else 'external-conversation-one' end,
      case when v_key = 'sender' then 'other-subject' else 'external-subject-one' end,
      'external-message-one', 'external-attachment-one');
    if v_key = 'direction' then v_changed := jsonb_set(v_changed, '{message,direction}', '"inbound"'); end if;
    if v_key = 'type' then v_changed := jsonb_set(v_changed, '{message,messageType}', '"html"'); end if;
    if v_key = 'reply' then v_changed := jsonb_set(v_changed, '{message,replyToMessageId}', '"message-other"'); end if;
    if v_key = 'structured' then v_changed := jsonb_set(v_changed, '{message,structuredContent}', '{"kind":"changed"}'); end if;
    v_changed := public.supper_test_intake_rehash(v_changed);
    begin perform * from public.support_accept_intake_event_v3(v_changed); raise exception 'Message mismatch accepted: %', v_key;
    exception when unique_violation then if sqlerrm <> 'INTAKE_MESSAGE_REPLAY_MISMATCH' then raise; end if; end;
    if exists (select 1 from public.intake_events where id = 'event-mismatch-' || v_key) then raise exception 'Rejected replay left an Event row'; end if;
  end loop;

  v_changed := public.supper_test_intake_payload('attachment-conflict','external-event-attachment-conflict','new-conversation','external-subject-one','new-message','external-attachment-one');
  begin perform * from public.support_accept_intake_event_v3(v_changed); raise exception 'Attachment mismatch accepted';
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
    begin perform * from public.support_accept_intake_event_v3(v_changed); raise exception 'Attachment material mismatch accepted: %', v_key;
    exception when unique_violation then if sqlerrm <> 'INTAKE_ATTACHMENT_REPLAY_MISMATCH' then raise; end if; end;
  end loop;

  foreach v_key in array array['apikey','xapikey','clientsecret','channelsecret','accesstoken','refreshtoken',
    'bearertoken','servicerolekey','supabaseservicerolekey','webhooksecret','sessionsecret','signeddownloadurl',
    'authorizationheader','authenticationcredential'] loop
    v_changed := public.supper_test_intake_payload('secret-' || replace(v_key,'-',''), 'external-event-secret-' || replace(v_key,'-',''),
      'conversation-secret-' || replace(v_key,'-',''), 'subject-secret-' || replace(v_key,'-',''),
      'message-secret-' || replace(v_key,'-',''), 'attachment-secret-' || replace(v_key,'-',''));
    v_changed := jsonb_set(v_changed, '{message,structuredContent}', jsonb_build_object(v_key, 'forbidden'));
    v_changed := public.supper_test_intake_rehash(v_changed);
    begin perform * from public.support_accept_intake_event_v3(v_changed); raise exception 'Sensitive key accepted: %', v_key;
    exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_SENSITIVE_DATA_REJECTED' then raise; end if; end;
  end loop;

  v_changed := public.supper_test_intake_rehash(jsonb_set(v_payload, '{event,receivedAt}', '"not-a-timestamp"'));
  begin perform * from public.support_accept_intake_event_v3(v_changed); raise exception 'Malformed timestamp accepted';
  exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_PAYLOAD_INVALID' then raise; end if; end;

  v_changed := jsonb_set(public.supper_test_intake_payload('fractional','external-event-fractional','conversation-fractional',
    'subject-fractional','message-fractional','attachment-fractional'), '{message,structuredContent}', '{"value":1.5}'::jsonb);
  begin perform * from public.support_accept_intake_event_v3(v_changed); raise exception 'Fractional canonical number accepted';
  exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_CANONICAL_NUMBER_INVALID' then raise; end if; end;

  foreach v_key in array array['tokenizer','secretariat','monkey','keyboard'] loop
    if public.support_intake_classify_key(v_key) <> 'safe' then raise exception 'Safe key rejected: %', v_key; end if;
  end loop;
  v_changed := jsonb_set(public.supper_test_intake_payload('nested-secret','external-event-nested-secret','conversation-nested-secret',
    'subject-nested-secret','message-nested-secret','attachment-nested-secret'), '{message,structuredContent}',
    '{"outer":[{"apikey":"forbidden"}]}'::jsonb);
  begin perform * from public.support_accept_intake_event_v3(v_changed); raise exception 'Nested compact sensitive key accepted';
  exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_SENSITIVE_DATA_REJECTED' then raise; end if; end;
  v_changed := jsonb_set(public.supper_test_intake_payload('unsafe-number','external-event-unsafe-number','conversation-unsafe-number',
    'subject-unsafe-number','message-unsafe-number','attachment-unsafe-number'), '{message,structuredContent}',
    '{"value":9007199254740992}'::jsonb);
  begin perform * from public.support_accept_intake_event_v3(v_changed); raise exception 'Unsafe canonical integer accepted';
  exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_CANONICAL_NUMBER_INVALID' then raise; end if; end;
end;
$$;

do $$
declare v_created record; v_unchanged record; v_revoked record;
begin
  select * into v_created from public.support_apply_intake_identity_binding_v2(jsonb_build_object(
    'bindingId','binding-one','eventId','binding-event-one','identityId','identity-one','customerKey','customer-a',
    'projectCode','A-001','allowedSystems',jsonb_build_array('servicenow'),'targetReferences',jsonb_build_object(
      'servicenow',jsonb_build_object('callerId','caller-a','companyId','company-a')),
    'actorUserId','admin','requestId','request-binding-one','correlationId','request-binding-one',
    'appliedAt','2026-07-22T00:00:30.000Z','metadata',jsonb_build_object('source','sql-verifier')));
  select * into v_unchanged from public.support_apply_intake_identity_binding_v2(jsonb_build_object(
    'bindingId','unused-binding','eventId','unused-binding-event','identityId','identity-one','customerKey','customer-a',
    'projectCode','A-001','allowedSystems',jsonb_build_array('servicenow'),'targetReferences',jsonb_build_object(
      'servicenow',jsonb_build_object('callerId','caller-a','companyId','company-a')),
    'actorUserId','admin','correlationId','request-binding-repeat','appliedAt','2026-07-22T00:00:31.000Z','metadata',jsonb_build_object('source','sql-verifier')));
  select * into v_revoked from public.support_revoke_intake_identity_binding(jsonb_build_object(
    'eventId','binding-event-revoke','identityId','identity-one','actorUserId','admin','requestId','request-binding-revoke',
    'correlationId','request-binding-revoke','appliedAt','2026-07-22T00:00:32.000Z','metadata',jsonb_build_object('reason','verification')));
  if v_created.action <> 'created' or v_unchanged.action <> 'unchanged' or v_revoked.action <> 'revoked'
    or (select count(*) from public.integration_identity_binding_events where identity_id='identity-one') <> 2 then
    raise exception 'Identity binding regression';
  end if;
  begin perform * from public.support_apply_intake_identity_binding_v2(jsonb_build_object(
    'bindingId','binding-unknown','eventId','binding-event-unknown','identityId','identity-one','customerKey','customer-a',
    'allowedSystems',jsonb_build_array('servicenow'),'targetReferences',jsonb_build_object(
      'servicenow',jsonb_build_object('unknownField','opaque')),'actorUserId','admin',
    'correlationId','request-binding-unknown','appliedAt','2026-07-22T00:00:33.000Z','metadata','{}'::jsonb));
    raise exception 'Unknown target-reference field accepted';
  exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_TARGET_REFERENCE_INVALID' then raise; end if; end;
  begin perform * from public.support_apply_intake_identity_binding_v2(jsonb_build_object(
    'bindingId','binding-provider','eventId','binding-event-provider','identityId','identity-one','customerKey','customer-a',
    'allowedSystems',jsonb_build_array('servicenow'),'targetReferences',jsonb_build_object(
      'unknownProvider',jsonb_build_object('userId','opaque')),'actorUserId','admin',
    'correlationId','request-binding-provider','appliedAt','2026-07-22T00:00:34.000Z','metadata','{}'::jsonb));
    raise exception 'Unknown target-reference provider accepted';
  exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_TARGET_REFERENCE_INVALID' then raise; end if; end;
  begin perform * from public.support_apply_intake_identity_binding_v2(jsonb_build_object(
    'bindingId','binding-secret','eventId','binding-event-secret','identityId','identity-one','customerKey','customer-a',
    'allowedSystems',jsonb_build_array('servicenow'),'targetReferences',jsonb_build_object(
      'servicenow',jsonb_build_object('clientsecret','forbidden')),'actorUserId','admin',
    'correlationId','request-binding-secret','appliedAt','2026-07-22T00:00:35.000Z','metadata','{}'::jsonb));
    raise exception 'Sensitive target-reference field accepted';
  exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_SENSITIVE_DATA_REJECTED' then raise; end if; end;
end;
$$;

do $$
declare v_closed record; v_reopened record; v_noop record; v_ticket_count integer; v_outbox_count integer;
  v_history_count integer; v_updated_at timestamptz;
begin
  select count(*) into v_ticket_count from public.support_tickets;
  select count(*) into v_outbox_count from public.integration_outbox;
  select * into v_closed from public.support_transition_intake_conversation_v2(jsonb_build_object(
    'eventId','conversation-history-close','conversationId','conversation-one','expectedVersion',1,'targetStatus','closed',
    'explicitReopen',false,'actorUserId','admin','requestId','request-conversation-close','correlationId','request-conversation-close',
    'occurredAt','2026-07-22T00:01:00.000Z','metadata',jsonb_build_object('source','sql-verifier')));
  if v_closed.version <> 2 or (select count(*) from public.intake_conversation_events where conversation_id='conversation-one') <> 2 then raise exception 'Conversation history missing'; end if;
  begin perform * from public.support_transition_intake_conversation_v2(jsonb_build_object(
    'eventId','conversation-stale','conversationId','conversation-one','expectedVersion',1,'targetStatus','archived','explicitReopen',false,
    'actorUserId','admin','correlationId','request-conversation-stale','occurredAt','2026-07-22T00:02:00.000Z','metadata','{}'::jsonb));
    raise exception 'Stale Conversation accepted'; exception when serialization_failure then if sqlerrm <> 'INTAKE_CONVERSATION_VERSION_CONFLICT' then raise; end if; end;
  begin perform * from public.support_transition_intake_conversation_v2(jsonb_build_object(
    'eventId','conversation-no-reopen','conversationId','conversation-one','expectedVersion',2,'targetStatus','open','explicitReopen',false,
    'actorUserId','admin','correlationId','request-conversation-no-reopen','occurredAt','2026-07-22T00:03:00.000Z','metadata','{}'::jsonb));
    raise exception 'Implicit reopen accepted'; exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_CONVERSATION_TRANSITION_INVALID' then raise; end if; end;
  select * into v_reopened from public.support_transition_intake_conversation_v2(jsonb_build_object(
    'eventId','conversation-reopen','conversationId','conversation-one','expectedVersion',2,'targetStatus','open','explicitReopen',true,
    'actorUserId','admin','correlationId','request-conversation-reopen','occurredAt','2026-07-22T00:04:00.000Z','metadata','{}'::jsonb));
  if v_reopened.version <> 3 or (select action from public.intake_conversation_events where id='conversation-reopen') <> 'reopened' then raise exception 'Explicit reopen history failed'; end if;
  select count(*) into v_history_count from public.intake_conversation_events where conversation_id='conversation-one';
  select updated_at into v_updated_at from public.intake_conversations where id='conversation-one';
  select * into v_noop from public.support_transition_intake_conversation_v2(jsonb_build_object(
    'eventId','conversation-noop','conversationId','conversation-one','expectedVersion',3,'targetStatus','open','explicitReopen',false,
    'actorUserId','admin','correlationId','request-conversation-noop','occurredAt','2026-07-22T00:04:30.000Z','metadata','{}'::jsonb));
  if v_noop.action <> 'unchanged' or v_noop.version <> 3
    or (select count(*) from public.intake_conversation_events where conversation_id='conversation-one') <> v_history_count
    or exists (select 1 from public.intake_conversation_events where id='conversation-noop')
    or (select updated_at from public.intake_conversations where id='conversation-one') is distinct from v_updated_at then
    raise exception 'Same-state Conversation transition was not a pure no-op';
  end if;
  begin perform * from public.support_transition_intake_conversation_v2(jsonb_build_object(
    'eventId','conversation-stale-noop','conversationId','conversation-one','expectedVersion',2,'targetStatus','open','explicitReopen',false,
    'actorUserId','admin','correlationId','request-conversation-stale-noop','occurredAt','2026-07-22T00:04:31.000Z','metadata','{}'::jsonb));
    raise exception 'Stale same-state Conversation accepted';
  exception when serialization_failure then if sqlerrm <> 'INTAKE_CONVERSATION_VERSION_CONFLICT' then raise; end if; end;

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
  select * into v_created from public.support_enqueue_integration_outbox_v2(jsonb_build_object('id','outbox-one','targetProvider','internal',
    'commandType','notification.send','idempotencyKey','outbox-key-one','payload',jsonb_build_object('kind','diagnostic'),
    'availableAt','2026-07-22T00:08:00.000Z','maxAttempts',5,'correlationId','request-outbox-one','metadata',jsonb_build_object('source','sql-verifier')));
  update public.integration_outbox set status='succeeded', attempt_count=2 where id='outbox-one';
  select * into v_same from public.support_enqueue_integration_outbox_v2(jsonb_build_object('id','unused-outbox','targetProvider','internal',
    'commandType','notification.send','idempotencyKey','outbox-key-one','payload',jsonb_build_object('kind','diagnostic'),
    'availableAt','2026-07-22T00:08:00.000Z','maxAttempts',5,'correlationId','request-outbox-two','metadata',jsonb_build_object('source','sql-verifier')));
  if v_created.action <> 'created' or v_same.action <> 'unchanged' or v_same.status <> 'succeeded' or v_same.attempt_count <> 2 then raise exception 'Existing outbox status was not returned safely'; end if;
  begin perform * from public.support_enqueue_integration_outbox_v2(jsonb_build_object('id','bad-outbox','targetProvider','internal',
    'commandType','notification.send','idempotencyKey','bad-key','payload',jsonb_build_object('clientSecret','forbidden'),
    'availableAt','2026-07-22T00:08:00.000Z','maxAttempts',5,'correlationId','request-outbox-bad','metadata','{}'::jsonb));
    raise exception 'Sensitive outbox accepted'; exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_SENSITIVE_DATA_REJECTED' then raise; end if; end;
  begin perform * from public.support_enqueue_integration_outbox_v2(jsonb_build_object('id','bad-integer-outbox','targetProvider','internal',
    'commandType','notification.send','idempotencyKey','bad-integer-key','payload',jsonb_build_object('kind','diagnostic'),
    'availableAt','2026-07-22T00:08:00.000Z','maxAttempts','not-an-integer','correlationId','request-outbox-bad-integer','metadata','{}'::jsonb));
    raise exception 'Malformed integer accepted'; exception when invalid_parameter_value then if sqlerrm <> 'INTEGRATION_OUTBOX_PAYLOAD_INVALID' then raise; end if; end;
  begin perform * from public.support_enqueue_integration_outbox_v2(jsonb_build_object('id','fractional-outbox','targetProvider','internal',
    'commandType','notification.send','idempotencyKey','fractional-key','payload',jsonb_build_object('retryWeight',1.5),
    'availableAt','2026-07-22T00:08:00.000Z','maxAttempts',5,'correlationId','request-outbox-fractional','metadata','{}'::jsonb));
    raise exception 'Fractional outbox payload accepted'; exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_CANONICAL_NUMBER_INVALID' then raise; end if; end;
end;
$$;

do $$
declare v_summary record; v_recent_duplicates integer; v_lifetime_duplicates integer;
begin
  update public.intake_event_deliveries set received_at = now() - interval '25 hours'
    where event_id='event-one' and delivery_number=2;
  select count(*)::integer into v_recent_duplicates from public.intake_event_deliveries
    where delivery_type='duplicate' and received_at >= now() - interval '24 hours';
  select coalesce(sum(duplicate_delivery_count),0)::integer into v_lifetime_duplicates from public.intake_events;
  select * into v_summary from public.support_get_intake_operations_summary();
  if v_summary.duplicate_events_24h <> v_recent_duplicates or v_lifetime_duplicates <= v_recent_duplicates then
    raise exception 'Chronological 24-hour duplicate metrics overcounted lifetime deliveries';
  end if;
  if exists (select 1 from public.intake_event_deliveries where metadata <> '{}'::jsonb
      or metadata::text ~* '(payload|body|externalSubject|authorization|password|secret|token)') then
    raise exception 'Delivery ledger retained forbidden payload material';
  end if;
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

const finalIntegritySql = String.raw`
do $$
declare
  v_payload jsonb; v_second jsonb; v_result record; v_before jsonb; v_after jsonb;
  v_good_hash text; v_bad_hash text := repeat('f', 64);
begin
  -- Direct source-hash or canonical-hash changes are replay mismatches.
  select source_material_hash into v_good_hash from public.intake_attachments where id='attachment-one';
  begin update public.intake_attachments set source_material_hash=v_bad_hash where id='attachment-one';
    raise exception 'Direct source_material_hash mutation succeeded';
  exception when unique_violation then if sqlerrm <> 'INTAKE_ATTACHMENT_REPLAY_MISMATCH' then raise; end if; end;
  begin update public.intake_attachments set canonical_hash=v_bad_hash where id='attachment-one';
    raise exception 'Direct canonical_hash mutation succeeded';
  exception when unique_violation then if sqlerrm <> 'INTAKE_ATTACHMENT_REPLAY_MISMATCH' then raise; end if; end;

  -- A pre-existing corrupt source identity must be surfaced, never silently blessed.
  alter table public.intake_attachments disable trigger support_intake_attachment_source_hash_guard;
  update public.intake_attachments set source_material_hash=v_bad_hash, canonical_hash=v_bad_hash where id='attachment-one';
  alter table public.intake_attachments enable trigger support_intake_attachment_source_hash_guard;
  begin update public.intake_attachments set scan_status='not_scanned' where id='attachment-one';
    raise exception 'Corrupt Attachment state was silently accepted';
  exception when data_corrupted then if sqlerrm <> 'INTAKE_STORAGE_INTEGRITY_ERROR' then raise; end if; end;
  alter table public.intake_attachments disable trigger support_intake_attachment_source_hash_guard;
  update public.intake_attachments set source_material_hash=v_good_hash, canonical_hash=v_good_hash where id='attachment-one';
  alter table public.intake_attachments enable trigger support_intake_attachment_source_hash_guard;

  select jsonb_build_object(
    'events',(select count(*) from public.intake_events),
    'messages',(select count(*) from public.intake_messages),
    'attachments',(select count(*) from public.intake_attachments),
    'sessions',(select count(*) from public.intake_sessions),
    'deliveries',(select count(*) from public.intake_event_deliveries)) into v_before;

  v_payload := public.supper_test_intake_payload('duplicate-internal','external-event-duplicate-internal',
    'external-conversation-duplicate-internal','external-subject-duplicate-internal',
    'external-message-duplicate-internal','external-attachment-duplicate-internal');
  v_second := (v_payload#>'{attachments,0}') || jsonb_build_object(
    'externalAttachmentId','external-attachment-duplicate-internal-two');
  v_payload := jsonb_set(v_payload, '{attachments}', jsonb_build_array(v_payload#>'{attachments,0}', v_second));
  v_payload := public.supper_test_intake_rehash(v_payload);
  begin perform * from public.support_accept_intake_event_v3(v_payload);
    raise exception 'Duplicate internal Attachment ID was accepted';
  exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_ATTACHMENT_DUPLICATE_IN_EVENT' then raise; end if; end;

  v_payload := public.supper_test_intake_payload('duplicate-external','external-event-duplicate-external',
    'external-conversation-duplicate-external','external-subject-duplicate-external',
    'external-message-duplicate-external','external-attachment-duplicate-external');
  v_second := (v_payload#>'{attachments,0}') || jsonb_build_object('id','attachment-duplicate-external-two');
  v_payload := jsonb_set(v_payload, '{attachments}', jsonb_build_array(v_payload#>'{attachments,0}', v_second));
  v_payload := public.supper_test_intake_rehash(v_payload);
  begin perform * from public.support_accept_intake_event_v3(v_payload);
    raise exception 'Duplicate external Attachment ID was accepted';
  exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_ATTACHMENT_DUPLICATE_IN_EVENT' then raise; end if; end;

  select jsonb_build_object(
    'events',(select count(*) from public.intake_events),
    'messages',(select count(*) from public.intake_messages),
    'attachments',(select count(*) from public.intake_attachments),
    'sessions',(select count(*) from public.intake_sessions),
    'deliveries',(select count(*) from public.intake_event_deliveries)) into v_after;
  if v_after <> v_before then raise exception 'Rejected duplicate Attachment payload left partial state'; end if;

  -- Equal content under different external IDs remains valid, including reversed replay order.
  v_payload := public.supper_test_intake_payload('multiple','external-event-multiple',
    'external-conversation-multiple','external-subject-multiple','external-message-multiple','external-attachment-multiple-a');
  v_second := (v_payload#>'{attachments,0}') || jsonb_build_object(
    'id','attachment-multiple-b','externalAttachmentId','external-attachment-multiple-b');
  v_payload := jsonb_set(v_payload, '{attachments}', jsonb_build_array(v_payload#>'{attachments,0}', v_second));
  v_payload := public.supper_test_intake_rehash(v_payload);
  select * into v_result from public.support_accept_intake_event_v3(v_payload);
  if v_result.action <> 'accepted' or v_result.attachment_count <> 2 then raise exception 'Distinct multi-Attachment event failed'; end if;
  v_payload := jsonb_set(v_payload, '{attachments}', jsonb_build_array(v_second, v_payload#>'{attachments,0}'));
  v_payload := jsonb_set(v_payload, '{event,receivedAt}', '"2026-07-22T00:12:00.000Z"');
  v_payload := public.supper_test_intake_rehash(v_payload);
  select * into v_result from public.support_accept_intake_event_v3(v_payload);
  if v_result.action <> 'duplicate'
    or (select content_hash = public.support_intake_sha256_hex(public.support_intake_canonical_json(
      public.support_intake_persisted_message_material(id)))
      from public.intake_messages where id='message-multiple') is not true then
    raise exception 'Reversed multi-Attachment replay or persisted Message invariant failed';
  end if;

  -- Zero Attachment material also reconstructs exactly.
  v_payload := public.supper_test_intake_payload('zero','external-event-zero','external-conversation-zero',
    'external-subject-zero','external-message-zero','external-attachment-unused');
  v_payload := jsonb_set(v_payload, '{attachments}', '[]'::jsonb);
  v_payload := public.supper_test_intake_rehash(v_payload);
  select * into v_result from public.support_accept_intake_event_v3(v_payload);
  if v_result.action <> 'accepted'
    or (select content_hash = public.support_intake_sha256_hex(public.support_intake_canonical_json(
      public.support_intake_persisted_message_material(id)))
      from public.intake_messages where id='message-zero') is not true then
    raise exception 'Zero-Attachment persisted Message invariant failed';
  end if;

  -- Delivery metadata is recursively credential-safe at the database boundary.
  begin insert into public.intake_event_deliveries
    (id,event_id,channel_id,delivery_number,delivery_type,received_at,metadata)
    values ('unsafe-delivery','event-one','channel-one',999,'duplicate',now(),
      '{"nested":{"linetoken":"forbidden"}}'::jsonb);
    raise exception 'Unsafe delivery metadata was accepted';
  exception when invalid_parameter_value then if sqlerrm <> 'INTAKE_SENSITIVE_DATA_REJECTED' then raise; end if; end;
end;
$$;

create or replace function public.supper_test_corrupt_new_message_hash() returns trigger language plpgsql as $$
begin
  if new.id = 'attachment-post-write-corrupt' then
    update public.intake_messages set content_hash=repeat('f',64) where id=new.message_id;
  end if;
  return new;
end;
$$;
drop trigger if exists supper_test_corrupt_new_message_hash on public.intake_attachments;
create trigger supper_test_corrupt_new_message_hash after insert on public.intake_attachments
for each row execute function public.supper_test_corrupt_new_message_hash();
do $$
declare v_payload jsonb;
begin
  v_payload := public.supper_test_intake_payload('post-write-corrupt','external-event-post-write-corrupt',
    'external-conversation-post-write-corrupt','external-subject-post-write-corrupt',
    'external-message-post-write-corrupt','external-attachment-post-write-corrupt');
  begin perform * from public.support_accept_intake_event_v3(v_payload);
    raise exception 'Post-write Message corruption was accepted';
  exception when data_corrupted then if sqlerrm <> 'INTAKE_STORAGE_INTEGRITY_ERROR' then raise; end if; end;
  if exists (select 1 from public.intake_events where id='event-post-write-corrupt')
    or exists (select 1 from public.intake_messages where id='message-post-write-corrupt')
    or exists (select 1 from public.intake_attachments where id='attachment-post-write-corrupt')
    or exists (select 1 from public.intake_sessions where id='session-post-write-corrupt')
    or exists (select 1 from public.intake_event_deliveries where event_id='event-post-write-corrupt') then
    raise exception 'Post-write Message integrity failure did not roll back';
  end if;
end;
$$;
drop trigger if exists supper_test_corrupt_new_message_hash on public.intake_attachments;
drop function if exists public.supper_test_corrupt_new_message_hash();
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
    slow = psqlAsync(String.raw`select action from public.support_accept_intake_event_v3(public.supper_test_intake_payload(
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
    const fastResult = psql(["-Atc", String.raw`select action from public.support_accept_intake_event_v3(public.supper_test_intake_payload(
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

async function verifyGlobalLockOrderConcurrency() {
  const timed = (sql) => psqlAsync(`\\pset tuples_only on\n\\pset format unaligned\nset statement_timeout='5s';\n${sql}`)
    .then((output) => output.split("\n").at(-1)?.trim());

  const sameEvent = await Promise.all([
    timed(String.raw`select action from public.support_accept_intake_event_v3(public.supper_test_intake_two_attachment_payload(
      'lock-same-a','external-event-lock-same','external-conversation-lock-same','external-subject-lock-same',
      'external-message-lock-same','external-attachment-lock-same-a','external-attachment-lock-same-b',false));`),
    timed(String.raw`select action from public.support_accept_intake_event_v3(public.supper_test_intake_two_attachment_payload(
      'lock-same-b','external-event-lock-same','external-conversation-lock-same','external-subject-lock-same',
      'external-message-lock-same','external-attachment-lock-same-a','external-attachment-lock-same-b',true));`),
  ]);
  if (sameEvent.sort().join(",") !== "accepted,duplicate") {
    throw new Error(`Same Event reversed-Attachment concurrency failed: ${sameEvent.join(",")}`);
  }

  const sharedAttachments = await Promise.allSettled([
    timed(String.raw`select action from public.support_accept_intake_event_v3(public.supper_test_intake_two_attachment_payload(
      'lock-shared-a','external-event-lock-shared-a','external-conversation-lock-shared-a','external-subject-lock-shared-a',
      'external-message-lock-shared-a','external-attachment-lock-shared-a','external-attachment-lock-shared-b',false));`),
    timed(String.raw`select action from public.support_accept_intake_event_v3(public.supper_test_intake_two_attachment_payload(
      'lock-shared-b','external-event-lock-shared-b','external-conversation-lock-shared-b','external-subject-lock-shared-b',
      'external-message-lock-shared-b','external-attachment-lock-shared-a','external-attachment-lock-shared-b',true));`),
  ]);
  const acceptedShared = sharedAttachments.filter((result) => result.status === "fulfilled" && result.value === "accepted");
  const rejectedShared = sharedAttachments.filter((result) => result.status === "rejected"
    && /INTAKE_ATTACHMENT_REPLAY_MISMATCH/.test(String(result.reason)));
  if (acceptedShared.length !== 1 || rejectedShared.length !== 1) {
    throw new Error(`Shared Attachment concurrency did not serialize safely: ${JSON.stringify(sharedAttachments)}`);
  }

  const mixedGeneration = await Promise.all([
    timed(String.raw`select action from public.support_accept_intake_event(public.supper_test_intake_two_attachment_payload(
      'lock-mixed-old','external-event-lock-mixed','external-conversation-lock-mixed','external-subject-lock-mixed',
      'external-message-lock-mixed','external-attachment-lock-mixed-a','external-attachment-lock-mixed-b',true));`),
    timed(String.raw`select action from public.support_accept_intake_event_v3(public.supper_test_intake_two_attachment_payload(
      'lock-mixed-new','external-event-lock-mixed','external-conversation-lock-mixed','external-subject-lock-mixed',
      'external-message-lock-mixed','external-attachment-lock-mixed-a','external-attachment-lock-mixed-b',false));`),
  ]);
  if (mixedGeneration.sort().join(",") !== "accepted,duplicate") {
    throw new Error(`Legacy/current RPC concurrency failed: ${mixedGeneration.join(",")}`);
  }
}

try {
  run("initdb", ["-A", "trust", "-U", "postgres", "-D", dataDirectory, "--no-locale"]);
  mkdirSync(socketDirectory, { recursive: true });
  run("pg_ctl", ["-D", dataDirectory, "-l", logPath, "-o", `-F -k ${socketDirectory} -p ${port}`, "-w", "start"]);
  started = true;
  psql([], baseSchema);
  const pgcryptoSchema = psql(["-Atc", "select namespace.nspname from pg_extension extension join pg_namespace namespace on namespace.oid=extension.extnamespace where extension.extname='pgcrypto'"]);
  if (pgcryptoSchema !== "extensions") throw new Error(`pgcrypto is installed in ${pgcryptoSchema || "no schema"}, expected extensions`);
  const migrationDirectory = path.join(root, "supabase/migrations");
  const migrations = readdirSync(migrationDirectory).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  const intakeReplayMigration = "202607220003_unified_intake_core_replay_corrections.sql";
  const intakeFinalMigration = "202607220004_unified_intake_core_final_integrity.sql";
  const replayMigrationSql = readFileSync(path.join(migrationDirectory, intakeReplayMigration), "utf8");
  const finalMigrationSql = readFileSync(path.join(migrationDirectory, intakeFinalMigration), "utf8");
  const replayDigestCalls = [...replayMigrationSql.matchAll(/\bdigest\s*\(/giu)];
  if (replayDigestCalls.length !== 1
    || !/function public\.support_intake_sha256_hex\(p_value text\)[\s\S]*?return encode\(digest\(p_value, 'sha256'\), 'hex'\);/u.test(replayMigrationSql)) {
    throw new Error("Migration 003 contains an unresolved direct pgcrypto digest call outside the portable helper");
  }
  if (/\bdigest\s*\(/iu.test(finalMigrationSql)) {
    throw new Error("Migration 004 contains an unresolved direct pgcrypto digest call");
  }
  if (!/alter function public\.support_accept_intake_event_locked_write_impl\(jsonb\)\s+set search_path = pg_catalog, public, extensions, pg_temp;/iu.test(finalMigrationSql)) {
    throw new Error("The legacy locked write implementation does not receive the Supabase-compatible search_path");
  }
  for (const migration of migrations.filter((name) => name < intakeReplayMigration)) {
    psql(["-f", path.join(migrationDirectory, migration)]);
  }
  psql([], fixtureSql);
  psql([], legacySeedSql);
  psql(["-f", path.join(migrationDirectory, intakeReplayMigration)]);
  psql(["-f", path.join(migrationDirectory, intakeFinalMigration)]);
  psql([], pgcryptoCompatibilitySql);
  psql([], canonicalVectorSql());
  psql([], sensitiveKeyVectorSql());
  psql([], upgradeVerificationSql);
  psql([], acceptanceSql);
  psql([], finalIntegritySql);
  psql(["-f", path.join(migrationDirectory, intakeReplayMigration)]);
  psql(["-f", path.join(migrationDirectory, intakeFinalMigration)]);
  await verifyUnrelatedEventConcurrency();
  await verifyGlobalLockOrderConcurrency();

  const expectedTables = [
    "integration_channels", "integration_external_identities", "integration_identity_bindings", "integration_identity_binding_events",
    "intake_conversations", "intake_conversation_events", "intake_messages", "intake_attachments", "intake_sessions",
    "intake_session_events", "intake_events", "intake_event_deliveries", "intake_ticket_links", "integration_outbox",
  ];
  const tables = psql(["-Atc", `select tablename from pg_tables where schemaname='public' and tablename in (${expectedTables.map((name) => `'${name}'`).join(",")}) order by tablename`]).split("\n").filter(Boolean);
  if (tables.length !== expectedTables.length) throw new Error(`Missing intake tables: ${expectedTables.filter((name) => !tables.includes(name)).join(", ")}`);
  const rlsCount = Number(psql(["-Atc", `select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in (${expectedTables.map((name) => `'${name}'`).join(",")}) and c.relrowsecurity`]));
  if (rlsCount !== expectedTables.length) throw new Error("RLS is not enabled on every intake table");
  const unsafeDeliveryPrivileges = Number(psql(["-Atc", "select count(*) from information_schema.table_privileges where table_schema='public' and table_name='intake_event_deliveries' and grantee in ('PUBLIC','anon','authenticated')"]));
  if (unsafeDeliveryPrivileges !== 0) throw new Error("The delivery ledger is accessible to a browser role");
  const mutableDeliveryPrivileges = Number(psql(["-Atc", "select count(*) from information_schema.table_privileges where table_schema='public' and table_name='intake_event_deliveries' and grantee='service_role' and privilege_type in ('UPDATE','DELETE','TRUNCATE')"]));
  if (mutableDeliveryPrivileges !== 0) throw new Error("The service role can mutate the append-only delivery ledger");
  const deliveryServicePrivileges = psql(["-Atc", "select string_agg(privilege_type, ',' order by privilege_type) from information_schema.table_privileges where table_schema='public' and table_name='intake_event_deliveries' and grantee='service_role'"]);
  if (deliveryServicePrivileges !== "INSERT,SELECT") throw new Error(`Unexpected delivery-ledger service grants: ${deliveryServicePrivileges}`);
  const functions = [
    "support_get_intake_operations_summary", "support_list_intake_identities", "support_list_intake_conversations",
    "support_list_intake_events", "support_accept_intake_event", "support_apply_intake_identity_binding",
    "support_revoke_intake_identity_binding", "support_transition_intake_session", "support_transition_intake_conversation",
    "support_enqueue_integration_outbox", "support_apply_intake_identity_binding_v2",
    "support_transition_intake_conversation_v2", "support_enqueue_integration_outbox_v2",
    "support_accept_intake_event_v2", "support_accept_intake_event_v3",
  ];
  const unsafe = Number(psql(["-Atc", `select count(*) from information_schema.routine_privileges where routine_schema='public' and routine_name in (${functions.map((name) => `'${name}'`).join(",")}) and grantee in ('PUBLIC','anon','authenticated') and privilege_type='EXECUTE'`]));
  if (unsafe !== 0) throw new Error("A privileged intake RPC is executable by a browser role");
  const serviceGrants = Number(psql(["-Atc", `select count(distinct routine_name) from information_schema.routine_privileges where routine_schema='public' and routine_name in (${functions.map((name) => `'${name}'`).join(",")}) and grantee='service_role' and privilege_type='EXECUTE'`]));
  if (serviceGrants !== functions.length) throw new Error("service_role is missing an intake RPC grant");
  const internalGrants = Number(psql(["-Atc", "select count(*) from information_schema.routine_privileges where routine_schema='public' and routine_name in ('support_accept_intake_event_final_impl','support_accept_intake_event_locked_write_impl') and grantee in ('PUBLIC','anon','authenticated','service_role') and privilege_type='EXECUTE'"]));
  if (internalGrants !== 0) throw new Error("An internal intake acceptance implementation is directly executable");
  const helperGrants = Number(psql(["-Atc", "select count(*) from information_schema.routine_privileges where routine_schema='public' and routine_name='support_intake_sha256_hex' and grantee in ('PUBLIC','anon','authenticated','service_role') and privilege_type='EXECUTE'"]));
  if (helperGrants !== 0) throw new Error("The portable SHA-256 helper is directly executable outside its owner");
  const expectedSearchPath = "search_path=pg_catalog, public, extensions, pg_temp";
  const helperSearchPath = psql(["-Atc", "select array_to_string(proconfig, ',') from pg_proc where oid='public.support_intake_sha256_hex(text)'::regprocedure"]);
  if (helperSearchPath !== expectedSearchPath) throw new Error(`Portable SHA-256 helper has an unsafe search_path: ${helperSearchPath}`);
  const legacySearchPath = psql(["-Atc", "select array_to_string(proconfig, ',') from pg_proc where oid='public.support_accept_intake_event_locked_write_impl(jsonb)'::regprocedure"]);
  if (legacySearchPath !== expectedSearchPath) throw new Error(`Legacy locked write implementation has an unsafe search_path: ${legacySearchPath}`);
  const unsafePgcryptoFunctions = psql(["-Atc", `select coalesce(string_agg(procedure.proname, ',' order by procedure.proname), '')
    from pg_proc procedure join pg_namespace namespace on namespace.oid=procedure.pronamespace
    where namespace.nspname='public' and procedure.prokind='f'
      and procedure.proname like 'support_%intake%'
      and procedure.prosrc ~ '\\mdigest[[:space:]]*\\('
      and (procedure.proconfig is null or not ('${expectedSearchPath}' = any(procedure.proconfig)))`]);
  if (unsafePgcryptoFunctions) throw new Error(`Intake functions contain unresolved pgcrypto calls: ${unsafePgcryptoFunctions}`);
  const deliveryTriggerCount = Number(psql(["-Atc", "select count(*) from pg_trigger where tgrelid='public.intake_events'::regclass and tgname='support_intake_event_delivery_ledger' and not tgisinternal"]));
  if (deliveryTriggerCount !== 0) throw new Error("Legacy Event delivery trigger is still active");
  const versions = psql(["-Atc", "select string_agg(version, ',' order by version) from public.support_schema_migrations where version in ('202607220001','202607220002','202607220003','202607220004')"]);
  if (versions !== "202607220001,202607220002,202607220003,202607220004") throw new Error("Intake migration versions were not recorded");

  const migration = finalMigrationSql;
  if (/integration_channels[^;]{0,500}for update/is.test(migration)) throw new Error("Event acceptance still serializes the whole Channel row");
  for (const scope of ["intake-event:", "intake-message:", "intake-conversation:", "intake-identity:", "intake-attachment:"]) {
    if (!migration.includes(scope)) throw new Error(`Missing scoped concurrency lock: ${scope}`);
  }
  for (const wrapper of ["support_accept_intake_event", "support_accept_intake_event_v2", "support_accept_intake_event_v3"]) {
    if (!new RegExp(`function public\\.${wrapper}\\(p_payload jsonb\\)[\\s\\S]*?support_accept_intake_event_final_impl\\(p_payload\\)`).test(migration)) {
      throw new Error(`${wrapper} does not delegate to the final acceptance implementation`);
    }
  }
  const repository = readFileSync(path.join(root, "src/lib/intake-core/relational-repository.ts"), "utf8");
  if (!repository.includes('rpc("support_accept_intake_event_v3"') || repository.includes('rpc("support_accept_intake_event_v2"')) {
    throw new Error("The relational repository is not pinned to the final intake RPC");
  }
  if (!/listConversationMessages[\s\S]*?\.range\(from, to\)/.test(repository)
    || !/listConversationAttachments[\s\S]*?\.range\(from, to\)/.test(repository)) throw new Error("Child read pagination is not enforced at storage");
  if (/listConversationMessages[\s\S]*?body_html/.test(repository)) throw new Error("Conversation Messages expose raw HTML");
  if (/listConversationAttachments[\s\S]*?provider_locator/.test(repository)) throw new Error("Conversation Attachments expose provider locators");
  const binaryColumns = Number(psql(["-Atc", "select count(*) from information_schema.columns where table_schema='public' and table_name='intake_attachments' and column_name ~* '(bytes|binary|blob|base64|content_data)'"]));
  if (binaryColumns !== 0) throw new Error("Unified Intake added Attachment byte storage");
  if (Number(psql(["-Atc", "select count(*) from public.support_tickets"])) !== 0) throw new Error("Unified Intake created a SUPPER Ticket");

  console.log("Unified intake final integrity migrations upgraded real 1.3.1 state under a Supabase-style extensions.pgcrypto layout and reapplied safely; portable hashing, all acceptance RPC generations, immutable Attachment hashes, duplicate rejection, persisted Message reconstruction, current delivery context, scoped concurrency, grants, and intent-only behavior passed.");
} finally {
  if (started) spawnSync("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"], { encoding: "utf8" });
  for (const target of [dataDirectory, socketDirectory, logPath]) if (existsSync(target)) rmSync(target, { recursive: true, force: true });
}
