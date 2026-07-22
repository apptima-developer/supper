import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyArchitecture } from "./architecture-verifier.mjs";
import { removeTemporaryTestDirectory } from "./test-path-safety.mjs";

const prefix = "supper-architecture-test-";
const temporaryDirectories = new Set();
const migrations = [
  "202607170001_security_foundation.sql",
  "202607170002_security_foundation_corrections.sql",
  "202607180001_fix_login_rate_limit_rpc_conflict.sql",
  "202607180002_fix_login_rate_limit_rpc_variable_conflict.sql",
  "202607200001_servicenow_incremental_sync.sql",
  "202607200002_servicenow_sync_reliability_corrections.sql",
  "202607210001_servicenow_customer_mapping_operations.sql",
  "202607220001_unified_intake_core.sql",
  "202607220002_unified_intake_core_corrections.sql",
];

function write(root, relative, source = "export {};\n") {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, source);
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(root);
  write(root, "package.json", '{"dependencies":{},"devDependencies":{}}\n');
  for (const migration of migrations) write(root, `supabase/migrations/${migration}`, "-- immutable fixture\n");
  for (const relative of [
    "src/lib/integrations/contracts.ts",
    "src/lib/integrations/errors.ts",
    "src/lib/integrations/idempotency.ts",
    "src/lib/integrations/normalization.ts",
    "src/lib/integrations/schemas.ts",
    "src/lib/integrations/validation.ts",
    "src/lib/integrations/sync/contracts.ts",
    "src/lib/integrations/sync/lock-policy.ts",
    "src/lib/email-intake/aggregate.ts",
    "src/lib/email-intake/errors.ts",
    "src/lib/email-intake/events.ts",
    "src/lib/email-intake/repository.ts",
    "src/lib/email-intake/schemas.ts",
    "src/lib/intake-core/contracts.ts",
    "src/lib/intake-core/canonical-material.ts",
    "src/lib/intake-core/conversation.ts",
    "src/lib/intake-core/email-compatibility.ts",
    "src/lib/intake-core/errors.ts",
    "src/lib/intake-core/identity.ts",
    "src/lib/intake-core/presentation.ts",
    "src/lib/intake-core/schemas.ts",
    "src/lib/intake-core/sensitive-data.ts",
    "src/lib/intake-core/session.ts",
    "src/lib/integrations/index.ts",
    "src/lib/email-intake/index.ts",
    "src/lib/repositories.ts",
  ]) write(root, relative);
  return root;
}

afterEach(async () => {
  for (const directory of temporaryDirectories) await removeTemporaryTestDirectory(directory, prefix);
  temporaryDirectories.clear();
});

describe("architecture verifier", () => {
  it("accepts an isolated provider-neutral architecture", () => {
    expect(verifyArchitecture(fixture()).failures).toEqual([]);
  });

  it("detects domain-to-infrastructure imports and cycles", () => {
    const root = fixture();
    write(root, "src/lib/integrations/contracts.ts", 'import "node:fs";\nimport "./errors";\n');
    write(root, "src/lib/integrations/errors.ts", 'import "./contracts";\n');
    const result = verifyArchitecture(root);
    expect(result.failures.some((failure) => failure.startsWith("domain dependency direction"))).toBe(true);
    expect(result.failures.some((failure) => failure.startsWith("circular dependencies"))).toBe(true);
  });

  it("detects provider SDKs and public test-helper leakage", () => {
    const root = fixture();
    write(root, "package.json", '{"dependencies":{"imapflow":"1.0.0"}}\n');
    write(root, "src/lib/integrations/index.ts", "export { InMemoryIntegrationConnector } from './in-memory-adapter';\n");
    const result = verifyArchitecture(root);
    expect(result.failures.some((failure) => failure.startsWith("provider SDK boundary"))).toBe(true);
    expect(result.failures.some((failure) => failure.startsWith("integration public surface"))).toBe(true);
  });
});
