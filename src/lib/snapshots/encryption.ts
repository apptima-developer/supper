import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const headerSchema = z.object({ version: z.literal(1), keyId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), nonce: z.string().regex(/^[A-Za-z0-9+/]{16}$/) }).strict();
export type SnapshotKeyring = { activeKeyId: string; keys: Readonly<Record<string, Buffer>> };
export function validateKeyring(keyring: SnapshotKeyring) {
  if (!Object.prototype.hasOwnProperty.call(keyring.keys, keyring.activeKeyId) || !/^[A-Za-z0-9_-]{1,64}$/.test(keyring.activeKeyId)) throw new Error("Invalid snapshot encryption keyring");
  for (const [id, key] of Object.entries(keyring.keys)) if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || key.length !== 32) throw new Error("Snapshot encryption requires 256-bit keys");
}
// Authenticated context binds ciphertext to its bucket and exact object key; copies must be re-encrypted.
export function sealSnapshotBytes(plaintext: Buffer, context: string, keyring: SnapshotKeyring) {
  validateKeyring(keyring);
  const nonce = randomBytes(12);
  const header = Buffer.from(JSON.stringify({ version: 1, keyId: keyring.activeKeyId, nonce: nonce.toString("base64") }));
  const length = Buffer.alloc(4); length.writeUInt32BE(header.length);
  const cipher = createCipheriv("aes-256-gcm", keyring.keys[keyring.activeKeyId], nonce);
  cipher.setAAD(Buffer.concat([Buffer.from(`SUPPER-SNAPSHOT-V1\0${context}\0`), length, header]));
  return Buffer.concat([length, header, cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
}
export function openSnapshotBytes(bytes: Buffer, context: string, keyring: SnapshotKeyring) {
  validateKeyring(keyring);
  if (bytes.length < 24) throw new Error("Invalid encrypted snapshot envelope");
  const size = bytes.readUInt32BE(0);
  if (size > 1024 || size < 1 || bytes.length < size + 20) throw new Error("Invalid encrypted snapshot envelope");
  const header = headerSchema.parse(JSON.parse(bytes.subarray(4, size + 4).toString("utf8")));
  const key = Object.prototype.hasOwnProperty.call(keyring.keys, header.keyId) ? keyring.keys[header.keyId] : undefined;
  if (!key) throw new Error("Snapshot decryption key unavailable; recover the retained key version");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(header.nonce, "base64"));
    decipher.setAAD(Buffer.concat([Buffer.from(`SUPPER-SNAPSHOT-V1\0${context}\0`), bytes.subarray(0, size + 4)]));
    decipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([decipher.update(bytes.subarray(size + 4, -16)), decipher.final()]);
  } catch { throw new Error("Snapshot authenticated decryption failed"); }
}
