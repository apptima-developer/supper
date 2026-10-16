import "server-only";
import { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command } from "@aws-sdk/client-s3";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { z } from "zod";
import { backupTarget } from "../backup-restore-policy";
import { metadataSchema, snapshotId, sha256, SnapshotNotFoundError, type SnapshotInput, type SnapshotMetadata, type S3CompatibleSnapshotStore } from "./store";
import { openSnapshotBytes, sealSnapshotBytes, validateKeyring, type SnapshotKeyring } from "./encryption";

const compress = promisify(gzip), decompress = promisify(gunzip);
const status = (error: unknown) => (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
export type RemoteSnapshotOptions = { client: S3Client; bucket: string; prefix: string; keyring: SnapshotKeyring; maxBytes?: number; pageSize?: number; attempts?: number; retryBaseMs?: number };

export class S3SnapshotStore implements S3CompatibleSnapshotStore {
  readonly provider = "s3-compatible" as const;
  readonly maxBytes: number;
  constructor(readonly options: RemoteSnapshotOptions) {
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(options.bucket) || !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*$/.test(options.prefix)) throw new Error("Invalid private snapshot bucket/prefix");
    validateKeyring(options.keyring);
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1 || this.maxBytes > 64 * 1024 * 1024) throw new Error("Invalid snapshot size limit");
    if (!Number.isInteger(options.pageSize ?? 100) || (options.pageSize ?? 100) < 1 || (options.pageSize ?? 100) > 1000 || !Number.isInteger(options.attempts ?? 4) || (options.attempts ?? 4) < 1 || (options.attempts ?? 4) > 5 || !Number.isInteger(options.retryBaseMs ?? 100) || (options.retryBaseMs ?? 100) < 0 || (options.retryBaseMs ?? 100) > 1000) throw new Error("Invalid remote retry/pagination limits");
  }
  private key(kind: "objects" | "index", backup: string) { return `${this.options.prefix}/${kind}/${snapshotId(backup)}.${kind === "objects" ? "snapshot" : "manifest"}`; }
  private context(key: string) { return `${this.options.bucket}\0${key}`; }
  private async retry<T>(action: () => Promise<T>) {
    for (let attempt = 0; ; attempt++) {
      try { return await action(); }
      catch (error) {
        const code = status(error), name = (error as Error).name;
        const retryable = code === 409 || code === 408 || code === 429 || (code !== undefined && code >= 500) || ["TimeoutError", "AbortError", "RequestTimeout", "NetworkingError"].includes(name) || ["ECONNRESET", "ECONNREFUSED", "ETIMEDOUT", "EPIPE", "ENOTFOUND", "EAI_AGAIN", "ERR_STREAM_PREMATURE_CLOSE"].includes((error as NodeJS.ErrnoException).code || "");
        if (!retryable || attempt + 1 >= (this.options.attempts ?? 4)) throw error;
        await new Promise(resolve => setTimeout(resolve, Math.min(1000, (this.options.retryBaseMs ?? 100) * 2 ** attempt) * (0.5 + Math.random() / 2)));
      }
    }
  }
  private async download(key: string, limit: number) {
    try {
      return await this.retry(async () => {
        const deadline = AbortSignal.timeout(10000);
        const response = await this.options.client.send(new GetObjectCommand({ Bucket: this.options.bucket, Key: key }), { abortSignal: deadline });
        const body = response.Body as (AsyncIterable<Uint8Array> & { destroy?: (error?: Error) => void }) | undefined;
        if (!body || (response.ContentLength ?? 0) > limit) { body?.destroy?.(); throw new Error("Remote snapshot size limit exceeded"); }
        if (typeof body.destroy !== "function") throw new Error("Remote snapshots require a Node readable response");
        const timeout = () => Object.assign(new Error("Remote snapshot stream timed out"), { name: "TimeoutError" });
        if (deadline.aborted) { body.destroy(); throw timeout(); }
        const abortRead = () => body.destroy?.(timeout());
        deadline.addEventListener("abort", abortRead, { once: true });
        try {
          const chunks: Buffer[] = []; let size = 0;
          for await (const chunk of body) {
            size += chunk.length;
            if (size > limit) { body.destroy(); throw new Error("Remote snapshot size limit exceeded"); }
            chunks.push(Buffer.from(chunk));
          }
          const bytes = Buffer.concat(chunks);
          if (response.ContentLength !== undefined && bytes.length !== response.ContentLength) throw Object.assign(new Error("Incomplete remote snapshot response"), { code: "ECONNRESET" });
          return bytes;
        } finally { deadline.removeEventListener("abort", abortRead); }
      });
    } catch (error) {
      if ((error as Error).name === "NoSuchKey") throw new SnapshotNotFoundError();
      throw new Error("Remote snapshot read failed; restore stopped");
    }
  }
  private async publish(key: string, bytes: Buffer) {
    try {
      await this.retry(() => this.options.client.send(new PutObjectCommand({ Bucket: this.options.bucket, Key: key, Body: bytes, ContentLength: bytes.length, ContentType: "application/octet-stream", IfNoneMatch: "*" }), { abortSignal: AbortSignal.timeout(10000) }));
      return true;
    } catch (error) {
      if (status(error) === 412 || (error as Error).name === "PreconditionFailed") return false;
      throw new Error("Remote snapshot publication failed; database write stopped");
    }
  }
  private identity(metadata: SnapshotMetadata, key: string) {
    if (metadata.snapshotId !== snapshotId(metadata.backupPath) || metadata.originalKey !== backupTarget(metadata.backupPath).target || metadata.storageLocation !== this.key("objects", metadata.backupPath) || key !== metadata.storageLocation) throw new Error("Remote snapshot identity mismatch");
  }
  private equivalent(a: SnapshotMetadata, b: SnapshotMetadata) {
    return JSON.stringify({ ...a, storedBytes: undefined }) === JSON.stringify({ ...b, storedBytes: undefined });
  }
  private async readObject(key: string) {
    const bytes = await this.download(key, this.maxBytes + 2 * 1024 * 1024);
    const plaintext = openSnapshotBytes(bytes, this.context(key), this.options.keyring);
    if (plaintext.length < 4) throw new Error("Incomplete remote snapshot");
    const size = plaintext.readUInt32BE(0);
    if (size < 1 || size > 1024 * 1024 - 1024 || size + 4 >= plaintext.length) throw new Error("Invalid remote snapshot manifest");
    const metadata = metadataSchema.parse(JSON.parse(plaintext.subarray(4, size + 4).toString("utf8")));
    this.identity(metadata, key);
    if (metadata.storedBytes !== bytes.length || metadata.uncompressedBytes > this.maxBytes || metadata.compressedBytes > this.maxBytes) throw new Error("Remote snapshot size mismatch");
    const compressed = plaintext.subarray(size + 4);
    if (compressed.length !== metadata.compressedBytes || sha256(compressed) !== metadata.compressedChecksum) throw new Error("Remote snapshot compressed checksum mismatch");
    const raw = await decompress(compressed, { maxOutputLength: this.maxBytes });
    if (raw.length !== metadata.uncompressedBytes || sha256(raw) !== metadata.checksum) throw new Error("Remote snapshot content checksum mismatch");
    const json = raw.toString("utf8"); JSON.parse(json);
    return { metadata, json };
  }
  private async publishIndex(metadata: SnapshotMetadata) {
    const key = this.key("index", metadata.backupPath);
    const bytes = sealSnapshotBytes(Buffer.from(JSON.stringify(metadata)), this.context(key), this.options.keyring);
    await this.publish(key, bytes);
    const actual = await this.readIndex(key);
    if (!this.equivalent(actual, metadata)) throw new Error("Immutable snapshot index conflict");
  }
  private async readIndex(key: string) {
    const bytes = await this.download(key, 1024 * 1024);
    const metadata = metadataSchema.parse(JSON.parse(openSnapshotBytes(bytes, this.context(key), this.options.keyring).toString("utf8")));
    this.identity(metadata, this.key("objects", metadata.backupPath));
    if (key !== this.key("index", metadata.backupPath)) throw new Error("Remote index identity mismatch");
    return metadata;
  }
  async saveSnapshot(input: SnapshotInput) {
    const raw = Buffer.from(input.json); if (raw.length > this.maxBytes) throw new Error("Snapshot size limit exceeded"); JSON.parse(input.json);
    const compressed = await compress(raw, { level: 9 });
    const key = this.key("objects", input.backupPath);
    let metadata = metadataSchema.parse({ metadataVersion: 1, schemaVersion: 1, snapshotId: snapshotId(input.backupPath), originalKey: backupTarget(input.backupPath).target, backupPath: input.backupPath, createdAt: input.createdAt, sourceVersion: input.sourceVersion, checksum: sha256(raw), compressedChecksum: sha256(compressed), compressedBytes: compressed.length, uncompressedBytes: raw.length, compression: "gzip", storageLocation: key, state: "externally_verified", category: input.category, relatedImportBatchIds: [...new Set(input.relatedImportBatchIds)].sort() });
    if (compressed.length > this.maxBytes) throw new Error("Snapshot size limit exceeded");
    let encrypted: Buffer;
    // The encrypted object accounts for its own exact physical byte length.
    for (;;) {
      const manifest = Buffer.from(JSON.stringify(metadata)), length = Buffer.alloc(4);
      if (manifest.length > 1024 * 1024 - 1024) throw new Error("Snapshot metadata size limit exceeded");
      length.writeUInt32BE(manifest.length);
      encrypted = sealSnapshotBytes(Buffer.concat([length, manifest, compressed]), this.context(key), this.options.keyring);
      if (metadata.storedBytes === encrypted.length) break;
      metadata = { ...metadata, storedBytes: encrypted.length };
    }
    await this.publish(key, encrypted);
    const restored = await this.readObject(key);
    if (!this.equivalent(restored.metadata, metadata) || restored.json !== input.json) throw new Error("Immutable snapshot conflict");
    await this.publishIndex(restored.metadata);
    return restored.metadata;
  }
  async getSnapshot(backup: string) { return this.readObject(this.key("objects", backup)); }
  async verifySnapshot(backup: string) { return (await this.getSnapshot(backup)).metadata; }
  async getSnapshotMetadata(backup: string) { return this.verifySnapshot(backup); }
  private async page(kind: "objects" | "index", continuationToken?: string) {
    const response = await this.retry(() => this.options.client.send(new ListObjectsV2Command({ Bucket: this.options.bucket, Prefix: `${this.options.prefix}/${kind}/`, MaxKeys: this.options.pageSize ?? 100, ContinuationToken: continuationToken }), { abortSignal: AbortSignal.timeout(10000) }));
    if (response.IsTruncated && (!response.NextContinuationToken || response.NextContinuationToken === continuationToken)) throw new Error("Invalid remote pagination response");
    const keys = (response.Contents ?? []).map(o => o.Key || "");
    const expected = new RegExp(`^${this.options.prefix}/${kind}/[a-f0-9]{64}\\.${kind === "objects" ? "snapshot" : "manifest"}$`);
    if (keys.some(k => !expected.test(k))) throw new Error("Invalid snapshot object key in remote listing");
    return { keys, continuationToken: response.IsTruncated ? response.NextContinuationToken : undefined };
  }
  async listSnapshotPage(continuationToken?: string) {
    const page = await this.page("index", continuationToken), snapshots: SnapshotMetadata[] = [];
    for (const key of page.keys) snapshots.push(await this.readIndex(key));
    return { snapshots, continuationToken: page.continuationToken };
  }
  async listSnapshots() {
    const results: SnapshotMetadata[] = [], seen = new Set<string>(); let token: string | undefined;
    do { const page = await this.listSnapshotPage(token); results.push(...page.snapshots); token = page.continuationToken; if (token && seen.has(token)) throw new Error("Remote pagination loop"); if (token) seen.add(token); } while (token);
    return results.sort((a, b) => a.backupPath.localeCompare(b.backupPath));
  }
  async reconstructManifests() {
    let token: string | undefined, count = 0; const seen = new Set<string>();
    do {
      const page = await this.page("objects", token);
      for (const key of page.keys) { await this.publishIndex((await this.readObject(key)).metadata); count++; }
      token = page.continuationToken; if (token && seen.has(token)) throw new Error("Remote pagination loop"); if (token) seen.add(token);
    } while (token);
    return count;
  }
  async publishRecoveryManifest(backupPaths: readonly string[]) {
    if (new Set(backupPaths).size !== backupPaths.length) throw new Error("Duplicate recovery manifest identifier");
    const snapshots: SnapshotMetadata[] = [];
    for (const backup of [...backupPaths].sort()) snapshots.push(await this.verifySnapshot(backup));
    const plaintext = Buffer.from(JSON.stringify({ version: 1, snapshots }));
    if (plaintext.length > 16 * 1024 * 1024) throw new Error("Recovery catalog size limit exceeded");
    const key = `${this.options.prefix}/catalogs/${sha256(plaintext)}.manifest`;
    await this.publish(key, sealSnapshotBytes(plaintext, this.context(key), this.options.keyring));
    if (!openSnapshotBytes(await this.download(key, 17 * 1024 * 1024), this.context(key), this.options.keyring).equals(plaintext)) throw new Error("Recovery catalog verification failed");
    return { key, checksum: sha256(plaintext), count: snapshots.length };
  }
  async getRecoveryManifest(key: string) {
    const expected = new RegExp(`^${this.options.prefix}/catalogs/([a-f0-9]{64})\\.manifest$`).exec(key);
    if (!expected) throw new Error("Invalid recovery catalog key");
    const plaintext = openSnapshotBytes(await this.download(key, 17 * 1024 * 1024), this.context(key), this.options.keyring);
    if (sha256(plaintext) !== expected[1]) throw new Error("Recovery catalog checksum mismatch");
    const catalog = z.object({ version: z.literal(1), snapshots: z.array(metadataSchema) }).strict().parse(JSON.parse(plaintext.toString("utf8")));
    if (new Set(catalog.snapshots.map(m => m.backupPath)).size !== catalog.snapshots.length) throw new Error("Duplicate recovery catalog identifier");
    for (const metadata of catalog.snapshots) this.identity(metadata, this.key("objects", metadata.backupPath));
    return catalog;
  }
  async deleteSnapshot(backup: string): Promise<never> { snapshotId(backup); throw new Error("Remote snapshot deletion disabled"); }
}
