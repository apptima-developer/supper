import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sql = fs.readFileSync(path.join(process.cwd(), "supabase/migrations/202607210001_servicenow_customer_mapping_operations.sql"), "utf8").toLowerCase();

describe("ServiceNow customer mapping migration", () => {
  it("creates provider-neutral mapping and event tables with integrity controls", () => {
    expect(sql).toContain("create table if not exists public.integration_customer_mappings");
    expect(sql).toContain("create table if not exists public.integration_customer_mapping_events");
    expect(sql).toContain("unique (provider, external_customer_key)");
    expect(sql).toContain("references public.support_customers(customer_key)");
    expect(sql).toContain("on delete restrict");
    expect(sql).toContain("action in ('created', 'changed', 'reactivated', 'deactivated')");
    for (const index of ["integration_customer_mappings_provider_active_idx", "integration_customer_mappings_customer_key_idx", "integration_customer_mappings_updated_at_idx", "integration_customer_mappings_external_id_idx", "support_tickets_servicenow_external_customer_idx", "support_tickets_servicenow_customer_identity_idx"]) expect(sql).toContain(index);
  });

  it("enables RLS and reserves table and SECURITY DEFINER RPC access for service_role", () => {
    for (const table of ["integration_customer_mappings", "integration_customer_mapping_events"]) {
      expect(sql).toContain(`alter table public.${table} enable row level security`);
      expect(sql).toContain(`revoke all privileges on table public.${table} from public, anon, authenticated`);
    }
    for (const [rpc, signature] of [["support_get_servicenow_customer_source", "text"], ["support_apply_integration_customer_mapping", "jsonb"], ["support_deactivate_integration_customer_mapping", "jsonb"], ["support_upsert_servicenow_incident_with_mapping", "jsonb"]]) {
      expect(sql).toContain(`create or replace function public.${rpc}`);
      expect(sql).toContain("security definer");
      expect(sql).toContain("set search_path = public, pg_temp");
      expect(sql).toContain(`revoke all privileges on function public.${rpc}(${signature}) from public`);
      expect(sql).toContain(`revoke execute on function public.${rpc}(${signature}) from anon, authenticated`);
      expect(sql).toContain(`grant execute on function public.${rpc}(${signature}) to service_role`);
    }
  });

  it("rejects the unknown source, preserves tickets during deactivation, and records the version", () => {
    expect(sql).toContain("servicenow_unknown_customer_not_mappable");
    expect(sql).not.toMatch(/delete\s+from\s+public\.(support_tickets|integration_customer_mappings)/);
    expect(sql).not.toMatch(/truncate\s+/);
    expect(sql).toContain("values ('202607210001'");
    expect(sql).toContain("on conflict (version) do nothing");
  });

  it("uses canonical UTC text, shared identity matching, and no-write mapping guards", () => {
    expect(sql).toContain("support_canonical_utc_iso");
    expect(sql).toContain("yyyy-mm-dd\"t\"hh24:mi:ss.ms\"z\"");
    expect(sql).toContain("support_servicenow_ticket_customer_key");
    expect(sql).toContain("{servicenow,externalcustomerid}");
    expect(sql).toContain("{servicenow,companyexternalid}");
    expect(sql).toContain("v_requires_mapping_update");
    expect(sql).toContain("v_mapping_applied_iso := public.support_canonical_utc_iso");
    expect(sql).toContain("v_action := 'unchanged'");
  });
});
