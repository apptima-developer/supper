import { expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { openSnapshotBytes, sealSnapshotBytes } from "./encryption";

it("authenticates ciphertext, header and bucket/key identity with recoverable key versions", () => {
  const old = randomBytes(32), next = randomBytes(32), plaintext = Buffer.from("synthetic sensitive ไทย");
  const bytes = sealSnapshotBytes(plaintext, "bucket\0key", { activeKeyId: "old", keys: { old } });
  expect(bytes.includes(plaintext)).toBe(false);
  expect(openSnapshotBytes(bytes, "bucket\0key", { activeKeyId: "next", keys: { old, next } })).toEqual(plaintext);
  expect(() => openSnapshotBytes(bytes, "other-bucket\0key", { activeKeyId: "old", keys: { old } })).toThrow("authenticated");
  expect(() => openSnapshotBytes(bytes, "bucket\0key", { activeKeyId: "next", keys: { next } })).toThrow("key unavailable");
  const corrupt = Buffer.from(bytes); corrupt[corrupt.length - 1] ^= 1;
  expect(() => openSnapshotBytes(corrupt, "bucket\0key", { activeKeyId: "old", keys: { old } })).toThrow("authenticated");
  expect(() => sealSnapshotBytes(plaintext, "key", { activeKeyId: "weak", keys: { weak: Buffer.alloc(16) } })).toThrow("256-bit");
});
