import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function assertSafeTemporaryTestPath(candidate, requiredPrefix) {
  if (typeof candidate !== "string" || !candidate.trim()) {
    throw new TypeError("Temporary test path is required");
  }
  if (!/^[a-z0-9][a-z0-9-]{5,}$/i.test(requiredPrefix)) {
    throw new TypeError("Temporary test prefix is invalid");
  }

  const resolved = fs.realpathSync(path.resolve(candidate));
  const temporaryRoots = [...new Set([os.tmpdir(), "/tmp"]
    .filter((root) => fs.existsSync(root))
    .map((root) => fs.realpathSync(root)))];
  const relative = temporaryRoots
    .map((temporaryRoot) => path.relative(temporaryRoot, resolved))
    .find((value) => value && value !== ".." && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
  if (!relative) {
    throw new Error("Refusing to remove a path outside the operating-system temporary directory");
  }

  const [topLevelDirectory] = relative.split(path.sep);
  if (!topLevelDirectory.startsWith(requiredPrefix)) {
    throw new Error("Refusing to remove a temporary directory without the expected generated prefix");
  }
  return resolved;
}

export async function removeTemporaryTestDirectory(candidate, requiredPrefix) {
  const safePath = assertSafeTemporaryTestPath(candidate, requiredPrefix);
  await fs.promises.rm(safePath, { recursive: true, force: true });
}
