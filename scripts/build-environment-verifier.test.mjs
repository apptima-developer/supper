import { describe, expect, it } from "vitest";
import { collectBuildEnvironmentChecks, validateBuildEnvironment } from "./build-environment-verifier.mjs";

const strongSecret = "0123456789abcdef0123456789abcdef";
const migrationEntries = [{ name: "202607180001_valid.sql", sql: "select 1;" }];
const allFilesExist = () => true;

describe("build environment verification", () => {
  it("accepts local-json development configuration with optional metadata absent", async () => {
    const checks = await collectBuildEnvironmentChecks({
      env: { NODE_ENV: "development", DATA_BACKEND: "local-json" },
      root: "/workspace",
      exists: allFilesExist,
      migrationEntries,
    });
    expect(checks.some((item) => item.status === "FAIL")).toBe(false);
    expect(checks.filter((item) => item.name.includes("metadata")).every((item) => item.status === "OPTIONAL")).toBe(true);
  });

  it("accepts a production Supabase configuration", () => {
    const checks = validateBuildEnvironment({
      NODE_ENV: "production",
      DATA_BACKEND: "supabase-relational",
      SESSION_SECRET: strongSecret,
      RATE_LIMIT_PEPPER: strongSecret,
      APP_ORIGIN: "https://app.example.test",
      NEXT_PUBLIC_SUPABASE_URL: "https://project.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "configured-server-value",
    });
    expect(checks.some((item) => item.status === "FAIL")).toBe(false);
  });

  it("rejects missing required secrets and malformed production origins", () => {
    const checks = validateBuildEnvironment({
      NODE_ENV: "production",
      DATA_BACKEND: "local-json",
      RATE_LIMIT_PEPPER: strongSecret,
      APP_ORIGIN: "http://app.example.test/private",
    });
    expect(checks).toContainEqual(expect.objectContaining({ name: "SESSION_SECRET", status: "FAIL" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "APP_ORIGIN", status: "FAIL" }));
  });

  it("detects missing runtime assets and invalid migration names", async () => {
    const checks = await collectBuildEnvironmentChecks({
      env: { NODE_ENV: "development", DATA_BACKEND: "local-json" },
      root: "/workspace",
      exists: (file) => !file.endsWith("manday-summary-template.xlsx"),
      migrationEntries: [{ name: "invalid.sql", sql: "select 1;" }],
    });
    expect(checks).toContainEqual(expect.objectContaining({ name: "Manday summary Excel template", status: "FAIL" }));
    expect(checks).toContainEqual(expect.objectContaining({ name: "Migration inventory", status: "FAIL" }));
  });
});
