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
if (writeServiceSource.includes("`manual-op:${commandId}`")) {
  throw new Error("Manual operation identity is still derived from a per-request command ID");
}
if (!writeUiSource.includes("setManualOperation(operation)")
  || !writeUiSource.includes("manualOperationToken: operation.operationToken")) {
  throw new Error("Browser lost-response replay does not retain the server-issued operation token");
}
for (const required of [
  "ledgerRuntime",
  "providerRuntime",
  "optionalProviderRuntime",
  "provider_unavailable_manual_verification",
]) {
  if (!writeServiceSource.includes(required)) {
    throw new Error(`ServiceNow recovery runtime is missing ${required}`);
  }
}
for (const required of [
  "SERVICENOW_WRITE_LOOKUP_MISMATCH",
  "correlation_id",
  "expected.number",
  "expected.sysId",
  "expected.correlationMarker",
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
  'timeoutMs',15000,
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

do $$
declare
  v_result record;
  v_attempt record;
  v_command jsonb;
  v_confirmation jsonb;
  v_version integer;
  v_hash text;
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
    where source_type='supper_ticket'
      and source_entity_reference='ticket-write-00000001'
      and command_type in ('add_comment','add_work_note')
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
      'method','correlation_marker','evidenceClassification','provider_matched'
    ),
    'targetSysId','','targetNumber','','actorUserId','admin-user',
    'requestId','request-write-sql-0004','checkedAt','2026-07-23T01:02:30.000Z',
    'confirmed',true,'expectedVersion',v_version,'expectedNormalizedPayloadHash',v_hash,
    'confirmationNonceHash',repeat('e',64)
  ));
  if not exists (
    select 1 from public.servicenow_write_reconciliation_events
    where command_id='command-test-0000000001' and result='inconclusive'
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
      'evidenceClassification','provider_unavailable_manual_verification'
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
    'requestSummary',jsonb_build_object('method','POST'),'responseSummary','{}'::jsonb,
    'targetSysId','','targetNumber','','errorCode','SERVICENOW_WRITE_RESPONSE_LOST',
    'errorMessage','ServiceNow response was not definitive',
    'finishedAt','2026-07-23T01:04:11.000Z'
  ));
  select version,normalized_payload_hash into v_version,v_hash
  from public.servicenow_write_commands where id='command-verified-00000001';
  perform * from public.support_issue_servicenow_write_confirmation(jsonb_build_object(
    'commandId','command-verified-00000001','action','mark_succeeded_after_verification',
    'actorUserId','admin-user','expectedVersion',v_version,
    'expectedNormalizedPayloadHash',v_hash,'confirmationNonceHash',repeat('8',64),
    'issuedAt','2026-07-23T01:04:20.000Z','expiresAt','2026-07-23T01:06:00.000Z'
  ));
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
    ));
    raise exception 'Manual success without a complete target pair was accepted';
  exception when invalid_parameter_value then
    if sqlerrm<>'SERVICENOW_WRITE_RECONCILIATION_INVALID' then raise; end if;
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
    or has_table_privilege('service_role','public.servicenow_ticket_links','update')
    or has_table_privilege('service_role','public.servicenow_write_reconciliation_events','insert')
    or has_table_privilege('service_role','public.servicenow_write_readiness_proofs','insert') then
    raise exception 'service_role can directly mutate an authoritative ledger';
  end if;
  if has_table_privilege('anon','public.servicenow_write_commands','select')
    or has_table_privilege('authenticated','public.servicenow_write_commands','select') then
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
    or not has_function_privilege('service_role','public.support_reconcile_servicenow_write_command(jsonb)','execute') then
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
  console.log("ServiceNow write migration executed twice after real intake migrations; full command hash parity, evidence-gated reconciliation, database-clock authority, safe SQL parsing, uncertain outcomes, and ledger grants passed.");
} finally {
  if (started) spawnSync("pg_ctl", ["-D", dataDirectory, "-m", "fast", "-w", "stop"], { encoding: "utf8" });
  for (const target of [dataDirectory, socketDirectory, logPath]) {
    if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  }
}
