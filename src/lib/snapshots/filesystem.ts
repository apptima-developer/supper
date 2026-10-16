import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { gzip, gunzip } from "node:zlib";
import { promisify } from "node:util";
import { backupTarget } from "../backup-restore-policy";
import { SnapshotNotFoundError, metadataSchema, sha256, snapshotId, type SnapshotStore, type SnapshotInput, type SnapshotMetadata } from "./store";
const compress = promisify(gzip), decompress = promisify(gunzip);
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export { SnapshotNotFoundError } from "./store";

export class LocalFilesystemSnapshotStore implements SnapshotStore {
  readonly root: string;
  // shortcut: buffers are capped at 64 MiB, use streaming verification before accepting larger snapshots.
  constructor(root: string, readonly maxBytes = 64 * 1024 * 1024, readonly beforeAccess?: () => Promise<void>) {
    if (!path.isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error("Invalid snapshot store configuration");
    this.root = path.resolve(root);
  }
  private relative(backupPath: string) {
    const { target, timestamp } = backupTarget(backupPath);
    const date = new Date(timestamp).toISOString();
    return path.join("objects", date.slice(0, 4), date.slice(5, 7), target.slice(0, -5), snapshotId(backupPath));
  }
  private async directory(relative = "") {
    await this.beforeAccess?.();
    if (!this.beforeAccess) await fs.mkdir(this.root, { recursive: true, mode: 0o700 });
    let current = this.root;
    for (const part of ["", ...relative.split(path.sep).filter(Boolean)]) {
      if (part) {
        current = path.join(current, part);
        await this.beforeAccess?.();
        try { await fs.mkdir(current, { mode: 0o700 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      const stat = await fs.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Snapshot directories must be private and not symlinks");
    }
    return current;
  }
  private async readFile(file: string, limit: number) {
    await this.beforeAccess?.();
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit || (stat.mode & 0o077)) throw new Error("Unsafe snapshot object");
    return fs.readFile(file);
  }
  private async sync(directory: string) {
    await this.beforeAccess?.();
    const handle = await fs.open(directory, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  }
  private async publishFile(file: string, bytes: string | Buffer) {
    await this.beforeAccess?.();
    const handle = await fs.open(file, "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  }
  private async read(directory: string, backupPath: string) {
    const metadata = metadataSchema.parse(JSON.parse((await this.readFile(path.join(directory, "manifest.json"), 1024 * 1024)).toString("utf8")));
    if (metadata.snapshotId !== snapshotId(backupPath) || metadata.backupPath !== backupPath || metadata.originalKey !== backupTarget(backupPath).target || metadata.storageLocation !== path.join(this.relative(backupPath), "snapshot.json.gz")) throw new Error("Snapshot identity mismatch");
    if (metadata.uncompressedBytes > this.maxBytes || metadata.compressedBytes > this.maxBytes) throw new Error("Snapshot size limit exceeded");
    const compressed = await this.readFile(path.join(directory, "snapshot.json.gz"), this.maxBytes);
    if (compressed.length !== metadata.compressedBytes || sha256(compressed) !== metadata.compressedChecksum) throw new Error("Snapshot compressed checksum mismatch");
    const data = await decompress(compressed, { maxOutputLength: this.maxBytes });
    if (data.length !== metadata.uncompressedBytes || sha256(data) !== metadata.checksum) throw new Error("Snapshot content checksum mismatch");
    const json = data.toString("utf8");
    JSON.parse(json);
    return { metadata, json };
  }
  async saveSnapshot(input: SnapshotInput) {
    const relative = this.relative(input.backupPath), final = path.join(this.root, relative);
    const bytes = Buffer.from(input.json, "utf8");
    if (bytes.length > this.maxBytes) throw new Error("Snapshot size limit exceeded");
    JSON.parse(input.json);
    const compressed = await compress(bytes, { level: 9 });
    const metadata = metadataSchema.parse({
      metadataVersion: 1, schemaVersion: 1, snapshotId: snapshotId(input.backupPath),
      originalKey: backupTarget(input.backupPath).target, backupPath: input.backupPath,
      createdAt: input.createdAt, sourceVersion: input.sourceVersion, category: input.category,
      relatedImportBatchIds: [...new Set(input.relatedImportBatchIds)].sort(),
      checksum: sha256(bytes), compressedChecksum: sha256(compressed), compression: "gzip",
      compressedBytes: compressed.length, uncompressedBytes: bytes.length,
      storageLocation: path.join(relative, "snapshot.json.gz"), state: "externally_verified",
    });
    const parent = await this.directory(path.dirname(relative));
    const stage = path.join(parent, `.tmp-${metadata.snapshotId}-${randomUUID()}`);
    await fs.mkdir(stage, { mode: 0o700 });
    try {
      await this.publishFile(path.join(stage, "snapshot.json.gz"), compressed);
      await this.publishFile(path.join(stage, "manifest.json"), JSON.stringify(metadata));
      await this.read(stage, input.backupPath);
      await this.sync(stage);
      try { await fs.rename(stage, final); }
      catch (error) {
        if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code || "")) throw error;
        const existing = await this.getSnapshot(input.backupPath);
        if (JSON.stringify(existing.metadata) !== JSON.stringify(metadata) || existing.json !== input.json) throw new Error("Immutable snapshot conflict");
      }
      await this.sync(parent);
      return (await this.getSnapshot(input.backupPath)).metadata;
    } finally {
      // Only this invocation's unpublished staging directory is disposable.
      await fs.rm(stage, { force: true, recursive: true });
    }
  }
  async getSnapshot(backupPath: string) {
    await this.beforeAccess?.();
    try {
      const relative = this.relative(backupPath);
      let directory = this.root;
      for (const part of ["", ...relative.split(path.sep)]) {
        directory = path.join(directory, part);
        const stat = await fs.lstat(directory);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw new Error("Unsafe snapshot directory");
      }
      try { return await this.read(path.join(this.root, relative), backupPath); }
      catch (error) {
        if (missing(error)) throw new Error("Published snapshot object is incomplete");
        throw error;
      }
    } catch (error) { if (missing(error)) throw new SnapshotNotFoundError(); throw error; }
  }
  async getSnapshotMetadata(backupPath: string) { return (await this.getSnapshot(backupPath)).metadata; }
  async verifySnapshot(backupPath: string) { return (await this.getSnapshot(backupPath)).metadata; }
  async listSnapshots() {
    const results: SnapshotMetadata[] = [];
    const objects = await this.directory("objects");
    const walk = async (directory: string) => {
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        if (entry.name.startsWith(".tmp-")) continue;
        if (entry.isSymbolicLink() || !entry.isDirectory()) throw new Error("Unsafe snapshot layout");
        const child = path.join(directory, entry.name);
        if (/^[a-f0-9]{64}$/.test(entry.name)) {
          const metadata = metadataSchema.parse(JSON.parse((await this.readFile(path.join(child, "manifest.json"), 1024 * 1024)).toString("utf8")));
          if (path.join(this.root, this.relative(metadata.backupPath)) !== child || metadata.snapshotId !== entry.name) throw new Error("Snapshot manifest identity mismatch");
          results.push(metadata);
        } else { await walk(child); }
      }
    };
    await walk(objects);
    return results.sort((a, b) => a.backupPath.localeCompare(b.backupPath));
  }
  async deleteSnapshot(backupPath: string): Promise<never> { backupTarget(backupPath); throw new Error("Snapshot deletion disabled in Phase 02"); }
  async withDatasetLock<T>(target: string, action: () => Promise<T>): Promise<T> {
    const directory = await this.directory("locks"), lock = path.join(directory, sha256(target));
    const deadline = Date.now() + 5000;
    for (;;) {
      try { await fs.mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (Date.now() >= deadline) throw new Error("Snapshot writer busy; retry after reviewing stale locks");
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    try { return await action(); } finally { await fs.rmdir(lock); }
  }
}
