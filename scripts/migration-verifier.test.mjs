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
});
