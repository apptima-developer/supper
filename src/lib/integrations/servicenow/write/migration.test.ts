import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationName = "202607230001_servicenow_write_kernel.sql";
const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations", migrationName), "utf8").toLowerCase();

describe("ServiceNow write kernel migration", () => {
  it("creates the bounded write-kernel and immutable reconciliation ledger", () => {
    for (const table of [
      "servicenow_write_connections",
      "servicenow_write_mappings",
      "servicenow_write_commands",
      "servicenow_write_attempts",
      "servicenow_ticket_links",
      "servicenow_write_reconciliation_events",
      "servicenow_write_readiness_proofs",
    ]) expect(sql).toContain(`create table if not exists public.${table}`);
    for (const index of [
      "servicenow_write_commands_status_idx",
      "servicenow_write_commands_connection_idx",
      "servicenow_write_commands_type_idx",
      "servicenow_write_commands_created_at_idx",
      "servicenow_write_attempts_command_idx",
      "servicenow_write_reconciliation_command_idx",
      "servicenow_write_readiness_expiry_idx",
    ]) expect(sql).toContain(index);
    expect(sql).toContain("normalized_payload_hash");
    expect(sql).toContain("octet_length(normalized_payload::text) <= 65536");
    expect(sql).toContain("support_intake_json_has_unsafe_key");
  });

  it("enables RLS and denies browser roles while preserving service-role access", () => {
    for (const table of [
      "servicenow_write_connections",
      "servicenow_write_mappings",
      "servicenow_write_commands",
      "servicenow_write_attempts",
      "servicenow_ticket_links",
      "servicenow_write_reconciliation_events",
      "servicenow_write_readiness_proofs",
    ]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`revoke all privileges on table public.${table} from public, anon, authenticated`);
    }
    for (const rpc of [
      "support_create_servicenow_write_command",
      "support_issue_servicenow_write_confirmation",
      "support_begin_servicenow_write_attempt",
      "support_finish_servicenow_write_attempt",
      "support_reconcile_servicenow_write_command",
      "support_record_servicenow_write_readiness",
    ]) {
      expect(sql).toContain(`revoke all privileges on function public.${rpc}(jsonb) from public`);
      expect(sql).toContain(`revoke execute on function public.${rpc}(jsonb) from anon, authenticated`);
      expect(sql).toContain(`grant execute on function public.${rpc}(jsonb) to service_role`);
    }
    expect(sql).not.toMatch(/grant\s+(insert|update|delete|all)\s+on table public\.servicenow_write_/);
  });

  it("contains database-owned identity, bounded retries, and explicit uncertainty", () => {
    expect(sql).toContain("servicenow_write_idempotency_conflict");
    expect(sql).toContain("on conflict (idempotency_key) do nothing");
    expect(sql).toContain("servicenow-write-v2");
    expect(sql).toContain("support_servicenow_write_normalize");
    expect(sql).toContain("support_servicenow_write_normalized_hash");
    expect(sql).toContain("provider_correlation_marker");
    expect(sql).toContain("may_have_committed");
    expect(sql).toContain("reconciliation_required");
    expect(sql).toContain("outcome = 'uncertain'");
    expect(sql).toContain("retry_scheduled");
    expect(sql).toContain("retry_allowed");
    expect(sql).toContain("next_retry_at");
    expect(sql).toContain("for update");
    expect(sql).toContain("unique (command_id, attempt_number)");
  });

  it("requires one-time confirmations and append-only reconciliation", () => {
    expect(sql).toContain("confirmation_nonce_hash");
    expect(sql).toContain("confirmation_expires_at");
    expect(sql).toContain("servicenow_write_confirmation_invalid");
    expect(sql).toContain("servicenow_write_reconciliation_append_only");
    expect(sql).toContain("servicenow_write_reconciliation_immutable");
    expect(sql).toContain("mark_succeeded_after_verification");
    expect(sql).toContain("mark_not_applied_after_verification");
    expect(sql).toContain("verificationacknowledged");
    expect(sql).toContain("verificationnote");
    expect(sql).toContain("servicenow_write_verified_target_conflict");
  });

  it("enforces fresh readiness and exception-safe payload parsing", () => {
    expect(sql).toContain("configuration_fingerprint");
    expect(sql).toContain("servicenow_write_readiness_required");
    expect(sql).toContain("support_servicenow_write_configuration_fingerprint");
    expect(sql).toContain("support_servicenow_write_parse_timestamp");
    expect(sql).toContain("support_servicenow_write_parse_integer");
    expect(sql).toContain("support_servicenow_write_parse_boolean");
    expect(sql).toContain("when invalid_datetime_format or datetime_field_overflow or invalid_text_representation");
    expect(sql).toContain("when invalid_text_representation or numeric_value_out_of_range");
  });

  it("records the forward-only migration and uses the portable intake hash helper", () => {
    expect(sql).toContain("values ('202607230001'");
    expect(sql).toContain("on conflict (version) do nothing");
    expect(sql).toContain("public.support_intake_sha256_hex");
    expect(sql).not.toMatch(/\bencode\s*\(\s*sha256\s*\(/);
  });

  it("does not add automatic intake, attachment, scheduler, or worker behavior", () => {
    expect(sql).not.toMatch(/create\s+trigger\s+[^;]+\s+on\s+public\.intake_/);
    expect(sql).not.toMatch(/\b(cron|scheduler|worker|attachment_upload|line_oa)\b/);
  });
});
