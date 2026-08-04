import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

const root = process.cwd();
const suffix = `${process.pid}`;
const dataDirectory = `/tmp/supper-write-pg-data-${suffix}`;
const socketDirectory = `/tmp/supper-write-pg-socket-${suffix}`;
const logPath = `/tmp/supper-write-pg-${suffix}.log`;
const port = String(56_000 + (process.pid % 1_000));
let started = false;

const manualIdentitySource = readFileSync(
  path.join(root, "src/lib/integrations/servicenow/write/manual-operation.ts"),
  "utf8",
);
const writeServiceSource = readFileSync(
  path.join(root, "src/lib/integrations/servicenow/write/service.ts"),
  "utf8",
);
const writeAdapterSource = readFileSync(
  path.join(root, "src/lib/integrations/servicenow/write/adapter.ts"),
  "utf8",
);
const writeIdempotencySource = readFileSync(
  path.join(root, "src/lib/integrations/servicenow/write/idempotency.ts"),
  "utf8",
);
const writeUiSource = readFileSync(
  path.join(root, "src/components/servicenow-write-controls.tsx"),
  "utf8",
);
const writeTypesSource = readFileSync(
  path.join(root, "src/lib/integrations/servicenow/write/types.ts"),
  "utf8",
);
const writeMigrationSource = readFileSync(
  path.join(root, "supabase/migrations/202607230001_servicenow_write_kernel.sql"),
  "utf8",
);
for (const required of [
  "SignJWT",
  "jwtVerify",
  "operationReference",
  "commandType",
  "sourceEntityReference",
  "environment",
  "expiresAt",
]) {
  if (!manualIdentitySource.includes(required)) {
    throw new Error(`Manual operation identity is missing ${required}`);
  }
}
for (const required of [
  "recoverable_at",
  "provider_request_budget",
  "recovery_budget_ms",
  "recovery_lease_version",
  "SERVICENOW_WRITE_ATTEMPT_RECOVERY_TOO_EARLY",
  "recoveryOperationProviderRequestPerformed",
  "originalMutationOutcome",
  "exactMarkerVerified",
  "correlation_marker_exact",
  "SERVICENOW_WRITE_TARGET_CONTINUITY_CONFLICT",
  "SERVICENOW_WRITE_ATTEMPT_ALREADY_RECOVERED",
  "lookupCorrelationMarkerHash",
  "verifiedCorrelationMarkerHash",
]) {
  if (!writeMigrationSource.includes(required)) {
    throw new Error(`ServiceNow recovery proof migration is missing ${required}`);
  }
}
if (writeMigrationSource.includes("'recoveredByAdministrator',true,\n      'providerWritePerformed',false")) {
  throw new Error("Administrative recovery still claims the original provider mutation was absent");
}
if (writeServiceSource.includes("`manual-op:${commandId}`")) {
  throw new Error("Manual operation identity is still derived from a per-request command ID");
}
if (!writeUiSource.includes("setManualOperation(operation)")
  || !writeUiSource.includes("manualOperationToken: operation.operationToken")
  || !writeUiSource.includes("duplicateJournalRiskAcknowledged")
  || !writeUiSource.includes("mutationCandidateRiskAcknowledged")
  || !writeUiSource.includes("event.evidenceClassification")) {
  throw new Error("ServiceNow write controls are missing operation replay or reconciliation evidence safeguards");
}
for (const required of [
  "ledgerRuntime",
  "providerRuntime",
  "optionalProviderRuntime",
]) {
  if (!writeServiceSource.includes(required)) {
    throw new Error(`ServiceNow recovery runtime is missing ${required}`);
  }
}
for (const classification of [
  "provider_matched",
  "provider_not_found",
  "provider_ambiguous",
  "provider_inconclusive",
  "provider_target_conflict",
  "provider_unavailable",
  "provider_unavailable_manual_verification",
  "provider_target_matched_manual_verification",
  "journal_manual_verification",
]) {
  if (!writeTypesSource.includes(classification)
    || !writeServiceSource.includes(classification)) {
    throw new Error(`ServiceNow reconciliation evidence is missing ${classification}`);
  }
}
for (const required of [
  "SERVICENOW_WRITE_LOOKUP_MISMATCH",
  "mutationCandidate",
  "SERVICENOW_WRITE_POST_CREATE_NOT_FOUND",
  "correlation_id",
  "expected.number",
  "expected.sysId",
  "expected.correlationMarker",
  "postWriteMarkerVerified",
  "postWriteLookupHttpStatus",
]) {
  if (!writeAdapterSource.includes(required)) {
    throw new Error(`ServiceNow exact lookup verification is missing ${required}`);
  }
}
for (const required of [
  "servicenow-write-command-material-v1",
  "buildServiceNowWritePayloadMaterial(input.payload)",
  "maxAttempts",
]) {
  if (!writeIdempotencySource.includes(required)) {
    throw new Error(`ServiceNow command material is missing ${required}`);
  }
}

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
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
alter database postgres set search_path = pg_catalog, public, extensions;
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
create table public.support_users (
  id text primary key, username text not null, data jsonb not null default '{}'::jsonb
);
create table public.support_customers (
  id text primary key, customer_key text not null unique, customer_name text not null,
  project_code text not null default '', active boolean not null default true,
  end_period date, data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);
create table public.support_tickets (
  id text primary key, issue_id text not null unique, customer_key text not null,
  customer_name text not null, kanban_status text not null, status text not null,
  issue_type text not null, severity text not null, ticket_date date, start_date date,
  due_date date, close_date date, data jsonb not null, updated_at timestamptz not null
);
insert into public.support_customers (
  id,customer_key,customer_name,project_code,active,data
) values ('customer-write','customer-write','Write verifier','TEST',true,'{}');
insert into public.support_tickets (
  id,issue_id,customer_key,customer_name,kanban_status,status,issue_type,severity,data,updated_at
) values (
  'ticket-write-00000001','WRITE-1','customer-write','Write verifier',
  'open','open','Incident','Medium','{}',now()
), (
  'ticket-write-00000002','WRITE-2','customer-write','Write verifier',
  'open','open','Incident','Medium','{}',now()
);
`;

const acceptanceSqlTemplate = String.raw`
create or replace function public.supper_test_iso(p_value timestamptz)
returns text
language sql
immutable
as $$
  select to_char(p_value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
$$;

select * from public.support_upsert_servicenow_write_connection(jsonb_build_object(
  'id','connection-test-00000001','name','Test PDI','active',true,
  'authMode','basic','instanceUrl','https://example.service-now.com',
  'incidentTable','incident','configVersion','unversioned',
  'configurationFingerprint','b32a9f49f25d2986b9c37ec94bc6d32fbb5242969c83727cf3d65cb912f9c274',
  'timeoutMs',60000,
  'metadata',jsonb_build_object('source','sql-test'),
  'updatedAt','2026-07-23T01:00:00.000Z'
));

select * from public.support_upsert_servicenow_write_mapping(jsonb_build_object(
  'id','mapping-create-00000001','connectionId','connection-test-00000001',
  'commandType','create_incident','mappingName','SUPPER default','active',true,
  'fieldMapping','{
    "shortDescription":"short_description","description":"description",
    "callerId":"caller_id","category":"category","subcategory":"subcategory",
    "impact":"impact","urgency":"urgency","assignmentGroup":"assignment_group",
    "contactChannel":"contact_type","customer":"company","projectCode":"u_project_code"
  }'::jsonb,'metadata','{}'::jsonb,'updatedAt','2026-07-23T01:00:00.000Z'
));

select * from public.support_upsert_servicenow_write_mapping(jsonb_build_object(
  'id','mapping-update-00000001','connectionId','connection-test-00000001',
  'commandType','update_incident','mappingName','SUPPER default','active',true,
  'fieldMapping','{
    "shortDescription":"short_description","description":"description","state":"state",
    "impact":"impact","urgency":"urgency","assignmentGroup":"assignment_group",
    "customer":"company","projectCode":"u_project_code"
  }'::jsonb,'metadata','{}'::jsonb,'updatedAt','2026-07-23T01:00:00.000Z'
));

select * from public.support_upsert_servicenow_write_mapping(jsonb_build_object(
  'id','mapping-comment-00000001','connectionId','connection-test-00000001',
  'commandType','add_comment','mappingName','SUPPER default','active',true,
  'fieldMapping','{"text":"comments"}'::jsonb,
  'metadata','{}'::jsonb,'updatedAt','2026-07-23T01:00:00.000Z'
));

select * from public.support_upsert_servicenow_write_mapping(jsonb_build_object(
  'id','mapping-work-note-000001','connectionId','connection-test-00000001',
  'commandType','add_work_note','mappingName','SUPPER default','active',true,
  'fieldMapping','{"text":"work_notes"}'::jsonb,
  'metadata','{}'::jsonb,'updatedAt','2026-07-23T01:00:00.000Z'
));

select * from public.support_record_servicenow_write_readiness(jsonb_build_object(
  'connectionId','connection-test-00000001',
  'configurationFingerprint','b32a9f49f25d2986b9c37ec94bc6d32fbb5242969c83727cf3d65cb912f9c274',
  'testedAt','2026-07-23T01:00:00.000Z',
  'expiresAt','2026-07-23T01:10:00.000Z',
  'testStatus','succeeded','safeHttpStatus',200,
  'testedByUserId','admin-user','safeErrorCode','',
  'updatedAt','2026-07-23T01:00:00.000Z'
));

create or replace function public.supper_test_write_payload(
  p_command_id text,
  p_operation_reference text,
  p_description text default 'Safe SQL test body',
  p_source_type text default 'manual',
  p_source_entity_reference text default null
)
returns jsonb
language plpgsql
as $$
declare
  v_payload jsonb;
  v_mapping jsonb;
  v_key text;
  v_normalized jsonb;
  v_hash text;
  v_command_hash text;
begin
  v_payload := jsonb_build_object(
    'shortDescription','SQL test','description',p_description
  );
  select field_mapping into v_mapping from public.servicenow_write_mappings
  where id='mapping-create-00000001';
  v_key := public.support_servicenow_write_idempotency_hash(
    'connection-test-00000001','create_incident',p_operation_reference,
    p_source_type,p_source_entity_reference,'incident'
  );
  v_normalized := public.support_servicenow_write_normalize(
    'create_incident',v_payload,v_mapping,v_key
  );
  v_hash := public.support_servicenow_write_normalized_hash(v_normalized);
  v_command_hash := public.support_servicenow_write_command_material_hash(
    'connection-test-00000001','mapping-create-00000001','create_incident',
    p_source_type,coalesce(p_source_entity_reference,''),p_operation_reference,
    'incident',v_payload,3
  );
  return jsonb_build_object(
    'commandId',p_command_id,'commandType','create_incident',
    'idempotencyKey',v_key,'commandMaterialHash',v_command_hash,
    'normalizedPayloadHash',v_hash,
    'connectionId','connection-test-00000001','mappingId','mapping-create-00000001',
    'sourceType',p_source_type,'sourceEntityReference',coalesce(p_source_entity_reference,''),
    'operationReference',p_operation_reference,'targetTable','incident',
    'targetSysId','','targetNumber','',
    'providerCorrelationMarker',v_normalized->>'providerCorrelationMarker',
    'payload',v_payload,'normalizedPayload',v_normalized,
    'validationSummary',jsonb_build_object(
      'valid',true,'mappedFieldCount',3,
      'mappedFields',jsonb_build_array('correlation_id','description','short_description'),
      'warningCodes','[]'::jsonb
    ),
    'maxAttempts',3,'createdBy','admin-user',
    'requestId','request-write-sql-0001',
    'correlationId','correlation-write-sql-0001',
    'createdAt','2026-07-23T01:00:00.000Z'
  );
end;
$$;

create or replace function public.supper_test_write_payload_for(
  p_command_id text,
  p_command_type text,
  p_operation_reference text,
  p_payload jsonb,
  p_source_type text default 'supper_ticket',
  p_source_entity_reference text default 'ticket-write-00000001'
)
returns jsonb
language plpgsql
as $$
declare
  v_mapping_id text;
  v_mapping jsonb;
  v_key text;
  v_normalized jsonb;
  v_hash text;
  v_command_hash text;
  v_field_count integer;
begin
  select id,field_mapping into v_mapping_id,v_mapping
  from public.servicenow_write_mappings
  where connection_id='connection-test-00000001'
    and command_type=p_command_type and active;
  v_key := public.support_servicenow_write_idempotency_hash(
    'connection-test-00000001',p_command_type,p_operation_reference,
    p_source_type,p_source_entity_reference,'incident'
  );
  v_normalized := public.support_servicenow_write_normalize(
    p_command_type,p_payload,v_mapping,v_key
  );
  v_hash := public.support_servicenow_write_normalized_hash(v_normalized);
  v_command_hash := public.support_servicenow_write_command_material_hash(
    'connection-test-00000001',v_mapping_id,p_command_type,
    p_source_type,coalesce(p_source_entity_reference,''),p_operation_reference,
    'incident',p_payload,3
  );
  select count(*) into v_field_count from jsonb_object_keys(v_normalized->'fields');
  return jsonb_build_object(
    'commandId',p_command_id,'commandType',p_command_type,
    'idempotencyKey',v_key,'commandMaterialHash',v_command_hash,
    'normalizedPayloadHash',v_hash,
    'connectionId','connection-test-00000001','mappingId',v_mapping_id,
    'sourceType',p_source_type,'sourceEntityReference',coalesce(p_source_entity_reference,''),
    'operationReference',p_operation_reference,'targetTable','incident',
    'targetSysId',coalesce(v_normalized->>'targetSysId',''),
    'targetNumber',coalesce(v_normalized->>'targetNumber',''),
    'providerCorrelationMarker',coalesce(v_normalized->>'providerCorrelationMarker',''),
    'payload',p_payload,'normalizedPayload',v_normalized,
    'validationSummary',jsonb_build_object(
      'valid',true,'mappedFieldCount',v_field_count,
      'mappedFields','[]'::jsonb,'warningCodes','[]'::jsonb
    ),
    'maxAttempts',3,'createdBy','admin-user',
    'requestId','request-write-sql-0001',
    'correlationId','correlation-write-sql-0001',
    'createdAt','2026-07-23T01:00:00.000Z'
  );
end;
$$;

create or replace function public.supper_test_rehash_write_payload(p_command jsonb)
returns jsonb
language sql
as $$
  select jsonb_set(
    p_command,
    '{commandMaterialHash}',
    to_jsonb(public.support_servicenow_write_command_material_hash(
      p_command->>'connectionId',
      p_command->>'mappingId',
      p_command->>'commandType',
      p_command->>'sourceType',
      p_command->>'sourceEntityReference',
      p_command->>'operationReference',
      p_command->>'targetTable',
      p_command->'payload',
      (p_command->>'maxAttempts')::integer
    ))
  );
$$;

create or replace function public.supper_test_prepare_reconciliation(
  p_command_id text,
  p_command_type text,
  p_operation_reference text
)
returns void
language plpgsql
as $$
declare
  v_payload jsonb;
begin
  if p_command_type = 'create_incident' then
    perform * from public.support_create_servicenow_write_command(
      public.supper_test_write_payload(
        p_command_id,
        'manual-op:'||p_operation_reference,
        'Reconciliation matrix test'
      )
    );
  else
    v_payload := case p_command_type
      when 'update_incident' then
        jsonb_build_object('sysId',repeat('d',32),'state','2')
      when 'add_comment' then
        jsonb_build_object('number','INC0010001','text','Reviewed matrix comment')
      when 'add_work_note' then
        jsonb_build_object('sysId',repeat('d',32),'text','Reviewed matrix work note')
      else null
    end;
    perform * from public.support_create_servicenow_write_command(
      public.supper_test_write_payload_for(
        p_command_id,
        p_command_type,
        p_operation_reference,
        v_payload
      )
    );
  end if;
  update public.servicenow_write_commands
  set status='reconciliation_required',
    delivery_disposition='may_have_committed',
    failure_phase='read_back',
    retry_allowed=false,
    next_retry_at=null
  where id=p_command_id;
end;
$$;

do $$
declare
  v_version integer;
  v_hash text;
  v_nonce text := public.support_intake_sha256_hex('reconcile-exact-update-proof');
  v_sys_id text := repeat('c',32);
  v_number text := 'INC0081001';
begin
  perform * from public.support_create_servicenow_write_command(
    public.supper_test_write_payload_for(
      'reconcile-exact-update-proof','update_incident',
      'manual-op:reconcile-exact-update-proof',
      jsonb_build_object('sysId',v_sys_id,'state','2'),
      'supper_ticket','ticket-write-00000002'
    )
  );
  update public.servicenow_write_commands set
    status='reconciliation_required',delivery_disposition='may_have_committed',
    failure_phase='read_back',retry_allowed=false,next_retry_at=null
  where id='reconcile-exact-update-proof';
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='reconcile-exact-update-proof';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','reconcile-exact-update-proof','action','reconcile_by_read_back',
    'actorUserId','admin-user','expectedVersion',v_version,
    'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',v_nonce,
    'issuedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
  ));
  begin
    perform * from public.support_reconcile_servicenow_write_command(jsonb_build_object(
      'commandId','reconcile-exact-update-proof','action','reconcile_by_read_back',
      'result','confirmed_succeeded','safeReadBackSummary','{}'::jsonb,
      'targetSysId',v_sys_id,'targetNumber',v_number,'actorUserId','admin-user',
      'requestId','request-reconcile-empty-proof',
      'checkedAt',public.supper_test_iso(statement_timestamp()),
      'confirmed',true,'expectedVersion',v_version,
      'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',v_nonce
    ));
    raise exception 'Empty successful update reconciliation evidence was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_RECONCILIATION_EVIDENCE_INVALID' then raise; end if;
  end;
  if exists (
    select 1 from public.servicenow_ticket_links
    where supper_ticket_id='ticket-write-00000002'
  ) then
    raise exception 'Invalid update reconciliation evidence created a Ticket link';
  end if;
  perform * from public.support_reconcile_servicenow_write_command(jsonb_build_object(
    'commandId','reconcile-exact-update-proof','action','reconcile_by_read_back',
    'result','confirmed_succeeded','safeReadBackSummary',jsonb_build_object(
      'method','exact_sys_id','requestMethod','GET',
      'endpointPath','/api/now/table/incident/'||v_sys_id,
      'targetTable','incident','fieldNames',jsonb_build_array('state'),
      'matchedFields',1,'expectedFields',1,
      'evidenceClassification','provider_matched',
      'targetSysId',v_sys_id,'targetNumber',v_number
    ),
    'targetSysId',v_sys_id,'targetNumber',v_number,'actorUserId','admin-user',
    'requestId','request-reconcile-exact-proof',
    'checkedAt',public.supper_test_iso(statement_timestamp()),
    'confirmed',true,'expectedVersion',v_version,
    'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',v_nonce
  ));
  if not exists (
    select 1 from public.servicenow_write_commands command_record
    join public.servicenow_ticket_links ticket_link
      on ticket_link.supper_ticket_id=command_record.source_entity_reference
    where command_record.id='reconcile-exact-update-proof'
      and command_record.status='succeeded'
      and ticket_link.servicenow_sys_id=v_sys_id
      and ticket_link.servicenow_number=v_number
  ) then
    raise exception 'Exact successful update reconciliation proof was not accepted';
  end if;
end;
$$;

do $$
declare
  v_case record;
  v_command_id text;
  v_version integer;
  v_hash text;
  v_nonce text;
  v_attempt_id text;
  v_payload jsonb;
  v_attempt record;
begin
  for v_case in
    select * from (values
      ('create','create_incident',3,300000),
      ('number','update_incident',2,240000),
      ('sys-id','update_incident',1,180000)
    ) as lease_case(suffix,command_type,expected_requests,expected_budget_ms)
  loop
    v_command_id := 'lease-budget-'||v_case.suffix;
    v_attempt_id := 'attempt-lease-budget-'||v_case.suffix;
    v_payload := case v_case.command_type
      when 'create_incident' then public.supper_test_write_payload(
        v_command_id,'manual-op:lease-budget:'||v_case.suffix,'Lease budget verifier'
      )
      else public.supper_test_write_payload_for(
        v_command_id,'update_incident','manual-op:lease-budget:'||v_case.suffix,
        case when v_case.suffix='number'
          then jsonb_build_object('number','INC0060001','state','2')
          else jsonb_build_object('sysId',repeat('6',32),'state','2') end
      )
    end;
    perform * from public.support_create_servicenow_write_command(v_payload);
    select version,normalized_payload_hash into v_version,v_hash
    from public.servicenow_write_commands where id=v_command_id;
    v_nonce := public.support_intake_sha256_hex('lease-budget:'||v_case.suffix);
    perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
      'commandId',v_command_id,'action','execute','actorUserId','admin-user',
      'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',v_nonce,
      'issuedAt',public.supper_test_iso(statement_timestamp()),
      'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
    ));
    perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
      'commandId',v_command_id,'attemptId',v_attempt_id,
      'executionMode','live','retry',false,'requestId','request-'||v_command_id,
      'startedAt',public.supper_test_iso(statement_timestamp()),
      'actorUserId','admin-user','confirmed',true,'expectedVersion',v_version,
      'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',v_nonce
    ));
    select * into v_attempt from public.servicenow_write_attempts where id=v_attempt_id;
    if v_attempt.provider_request_budget<>v_case.expected_requests
      or v_attempt.recovery_budget_ms<>v_case.expected_budget_ms
      or round(extract(epoch from (v_attempt.recoverable_at-v_attempt.started_at))*1000)::integer
        <>v_case.expected_budget_ms
      or v_attempt.recoverable_at<=statement_timestamp() then
      raise exception 'Operation-wide recovery budget failed for %',v_case.suffix;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_case record;
  v_version integer;
  v_hash text;
  v_nonce text;
  v_command_id text;
  v_invalid record;
  v_valid_request jsonb;
  v_valid_response jsonb;
begin
  for v_case in
    select * from (values
      ('update-sys-id','update_incident',jsonb_build_object('sysId',repeat('d',32),'state','2'),repeat('e',32),'INC0070001',repeat('d',32),'INC0070001'),
      ('update-number','update_incident',jsonb_build_object('number','INC0070002','state','2'),repeat('e',32),'INC0099999',repeat('e',32),'INC0070002'),
      ('comment-number','add_comment',jsonb_build_object('number','INC0070003','text','Continuity comment'),repeat('e',32),'INC0099999',repeat('e',32),'INC0070003'),
      ('work-note-sys-id','add_work_note',jsonb_build_object('sysId',repeat('d',32),'text','Continuity work note'),repeat('e',32),'INC0070004',repeat('d',32),'INC0070004')
    ) as continuity_case(
      suffix,command_type,payload,conflict_sys_id,conflict_number,
      valid_sys_id,valid_number
    )
  loop
    v_command_id := 'continuity-'||v_case.suffix;
    perform * from public.support_create_servicenow_write_command(
      public.supper_test_write_payload_for(
        v_command_id,v_case.command_type,'manual-op:continuity:'||v_case.suffix,
        v_case.payload,'manual',null
      )
    );
    select version,normalized_payload_hash into v_version,v_hash
    from public.servicenow_write_commands where id=v_command_id;
    v_nonce := public.support_intake_sha256_hex('continuity:'||v_case.suffix);
    perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
      'commandId',v_command_id,'action','execute','actorUserId','admin-user',
      'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',v_nonce,
      'issuedAt',public.supper_test_iso(statement_timestamp()),
      'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
    ));
    perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
      'commandId',v_command_id,'attemptId','attempt-'||v_command_id,
      'executionMode','live','retry',false,'requestId','request-'||v_command_id,
      'startedAt',public.supper_test_iso(statement_timestamp()),
      'actorUserId','admin-user','confirmed',true,'expectedVersion',v_version,
      'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',v_nonce
    ));
    begin
      perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
        'commandId',v_command_id,'attemptId','attempt-'||v_command_id,
        'outcome','succeeded','deliveryDisposition','confirmed_succeeded',
        'failurePhase','','retryAllowed',false,'retryReason','','reconciliationReason','',
        'requestSummary',jsonb_build_object(
          'method','PATCH','endpointPath','/api/now/table/incident/'||v_case.conflict_sys_id,
          'targetTable','incident','fieldNames',case v_case.command_type
            when 'update_incident' then jsonb_build_array('state')
            when 'add_comment' then jsonb_build_array('comments')
            else jsonb_build_array('work_notes') end,
          'targetSysId',v_case.conflict_sys_id,'targetNumber',v_case.conflict_number
        ),
        'responseSummary',jsonb_build_object(
          'httpStatus',200,'sysId',v_case.conflict_sys_id,'number',v_case.conflict_number
        ),
        'targetSysId',v_case.conflict_sys_id,'targetNumber',v_case.conflict_number,
        'errorCode','','errorMessage','',
        'finishedAt',public.supper_test_iso(statement_timestamp())
      ));
      raise exception 'Non-create target continuity conflict % was accepted',v_case.suffix;
    exception when invalid_parameter_value then
      if sqlerrm<>'SERVICENOW_WRITE_TARGET_CONTINUITY_CONFLICT' then raise; end if;
    end;
    if not exists (
      select 1 from public.servicenow_write_commands command_record
      join public.servicenow_write_attempts attempt_record
        on attempt_record.command_id=command_record.id
      where command_record.id=v_command_id
        and command_record.status='executing'
        and attempt_record.outcome='executing'
        and not exists (
          select 1 from public.servicenow_ticket_links ticket_link
          where ticket_link.servicenow_sys_id=v_case.conflict_sys_id
            and ticket_link.servicenow_number=v_case.conflict_number
        )
    ) then
      raise exception 'Continuity conflict % changed command, Attempt, or Ticket link state',v_case.suffix;
    end if;
    v_valid_request := jsonb_build_object(
      'method','PATCH','endpointPath','/api/now/table/incident/'||v_case.valid_sys_id,
      'targetTable','incident','fieldNames',case v_case.command_type
        when 'update_incident' then jsonb_build_array('state')
        when 'add_comment' then jsonb_build_array('comments')
        else jsonb_build_array('work_notes') end,
      'targetSysId',v_case.valid_sys_id,'targetNumber',v_case.valid_number
    );
    v_valid_response := jsonb_build_object(
      'httpStatus',200,'sysId',v_case.valid_sys_id,'number',v_case.valid_number
    );
    for v_invalid in
      select * from (values
        ('empty-request','{}'::jsonb,v_valid_response),
        ('empty-response',v_valid_request,'{}'::jsonb),
        ('wrong-method',jsonb_set(v_valid_request,'{method}','"GET"'::jsonb),v_valid_response),
        ('wrong-endpoint',jsonb_set(v_valid_request,'{endpointPath}','"/api/now/table/incident/bad"'::jsonb),v_valid_response),
        ('wrong-request-sys-id',jsonb_set(v_valid_request,'{targetSysId}',to_jsonb(repeat('9',32))),v_valid_response),
        ('wrong-response-sys-id',v_valid_request,jsonb_set(v_valid_response,'{sysId}',to_jsonb(repeat('9',32)))),
        ('wrong-number',v_valid_request,jsonb_set(v_valid_response,'{number}','"INC0099999"'::jsonb)),
        ('forged-status',v_valid_request,jsonb_set(v_valid_response,'{httpStatus}','500'::jsonb)),
        ('extra-response-evidence',v_valid_request,v_valid_response||jsonb_build_object('rawBody','forbidden')),
        ('incorrect-field',jsonb_set(v_valid_request,'{fieldNames}',case
          when v_case.command_type='add_comment' then '["work_notes"]'::jsonb
          when v_case.command_type='add_work_note' then '["comments"]'::jsonb
          else '["description"]'::jsonb end),v_valid_response)
      ) as invalid_evidence(suffix,request_summary,response_summary)
    loop
      begin
        perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
          'commandId',v_command_id,'attemptId','attempt-'||v_command_id,
          'outcome','succeeded','deliveryDisposition','confirmed_succeeded',
          'failurePhase','','retryAllowed',false,'retryReason','','reconciliationReason','',
          'requestSummary',v_invalid.request_summary,
          'responseSummary',v_invalid.response_summary,
          'targetSysId',v_case.valid_sys_id,'targetNumber',v_case.valid_number,
          'errorCode','','errorMessage','',
          'finishedAt',public.supper_test_iso(statement_timestamp())
        ));
        raise exception 'Invalid non-create evidence %/% was accepted',v_case.suffix,v_invalid.suffix;
      exception when invalid_parameter_value then
        if sqlerrm<>'SERVICENOW_WRITE_RESULT_INVALID' then raise; end if;
      end;
      if exists (
        select 1 from public.servicenow_ticket_links ticket_link
        where ticket_link.servicenow_sys_id=v_case.valid_sys_id
          and ticket_link.servicenow_number=v_case.valid_number
      ) then
        raise exception 'Invalid non-create evidence %/% created a Ticket link',v_case.suffix,v_invalid.suffix;
      end if;
    end loop;
    perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
      'commandId',v_command_id,'attemptId','attempt-'||v_command_id,
      'outcome','succeeded','deliveryDisposition','confirmed_succeeded',
      'failurePhase','','retryAllowed',false,'retryReason','','reconciliationReason','',
      'requestSummary',v_valid_request,
      'responseSummary',v_valid_response,
      'targetSysId',v_case.valid_sys_id,'targetNumber',v_case.valid_number,
      'errorCode','','errorMessage','',
      'finishedAt',public.supper_test_iso(statement_timestamp())
    ));
    if not exists (
      select 1 from public.servicenow_write_commands
      where id=v_command_id and status='succeeded'
        and target_sys_id=v_case.valid_sys_id
        and target_number=v_case.valid_number
    ) then
      raise exception 'Safe missing counterpart resolution % was not persisted',v_case.suffix;
    end if;
  end loop;
  for v_case in
    select * from (values
      ('update-read-back','update_incident','reconcile_by_read_back',jsonb_build_object('sysId',repeat('d',32),'state','2'),repeat('e',32),'INC0080001'),
      ('comment-manual','add_comment','mark_succeeded_after_verification',jsonb_build_object('number','INC0080002','text','Continuity comment review'),repeat('e',32),'INC0099999'),
      ('work-note-manual','add_work_note','mark_succeeded_after_verification',jsonb_build_object('sysId',repeat('d',32),'text','Continuity work note review'),repeat('e',32),'INC0080003')
    ) as reconciliation_continuity(
      suffix,command_type,action,payload,conflict_sys_id,conflict_number
    )
  loop
    v_command_id := 'reconcile-continuity-'||v_case.suffix;
    perform * from public.support_create_servicenow_write_command(
      public.supper_test_write_payload_for(
        v_command_id,v_case.command_type,'manual-op:reconcile-continuity:'||v_case.suffix,
        v_case.payload,'manual',null
      )
    );
    update public.servicenow_write_commands set
      status='reconciliation_required',delivery_disposition='may_have_committed',
      failure_phase='read_back',retry_allowed=false,next_retry_at=null
    where id=v_command_id;
    select version,normalized_payload_hash into v_version,v_hash
    from public.servicenow_write_commands where id=v_command_id;
    v_nonce := public.support_intake_sha256_hex('reconcile-continuity:'||v_case.suffix);
    perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
      'commandId',v_command_id,'action',v_case.action,'actorUserId','admin-user',
      'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',v_nonce,
      'issuedAt',public.supper_test_iso(statement_timestamp()),
      'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
    ));
    begin
      perform * from public.support_reconcile_servicenow_write_command(
        jsonb_build_object(
          'commandId',v_command_id,'action',v_case.action,
          'result','confirmed_succeeded','safeReadBackSummary',jsonb_build_object(
            'method','continuity_verifier','evidenceClassification',
            case when v_case.action='reconcile_by_read_back'
              then 'provider_matched'
              else 'provider_target_matched_manual_verification' end
          ),
          'targetSysId',v_case.conflict_sys_id,'targetNumber',v_case.conflict_number,
          'actorUserId','admin-user','requestId','request-'||v_command_id,
          'checkedAt',public.supper_test_iso(statement_timestamp()),
          'confirmed',true,'expectedVersion',v_version,
          'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',v_nonce
        ) || case when v_case.action='reconcile_by_read_back' then '{}'::jsonb else
          jsonb_build_object(
            'verificationAcknowledged',true,
            'verificationNote','Conflicting target continuity must be rejected.'
          ) end
      );
      raise exception 'Reconciliation target continuity conflict % was accepted',v_case.suffix;
    exception when invalid_parameter_value then
      if sqlerrm<>'SERVICENOW_WRITE_TARGET_CONTINUITY_CONFLICT' then raise; end if;
    end;
    if not exists (
      select 1 from public.servicenow_write_commands command_record
      where command_record.id=v_command_id
        and command_record.status='reconciliation_required'
        and (
          command_record.target_sys_id is not distinct from nullif(command_record.normalized_payload->>'targetSysId','')
          and command_record.target_number is not distinct from nullif(command_record.normalized_payload->>'targetNumber','')
        )
    ) then
      raise exception 'Reconciliation conflict % changed authoritative target state',v_case.suffix;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_case record;
  v_version integer;
  v_hash text;
  v_nonce text;
  v_payload jsonb;
  v_status text;
  v_attempt_count integer;
begin
  select count(*) into v_attempt_count from public.servicenow_write_attempts;
  for v_case in
    select *
    from jsonb_to_recordset('[
      {"suffix":"matched","commandType":"create_incident","action":"reconcile_by_read_back","result":"confirmed_succeeded","evidence":"provider_matched","targetSysId":"11111111111111111111111111111111","targetNumber":"INC0011001","expectedStatus":"succeeded"},
      {"suffix":"not-found","commandType":"create_incident","action":"reconcile_by_read_back","result":"not_found","evidence":"provider_not_found","expectedStatus":"reconciliation_required"},
      {"suffix":"ambiguous","commandType":"create_incident","action":"reconcile_by_read_back","result":"ambiguous","evidence":"provider_ambiguous","expectedStatus":"reconciliation_required"},
      {"suffix":"inconclusive","commandType":"update_incident","action":"reconcile_by_read_back","result":"inconclusive","evidence":"provider_inconclusive","targetSysId":"dddddddddddddddddddddddddddddddd","targetNumber":"INC0011004","expectedStatus":"reconciliation_required"},
      {"suffix":"target-conflict","commandType":"create_incident","action":"reconcile_by_read_back","result":"read_back_failed","evidence":"provider_target_conflict","expectedStatus":"reconciliation_required"},
      {"suffix":"unavailable","commandType":"create_incident","action":"reconcile_by_read_back","result":"read_back_failed","evidence":"provider_unavailable","expectedStatus":"reconciliation_required"},
      {"suffix":"target-manual-create","commandType":"create_incident","action":"mark_succeeded_after_verification","result":"confirmed_succeeded","evidence":"provider_target_matched_manual_verification","targetSysId":"77777777777777777777777777777777","targetNumber":"INC0011007","expectedStatus":"succeeded"},
      {"suffix":"target-manual","commandType":"update_incident","action":"mark_succeeded_after_verification","result":"confirmed_succeeded","evidence":"provider_target_matched_manual_verification","targetSysId":"dddddddddddddddddddddddddddddddd","targetNumber":"INC0011008","expectedStatus":"succeeded"},
      {"suffix":"journal-manual","commandType":"add_comment","action":"mark_not_applied_after_verification","result":"confirmed_not_applied","evidence":"journal_manual_verification","duplicateRisk":true,"expectedStatus":"retry_scheduled"}
    ]'::jsonb) as x(
      suffix text,
      "commandType" text,
      action text,
      result text,
      evidence text,
      "targetSysId" text,
      "targetNumber" text,
      "duplicateRisk" boolean,
      "expectedStatus" text
    )
  loop
    perform public.supper_test_prepare_reconciliation(
      'matrix-valid-'||v_case.suffix,
      v_case."commandType",
      'matrix-valid:'||v_case.suffix
    );
    select version,normalized_payload_hash into v_version,v_hash
    from public.servicenow_write_commands
    where id='matrix-valid-'||v_case.suffix;
    v_nonce := public.support_intake_sha256_hex('matrix-valid:'||v_case.suffix);
    perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
      'commandId','matrix-valid-'||v_case.suffix,
      'action',v_case.action,
      'actorUserId','admin-user',
      'expectedVersion',v_version,
      'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',v_nonce,
      'issuedAt',public.supper_test_iso(statement_timestamp()),
      'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
    ));
    v_payload := jsonb_build_object(
      'commandId','matrix-valid-'||v_case.suffix,
      'action',v_case.action,
      'result',v_case.result,
      'safeReadBackSummary',jsonb_build_object(
        'method','matrix_verifier',
        'evidenceClassification',v_case.evidence
      ),
      'targetSysId',coalesce(v_case."targetSysId",''),
      'targetNumber',coalesce(v_case."targetNumber",''),
      'actorUserId','admin-user',
      'requestId','matrix-valid-'||v_case.suffix,
      'checkedAt',public.supper_test_iso(statement_timestamp()),
      'confirmed',true,
      'expectedVersion',v_version,
      'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',v_nonce
    );
    if v_case.action <> 'reconcile_by_read_back' then
      v_payload := v_payload || jsonb_build_object(
        'verificationAcknowledged',true,
        'verificationNote','Independent matrix verification completed.'
      );
    end if;
    if coalesce(v_case."duplicateRisk",false) then
      v_payload := v_payload || jsonb_build_object(
        'duplicateJournalRiskAcknowledged',true
      );
    end if;
    perform * from public.support_reconcile_servicenow_write_command(v_payload);
    select status into v_status
    from public.servicenow_write_commands
    where id='matrix-valid-'||v_case.suffix;
    if v_status <> v_case."expectedStatus" then
      raise exception 'Valid matrix case % produced status %',v_case.suffix,v_status;
    end if;
    if not exists (
      select 1
      from public.servicenow_write_reconciliation_events
      where command_id='matrix-valid-'||v_case.suffix
        and result=v_case.result
        and evidence_classification=v_case.evidence
        and safe_read_back_summary->>'evidenceClassification'=v_case.evidence
    ) then
      raise exception 'Valid matrix case % did not persist truthful evidence',v_case.suffix;
    end if;
    if v_case."expectedStatus"='reconciliation_required'
      and exists (
        select 1
        from public.servicenow_write_commands command_record
        join public.servicenow_ticket_links ticket_link
          on ticket_link.supper_ticket_id=command_record.source_entity_reference
        where command_record.id='matrix-valid-'||v_case.suffix
      ) then
      raise exception 'Unresolved matrix case % created a Ticket link',v_case.suffix;
    end if;
  end loop;
  if (select count(*) from public.servicenow_write_attempts) <> v_attempt_count then
    raise exception 'Reconciliation matrix performed a provider mutation attempt';
  end if;
end;
$$;

do $$
declare
  v_case record;
  v_version integer;
  v_hash text;
  v_nonce text;
  v_payload jsonb;
begin
  for v_case in
    select *
    from jsonb_to_recordset('[
      {"suffix":"read-success-unavailable","commandType":"create_incident","action":"reconcile_by_read_back","result":"confirmed_succeeded","evidence":"provider_unavailable_manual_verification","targetSysId":"11111111111111111111111111111111","targetNumber":"INC0020001"},
      {"suffix":"not-applied-inconclusive","commandType":"update_incident","action":"mark_not_applied_after_verification","result":"confirmed_not_applied","evidence":"provider_inconclusive"},
      {"suffix":"journal-provider-match","commandType":"add_comment","action":"mark_not_applied_after_verification","result":"confirmed_not_applied","evidence":"provider_matched","duplicateRisk":true},
      {"suffix":"success-not-found","commandType":"create_incident","action":"mark_succeeded_after_verification","result":"confirmed_succeeded","evidence":"provider_not_found","targetSysId":"22222222222222222222222222222222","targetNumber":"INC0020004"},
      {"suffix":"success-target-conflict","commandType":"create_incident","action":"mark_succeeded_after_verification","result":"confirmed_succeeded","evidence":"provider_target_conflict","targetSysId":"33333333333333333333333333333333","targetNumber":"INC0020005"},
      {"suffix":"manual-unavailable-without-candidate","commandType":"create_incident","action":"mark_succeeded_after_verification","result":"confirmed_succeeded","evidence":"provider_unavailable_manual_verification","targetSysId":"44444444444444444444444444444444","targetNumber":"INC0020006"},
      {"suffix":"journal-no-risk-ack","commandType":"add_work_note","action":"mark_not_applied_after_verification","result":"confirmed_not_applied","evidence":"journal_manual_verification"}
    ]'::jsonb) as x(
      suffix text,
      "commandType" text,
      action text,
      result text,
      evidence text,
      "targetSysId" text,
      "targetNumber" text,
      "duplicateRisk" boolean
    )
  loop
    perform public.supper_test_prepare_reconciliation(
      'matrix-invalid-'||v_case.suffix,
      v_case."commandType",
      'matrix-invalid:'||v_case.suffix
    );
    select version,normalized_payload_hash into v_version,v_hash
    from public.servicenow_write_commands
    where id='matrix-invalid-'||v_case.suffix;
    v_nonce := public.support_intake_sha256_hex('matrix-invalid:'||v_case.suffix);
    perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
      'commandId','matrix-invalid-'||v_case.suffix,
      'action',v_case.action,
      'actorUserId','admin-user',
      'expectedVersion',v_version,
      'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',v_nonce,
      'issuedAt',public.supper_test_iso(statement_timestamp()),
      'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
    ));
    v_payload := jsonb_build_object(
      'commandId','matrix-invalid-'||v_case.suffix,
      'action',v_case.action,
      'result',v_case.result,
      'safeReadBackSummary',jsonb_build_object(
        'method','forged_matrix_verifier',
        'evidenceClassification',v_case.evidence
      ),
      'targetSysId',coalesce(v_case."targetSysId",''),
      'targetNumber',coalesce(v_case."targetNumber",''),
      'actorUserId','admin-user',
      'requestId','matrix-invalid-'||v_case.suffix,
      'checkedAt',public.supper_test_iso(statement_timestamp()),
      'confirmed',true,
      'expectedVersion',v_version,
      'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',v_nonce
    );
    if v_case.action <> 'reconcile_by_read_back' then
      v_payload := v_payload || jsonb_build_object(
        'verificationAcknowledged',true,
        'verificationNote','Forged matrix verification must fail.'
      );
    end if;
    if coalesce(v_case."duplicateRisk",false) then
      v_payload := v_payload || jsonb_build_object(
        'duplicateJournalRiskAcknowledged',true
      );
    end if;
    begin
      perform * from public.support_reconcile_servicenow_write_command(v_payload);
      raise exception 'Contradictory matrix case % was accepted',v_case.suffix;
    exception when invalid_parameter_value then
      if sqlerrm <> 'SERVICENOW_WRITE_RECONCILIATION_EVIDENCE_INVALID' then
        raise;
      end if;
    end;
    if not exists (
      select 1 from public.servicenow_write_commands
      where id='matrix-invalid-'||v_case.suffix
        and status='reconciliation_required'
        and not retry_allowed
        and next_retry_at is null
    ) then
      raise exception 'Rejected matrix case % changed command state',v_case.suffix;
    end if;
  end loop;
end;
$$;

do $$
declare
  v_result record;
  v_attempt record;
  v_command jsonb;
  v_confirmation jsonb;
  v_version integer;
  v_hash text;
  v_candidate_event_id text;
  v_recovery_event_id text;
  v_marker_hash text;
  v_g2_request jsonb;
  v_g2_response jsonb;
  v_late record;
begin
  if public.support_servicenow_write_configuration_fingerprint(
    'https://example.service-now.com','incident','basic','unversioned'
  )<>'b32a9f49f25d2986b9c37ec94bc6d32fbb5242969c83727cf3d65cb912f9c274' then
    raise exception 'TypeScript/PostgreSQL configuration fingerprint parity failed';
  end if;
  if public.support_servicenow_write_idempotency_hash(
    'connection-a','create_incident','create:initial',
    'supper_ticket','ticket:T-100','incident'
  )<>'06cfd138fb4bbab5d8a82359e05d667ac6df4317f5e1259b22b08fec510ac1a6' then
    raise exception 'TypeScript/PostgreSQL idempotency parity failed';
  end if;
  if public.support_servicenow_write_normalized_hash(
    public.support_servicenow_write_normalize(
      'create_incident',
      jsonb_build_object('shortDescription','S','description','D'),
      (select field_mapping from public.servicenow_write_mappings where id='mapping-create-00000001'),
      '06cfd138fb4bbab5d8a82359e05d667ac6df4317f5e1259b22b08fec510ac1a6'
    )
  )<>'26096def22561832e72682010c663017acde6c4104fd6a9c62aee17451b01965' then
    raise exception 'TypeScript/PostgreSQL normalized hash parity failed';
  end if;
  if public.support_servicenow_write_command_material_hash(
    'connection-a','mapping-a','create_incident','supper_ticket',
    'ticket:T-100','create:initial','incident',
    jsonb_build_object(
      'shortDescription','S','description','D','supperTicketNo','T-100',
      'externalReferences',jsonb_build_object('zeta','Z','alpha','A')
    ),
    3
  )<>'81ecc7ec1b9b02c6038c4fef63ec4e24e5cc71bb8c66cd7da847ca84bb446971' then
    raise exception 'TypeScript/PostgreSQL command material hash parity failed';
  end if;

  v_command := public.supper_test_write_payload(
    'command-test-0000000001','manual-op:sql-0001'
  );
  select * into v_result from public.support_create_servicenow_write_command(v_command);
  if v_result.action<>'created' or v_result.command_status<>'validated' then
    raise exception 'Initial command creation failed';
  end if;

  begin
    perform * from public.support_create_servicenow_write_command(
      jsonb_set(
        public.supper_test_write_payload(
          'command-test-negative-0001','manual-op:sql-negative-0001'
        ),
        '{maxAttempts}',
        '-1'::jsonb
      )
    );
    raise exception 'Negative maxAttempts was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_COMMAND_INVALID' then raise; end if;
  end;

  select * into v_result from public.support_create_servicenow_write_command(
    jsonb_set(
      jsonb_set(v_command,'{commandId}','"command-test-0000000002"'::jsonb),
      '{requestId}',
      '"request-write-sql-transport-replay"'::jsonb
    )
  );
  if v_result.action<>'unchanged' or v_result.command_id<>'command-test-0000000001' then
    raise exception 'Identical operation did not deduplicate';
  end if;

  begin
    perform * from public.support_create_servicenow_write_command(
      public.supper_test_write_payload(
        'command-test-0000000003','manual-op:sql-0001','Changed material'
      )
    );
    raise exception 'Changed material reused one operation';
  exception when unique_violation then
    if sqlerrm<>'SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT' then raise; end if;
  end;

  begin
    perform * from public.support_create_servicenow_write_command(
      public.supper_test_rehash_write_payload(
        jsonb_set(
          v_command,
          '{payload,externalReferences}',
          '{"source":"changed"}'::jsonb,
          true
        )
      )
    );
    raise exception 'Changed externalReferences reused one operation';
  exception when unique_violation then
    if sqlerrm<>'SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT' then raise; end if;
  end;

  begin
    perform * from public.support_create_servicenow_write_command(
      public.supper_test_rehash_write_payload(
        jsonb_set(v_command,'{payload,supperTicketNo}','"T-CHANGED"'::jsonb,true)
      )
    );
    raise exception 'Changed supperTicketNo reused one operation';
  exception when unique_violation then
    if sqlerrm<>'SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT' then raise; end if;
  end;

  begin
    perform * from public.support_create_servicenow_write_command(
      public.supper_test_rehash_write_payload(
        jsonb_set(v_command,'{maxAttempts}','2'::jsonb)
      )
    );
    raise exception 'Changed maxAttempts reused one operation';
  exception when unique_violation then
    if sqlerrm<>'SERVICENOW_WRITE_IDEMPOTENCY_CONFLICT' then raise; end if;
  end;

  begin
    perform public.support_servicenow_write_parse_timestamp(
      to_jsonb('2026-02-30T01:00:00.000Z'::text),
      'SERVICENOW_WRITE_TIMESTAMP_INVALID'
    );
    raise exception 'Impossible calendar date was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_TIMESTAMP_INVALID' then raise; end if;
  end;

  begin
    perform public.support_servicenow_write_parse_timestamp(
      to_jsonb('2025-02-29T01:00:00.000Z'::text),
      'SERVICENOW_WRITE_TIMESTAMP_INVALID'
    );
    raise exception 'Impossible leap day was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_TIMESTAMP_INVALID' then raise; end if;
  end;

  begin
    perform public.support_servicenow_write_parse_timestamp(
      to_jsonb('2026-13-01T01:00:00.000Z'::text),
      'SERVICENOW_WRITE_TIMESTAMP_INVALID'
    );
    raise exception 'Impossible calendar month was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_TIMESTAMP_INVALID' then raise; end if;
  end;

  begin
    perform public.support_servicenow_write_parse_integer(
      '999999999999999999999999'::jsonb,
      'SERVICENOW_WRITE_INTEGER_INVALID'
    );
    raise exception 'Overflowing integer was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_INTEGER_INVALID' then raise; end if;
  end;

  begin
    perform public.support_servicenow_write_parse_boolean(
      '"truthy"'::jsonb,
      'SERVICENOW_WRITE_BOOLEAN_INVALID'
    );
    raise exception 'Malformed boolean was accepted';
  exception when invalid_parameter_value then
    if sqlerrm not in ('SERVICENOW_WRITE_BOOLEAN_INVALID','SERVICENOW_WRITE_VALUE_INVALID') then raise; end if;
  end;

  select * into v_result from public.support_create_servicenow_write_command(
    public.supper_test_write_payload(
      'command-test-0000000004','manual-op:sql-0002'
    )
  );
  if v_result.action<>'created' then
    raise exception 'Distinct operation on same source was rejected';
  end if;

  perform * from public.support_create_servicenow_write_command(
    public.supper_test_write_payload_for(
      'command-comment-00000001','add_comment','comment:event-0001',
      jsonb_build_object('number','INC0010001','text','First reviewed comment')
    )
  );
  perform * from public.support_create_servicenow_write_command(
    public.supper_test_write_payload_for(
      'command-comment-00000002','add_comment','comment:event-0002',
      jsonb_build_object('number','INC0010001','text','Second reviewed comment')
    )
  );
  perform * from public.support_create_servicenow_write_command(
    public.supper_test_write_payload_for(
      'command-work-note-0000001','add_work_note','work-note:event-0001',
      jsonb_build_object('sysId',repeat('c',32),'text','Reviewed work note')
    )
  );
  if (
    select count(*) from public.servicenow_write_commands
    where id in (
      'command-comment-00000001',
      'command-comment-00000002',
      'command-work-note-0000001'
    )
  )<>3 then
    raise exception 'Multiple operations on one Ticket were not preserved';
  end if;

  begin
    perform public.support_servicenow_write_normalize(
      'update_incident',
      jsonb_build_object('sysId',repeat('a',32),'number','INC0010001','state','2'),
      (select field_mapping from public.servicenow_write_mappings where id='mapping-update-00000001'),
      repeat('a',64)
    );
    raise exception 'Both sysId and number were accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_TARGET_INVALID' then raise; end if;
  end;

  begin
    perform public.support_servicenow_write_normalize(
      'add_comment',
      jsonb_build_object('text','Missing target'),
      (select field_mapping from public.servicenow_write_mappings where id='mapping-comment-00000001'),
      repeat('a',64)
    );
    raise exception 'Missing sysId and number were accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_TARGET_INVALID' then raise; end if;
  end;

  begin
    perform public.support_servicenow_write_normalize(
      'create_incident',
      jsonb_build_object(
        'shortDescription','Invalid reference','description','Invalid reference',
        'callerId',repeat('A',32)
      ),
      (select field_mapping from public.servicenow_write_mappings where id='mapping-create-00000001'),
      repeat('a',64)
    );
    raise exception 'Uppercase reference sys_id was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_PAYLOAD_INVALID' then raise; end if;
  end;

  begin
    perform * from public.support_upsert_servicenow_write_mapping(jsonb_build_object(
      'id','mapping-invalid-00000001','connectionId','connection-test-00000001',
      'commandType','add_comment','mappingName','invalid','active',true,
      'fieldMapping','{"text":"work_notes"}'::jsonb,'metadata','{}'::jsonb,
      'updatedAt','2026-07-23T01:00:00.000Z'
    ));
    raise exception 'Cross-journal mapping was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_MAPPING_INVALID' then raise; end if;
  end;

  begin
    perform * from public.support_upsert_servicenow_write_mapping(jsonb_build_object(
      'id','mapping-duplicate-0000001','connectionId','connection-test-00000001',
      'commandType','update_incident','mappingName','duplicate','active',true,
      'fieldMapping','{
        "shortDescription":"short_description","description":"description","state":"state",
        "impact":"impact","urgency":"urgency","assignmentGroup":"assignment_group",
        "customer":"company","projectCode":"company"
      }'::jsonb,'metadata','{}'::jsonb,'updatedAt','2026-07-23T01:00:00.000Z'
    ));
    raise exception 'Duplicate mapping target was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_MAPPING_INVALID' then raise; end if;
  end;

  begin
    perform * from public.support_upsert_servicenow_write_connection(jsonb_build_object(
      'id','connection-invalid-00001','name','Invalid','active','true',
      'authMode','basic','instanceUrl','https://example.service-now.com',
      'incidentTable','incident','timeoutMs','15000','metadata','{}'::jsonb,
      'updatedAt','not-a-timestamp'
    ));
    raise exception 'Malformed booleans, integers, and timestamps were cast';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_CONNECTION_INVALID' then raise; end if;
  end;

  begin
    perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
      'commandId','command-test-0000000001','action','execute','actorUserId','admin-user',
      'expectedVersion','not-an-integer','expectedNormalizedPayloadHash',repeat('a',64),
      'confirmationNonceHash',repeat('f',64),'issuedAt','invalid',
      'expiresAt','2026-07-23T01:02:00.000Z'
    ));
    raise exception 'Malformed cast material was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_CONFIRMATION_INVALID' then raise; end if;
  end;

  begin
    perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
      'commandId','command-test-0000000004','attemptId','attempt-chronology-00001',
      'executionMode','dry_run','retry',false,'requestId','request-write-sql-chronology',
      'startedAt','2000-01-01T00:00:00.000Z','actorUserId','admin-user'
    ));
    raise exception 'Attempt chronology before command creation was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_ATTEMPT_CHRONOLOGY_INVALID' then raise; end if;
  end;

  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-test-0000000001';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-test-0000000001','action','execute','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('f',64),
    'issuedAt','2026-07-23T01:01:00.000Z','expiresAt','2026-07-23T01:03:00.000Z'
  ));
  select * into v_attempt from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-test-0000000001','attemptId','attempt-live-00000000001',
    'executionMode','live','retry',false,'requestId','request-write-sql-0002',
    'startedAt','2026-07-23T01:01:30.000Z','actorUserId','admin-user',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('f',64)
  ));
  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-test-0000000001','attemptId','attempt-live-00000000001',
    'outcome','uncertain','deliveryDisposition','may_have_committed',
    'failurePhase','mutation_dispatch','retryAllowed',false,
    'retryReason','','reconciliationReason','Mutation dispatch ended without a response',
    'requestSummary',jsonb_build_object('method','POST'),
    'responseSummary','{}'::jsonb,'targetSysId','','targetNumber','',
    'errorCode','SERVICENOW_WRITE_TIMEOUT','errorMessage','ServiceNow request timed out',
    'finishedAt','2026-07-23T01:01:31.000Z'
  ));
  if not exists (
    select 1 from public.servicenow_write_commands
    where id='command-test-0000000001' and status='reconciliation_required'
      and delivery_disposition='may_have_committed' and not retry_allowed
      and next_retry_at is null
  ) then raise exception 'Uncertain mutation remained retryable'; end if;

  begin
    perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
      'commandId','command-test-0000000001','attemptId','attempt-unsafe-retry-0001',
      'executionMode','retry','retry',true,'requestId','request-write-sql-0003',
      'startedAt','2026-07-23T01:02:00.000Z','actorUserId','admin-user'
    ));
    raise exception 'Uncertain command was retryable';
  exception when invalid_parameter_value then
    if sqlerrm not in (
      'SERVICENOW_WRITE_CONFIRMATION_INVALID','SERVICENOW_WRITE_RETRY_NOT_ALLOWED'
    ) then raise; end if;
  end;

  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-test-0000000001';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-test-0000000001','action','reconcile_by_read_back',
    'actorUserId','admin-user','expectedVersion',v_version,
    'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',repeat('e',64),
    'issuedAt','2026-07-23T01:02:00.000Z','expiresAt','2026-07-23T01:04:00.000Z'
  ));
  perform * from public.support_reconcile_servicenow_write_command(jsonb_build_object(
    'commandId','command-test-0000000001','action','reconcile_by_read_back',
    'result','inconclusive','safeReadBackSummary',jsonb_build_object(
      'method','exact_target','evidenceClassification','provider_inconclusive'
    ),
    'targetSysId',repeat('1',32),'targetNumber','INC0010001','actorUserId','admin-user',
    'requestId','request-write-sql-0004','checkedAt','2026-07-23T01:02:30.000Z',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('e',64)
  ));
  if not exists (
    select 1 from public.servicenow_write_reconciliation_events
    where command_id='command-test-0000000001' and result='inconclusive'
      and evidence_classification='provider_inconclusive'
  ) then raise exception 'Reconciliation event was not appended'; end if;

  begin
    update public.servicenow_write_reconciliation_events set result='changed'
    where command_id='command-test-0000000001';
    raise exception 'Reconciliation history was mutable';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_RECONCILIATION_IMMUTABLE' then raise; end if;
  end;

  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-test-0000000001';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-test-0000000001','action','mark_not_applied_after_verification',
    'actorUserId','admin-user','expectedVersion',v_version,
    'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',repeat('d',64),
    'issuedAt','2026-07-23T01:03:00.000Z','expiresAt','2026-07-23T01:05:00.000Z'
  ));
  begin
    perform * from public.support_reconcile_servicenow_write_command(jsonb_build_object(
      'commandId','command-test-0000000001','action','mark_not_applied_after_verification',
      'result','confirmed_not_applied','safeReadBackSummary',jsonb_build_object(
        'method','manual_verification','evidenceClassification','provider_matched'
      ),
      'targetSysId','','targetNumber','','actorUserId','admin-user',
      'verificationAcknowledged',true,'verificationNote','Provider matched the reviewed change.',
      'requestId','request-write-sql-provider-match','checkedAt','2026-07-23T01:03:20.000Z',
      'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',repeat('d',64)
    ));
    raise exception 'Provider match allowed an unsafe not-applied decision';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_RECONCILIATION_EVIDENCE_INVALID' then raise; end if;
  end;
  perform * from public.support_reconcile_servicenow_write_command(jsonb_build_object(
    'commandId','command-test-0000000001','action','mark_not_applied_after_verification',
    'result','confirmed_not_applied','safeReadBackSummary',jsonb_build_object(
      'method','manual_verification',
      'evidenceClassification','provider_not_found'
    ),
    'targetSysId','','targetNumber','','actorUserId','admin-user',
    'verificationAcknowledged',true,'verificationNote','Exact target lookup found no applied mutation.',
    'requestId','request-write-sql-0005','checkedAt','2026-07-23T01:03:30.000Z',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('d',64)
  ));
  if not exists (
    select 1 from public.servicenow_write_commands
    where id='command-test-0000000001' and status='retry_scheduled'
      and delivery_disposition='safe_to_retry' and retry_allowed
      and next_retry_at is not null
      and next_retry_at <= statement_timestamp()
  ) then raise exception 'Verified-not-applied command did not enter safe retry'; end if;

  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-test-0000000001';
  begin
    perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
      'commandId','command-test-0000000001','action','retry','actorUserId','admin-user',
      'expectedVersion',v_version-1,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',repeat('c',64),
      'issuedAt','2026-07-23T01:03:31.000Z','expiresAt','2026-07-23T01:05:00.000Z'
    ));
    raise exception 'Stale confirmation was accepted';
  exception when serialization_failure then
    if sqlerrm<>'SERVICENOW_WRITE_VERSION_CONFLICT' then raise; end if;
  end;

  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-test-0000000001','action','retry','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('b',64),
    'issuedAt','2026-07-23T01:03:40.000Z','expiresAt','2026-07-23T01:05:00.000Z'
  ));
  select * into v_attempt from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-test-0000000001','attemptId','attempt-safe-retry-00001',
    'executionMode','retry','retry',true,'requestId','request-write-sql-0006',
    'startedAt','2026-07-23T01:03:50.000Z','actorUserId','admin-user',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('b',64)
  ));
  if exists (
    select 1 from public.servicenow_write_commands
    where id='command-test-0000000001' and confirmation_nonce_hash is not null
  ) then raise exception 'Confirmation nonce was not consumed'; end if;
  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-test-0000000001','attemptId','attempt-safe-retry-00001',
    'outcome','failed','deliveryDisposition','definitely_rejected',
    'failurePhase','mutation_response','retryAllowed',false,
    'retryReason','','reconciliationReason','',
    'requestSummary',jsonb_build_object('method','POST'),'responseSummary','{}'::jsonb,
    'targetSysId','','targetNumber','','errorCode','SERVICENOW_WRITE_REJECTED',
    'errorMessage','ServiceNow rejected the write request',
    'finishedAt','2026-07-23T01:03:51.000Z'
  ));
  if not exists (
    select 1 from public.servicenow_write_commands
    where id='command-test-0000000001' and status='failed' and not retry_allowed
  ) then raise exception 'Definitive rejection remained retryable'; end if;

  perform * from public.support_create_servicenow_write_command(
    public.supper_test_write_payload(
      'command-verified-00000001','manual-op:verified-success','Verified success body',
      'supper_ticket','ticket-write-00000001'
    )
  );
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-verified-00000001';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-verified-00000001','action','execute','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('9',64),
    'issuedAt','2026-07-23T01:04:00.000Z','expiresAt','2026-07-23T01:06:00.000Z'
  ));
  perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-verified-00000001','attemptId','attempt-verified-00000001',
    'executionMode','live','retry',false,'requestId','request-write-sql-verified',
    'startedAt','2026-07-23T01:04:10.000Z','actorUserId','admin-user',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('9',64)
  ));
  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-verified-00000001','attemptId','attempt-verified-00000001',
    'outcome','uncertain','deliveryDisposition','may_have_committed',
    'failurePhase','mutation_response','retryAllowed',false,
    'retryReason','','reconciliationReason','Provider response was lost',
    'requestSummary',jsonb_build_object('method','POST'),
    'responseSummary',jsonb_build_object(
      'mutationCandidateObserved',true,
      'candidateSysId',repeat('7',32),
      'candidateNumber','INC0017777',
      'mutationHttpStatus',201,
      'postWriteMarkerVerified',false
    ),
    'mutationCandidateSysId',repeat('7',32),
    'mutationCandidateNumber','INC0017777',
    'mutationCandidateHttpStatus',201,
    'mutationCandidateSource','mutation_response',
    'mutationCandidateProofStatus','marker_verification_unavailable',
    'targetSysId','','targetNumber','','errorCode','SERVICENOW_WRITE_RESPONSE_LOST',
    'errorMessage','ServiceNow response was not definitive',
    'finishedAt','2026-07-23T01:04:11.000Z'
  ));
  select id into v_candidate_event_id
  from public.servicenow_write_mutation_candidate_events
  where attempt_id='attempt-verified-00000001';
  if not exists (
    select 1 from public.servicenow_write_mutation_candidate_events
    where command_id='command-verified-00000001'
      and attempt_id='attempt-verified-00000001'
      and sys_id=repeat('7',32)
      and number='INC0017777'
      and http_status=201
      and source='mutation_response'
  ) then
    raise exception 'Attempt finish did not persist the mutation candidate';
  end if;
  if not exists (
    select 1 from public.servicenow_write_attempts
    where id='attempt-verified-00000001'
      and response_summary=jsonb_build_object(
        'mutationCandidateObserved',true,
        'candidateSysId',repeat('7',32),
        'candidateNumber','INC0017777',
        'mutationHttpStatus',201,
        'postWriteMarkerVerified',false
      )
  ) then
    raise exception 'Attempt did not retain the bounded candidate summary';
  end if;
  begin
    update public.servicenow_write_mutation_candidate_events
    set number='INC0099999'
    where command_id='command-verified-00000001';
    raise exception 'Mutation candidate was mutable';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_MUTATION_CANDIDATE_IMMUTABLE' then raise; end if;
  end;
  begin
    delete from public.servicenow_write_mutation_candidate_events
    where command_id='command-verified-00000001';
    raise exception 'Mutation candidate was deletable';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_MUTATION_CANDIDATE_IMMUTABLE' then raise; end if;
  end;
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-verified-00000001';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-verified-00000001','action','mark_succeeded_after_verification',
    'actorUserId','admin-user','expectedVersion',v_version,
    'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',repeat('8',64),
    'mutationCandidateEventId',v_candidate_event_id,
    'issuedAt','2026-07-23T01:04:20.000Z','expiresAt','2026-07-23T01:06:00.000Z'
  ));
  begin
    perform * from public.support_reconcile_servicenow_write_command(jsonb_build_object(
      'commandId','command-verified-00000001','action','mark_succeeded_after_verification',
      'result','confirmed_succeeded','safeReadBackSummary',jsonb_build_object(
        'method','manual_verified_target',
        'evidenceClassification','provider_target_matched_manual_verification'
      ),
      'targetSysId',repeat('6',32),'targetNumber','INC0016666','actorUserId','admin-user',
      'verificationAcknowledged',true,'verificationNote','Conflicting target must fail.',
      'requestId','request-write-sql-candidate-conflict','checkedAt','2026-07-23T01:04:22.000Z',
      'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',repeat('8',64)
      ,'mutationCandidateEventId',v_candidate_event_id
    ));
    raise exception 'A conflicting target bypassed the mutation candidate';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_MUTATION_CANDIDATE_CONFLICT' then raise; end if;
  end;
  if exists (
    select 1 from public.servicenow_ticket_links
    where servicenow_sys_id=repeat('6',32) or servicenow_number='INC0016666'
  ) then
    raise exception 'Conflicting mutation candidate created a Ticket link';
  end if;
  begin
    perform * from public.support_reconcile_servicenow_write_command(jsonb_build_object(
      'commandId','command-verified-00000001','action','mark_succeeded_after_verification',
      'result','confirmed_succeeded','safeReadBackSummary',jsonb_build_object(
        'method','correlation_marker','evidenceClassification','provider_not_found'
      ),
      'targetSysId',repeat('7',32),'targetNumber','INC0017777','actorUserId','admin-user',
      'verificationAcknowledged',true,'verificationNote','Provider lookup found no target.',
      'requestId','request-write-sql-provider-not-found','checkedAt','2026-07-23T01:04:25.000Z',
      'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',repeat('8',64)
      ,'mutationCandidateEventId',v_candidate_event_id
    ));
    raise exception 'Provider not-found became a successful command';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_RECONCILIATION_EVIDENCE_INVALID' then raise; end if;
  end;
  begin
    perform * from public.support_reconcile_servicenow_write_command(jsonb_build_object(
      'commandId','command-verified-00000001','action','mark_succeeded_after_verification',
      'result','confirmed_succeeded','safeReadBackSummary',jsonb_build_object(
        'method','manual_verified_target',
        'evidenceClassification','provider_unavailable_manual_verification'
      ),
      'targetSysId','','targetNumber','','actorUserId','admin-user',
      'verificationAcknowledged',true,'verificationNote','Verified exact target.',
      'requestId','request-write-sql-missing-target','checkedAt','2026-07-23T01:04:30.000Z',
      'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',repeat('8',64)
      ,'mutationCandidateEventId',v_candidate_event_id
    ));
    raise exception 'Manual success without a complete target pair was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_RECONCILIATION_EVIDENCE_INVALID' then raise; end if;
  end;
  perform * from public.support_reconcile_servicenow_write_command(jsonb_build_object(
    'commandId','command-verified-00000001','action','mark_succeeded_after_verification',
    'result','confirmed_succeeded',
    'safeReadBackSummary',jsonb_build_object(
      'method','manual_verified_target','verificationEvidenceProvided',true,
      'evidenceClassification','provider_unavailable_manual_verification'
    ),
    'targetSysId',repeat('7',32),'targetNumber','INC0017777','actorUserId','admin-user',
    'verificationAcknowledged',true,'verificationNote','Verified exact target independently.',
    'requestId','request-write-sql-success','checkedAt','2026-07-23T01:04:31.000Z',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('8',64)
    ,'mutationCandidateEventId',v_candidate_event_id
  ));
  if (
    select count(*) from public.servicenow_ticket_links
    where supper_ticket_id='ticket-write-00000001'
      and servicenow_sys_id=repeat('7',32)
      and servicenow_number='INC0017777'
  )<>1 then
    raise exception 'Verified reconciliation did not create exactly one Ticket link';
  end if;
  if exists (
    select 1 from public.servicenow_write_reconciliation_events
    where command_id='command-verified-00000001'
      and safe_read_back_summary::text ilike '%verified exact target independently%'
  ) then
    raise exception 'Raw verification note entered reconciliation history';
  end if;

  perform * from public.support_create_servicenow_write_command(
    public.supper_test_write_payload(
      'command-candidate-rewrite-01','manual-op:candidate-rewrite',
      'Candidate rewrite verifier'
    )
  );
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-candidate-rewrite-01';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-candidate-rewrite-01','action','execute','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('5',64),
    'issuedAt','2026-07-23T01:04:32.000Z','expiresAt','2026-07-23T01:06:00.000Z'
  ));
  perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-candidate-rewrite-01','attemptId','attempt-candidate-rewrite-1',
    'executionMode','live','retry',false,'requestId','request-candidate-rewrite-1',
    'startedAt','2026-07-23T01:04:33.000Z','actorUserId','admin-user',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('5',64)
  ));
  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-candidate-rewrite-01','attemptId','attempt-candidate-rewrite-1',
    'outcome','uncertain','deliveryDisposition','may_have_committed',
    'failurePhase','read_back','retryAllowed',false,
    'retryReason','','reconciliationReason','Post-write proof unavailable',
    'requestSummary',jsonb_build_object('method','POST'),
    'responseSummary',jsonb_build_object(
      'mutationCandidateObserved',true,'candidateSysId',repeat('5',32),
      'candidateNumber','INC0015555','mutationHttpStatus',201,
      'postWriteMarkerVerified',false
    ),
    'mutationCandidateSysId',repeat('5',32),
    'mutationCandidateNumber','INC0015555',
    'mutationCandidateHttpStatus',201,
    'mutationCandidateSource','mutation_response',
    'mutationCandidateProofStatus','marker_verification_unavailable',
    'targetSysId','','targetNumber','','errorCode','SERVICENOW_WRITE_READ_BACK_FAILED',
    'errorMessage','Post-write proof was unavailable',
    'finishedAt','2026-07-23T01:04:34.000Z'
  ));
  select id into v_candidate_event_id
  from public.servicenow_write_mutation_candidate_events
  where attempt_id='attempt-candidate-rewrite-1';
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-candidate-rewrite-01';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-candidate-rewrite-01',
    'action','mark_not_applied_after_verification','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('4',64),
    'mutationCandidateEventId',v_candidate_event_id,
    'issuedAt','2026-07-23T01:04:35.000Z','expiresAt','2026-07-23T01:06:00.000Z'
  ));
  begin
    perform * from public.support_reconcile_servicenow_write_command(jsonb_build_object(
      'commandId','command-candidate-rewrite-01',
      'action','mark_not_applied_after_verification','result','confirmed_not_applied',
      'safeReadBackSummary',jsonb_build_object(
        'method','manual_verification',
        'evidenceClassification','provider_unavailable_manual_verification'
      ),
      'targetSysId','','targetNumber','','actorUserId','admin-user',
      'verificationAcknowledged',true,
      'verificationNote','Provider was unavailable after independent review.',
      'requestId','request-candidate-no-risk-ack','checkedAt','2026-07-23T01:04:36.000Z',
      'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',repeat('4',64)
      ,'mutationCandidateEventId',v_candidate_event_id
    ));
    raise exception 'Candidate not-applied was accepted without duplicate-risk acknowledgment';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_RECONCILIATION_EVIDENCE_INVALID' then raise; end if;
  end;
  perform * from public.support_reconcile_servicenow_write_command(jsonb_build_object(
    'commandId','command-candidate-rewrite-01',
    'action','mark_not_applied_after_verification','result','confirmed_not_applied',
    'safeReadBackSummary',jsonb_build_object(
      'method','manual_verification',
      'evidenceClassification','provider_unavailable_manual_verification'
    ),
    'targetSysId','','targetNumber','','actorUserId','admin-user',
    'verificationAcknowledged',true,'mutationCandidateRiskAcknowledged',true,
    'verificationNote','Duplicate risk accepted after independent review.',
    'requestId','request-candidate-with-risk-ack','checkedAt','2026-07-23T01:04:37.000Z',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('4',64)
    ,'mutationCandidateEventId',v_candidate_event_id
  ));
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-candidate-rewrite-01';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-candidate-rewrite-01','action','retry','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('3',64),
    'issuedAt','2026-07-23T01:04:38.000Z','expiresAt','2026-07-23T01:06:00.000Z'
  ));
  perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-candidate-rewrite-01','attemptId','attempt-candidate-rewrite-2',
    'executionMode','retry','retry',true,'requestId','request-candidate-rewrite-2',
    'startedAt','2026-07-23T01:04:39.000Z','actorUserId','admin-user',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('3',64)
  ));
  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-candidate-rewrite-01','attemptId','attempt-candidate-rewrite-2',
    'outcome','uncertain','deliveryDisposition','may_have_committed',
    'failurePhase','read_back','retryAllowed',false,
    'retryReason','','reconciliationReason','Second candidate proof unavailable',
    'requestSummary',jsonb_build_object('method','POST'),
    'responseSummary',jsonb_build_object(
      'mutationCandidateObserved',true,'candidateSysId',repeat('4',32),
      'candidateNumber','INC0014444','mutationHttpStatus',201,
      'postWriteMarkerVerified',false
    ),
    'mutationCandidateSysId',repeat('4',32),
    'mutationCandidateNumber','INC0014444',
    'mutationCandidateHttpStatus',201,
    'mutationCandidateSource','mutation_response',
    'mutationCandidateProofStatus','marker_not_found',
    'targetSysId','','targetNumber','','errorCode','SERVICENOW_WRITE_READ_BACK_FAILED',
    'errorMessage','Second candidate proof unavailable',
    'finishedAt','2026-07-23T01:04:40.000Z'
  ));
  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-candidate-rewrite-01','attemptId','attempt-candidate-rewrite-2',
    'outcome','uncertain','deliveryDisposition','may_have_committed',
    'failurePhase','read_back','retryAllowed',false,
    'retryReason','','reconciliationReason','Second candidate proof unavailable',
    'requestSummary',jsonb_build_object('method','POST'),
    'responseSummary',jsonb_build_object(
      'mutationCandidateObserved',true,'candidateSysId',repeat('4',32),
      'candidateNumber','INC0014444','mutationHttpStatus',201,
      'postWriteMarkerVerified',false
    ),
    'mutationCandidateSysId',repeat('4',32),
    'mutationCandidateNumber','INC0014444',
    'mutationCandidateHttpStatus',201,
    'mutationCandidateSource','mutation_response',
    'mutationCandidateProofStatus','marker_not_found',
    'targetSysId','','targetNumber','','errorCode','SERVICENOW_WRITE_READ_BACK_FAILED',
    'errorMessage','Second candidate proof unavailable',
    'finishedAt','2026-07-23T01:04:41.000Z'
  ));
  begin
    perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
      'commandId','command-candidate-rewrite-01','attemptId','attempt-candidate-rewrite-2',
      'outcome','uncertain','deliveryDisposition','may_have_committed',
      'failurePhase','read_back','retryAllowed',false,
      'retryReason','','reconciliationReason','Different terminal material',
      'requestSummary',jsonb_build_object('method','POST'),
      'responseSummary',jsonb_build_object(
        'mutationCandidateObserved',true,'candidateSysId',repeat('4',32),
        'candidateNumber','INC0014444','mutationHttpStatus',201,
        'postWriteMarkerVerified',false
      ),
      'mutationCandidateSysId',repeat('4',32),
      'mutationCandidateNumber','INC0014444',
      'mutationCandidateHttpStatus',201,
      'mutationCandidateSource','mutation_response',
      'mutationCandidateProofStatus','marker_not_found',
      'targetSysId','','targetNumber','','errorCode','SERVICENOW_WRITE_READ_BACK_FAILED',
      'errorMessage','Different terminal material',
      'finishedAt','2026-07-23T01:04:41.000Z'
    ));
    raise exception 'Different terminal material was idempotently accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_ATTEMPT_FINISH_CONFLICT' then raise; end if;
  end;
  if (
    select count(*) from public.servicenow_write_mutation_candidate_events
    where command_id='command-candidate-rewrite-01'
  )<>2 then
    raise exception 'Retry did not preserve Candidate A and append Candidate B';
  end if;
  if not exists (
    select 1 from public.servicenow_write_mutation_candidate_events candidate
    where candidate.command_id='command-candidate-rewrite-01'
      and candidate.attempt_number=1
      and candidate.sys_id=repeat('5',32)
      and exists (
        select 1 from public.servicenow_write_reconciliation_events resolution
        where resolution.mutation_candidate_event_id=candidate.id
          and resolution.result='confirmed_not_applied'
      )
  ) or not exists (
    select 1 from public.servicenow_write_mutation_candidate_events candidate
    where candidate.command_id='command-candidate-rewrite-01'
      and candidate.attempt_number=2
      and candidate.sys_id=repeat('4',32)
      and not exists (
        select 1 from public.servicenow_write_reconciliation_events resolution
        where resolution.mutation_candidate_event_id=candidate.id
          and resolution.result in ('confirmed_succeeded','confirmed_not_applied')
      )
  ) then
    raise exception 'Candidate resolution continuity is invalid';
  end if;
  if not exists (
    select 1 from public.servicenow_write_commands command_record
    join public.servicenow_write_attempts attempt_record
      on attempt_record.command_id=command_record.id
      and attempt_record.id='attempt-candidate-rewrite-2'
    where command_record.id='command-candidate-rewrite-01'
      and command_record.status='reconciliation_required'
      and attempt_record.outcome='uncertain'
  ) then
    raise exception 'Retry Candidate B left Command or Attempt executing';
  end if;
  select id into v_candidate_event_id
  from public.servicenow_write_mutation_candidate_events
  where command_id='command-candidate-rewrite-01' and attempt_number=1;
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-candidate-rewrite-01';
  begin
    perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
      'commandId','command-candidate-rewrite-01',
      'action','mark_not_applied_after_verification','actorUserId','admin-user',
      'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',repeat('f',64),
      'mutationCandidateEventId',v_candidate_event_id,
      'issuedAt',public.supper_test_iso(statement_timestamp()),
      'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
    ));
    raise exception 'Stale Candidate A confirmation was accepted after Candidate B';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_CONFIRMATION_INVALID' then raise; end if;
  end;

  perform * from public.support_create_servicenow_write_command(
    public.supper_test_write_payload(
      'command-retry-success-01','manual-op:retry-success',
      'Retry succeeds with Candidate B',
      'supper_ticket','ticket-write-00000002'
    )
  );
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-retry-success-01';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-retry-success-01','action','execute','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('e',64),
    'issuedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
  ));
  perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-retry-success-01','attemptId','attempt-retry-success-a',
    'executionMode','live','retry',false,'requestId','request-retry-success-a',
    'startedAt',public.supper_test_iso(statement_timestamp()),'actorUserId','admin-user',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('e',64)
  ));
  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-retry-success-01','attemptId','attempt-retry-success-a',
    'outcome','uncertain','deliveryDisposition','may_have_committed',
    'failurePhase','read_back','retryAllowed',false,'retryReason','',
    'reconciliationReason','Candidate A proof failed',
    'requestSummary',jsonb_build_object('method','POST'),
    'responseSummary',jsonb_build_object(
      'mutationCandidateObserved',true,'candidateSysId',repeat('8',32),
      'candidateNumber','INC0088888','mutationHttpStatus',201,
      'postWriteMarkerVerified',false
    ),
    'mutationCandidateSysId',repeat('8',32),
    'mutationCandidateNumber','INC0088888',
    'mutationCandidateHttpStatus',201,
    'mutationCandidateSource','mutation_response',
    'mutationCandidateProofStatus','marker_not_found',
    'targetSysId','','targetNumber','','errorCode','SERVICENOW_WRITE_MARKER_NOT_FOUND',
    'errorMessage','Candidate A marker proof failed',
    'finishedAt',public.supper_test_iso(statement_timestamp())
  ));
  select id into v_candidate_event_id
  from public.servicenow_write_mutation_candidate_events
  where attempt_id='attempt-retry-success-a';
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-retry-success-01';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-retry-success-01',
    'action','mark_not_applied_after_verification','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('d',64),
    'mutationCandidateEventId',v_candidate_event_id,
    'issuedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
  ));
  perform * from public.support_reconcile_servicenow_write_command(jsonb_build_object(
    'commandId','command-retry-success-01',
    'action','mark_not_applied_after_verification','result','confirmed_not_applied',
    'safeReadBackSummary',jsonb_build_object(
      'method','manual_verification',
      'evidenceClassification','provider_not_found'
    ),
    'targetSysId','','targetNumber','','actorUserId','admin-user',
    'verificationAcknowledged',true,'mutationCandidateRiskAcknowledged',true,
    'verificationNote','Exact Candidate A review found no applied Incident.',
    'requestId','request-retry-success-resolve-a',
    'checkedAt',public.supper_test_iso(statement_timestamp()),
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('d',64),
    'mutationCandidateEventId',v_candidate_event_id
  ));
  insert into public.servicenow_write_reconciliation_events (
    id,command_id,mutation_candidate_event_id,action,result,evidence_classification,
    safe_read_back_summary,actor_user_id,request_id,
    command_version_before,command_version_after,created_at
  ) values (
    'sn-reconcile-projection-older-inconclusive',
    'command-retry-success-01',v_candidate_event_id,
    'reconcile_by_read_back','inconclusive','provider_inconclusive',
    jsonb_build_object(
      'method','exact_target',
      'evidenceClassification','provider_inconclusive'
    ),
    'admin-user','request-projection-older',1,2,
    statement_timestamp()-interval '1 minute'
  );
  insert into public.servicenow_write_reconciliation_events (
    id,command_id,mutation_candidate_event_id,action,result,evidence_classification,
    safe_read_back_summary,actor_user_id,request_id,
    command_version_before,command_version_after,created_at
  )
  select
    'sn-reconcile-projection-inconclusive-'||sequence_number,
    'command-retry-success-01',v_candidate_event_id,
    'reconcile_by_read_back','inconclusive','provider_inconclusive',
    jsonb_build_object('method','exact_target','evidenceClassification','provider_inconclusive'),
    'admin-user','request-projection-inconclusive-'||sequence_number,2,3,
    clock_timestamp()+make_interval(secs => sequence_number/1000.0)
  from generate_series(1,101) sequence_number;
  insert into public.servicenow_write_reconciliation_events (
    id,command_id,mutation_candidate_event_id,action,result,evidence_classification,
    safe_read_back_summary,actor_user_id,request_id,
    command_version_before,command_version_after,created_at
  )
  select
    'sn-reconcile-projection-not-found-'||sequence_number,
    'command-retry-success-01',v_candidate_event_id,
    'reconcile_by_read_back','not_found','provider_not_found',
    jsonb_build_object('method','correlation_marker','evidenceClassification','provider_not_found'),
    'admin-user','request-projection-not-found-'||sequence_number,2,3,
    clock_timestamp()+interval '1 second'+make_interval(secs => sequence_number/1000.0)
  from generate_series(1,101) sequence_number;
  if not exists (
    select 1
    from public.servicenow_write_reconciliation_events terminal_resolution
    where terminal_resolution.mutation_candidate_event_id=v_candidate_event_id
      and terminal_resolution.result='confirmed_not_applied'
      and terminal_resolution.created_at=(
        select max(newest_terminal.created_at)
        from public.servicenow_write_reconciliation_events newest_terminal
        where newest_terminal.mutation_candidate_event_id=v_candidate_event_id
          and newest_terminal.result in ('confirmed_succeeded','confirmed_not_applied')
      )
  ) then
    raise exception 'Older inconclusive history overrode terminal Candidate A resolution';
  end if;
  if exists (
    select 1 from (
      select result
      from public.servicenow_write_reconciliation_events
      where command_id='command-retry-success-01'
      order by created_at desc
      limit 100
    ) display_window
    where display_window.result in ('confirmed_succeeded','confirmed_not_applied')
  ) or not exists (
    select 1
    from public.servicenow_write_mutation_candidate_events candidate_b
    where candidate_b.command_id='command-candidate-rewrite-01'
      and candidate_b.attempt_number=2
      and not exists (
        select 1 from public.servicenow_write_reconciliation_events terminal_resolution
        where terminal_resolution.mutation_candidate_event_id=candidate_b.id
          and terminal_resolution.result in ('confirmed_succeeded','confirmed_not_applied')
      )
  ) then
    raise exception 'Terminal Candidate projection depended on the 100-row display window';
  end if;
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-retry-success-01';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-retry-success-01','action','retry','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('c',64),
    'issuedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
  ));
  perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-retry-success-01','attemptId','attempt-retry-success-b',
    'executionMode','retry','retry',true,'requestId','request-retry-success-b',
    'startedAt',public.supper_test_iso(statement_timestamp()),'actorUserId','admin-user',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('c',64)
  ));
  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-retry-success-01','attemptId','attempt-retry-success-b',
    'outcome','succeeded','deliveryDisposition','confirmed_succeeded',
    'failurePhase','','retryAllowed',false,'retryReason','','reconciliationReason','',
    'requestSummary',jsonb_build_object('method','POST'),
    'responseSummary',jsonb_build_object(
      'mutationCandidateObserved',true,'candidateSysId',repeat('9',32),
      'candidateNumber','INC0099999','mutationHttpStatus',201,
      'postWriteMarkerVerified',true
    ),
    'mutationCandidateSysId',repeat('9',32),
    'mutationCandidateNumber','INC0099999',
    'mutationCandidateHttpStatus',201,
    'mutationCandidateSource','mutation_response',
    'mutationCandidateProofStatus','marker_verified',
    'targetSysId',repeat('9',32),'targetNumber','INC0099999',
    'errorCode','','errorMessage','',
    'finishedAt',public.supper_test_iso(statement_timestamp())
  ));
  if (
    select count(*) from public.servicenow_write_mutation_candidate_events
    where command_id='command-retry-success-01'
  )<>2 or not exists (
    select 1
    from public.servicenow_write_mutation_candidate_events candidate_a
    where candidate_a.command_id='command-retry-success-01'
      and candidate_a.attempt_number=1
      and candidate_a.sys_id=repeat('8',32)
      and exists (
        select 1 from public.servicenow_write_reconciliation_events resolution
        where resolution.mutation_candidate_event_id=candidate_a.id
          and resolution.result='confirmed_not_applied'
      )
  ) or not exists (
    select 1
    from public.servicenow_write_mutation_candidate_events candidate_b
    where candidate_b.command_id='command-retry-success-01'
      and candidate_b.attempt_number=2
      and candidate_b.sys_id=repeat('9',32)
      and candidate_b.proof_status='marker_verified'
  ) then
    raise exception 'Successful retry did not preserve Candidate A and confirm Candidate B';
  end if;
  if not exists (
    select 1
    from public.servicenow_write_commands command_record
    join public.servicenow_write_attempts attempt_record
      on attempt_record.command_id=command_record.id
      and attempt_record.id='attempt-retry-success-b'
    join public.servicenow_ticket_links ticket_link
      on ticket_link.supper_ticket_id='ticket-write-00000002'
    where command_record.id='command-retry-success-01'
      and command_record.status='succeeded'
      and command_record.target_sys_id=repeat('9',32)
      and command_record.target_number='INC0099999'
      and attempt_record.outcome='succeeded'
      and ticket_link.servicenow_sys_id=repeat('9',32)
      and ticket_link.servicenow_number='INC0099999'
  ) then
    raise exception 'Successful retry did not finalize Candidate B and its Ticket link';
  end if;

  perform * from public.support_create_servicenow_write_command(
    public.supper_test_write_payload(
      'command-proof-negative-01','manual-op:proof-negative',
      'Strict candidate proof verifier'
    )
  );
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-proof-negative-01';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-proof-negative-01','action','execute','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('2',64),
    'issuedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
  ));
  perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-proof-negative-01','attemptId','attempt-proof-negative-01',
    'executionMode','live','retry',false,'requestId','request-proof-negative',
    'startedAt',public.supper_test_iso(statement_timestamp()),'actorUserId','admin-user',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('2',64)
  ));
  for v_attempt in
    select *
    from jsonb_to_recordset('[
      {"suffix":"missing","summary":{"mutationCandidateObserved":true,"candidateSysId":"33333333333333333333333333333333","candidateNumber":"INC0033333","mutationHttpStatus":201}},
      {"suffix":"null","summary":{"mutationCandidateObserved":true,"candidateSysId":"33333333333333333333333333333333","candidateNumber":"INC0033333","mutationHttpStatus":201,"postWriteMarkerVerified":null}},
      {"suffix":"false","summary":{"mutationCandidateObserved":true,"candidateSysId":"33333333333333333333333333333333","candidateNumber":"INC0033333","mutationHttpStatus":201,"postWriteMarkerVerified":false}},
      {"suffix":"mixed-recovery","summary":{"mutationCandidateObserved":true,"candidateSysId":"33333333333333333333333333333333","candidateNumber":"INC0033333","mutationHttpStatus":201,"postWriteMarkerVerified":true,"recoveredByCorrelationMarker":true,"providerWritePerformed":false}}
    ]'::jsonb) as proof_case(suffix text, summary jsonb)
  loop
    begin
      perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
        'commandId','command-proof-negative-01','attemptId','attempt-proof-negative-01',
        'outcome','succeeded','deliveryDisposition','confirmed_succeeded',
        'failurePhase','','retryAllowed',false,'retryReason','','reconciliationReason','',
        'requestSummary',jsonb_build_object('method','POST'),
        'responseSummary',v_attempt.summary,
        'mutationCandidateSysId',repeat('3',32),
        'mutationCandidateNumber','INC0033333',
        'mutationCandidateHttpStatus',201,
        'mutationCandidateSource','mutation_response',
        'mutationCandidateProofStatus','marker_verified',
        'targetSysId',repeat('3',32),'targetNumber','INC0033333',
        'errorCode','','errorMessage','',
        'finishedAt',public.supper_test_iso(statement_timestamp())
      ));
      raise exception 'Invalid candidate proof case % was accepted',v_attempt.suffix;
    exception when invalid_parameter_value then
      if sqlerrm<>'SERVICENOW_WRITE_RESULT_INVALID' then raise; end if;
    end;
  end loop;
  begin
    perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
      'commandId','command-proof-negative-01','attemptId','attempt-proof-negative-01',
      'outcome','succeeded','deliveryDisposition','confirmed_succeeded',
      'failurePhase','','retryAllowed',false,'retryReason','','reconciliationReason','',
      'requestSummary',jsonb_build_object('method','GET'),
      'responseSummary','{}'::jsonb,
      'targetSysId',repeat('3',32),'targetNumber','INC0033333',
      'errorCode','','errorMessage','',
      'finishedAt',public.supper_test_iso(statement_timestamp())
    ));
    raise exception 'Create success with empty proof summary was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_RESULT_INVALID' then raise; end if;
  end;
  begin
    perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
      'commandId','command-proof-negative-01','attemptId','attempt-proof-negative-01',
      'outcome','uncertain','deliveryDisposition','may_have_committed',
      'failurePhase','read_back','retryAllowed',false,'retryReason','',
      'reconciliationReason','Forged verified proof on uncertain outcome',
      'requestSummary',jsonb_build_object('method','POST'),
      'responseSummary',jsonb_build_object(
        'mutationCandidateObserved',true,'candidateSysId',repeat('3',32),
        'candidateNumber','INC0033333','mutationHttpStatus',201,
        'postWriteMarkerVerified',true
      ),
      'mutationCandidateSysId',repeat('3',32),
      'mutationCandidateNumber','INC0033333',
      'mutationCandidateHttpStatus',201,
      'mutationCandidateSource','mutation_response',
      'mutationCandidateProofStatus','marker_verified',
      'targetSysId','','targetNumber','','errorCode','SERVICENOW_WRITE_FORGED_PROOF',
      'errorMessage','Forged verified proof on uncertain outcome',
      'finishedAt',public.supper_test_iso(statement_timestamp())
    ));
    raise exception 'Verified proof was accepted for an uncertain outcome';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_RESULT_INVALID' then raise; end if;
  end;
  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-proof-negative-01','attemptId','attempt-proof-negative-01',
    'outcome','uncertain','deliveryDisposition','may_have_committed',
    'failurePhase','read_back','retryAllowed',false,'retryReason','',
    'reconciliationReason','Marker proof was not verified',
    'requestSummary',jsonb_build_object('method','POST'),
    'responseSummary',jsonb_build_object(
      'mutationCandidateObserved',true,'candidateSysId',repeat('3',32),
      'candidateNumber','INC0033333','mutationHttpStatus',201,
      'postWriteMarkerVerified',false
    ),
    'mutationCandidateSysId',repeat('3',32),
    'mutationCandidateNumber','INC0033333',
    'mutationCandidateHttpStatus',201,
    'mutationCandidateSource','mutation_response',
    'mutationCandidateProofStatus','marker_not_verified',
    'targetSysId','','targetNumber','','errorCode','SERVICENOW_WRITE_MARKER_NOT_VERIFIED',
    'errorMessage','Marker proof was not verified',
    'finishedAt',public.supper_test_iso(statement_timestamp())
  ));

  perform * from public.support_create_servicenow_write_command(
    public.supper_test_write_payload(
      'command-marker-recovery-01','manual-op:marker-recovery',
      'Exact marker recovery verifier'
    )
  );
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-marker-recovery-01';
  select public.support_intake_sha256_hex(provider_correlation_marker)
  into v_marker_hash
  from public.servicenow_write_commands where id='command-marker-recovery-01';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-marker-recovery-01','action','execute','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('1',64),
    'issuedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
  ));
  perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-marker-recovery-01','attemptId','attempt-marker-recovery-01',
    'executionMode','live','retry',false,'requestId','request-marker-recovery',
    'startedAt',public.supper_test_iso(statement_timestamp()),'actorUserId','admin-user',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('1',64)
  ));
  for v_attempt in
    select * from (values
      (
        'missing-identity',
        jsonb_build_object(
          'httpStatus',200,'recoveredByCorrelationMarker',true,
          'providerWritePerformed',false,'exactMarkerVerified',true,
          'verifiedCorrelationMarkerHash',v_marker_hash
        ),repeat('2',32),'INC0022222'
      ),
      (
        'sys-id-mismatch',
        jsonb_build_object(
          'httpStatus',200,'sysId',repeat('3',32),'number','INC0022222',
          'recoveredByCorrelationMarker',true,'providerWritePerformed',false,
          'exactMarkerVerified',true,'verifiedCorrelationMarkerHash',v_marker_hash
        ),repeat('2',32),'INC0022222'
      ),
      (
        'number-mismatch',
        jsonb_build_object(
          'httpStatus',200,'sysId',repeat('2',32),'number','INC0099999',
          'recoveredByCorrelationMarker',true,'providerWritePerformed',false,
          'exactMarkerVerified',true,'verifiedCorrelationMarkerHash',v_marker_hash
        ),repeat('2',32),'INC0022222'
      ),
      (
        'missing-exact-proof',
        jsonb_build_object(
          'httpStatus',200,'sysId',repeat('2',32),'number','INC0022222',
          'recoveredByCorrelationMarker',true,'providerWritePerformed',false,
          'verifiedCorrelationMarkerHash',v_marker_hash
        ),repeat('2',32),'INC0022222'
      ),
      (
        'forged-target-pair',
        jsonb_build_object(
          'httpStatus',200,'sysId',repeat('2',32),'number','INC0022222',
          'recoveredByCorrelationMarker',true,'providerWritePerformed',false,
          'exactMarkerVerified',true,'verifiedCorrelationMarkerHash',v_marker_hash
        ),repeat('4',32),'INC0044444'
      )
    ) as invalid_g2(suffix,response_summary,target_sys_id,target_number)
  loop
    begin
      perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
        'commandId','command-marker-recovery-01','attemptId','attempt-marker-recovery-01',
        'outcome','succeeded','deliveryDisposition','confirmed_succeeded',
        'failurePhase','','retryAllowed',false,'retryReason','','reconciliationReason','',
        'requestSummary',jsonb_build_object(
          'method','GET','endpointPath','/api/now/table/incident',
          'targetTable','incident','fieldNames',jsonb_build_array(
            'correlation_id','number','state','sys_id'
          ),'targetSysId',repeat('2',32),'targetNumber','INC0022222',
          'lookupClassification','correlation_marker_exact',
          'lookupCorrelationMarkerHash',v_marker_hash
        ),
        'responseSummary',v_attempt.response_summary,
        'targetSysId',v_attempt.target_sys_id,'targetNumber',v_attempt.target_number,
        'errorCode','','errorMessage','',
        'finishedAt',public.supper_test_iso(statement_timestamp())
      ));
      raise exception 'Invalid G2 case % was accepted',v_attempt.suffix;
    exception when invalid_parameter_value then
      if sqlerrm<>'SERVICENOW_WRITE_RESULT_INVALID' then raise; end if;
    end;
  end loop;
  v_g2_request := jsonb_build_object(
    'method','GET','endpointPath','/api/now/table/incident',
    'targetTable','incident','fieldNames',jsonb_build_array(
      'correlation_id','number','state','sys_id'
    ),'targetSysId',repeat('2',32),'targetNumber','INC0022222',
    'lookupClassification','correlation_marker_exact',
    'lookupCorrelationMarkerHash',v_marker_hash
  );
  v_g2_response := jsonb_build_object(
    'httpStatus',200,'sysId',repeat('2',32),'number','INC0022222',
    'recoveredByCorrelationMarker',true,'providerWritePerformed',false,
    'exactMarkerVerified',true,'verifiedCorrelationMarkerHash',v_marker_hash
  );
  for v_attempt in
    select * from (values
      ('missing-request-hash',v_g2_request-'lookupCorrelationMarkerHash',v_g2_response),
      ('missing-response-hash',v_g2_request,v_g2_response-'verifiedCorrelationMarkerHash'),
      ('wrong-marker-hash',jsonb_set(v_g2_request,'{lookupCorrelationMarkerHash}',to_jsonb(repeat('f',64))),jsonb_set(v_g2_response,'{verifiedCorrelationMarkerHash}',to_jsonb(repeat('f',64)))),
      ('request-response-hash-mismatch',jsonb_set(v_g2_request,'{lookupCorrelationMarkerHash}',to_jsonb(repeat('e',64))),v_g2_response)
    ) as invalid_marker_hash(suffix,request_summary,response_summary)
  loop
    begin
      perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
        'commandId','command-marker-recovery-01','attemptId','attempt-marker-recovery-01',
        'outcome','succeeded','deliveryDisposition','confirmed_succeeded',
        'failurePhase','','retryAllowed',false,'retryReason','','reconciliationReason','',
        'requestSummary',v_attempt.request_summary,
        'responseSummary',v_attempt.response_summary,
        'targetSysId',repeat('2',32),'targetNumber','INC0022222',
        'errorCode','','errorMessage','',
        'finishedAt',public.supper_test_iso(statement_timestamp())
      ));
      raise exception 'Invalid G2 marker hash case % was accepted',v_attempt.suffix;
    exception when invalid_parameter_value then
      if sqlerrm<>'SERVICENOW_WRITE_RESULT_INVALID' then raise; end if;
    end;
  end loop;
  perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-marker-recovery-01','attemptId','attempt-marker-recovery-01',
    'outcome','succeeded','deliveryDisposition','confirmed_succeeded',
    'failurePhase','','retryAllowed',false,'retryReason','','reconciliationReason','',
    'requestSummary',jsonb_build_object(
      'method','GET','endpointPath','/api/now/table/incident',
      'targetTable','incident','fieldNames',jsonb_build_array(
        'correlation_id','number','state','sys_id'
      ),'targetSysId',repeat('2',32),'targetNumber','INC0022222',
      'lookupClassification','correlation_marker_exact',
      'lookupCorrelationMarkerHash',v_marker_hash
    ),
    'responseSummary',jsonb_build_object(
      'httpStatus',200,'sysId',repeat('2',32),'number','INC0022222',
      'recoveredByCorrelationMarker',true,
      'providerWritePerformed',false,
      'exactMarkerVerified',true,
      'verifiedCorrelationMarkerHash',v_marker_hash
    ),
    'targetSysId',repeat('2',32),'targetNumber','INC0022222',
    'errorCode','','errorMessage','',
    'finishedAt',public.supper_test_iso(statement_timestamp())
  ));
  if not exists (
    select 1 from public.servicenow_write_commands command_record
    join public.servicenow_write_attempts attempt_record
      on attempt_record.command_id=command_record.id
    where command_record.id='command-marker-recovery-01'
      and command_record.status='succeeded'
      and attempt_record.request_summary->>'method'='GET'
      and attempt_record.response_summary->'recoveredByCorrelationMarker'='true'::jsonb
      and attempt_record.response_summary->'providerWritePerformed'='false'::jsonb
      and attempt_record.response_summary->'exactMarkerVerified'='true'::jsonb
      and attempt_record.response_summary->>'sysId'=repeat('2',32)
      and attempt_record.response_summary->>'number'='INC0022222'
      and not exists (
        select 1 from public.servicenow_write_mutation_candidate_events candidate
        where candidate.command_id=command_record.id
      )
  ) then
    raise exception 'Exact marker recovery did not preserve no-mutation proof';
  end if;

  perform * from public.support_create_servicenow_write_command(
    public.supper_test_write_payload(
      'command-stuck-recovery-01','manual-op:stuck-recovery',
      'Administrative recovery verifier'
    )
  );
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-stuck-recovery-01';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-stuck-recovery-01','action','execute','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('a',64),
    'issuedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
  ));
  perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-stuck-recovery-01','attemptId','attempt-stuck-recovery-01',
    'executionMode','live','retry',false,'requestId','request-stuck-start',
    'startedAt',public.supper_test_iso(statement_timestamp()),'actorUserId','admin-user',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('a',64)
  ));
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-stuck-recovery-01';
  begin
    perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
      'commandId','command-stuck-recovery-01','action','recover_stuck_attempt',
      'actorUserId','admin-user','expectedVersion',v_version,
      'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',repeat('b',64),
      'issuedAt',public.supper_test_iso(statement_timestamp()),
      'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
    ));
    raise exception 'Immediate recovery confirmation bypassed the recovery lease';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_ATTEMPT_RECOVERY_TOO_EARLY' then raise; end if;
  end;
  begin
    perform * from public.support_recover_servicenow_write_attempt(jsonb_build_object(
      'commandId','command-stuck-recovery-01','actorUserId','admin-user',
      'requestId','request-stuck-recover','recoveredAt','2000-01-01T00:00:00.000Z',
      'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',repeat('b',64)
    ));
    raise exception 'Caller recovery time bypass material was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_ATTEMPT_RECOVERY_INVALID' then raise; end if;
  end;
  perform set_config('session_replication_role','replica',true);
  update public.servicenow_write_attempts set
    recoverable_at=statement_timestamp()+interval '1 second',
    started_at=statement_timestamp()+interval '1 second'
      -make_interval(secs => recovery_budget_ms/1000.0)
  where id='attempt-stuck-recovery-01';
  perform set_config('session_replication_role','origin',true);
  begin
    perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
      'commandId','command-stuck-recovery-01','action','recover_stuck_attempt',
      'actorUserId','admin-user','expectedVersion',v_version,
      'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',repeat('b',64),
      'issuedAt',public.supper_test_iso(statement_timestamp()),
      'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
    ));
    raise exception 'Recovery confirmation one second before eligibility was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_ATTEMPT_RECOVERY_TOO_EARLY' then raise; end if;
  end;
  perform set_config('session_replication_role','replica',true);
  update public.servicenow_write_attempts
  set recoverable_at=statement_timestamp(),
    started_at=statement_timestamp()-make_interval(secs => recovery_budget_ms/1000.0)
  where id='attempt-stuck-recovery-01';
  perform set_config('session_replication_role','origin',true);
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-stuck-recovery-01','action','recover_stuck_attempt',
    'actorUserId','admin-user','expectedVersion',v_version,
    'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',repeat('b',64),
    'issuedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
  ));
  perform set_config('session_replication_role','replica',true);
  update public.servicenow_write_attempts
  set recoverable_at=statement_timestamp()+interval '1 second',
    started_at=statement_timestamp()+interval '1 second'
      -make_interval(secs => recovery_budget_ms/1000.0)
  where id='attempt-stuck-recovery-01';
  perform set_config('session_replication_role','origin',true);
  begin
    perform * from public.support_recover_servicenow_write_attempt(jsonb_build_object(
      'commandId','command-stuck-recovery-01','actorUserId','admin-user',
      'requestId','request-stuck-recover','confirmed',true,
      'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',repeat('b',64)
    ));
    raise exception 'Recovery RPC bypassed database eligibility time';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_ATTEMPT_RECOVERY_TOO_EARLY' then raise; end if;
  end;
  perform set_config('session_replication_role','replica',true);
  update public.servicenow_write_attempts
  set recoverable_at=statement_timestamp(),
    started_at=statement_timestamp()-make_interval(secs => recovery_budget_ms/1000.0)
  where id='attempt-stuck-recovery-01';
  perform set_config('session_replication_role','origin',true);
  perform * from public.support_recover_servicenow_write_attempt(jsonb_build_object(
    'commandId','command-stuck-recovery-01','actorUserId','admin-user',
    'requestId','request-stuck-recover','confirmed',true,
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('b',64)
  ));
  select id into v_recovery_event_id
  from public.servicenow_write_attempt_recovery_events
  where command_id='command-stuck-recovery-01';
  if v_recovery_event_id is null or not exists (
    select 1 from public.servicenow_write_commands command_record
    join public.servicenow_write_attempts attempt_record
      on attempt_record.command_id=command_record.id
    where command_record.id='command-stuck-recovery-01'
      and command_record.status='reconciliation_required'
      and attempt_record.outcome='uncertain'
      and attempt_record.request_summary='{}'::jsonb
      and attempt_record.response_summary->'recoveryOperationProviderRequestPerformed'='false'::jsonb
      and attempt_record.response_summary->>'originalMutationOutcome'='unknown'
      and not (attempt_record.response_summary ? 'providerWritePerformed')
  ) then
    raise exception 'Administrative recovery did not close the stuck ledger state safely';
  end if;
  begin
    perform * from public.support_finish_servicenow_write_attempt(jsonb_build_object(
      'commandId','command-stuck-recovery-01','attemptId','attempt-stuck-recovery-01',
      'outcome','succeeded','deliveryDisposition','confirmed_succeeded',
      'failurePhase','','retryAllowed',false,'retryReason','','reconciliationReason','',
      'requestSummary',jsonb_build_object('method','POST'),
      'responseSummary',jsonb_build_object('httpStatus',201),
      'targetSysId',repeat('5',32),'targetNumber','INC0055555',
      'errorCode','','errorMessage','',
      'finishedAt',public.supper_test_iso(statement_timestamp())
    ));
    raise exception 'Late provider finish rewrote a recovered Attempt';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_ATTEMPT_ALREADY_RECOVERED' then raise; end if;
  end;
  for v_late in
    select * from (values
      ('timeout',jsonb_build_object(
        'commandId','command-stuck-recovery-01','attemptId','attempt-stuck-recovery-01',
        'outcome','uncertain','deliveryDisposition','may_have_committed',
        'failurePhase','mutation_dispatch','retryAllowed',false,'retryReason','',
        'reconciliationReason','Late timeout outcome','requestSummary',jsonb_build_object('method','POST'),
        'responseSummary','{}'::jsonb,'targetSysId','','targetNumber','',
        'errorCode','SERVICENOW_WRITE_TIMEOUT','errorMessage','Late timeout outcome',
        'finishedAt',public.supper_test_iso(statement_timestamp())
      )),
      ('http-5xx',jsonb_build_object(
        'commandId','command-stuck-recovery-01','attemptId','attempt-stuck-recovery-01',
        'outcome','uncertain','deliveryDisposition','may_have_committed',
        'failurePhase','mutation_response','retryAllowed',false,'retryReason','',
        'reconciliationReason','Late provider 5xx outcome','requestSummary',jsonb_build_object('method','POST'),
        'responseSummary',jsonb_build_object('httpStatus',503),'targetSysId','','targetNumber','',
        'errorCode','SERVICENOW_WRITE_UNAVAILABLE','errorMessage','Late provider 5xx outcome',
        'finishedAt',public.supper_test_iso(statement_timestamp())
      )),
      ('candidate-proof-failure',jsonb_build_object(
        'commandId','command-stuck-recovery-01','attemptId','attempt-stuck-recovery-01',
        'outcome','uncertain','deliveryDisposition','may_have_committed',
        'failurePhase','read_back','retryAllowed',false,'retryReason','',
        'reconciliationReason','Late Candidate proof failure',
        'requestSummary',jsonb_build_object('method','POST'),
        'responseSummary',jsonb_build_object(
          'mutationCandidateObserved',true,'candidateSysId',repeat('6',32),
          'candidateNumber','INC0066666','mutationHttpStatus',201,
          'postWriteMarkerVerified',false
        ),
        'mutationCandidateSysId',repeat('6',32),
        'mutationCandidateNumber','INC0066666','mutationCandidateHttpStatus',201,
        'mutationCandidateSource','mutation_response',
        'mutationCandidateProofStatus','marker_not_found',
        'targetSysId','','targetNumber','',
        'errorCode','SERVICENOW_WRITE_POST_CREATE_NOT_FOUND',
        'errorMessage','Late Candidate proof failure',
        'finishedAt',public.supper_test_iso(statement_timestamp())
      ))
    ) as late_outcome(suffix,payload)
  loop
    begin
      perform * from public.support_finish_servicenow_write_attempt(v_late.payload);
      raise exception 'Late % outcome rewrote a recovered Attempt',v_late.suffix;
    exception when invalid_parameter_value then
      if sqlerrm<>'SERVICENOW_WRITE_ATTEMPT_ALREADY_RECOVERED' then raise; end if;
    end;
  end loop;
  if not exists (
    select 1 from public.servicenow_write_commands command_record
    join public.servicenow_write_attempts attempt_record
      on attempt_record.command_id=command_record.id
    where command_record.id='command-stuck-recovery-01'
      and command_record.status='reconciliation_required'
      and attempt_record.outcome='uncertain'
      and not exists (
        select 1 from public.servicenow_write_mutation_candidate_events candidate
        where candidate.command_id=command_record.id
      )
  ) then
    raise exception 'Late provider finish changed recovered command or Candidate state';
  end if;
  begin
    update public.servicenow_write_attempt_recovery_events
    set request_id='changed'
    where id=v_recovery_event_id;
    raise exception 'Attempt recovery history was mutable';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_RECONCILIATION_IMMUTABLE' then raise; end if;
  end;

  perform * from public.support_upsert_servicenow_write_connection(jsonb_build_object(
    'id','connection-test-00000001','name','Test PDI','active',true,
    'authMode','basic','instanceUrl','https://example.service-now.com',
    'incidentTable','incident','configVersion','rotated',
    'configurationFingerprint','eb7f725367657b0a1763468f09198b537840521fea61b6ad9acbd28a9ce50648',
    'timeoutMs',15000,'metadata',jsonb_build_object('source','sql-test'),
    'updatedAt','2026-07-23T01:05:00.000Z'
  ));
  if exists (
    select 1 from public.servicenow_write_readiness_proofs
    where connection_id='connection-test-00000001'
  ) then
    raise exception 'Connection configuration change did not invalidate readiness';
  end if;
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-test-0000000004';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-test-0000000004','action','execute','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('6',64),
    'issuedAt','2026-07-23T01:05:01.000Z','expiresAt','2026-07-23T01:07:00.000Z'
  ));
  begin
    perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
      'commandId','command-test-0000000004','attemptId','attempt-no-readiness-0001',
      'executionMode','live','retry',false,'requestId','request-write-sql-no-proof',
      'startedAt','2026-07-23T01:05:10.000Z','actorUserId','admin-user',
      'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',repeat('6',64)
    ));
    raise exception 'Live attempt started without fresh readiness';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_READINESS_REQUIRED' then raise; end if;
  end;
  if exists (
    select 1 from public.servicenow_write_attempts
    where id='attempt-no-readiness-0001'
  ) then
    raise exception 'Failed readiness consumed a live attempt';
  end if;
end;
$$;

do $$
declare
  v_version integer;
  v_hash text;
begin
  begin
    perform * from public.support_record_servicenow_write_readiness(jsonb_build_object(
      'connectionId','connection-test-00000001',
      'configurationFingerprint','eb7f725367657b0a1763468f09198b537840521fea61b6ad9acbd28a9ce50648',
      'testedAt',public.supper_test_iso(statement_timestamp()+interval '10 minutes'),
      'expiresAt',public.supper_test_iso(statement_timestamp()+interval '11 minutes'),
      'testStatus','succeeded','safeHttpStatus',200,
      'testedByUserId','admin-user','safeErrorCode','',
      'updatedAt',public.supper_test_iso(statement_timestamp()+interval '10 minutes')
    ));
    raise exception 'Future readiness proof was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_READINESS_INVALID' then raise; end if;
  end;

  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-test-0000000004';
  begin
    perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
      'commandId','command-test-0000000004','action','execute','actorUserId','admin-user',
      'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
      'confirmationNonceHash',repeat('5',64),
      'issuedAt',public.supper_test_iso(statement_timestamp()+interval '10 minutes'),
      'expiresAt',public.supper_test_iso(statement_timestamp()+interval '11 minutes')
    ));
    raise exception 'Future confirmation issue timestamp was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_CONFIRMATION_INVALID' then raise; end if;
  end;

  perform * from public.support_record_servicenow_write_readiness(jsonb_build_object(
    'connectionId','connection-test-00000001',
    'configurationFingerprint','eb7f725367657b0a1763468f09198b537840521fea61b6ad9acbd28a9ce50648',
    'testedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute'),
    'testStatus','succeeded','safeHttpStatus',200,
    'testedByUserId','admin-user','safeErrorCode','',
    'updatedAt',public.supper_test_iso(statement_timestamp())
  ));
  update public.servicenow_write_readiness_proofs
  set tested_at=statement_timestamp()-interval '2 seconds',
    expires_at=statement_timestamp()-interval '1 second'
  where connection_id='connection-test-00000001';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-test-0000000004','action','execute','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('4',64),
    'issuedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
  ));
  begin
    perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
      'commandId','command-test-0000000004','attemptId','attempt-stale-db-clock-0001',
      'executionMode','live','retry',false,'requestId','request-stale-db-clock',
      'startedAt',public.supper_test_iso(statement_timestamp()-interval '90 seconds'),
      'actorUserId','admin-user','confirmed',true,'expectedVersion',v_version,
      'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',repeat('4',64)
    ));
    raise exception 'Stale readiness was bypassed with an old caller timestamp';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_READINESS_REQUIRED' then raise; end if;
  end;

  perform * from public.support_record_servicenow_write_readiness(jsonb_build_object(
    'connectionId','connection-test-00000001',
    'configurationFingerprint','eb7f725367657b0a1763468f09198b537840521fea61b6ad9acbd28a9ce50648',
    'testedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute'),
    'testStatus','succeeded','safeHttpStatus',200,
    'testedByUserId','admin-user','safeErrorCode','',
    'updatedAt',public.supper_test_iso(statement_timestamp())
  ));
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-test-0000000004','action','execute','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('3',64),
    'issuedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
  ));
  update public.servicenow_write_commands
  set confirmation_expires_at=statement_timestamp()-interval '1 second'
  where id='command-test-0000000004';
  begin
    perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
      'commandId','command-test-0000000004','attemptId','attempt-expired-confirm-001',
      'executionMode','live','retry',false,'requestId','request-expired-confirm',
      'startedAt',public.supper_test_iso(statement_timestamp()-interval '90 seconds'),
      'actorUserId','admin-user','confirmed',true,'expectedVersion',v_version,
      'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',repeat('3',64)
    ));
    raise exception 'Expired confirmation was bypassed with an old caller timestamp';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_CONFIRMATION_INVALID' then raise; end if;
  end;

  update public.servicenow_write_commands set
    status='retry_scheduled',retry_allowed=true,
    next_retry_at=statement_timestamp()+interval '1 minute',
    confirmation_nonce_hash=null,confirmation_action=null,
    confirmation_user_id=null,confirmation_expires_at=null
  where id='command-test-0000000004';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-test-0000000004','action','retry','actorUserId','admin-user',
    'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('2',64),
    'issuedAt',public.supper_test_iso(statement_timestamp()),
    'expiresAt',public.supper_test_iso(statement_timestamp()+interval '1 minute')
  ));
  begin
    perform * from public.support_begin_servicenow_write_attempt(jsonb_build_object(
      'commandId','command-test-0000000004','attemptId','attempt-before-db-retry-001',
      'executionMode','retry','retry',true,'requestId','request-before-db-retry',
      'startedAt',public.supper_test_iso(statement_timestamp()-interval '90 seconds'),
      'actorUserId','admin-user','confirmed',true,'expectedVersion',v_version,
      'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',repeat('2',64)
    ));
    raise exception 'Retry started before database next_retry_at';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_RETRY_NOT_ALLOWED' then raise; end if;
  end;
end;
$$;

do $$
begin
  if has_table_privilege('service_role','public.servicenow_write_commands','insert')
    or has_table_privilege('service_role','public.servicenow_write_connections','update')
    or has_table_privilege('service_role','public.servicenow_write_mappings','insert')
    or has_table_privilege('service_role','public.servicenow_write_commands','update')
    or has_table_privilege('service_role','public.servicenow_write_attempts','insert')
    or has_table_privilege('service_role','public.servicenow_write_mutation_candidate_events','insert')
    or has_table_privilege('service_role','public.servicenow_write_mutation_candidate_events','update')
    or has_table_privilege('service_role','public.servicenow_write_mutation_candidate_events','delete')
    or has_table_privilege('service_role','public.servicenow_write_attempt_recovery_events','insert')
    or has_table_privilege('service_role','public.servicenow_ticket_links','update')
    or has_table_privilege('service_role','public.servicenow_write_reconciliation_events','insert')
    or has_table_privilege('service_role','public.servicenow_write_readiness_proofs','insert') then
    raise exception 'service_role can directly mutate an authoritative ledger';
  end if;
  if has_table_privilege('anon','public.servicenow_write_commands','select')
    or has_table_privilege('authenticated','public.servicenow_write_commands','select')
    or has_table_privilege('anon','public.servicenow_write_mutation_candidate_events','select')
    or has_table_privilege('authenticated','public.servicenow_write_mutation_candidate_events','select')
    or has_table_privilege('anon','public.servicenow_write_attempt_recovery_events','select') then
    raise exception 'Browser roles can read the write ledger';
  end if;
  if has_function_privilege('public','public.support_create_servicenow_write_command(jsonb)','execute')
    or has_function_privilege('anon','public.support_begin_servicenow_write_attempt(jsonb)','execute')
    or has_function_privilege('authenticated','public.support_reconcile_servicenow_write_command(jsonb)','execute')
    or has_function_privilege('public','public.support_record_servicenow_write_readiness(jsonb)','execute') then
    raise exception 'Privileged write RPC is browser executable';
  end if;
  if not has_function_privilege('service_role','public.support_create_servicenow_write_command(jsonb)','execute')
    or not has_function_privilege('service_role','public.support_issue_servicenow_write_confirmation(jsonb)','execute')
    or not has_function_privilege('service_role','public.support_begin_servicenow_write_attempt(jsonb)','execute')
    or not has_function_privilege('service_role','public.support_finish_servicenow_write_attempt(jsonb)','execute')
    or not has_function_privilege('service_role','public.support_record_servicenow_write_readiness(jsonb)','execute')
    or not has_function_privilege('service_role','public.support_reconcile_servicenow_write_command(jsonb)','execute')
    or not has_function_privilege('service_role','public.support_recover_servicenow_write_attempt(jsonb)','execute') then
    raise exception 'service_role cannot execute controlled write RPCs';
  end if;
end;
$$;
`;

const acceptanceReference = Date.parse("2026-07-23T01:00:00.000Z");
const acceptanceBase = Date.now() - 30_000;
const acceptanceSql = acceptanceSqlTemplate.replace(
  /2026-07-(?:22|23)T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
  (value) => new Date(
    acceptanceBase + (Date.parse(value) - acceptanceReference) / 60,
  ).toISOString(),
);

try {
  run("initdb", ["-A", "trust", "-U", "postgres", "-D", dataDirectory, "--no-locale"]);
  mkdirSync(socketDirectory, { recursive: true });
  run("pg_ctl", ["-D", dataDirectory, "-l", logPath, "-o", `-F -k ${socketDirectory} -p ${port}`, "-w", "start"]);
  started = true;
  psql([], baseSchema);
  for (const name of [
    "202607220001_unified_intake_core.sql",
    "202607220002_unified_intake_core_corrections.sql",
    "202607220003_unified_intake_core_replay_corrections.sql",
    "202607220004_unified_intake_core_final_integrity.sql",
  ]) {
    psql(["-f", path.join(root, "supabase/migrations", name)]);
  }
  const migration = path.join(root, "supabase/migrations/202607230001_servicenow_write_kernel.sql");
  psql(["-f", migration]);
  psql(["-f", migration]);
  psql([], acceptanceSql);
  const version = psql(["-Atc", "select version from public.support_schema_migrations where version='202607230001'"]);
  if (version !== "202607230001") throw new Error(`Unexpected write migration version: ${version}`);
  console.log("ServiceNow write migration executed twice after real intake migrations; operation-wide recovery leases, unified late-response closure, marker-hash-bound G2 proof, exact non-create execution and reconciliation evidence, terminal Candidate projection, database-clock authority, and ledger grants passed.");
} finally {
  if (started) spawnSync("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"], { encoding: "utf8" });
  for (const target of [dataDirectory, socketDirectory, logPath]) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
}
