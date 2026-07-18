import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { verifyMigrationEntries } from "./migration-verifier.mjs";

describe("migration verifier", () => {
  it("orders valid immutable migration names", () => {
    expect(verifyMigrationEntries([
      { name: "202607170002_second.sql", sql: "select 2;" },
      { name: "202607170001_first.sql", sql: "select 1;" },
    ])).toEqual(["202607170001_first.sql", "202607170002_second.sql"]);
  });

  it("rejects invalid, duplicate, and empty migrations", () => {
    expect(() => verifyMigrationEntries([{ name: "migration.sql", sql: "select 1;" }])).toThrow(/Invalid migration/);
    expect(() => verifyMigrationEntries([
      { name: "202607170001_first.sql", sql: "select 1;" },
      { name: "202607170001_second.sql", sql: "select 2;" },
    ])).toThrow(/Duplicate/);
    expect(() => verifyMigrationEntries([{ name: "202607170001_first.sql", sql: " " }])).toThrow(/empty/);
  });

  it("rejects SECURITY DEFINER application RPCs without an exact PUBLIC revoke", () => {
    const functionSql = `
      create or replace function public.application_rpc(p_key text)
      returns text language sql security definer as $$ select p_key $$;
    `;
    expect(() => verifyMigrationEntries([
      { name: "202607170001_first.sql", sql: functionSql },
    ])).toThrow(/explicit PUBLIC revoke/);
    expect(() => verifyMigrationEntries([
      { name: "202607170001_first.sql", sql: functionSql },
      { name: "202607170002_wrong.sql", sql: "revoke execute on function public.application_rpc(integer) from public;" },
    ])).toThrow(/public\.application_rpc\(text\)/);
  });

  it("accepts a later immutable migration that explicitly revokes PUBLIC execution", () => {
    expect(verifyMigrationEntries([
      {
        name: "202607170001_first.sql",
        sql: "create function public.application_rpc(p_key text) returns text language sql security definer as $$ select p_key $$;",
      },
      {
        name: "202607170002_correction.sql",
        sql: "revoke all privileges on function public.application_rpc(text) from public;",
      },
    ])).toEqual(["202607170001_first.sql", "202607170002_correction.sql"]);
  });

  it("locks the deployed rate-limit RPC to service_role without destructive SQL", async () => {
    const sql = (await readFile(path.join(
      process.cwd(),
      "supabase/migrations/202607170002_security_foundation_corrections.sql",
    ), "utf8")).toLowerCase().replace(/\s+/g, " ");
    const signature = "public.support_record_login_failure( text, timestamptz, integer, integer, integer )";
    expect(sql).toContain(`revoke all privileges on function ${signature} from public;`);
    expect(sql).toContain(`revoke execute on function ${signature} from anon, authenticated;`);
    expect(sql).toContain(`grant execute on function ${signature} to service_role;`);
    expect(sql).toContain(`alter function ${signature} set search_path = pg_catalog, public;`);
    expect(sql).not.toMatch(/\bdrop\s+(?:function|table)\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\s+public\.support_login_rate_limits\b/);
  });

  it("uses an unambiguous constraint target in the login rate-limit RPC hotfix", async () => {
    const sql = (await readFile(path.join(
      process.cwd(),
      "supabase/migrations/202607180001_fix_login_rate_limit_rpc_conflict.sql",
    ), "utf8")).toLowerCase().replace(/\s+/g, " ");
    expect(sql).toContain("on conflict on constraint support_login_rate_limits_pkey do update");
    expect(sql).not.toContain("on conflict (key_hash) do update");
    expect(sql).toContain("set search_path = pg_catalog, public");
    expect(sql).toContain("from public;");
    expect(sql).toContain("from anon, authenticated;");
    expect(sql).toContain("to service_role;");
    expect(sql).not.toMatch(/\bdrop\s+(?:function|table)\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\s+public\.support_login_rate_limits\b/);
  });

  it("sets column precedence for PL/pgSQL output-variable name collisions", async () => {
    const sql = (await readFile(path.join(
      process.cwd(),
      "supabase/migrations/202607180002_fix_login_rate_limit_rpc_variable_conflict.sql",
    ), "utf8")).toLowerCase().replace(/\s+/g, " ");
    expect(sql).toContain("#variable_conflict use_column");
    expect(sql).toContain("on conflict on constraint support_login_rate_limits_pkey do update");
    expect(sql).toContain("set search_path = pg_catalog, public");
    expect(sql).toContain("from public;");
    expect(sql).toContain("from anon, authenticated;");
    expect(sql).toContain("to service_role;");
    expect(sql).not.toMatch(/\bdrop\s+(?:function|table)\b/);
    expect(sql).not.toMatch(/\bdelete\s+from\s+public\.support_login_rate_limits\b/);
  });
});
