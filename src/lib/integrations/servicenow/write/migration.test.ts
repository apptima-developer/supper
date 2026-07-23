import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationName = "202607230001_servicenow_write_kernel.sql";
const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations", migrationName), "utf8").toLowerCase();

describe("ServiceNow write kernel migration", () => {
  it("creates the five bounded write-kernel tables and required indexes", () => {
    for (const table of [
      "servicenow_write_connections",
      "servicenow_write_mappings",
      "servicenow_write_commands",
      "servicenow_write_attempts",
      "servicenow_ticket_links",
    ]) expect(sql).toContain(`create table if not exists public.${table}`);
    for (const index of [
      "servicenow_write_commands_status_idx",
      "servicenow_write_commands_connection_idx",
      "servicenow_write_commands_type_idx",
      "servicenow_write_commands_created_at_idx",
      "servicenow_write_attempts_command_idx",
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
    ]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`revoke all privileges on table public.${table} from public, anon, authenticated`);
    }
    for (const rpc of [
      "support_create_servicenow_write_command",
      "support_begin_servicenow_write_attempt",
      "support_finish_servicenow_write_attempt",
    ]) {
      expect(sql).toContain(`revoke all privileges on function public.${rpc}(jsonb) from public`);
      expect(sql).toContain(`revoke execute on function public.${rpc}(jsonb) from anon, authenticated`);
      expect(sql).toContain(`grant execute on function public.${rpc}(jsonb) to service_role`);
    }
  });

  it("contains atomic idempotency, dry-run, retry, and attempt transitions", () => {
    expect(sql).toContain("servicenow_write_idempotency_conflict");
    expect(sql).toContain("on conflict (idempotency_key) do nothing");
    expect(sql).toContain("dry-runs never consume the bounded live attempt budget");
    expect(sql).toContain("retry_scheduled");
    expect(sql).toContain("for update");
    expect(sql).toContain("unique (command_id, attempt_number)");
  });

  it("records the forward-only migration and uses the portable intake hash helper", () => {
    expect(sql).toContain("values ('202607230001'");
    expect(sql).toContain("on conflict (version) do nothing");
    expect(sql).toContain("public.support_intake_sha256_hex");
    expect(sql).not.toMatch(/\bencode\s*\(\s*sha256\s*\(/);
  });
});
