import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(process.cwd(), "supabase/migrations/202607200001_servicenow_incremental_sync.sql");
const sql = readFileSync(migrationPath, "utf8").toLowerCase().replace(/\s+/g, " ");

describe("ServiceNow synchronization migration", () => {
  it.each(["external_ticket_links", "integration_sync_state", "integration_sync_runs", "integration_sync_run_items"])("creates %s", (table) => {
    expect(sql).toContain(`create table if not exists public.${table}`);
    expect(sql).toContain(`alter table public.${table} enable row level security`);
    expect(sql).toContain(`revoke all on table public.${table} from public, anon, authenticated`);
  });

  it("enforces unique provider/sys_id and provider/number links", () => {
    expect(sql).toContain("unique (provider, external_sys_id)");
    expect(sql).toContain("unique (provider, external_number)");
  });

  it("contains atomic lock acquisition, same-token refresh, expiry takeover, and token-matched release", () => {
    expect(sql).toContain("support_acquire_integration_sync_lock");
    expect(sql).toContain("current_state.locked_until <= p_now");
    expect(sql).toContain("current_state.lock_token = p_lock_token");
    expect(sql).toContain("support_release_integration_sync_lock");
    expect(sql).toContain("and lock_token = trim(p_lock_token)");
    expect(sql).toContain("and locked_until > now()");
  });

  it("atomically creates or updates the ticket and durable external link", () => {
    expect(sql).toContain("support_upsert_servicenow_incident(p_payload jsonb)");
    expect(sql).toContain("insert into public.support_tickets");
    expect(sql).toContain("insert into public.external_ticket_links");
    expect(sql).toContain("update public.support_tickets");
    expect(sql).toContain("update public.external_ticket_links");
  });

  it("atomically completes a successful run and advances its owned watermark", () => {
    expect(sql).toContain("support_complete_integration_sync_run");
    expect(sql).toContain("and lock_token = trim(p_lock_token)");
    expect(sql).toContain("last_successful_sync_at = p_completed_at");
    expect(sql).toContain("status = 'succeeded'");
  });

  it("protects duplicate sys_id and number while preserving SUPPER JSON fields", () => {
    expect(sql).toContain("for update");
    expect(sql).toContain("servicenow_external_number_conflict");
    expect(sql).toContain("v_ticket.data || jsonb_build_object");
    expect(sql).not.toContain("delete from public.support_tickets");
  });

  it("implements stale, unchanged, and equal-timestamp changed behavior", () => {
    expect(sql).toContain("return query select 'stale'");
    expect(sql).toContain("return query select 'unchanged'");
    expect(sql).toContain("same_timestamp_changed");
  });

  it.each([
    "support_acquire_integration_sync_lock(text, text, text, integer, timestamptz)",
    "support_release_integration_sync_lock(text, text, text)",
    "support_complete_integration_sync_run(text, text, timestamptz, timestamptz, jsonb)",
    "support_upsert_servicenow_incident(jsonb)",
  ])("revokes PUBLIC, anon, and authenticated execution from %s", (signature) => {
    expect(sql).toContain(`revoke all privileges on function public.${signature} from public`);
    expect(sql).toContain(`revoke execute on function public.${signature} from anon, authenticated`);
    expect(sql).toContain(`grant execute on function public.${signature} to service_role`);
  });

  it("records the immutable migration version", () => {
    expect(sql).toContain("values ('202607200001', 'servicenow incremental synchronization engine'");
  });
});
