import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSafeTemporaryTestPath,
  removeTemporaryTestDirectory,
} from "./test-path-safety.mjs";

const prefix = "supper-path-safety-";
const temporaryDirectories = new Set();

function temporaryDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.add(directory);
  return directory;
}

afterEach(async () => {
  for (const directory of temporaryDirectories) {
    if (fs.existsSync(directory)) await removeTemporaryTestDirectory(directory, prefix);
  }
  temporaryDirectories.clear();
});

describe("temporary test path safety", () => {
  it("allows only a generated directory with the required prefix below OS temp", () => {
    const directory = temporaryDirectory();
    expect(assertSafeTemporaryTestPath(directory, prefix)).toBe(fs.realpathSync(directory));
  });

  it("rejects the temp root, paths outside temp, and a mismatched prefix", () => {
    const directory = temporaryDirectory();
    expect(() => assertSafeTemporaryTestPath(os.tmpdir(), prefix)).toThrow(/outside/);
    expect(() => assertSafeTemporaryTestPath("/tmp", prefix)).toThrow(/outside/);
    expect(() => assertSafeTemporaryTestPath(process.cwd(), prefix)).toThrow(/outside/);
    expect(() => assertSafeTemporaryTestPath(directory, "different-safe-prefix-")).toThrow(/prefix/);
  });

  it("removes an approved temporary test directory", async () => {
    const directory = temporaryDirectory();
    fs.writeFileSync(path.join(directory, "fixture.json"), "{}\n");
    await removeTemporaryTestDirectory(directory, prefix);
    temporaryDirectories.delete(directory);
    expect(fs.existsSync(directory)).toBe(false);
  });
});
