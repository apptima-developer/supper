import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const activeJsonDirectories = Object.freeze([
  "data/audit",
  "data/auth",
  "data/core",
  "data/imports",
  "data/integrations",
  "data/master",
  "data/notifications",
]);
const activeJsonFiles = Object.freeze(["data/reports/report-jobs.json"]);

function walkJsonFiles(root, relativeDirectory) {
  const absoluteDirectory = path.join(root, relativeDirectory);
  if (!fs.existsSync(absoluteDirectory)) return [];
  return fs.readdirSync(absoluteDirectory, { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic links are not allowed in production data paths: ${relative}`);
    if (entry.isDirectory()) return walkJsonFiles(root, relative);
    return entry.isFile() && entry.name.endsWith(".json") ? [relative] : [];
  });
}

export function activeProductionDataFiles(root) {
  const discovered = activeJsonDirectories.flatMap((directory) => walkJsonFiles(root, directory));
  for (const relative of activeJsonFiles) {
    const absolute = path.join(root, relative);
    if (fs.existsSync(absolute)) discovered.push(relative);
  }
  return Object.freeze([...new Set(discovered)].sort());
}

export function snapshotProductionData(root) {
  const files = {};
  for (const relative of activeProductionDataFiles(root)) {
    const absolute = path.join(root, relative);
    const before = fs.statSync(absolute);
    if (!before.isFile()) throw new Error(`Production data target is not a regular file: ${relative}`);
    const body = fs.readFileSync(absolute);
    const after = fs.statSync(absolute);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new Error(`Production data changed while it was being verified: ${relative}`);
    }
    files[relative] = Object.freeze({
      size: after.size,
      mtimeMs: after.mtimeMs,
      sha256: crypto.createHash("sha256").update(body).digest("hex"),
    });
  }
  return Object.freeze({ version: 1, files: Object.freeze(files) });
}

export function compareProductionDataSnapshots(expected, actual, options = {}) {
  const compareMtime = options.compareMtime !== false;
  const failures = [];
  if (expected?.version !== 1 || !expected.files || typeof expected.files !== "object") {
    return Object.freeze(["Integrity manifest format is invalid"]);
  }
  const expectedNames = Object.keys(expected.files).sort();
  const actualNames = Object.keys(actual.files).sort();
  for (const name of expectedNames) {
    const expectedFile = expected.files[name];
    const actualFile = actual.files[name];
    if (!actualFile) {
      failures.push(`missing: ${name}`);
      continue;
    }
    if (actualFile.size !== expectedFile.size) failures.push(`size changed: ${name}`);
    if (actualFile.sha256 !== expectedFile.sha256) failures.push(`content changed: ${name}`);
    if (compareMtime && expectedFile.mtimeMs !== undefined && actualFile.mtimeMs !== expectedFile.mtimeMs) {
      failures.push(`mtime changed: ${name}`);
    }
  }
  for (const name of actualNames) {
    if (!Object.hasOwn(expected.files, name)) failures.push(`unexpected: ${name}`);
  }
  return Object.freeze(failures);
}

export function readIntegrityManifest(manifestPath) {
  return JSON.parse(fs.readFileSync(path.resolve(manifestPath), "utf8"));
}
