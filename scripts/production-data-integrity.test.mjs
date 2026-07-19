import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activeProductionDataFiles,
  compareProductionDataSnapshots,
  readIntegrityManifest,
  snapshotProductionData,
} from "./production-data-integrity.mjs";
import { removeTemporaryTestDirectory } from "./test-path-safety.mjs";

const prefix = "supper-data-integrity-test-";
const temporaryDirectories = new Set();

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(root);
  fs.mkdirSync(path.join(root, "data/core"), { recursive: true });
  fs.mkdirSync(path.join(root, "data/backups"), { recursive: true });
  fs.mkdirSync(path.join(root, "data/generated"), { recursive: true });
  fs.writeFileSync(path.join(root, "data/core/tickets.json"), "[]\n");
  fs.writeFileSync(path.join(root, "data/backups/tickets.json"), '[{"ignored":true}]\n');
  fs.writeFileSync(path.join(root, "data/generated/report.json"), '{"ignored":true}\n');
  return root;
}

afterEach(async () => {
  for (const directory of temporaryDirectories) await removeTemporaryTestDirectory(directory, prefix);
  temporaryDirectories.clear();
});

describe("production data integrity verifier", () => {
  it("hashes active JSON and excludes backup and generated output", () => {
    const root = fixture();
    expect(activeProductionDataFiles(root)).toEqual(["data/core/tickets.json"]);
    expect(Object.keys(snapshotProductionData(root).files)).toEqual(["data/core/tickets.json"]);
  });

  it("detects content, size, mtime, missing, and unexpected file changes", () => {
    const root = fixture();
    const before = snapshotProductionData(root);
    fs.writeFileSync(path.join(root, "data/core/tickets.json"), "[1]\n");
    fs.writeFileSync(path.join(root, "data/core/customers.json"), "[]\n");
    const failures = compareProductionDataSnapshots(before, snapshotProductionData(root));
    expect(failures).toContain("size changed: data/core/tickets.json");
    expect(failures).toContain("content changed: data/core/tickets.json");
    expect(failures).toContain("unexpected: data/core/customers.json");
    fs.rmSync(path.join(root, "data/core/tickets.json"));
    expect(compareProductionDataSnapshots(before, snapshotProductionData(root))).toContain("missing: data/core/tickets.json");
  });

  it("reads an externally supplied manifest without writing to it", () => {
    const root = fixture();
    const manifestPath = path.join(root, "manifest.json");
    fs.writeFileSync(manifestPath, JSON.stringify(snapshotProductionData(root)));
    const before = fs.readFileSync(manifestPath);
    expect(readIntegrityManifest(manifestPath).version).toBe(1);
    expect(fs.readFileSync(manifestPath).equals(before)).toBe(true);
  });
});
