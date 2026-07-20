import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.join(process.cwd(), "supabase/migrations/202607200002_servicenow_sync_reliability_corrections.sql");
const rawSql = readFileSync(migrationPath, "utf8");
const sql = rawSql.toLowerCase().replace(/\s+/g, " ");

describe("ServiceNow reliability correction migration", () => {
  it("adds a schema-backed composite watermark and fixed run window", () => {
    expect(sql).toContain("add column if not exists watermark_sys_id text");
    expect(sql).toContain("add column if not exists watermark_from_sys_id text");
    expect(sql).toContain("add column if not exists watermark_to_sys_id text");
    expect(sql).toContain("add column if not exists window_start_at timestamptz");
    expect(sql).toContain("add column if not exists window_end_at timestamptz");
    expect(sql).toContain("watermark_sys_id = case when p_watermark is null then watermark_sys_id else lower(v_watermark_sys_id) end");
  });

  it("uses one atomic RPC for dry-run and committed reconciliation", () => {
    expect(sql).toContain("create or replace function public.support_upsert_servicenow_incident(p_payload jsonb)");
    expect(sql).toContain("v_dry_run := coalesce((p_payload->>'dryrun')::boolean, false)");
    expect(sql).toContain("if v_dry_run then");
    expect(sql).toContain("if not v_dry_run then");
  });

  it("adopts an existing issue ID while preserving its ID and JSON properties", () => {
    expect(sql).toContain("where issue_id = p_payload->>'externalnumber'");
    expect(sql).toContain("'adopted_existing_ticket'");
    expect(sql).toContain("v_ticket.data || jsonb_build_object");
    expect(sql).toContain("p_payload->>'externalnumber', v_ticket.id");
    expect(sql).not.toContain("delete from public.support_tickets");
    expect(sql).not.toContain("truncate table public.support_tickets");
  });

  it("returns bounded number, sys_id, linked-ticket, and provider conflicts", () => {
    expect(sql).toContain("servicenow_external_number_conflict");
    expect(sql).toContain("servicenow_sys_id_number_conflict");
    expect(sql).toContain("servicenow_ticket_link_conflict");
    expect(sql).toContain("servicenow_linked_ticket_missing");
  });

  it("serializes committed concurrent adoption and keeps dry-run non-mutating", () => {
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("servicenow:incident:number:");
    expect(sql).toContain("servicenow:incident:sysid:");
    expect(sql).toMatch(/if v_dry_run then return query select 'updated'::text, v_ticket\.id, 'adopted_existing_ticket'::text;/);
  });

  it("advances link observation timestamps without rewriting an unchanged ticket", () => {
    const unchangedStart = sql.indexOf("if p_payload->>'sourcehash' = v_link.source_hash then");
    const unchangedEnd = sql.indexOf("if (p_payload->>'externalupdatedat')::timestamptz = v_link.external_updated_at", unchangedStart);
    const unchanged = sql.slice(unchangedStart, unchangedEnd);
    expect(unchanged).toContain("external_updated_at = greatest");
    expect(unchanged).toContain("last_seen_at = v_now");
    expect(unchanged).not.toContain("update public.support_tickets");
  });

  it.each([
    "support_complete_integration_sync_run(text, text, timestamptz, timestamptz, jsonb)",
    "support_upsert_servicenow_incident(jsonb)",
  ])("keeps SECURITY DEFINER execution service-role-only for %s", (signature) => {
    expect(sql).toContain(`revoke all privileges on function public.${signature} from public`);
    expect(sql).toContain(`revoke execute on function public.${signature} from anon, authenticated`);
    expect(sql).toContain(`grant execute on function public.${signature} to service_role`);
  });

  it("records its forward-only migration version", () => {
    expect(sql).toContain("values ('202607200002', 'servicenow reliable cursor and existing-ticket reconciliation'");
  });
});
