import { createHash } from "node:crypto";

export function hashExternalIdentity(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function maskExternalIdentity(value: string) {
  const characters = Array.from(value);
  if (characters.length <= 4) return "••••";
  const start = characters.slice(0, Math.min(4, Math.ceil(characters.length / 3))).join("");
  const end = characters.slice(-Math.min(4, Math.floor(characters.length / 3))).join("");
  return `${start}••••••••${end}`;
}

export function maskedIdentityFromHash(hash: string) {
  return `id-${hash.slice(0, 4)}••••${hash.slice(-4)}`;
}
