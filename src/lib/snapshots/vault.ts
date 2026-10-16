import { promises as fs } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { LocalFilesystemSnapshotStore } from "./filesystem";
import { metadataSchema, sha256, SnapshotNotFoundError, type SnapshotInput } from "./store";

export const VAULT_ROOT = "/Volumes/Vault/storage/supper";
export const HISTORICAL_MANIFEST_SHA = "585247ac16c6e4bc50a42db88cf11c10657180dab76ae1c48458024568a0af69";
const referencesSchema = z.object({ version: z.literal(1), complete: z.literal(true), capturedAt: z.string().datetime(), sourceVersion: z.string().min(1), referencedPaths: z.array(z.string()) }).strict();
const requestSchema = z.object({ before: z.string().datetime(), keepLatest: z.number().int().min(1), referenceInventory: referencesSchema }).strict();
export type PruneRequest = z.infer<typeof requestSchema>;

// Local maintenance only: never import into the web/application runtime.
export class VaultAuthority {
  readonly activeRoot: string;
  readonly historicalRoot: string;
  readonly active: LocalFilesystemSnapshotStore;
  readonly historical: LocalFilesystemSnapshotStore;
  constructor(readonly root = VAULT_ROOT, private readonly mountCheck: () => Promise<void> = async () => {
    const volume = await fs.stat("/Volumes/Vault"), parent = await fs.stat("/Volumes");
    if (volume.dev === parent.dev) throw new Error("VAULT_UNAVAILABLE: external volume is not mounted");
  }, private readonly baseline = { sha: HISTORICAL_MANIFEST_SHA, count: 6085 }) {
    if ((baseline.sha !== HISTORICAL_MANIFEST_SHA || baseline.count !== 6085) && process.env.NODE_ENV !== "test") throw new Error("Historical baseline override is test-only");
    if (root !== VAULT_ROOT && process.env.NODE_ENV !== "test") throw new Error("Canonical Vault root required");
    this.activeRoot = path.join(root, "snapshot-archives/local-vault");
    this.historicalRoot = path.join(root, "snapshot-archives/phase03");
    this.active = new LocalFilesystemSnapshotStore(this.activeRoot, undefined, () => this.guard(this.activeRoot));
    this.historical = new LocalFilesystemSnapshotStore(this.historicalRoot, undefined, () => this.guard(this.historicalRoot));
  }
  async guard(directory = this.root) {
    if (process.env.VERCEL) throw new Error("Vault operations require a local process");
    try {
      await this.mountCheck();
      if (await fs.realpath(directory) !== directory) throw new Error("Noncanonical or symlinked Vault path");
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe Vault directory");
      if (directory !== this.root && stat.mode & 0o077) throw new Error("Vault archive must be private");
    } catch { throw new Error("VAULT_UNAVAILABLE_OR_UNSAFE: mount/path check failed; no fallback"); }
  }
  async initialize() {
    await this.guard();
    // Never recursively create the mountpoint or canonical storage root.
    await this.guard(path.join(this.root, "snapshot-archives"));
    for (const directory of [path.join(this.root, "recovery-exports"), this.activeRoot, path.join(this.activeRoot, "operations"), path.join(this.activeRoot, "catalogs")]) {
      await this.guard();
      try { await fs.mkdir(directory, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
      await this.guard(directory);
    }
  }
  private async journal(file: string, value: unknown) {
    await this.guard(this.activeRoot);
    await this.guard(path.dirname(file));
    const handle = await fs.open(file, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); } finally { await handle.close(); }
    const parent = await fs.open(path.dirname(file), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  }
  async readiness() {
    await this.guard(this.historicalRoot); await this.guard(this.activeRoot);
    const bytes = await fs.readFile(path.join(this.historicalRoot, "full-manifest.json"));
    if (sha256(bytes) !== this.baseline.sha) throw new Error("Historical manifest changed");
    const frozen = z.array(metadataSchema).length(this.baseline.count).parse(JSON.parse(bytes.toString()));
    if (new Set(frozen.map(s => s.backupPath)).size !== this.baseline.count) throw new Error("Historical catalog duplicate");
    await this.guard(path.join(this.activeRoot, "operations"));
    await this.guard(path.join(this.activeRoot, "catalogs"));
    const operations = await fs.readdir(path.join(this.activeRoot, "operations"));
    const pending = operations.filter(f => f.endsWith(".intent.json") && !operations.includes(f.replace(".intent.json", ".result.json")));
    if (pending.length) throw new Error("PRUNE_RECOVERY_REQUIRED: unresolved intent; inspect operation journal before further writes");
    return { state: "VAULT_READY", root: this.root, historicalCount: frozen.length, historicalManifestSha: sha256(bytes), activeCount: (await this.active.listSnapshots()).length };
  }
  async save(input: SnapshotInput) {
    return this.active.withDatasetLock("vault-maintenance", async () => { await this.readiness(); return this.active.saveSnapshot(input); });
  }
  async read(backupPath: string) {
    await this.readiness();
    try { return await this.active.getSnapshot(backupPath); }
    catch (e) { if (!(e instanceof SnapshotNotFoundError)) throw e; return this.historical.getSnapshot(backupPath); }
  }
  async export(backupPath: string, filename: string) {
    if (!/^[A-Za-z0-9_-]+\.json$/.test(filename)) throw new Error("Export requires a plain JSON filename");
    return this.active.withDatasetLock("vault-maintenance", async () => {
      const snapshot = await this.read(backupPath);
      const directory = path.join(this.root, "recovery-exports");
      await this.guard(directory);
      const file = path.join(directory, filename);
      const handle = await fs.open(file, "wx", 0o600);
      try { await handle.writeFile(snapshot.json); await handle.sync(); } finally { await handle.close(); }
      const parent = await fs.open(directory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
      return { file, sourceChecksum: snapshot.metadata.checksum };
    });
  }
  async catalog(name: string, backupPaths: string[]) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || new Set(backupPaths).size !== backupPaths.length) throw new Error("Invalid catalog");
    return this.active.withDatasetLock("vault-maintenance", async () => {
      await this.readiness();
      const entries = await Promise.all(backupPaths.map(p => this.active.verifySnapshot(p)));
      await this.journal(path.join(this.activeRoot, "catalogs", `${name}.json`), entries);
      return entries;
    });
  }
  async plan(request: PruneRequest) {
    request = requestSchema.parse(request); await this.readiness();
    const age = Date.now() - Date.parse(request.referenceInventory.capturedAt);
    if (age < -60000 || age > 15 * 60000) throw new Error("Fresh complete reference inventory required (15 minutes)");
    const snapshots = await this.active.listSnapshots();
    const pinned = new Set(request.referenceInventory.referencedPaths);
    for (const name of await fs.readdir(path.join(this.activeRoot, "catalogs"))) {
      if (!/^[a-zA-Z0-9_-]+\.json$/.test(name)) throw new Error("Unsafe catalog layout");
      const file = path.join(this.activeRoot, "catalogs", name);
      const stat = await fs.lstat(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error("Unsafe catalog");
      const entries = z.array(metadataSchema).parse(JSON.parse(await fs.readFile(file, "utf8")));
      for (const entry of entries) {
        if (JSON.stringify(await this.active.verifySnapshot(entry.backupPath)) !== JSON.stringify(entry)) throw new Error("Catalog inconsistency");
        pinned.add(entry.backupPath);
      }
    }
    // Missing references may belong to the protected historical store; verify rather than ignore them.
    for (const p of pinned) {
      if (snapshots.some(s => s.backupPath === p)) await this.active.verifySnapshot(p);
      else await this.historical.verifySnapshot(p);
    }
    const frozen = z.array(metadataSchema).parse(JSON.parse(await fs.readFile(path.join(this.historicalRoot, "full-manifest.json"), "utf8")));
    const historicalIds = new Set(frozen.map(s => s.backupPath));
    const latest = new Set<string>(); const counts = new Map<string, number>();
    for (const s of [...snapshots].sort((a,b) => b.createdAt.localeCompare(a.createdAt))) {
      const n = counts.get(s.originalKey) ?? 0; if (n < request.keepLatest) latest.add(s.backupPath); counts.set(s.originalKey, n+1);
    }
    const candidates = snapshots.filter(s => !historicalIds.has(s.backupPath) && s.category === "automatic" && !s.relatedImportBatchIds.length && !pinned.has(s.backupPath) && !latest.has(s.backupPath) && s.createdAt < request.before);
    for (const s of candidates) await this.active.verifySnapshot(s.backupPath);
    const plan = { version: 1, request, candidates, bytes: candidates.reduce((n,s) => n+s.compressedBytes+Buffer.byteLength(JSON.stringify(s)),0) };
    return { ...plan, digest: sha256(JSON.stringify(plan)) };
  }
  async prune(request: PruneRequest, approvedDigest?: string) {
    if (approvedDigest && this.root === VAULT_ROOT) throw new Error("Real-data prune disabled pending Owner-approved complete reference inventory");
    return this.active.withDatasetLock("vault-maintenance", async () => {
      const plan = await this.plan(request);
      if (!approvedDigest) return { dryRun: true, ...plan };
      if (approvedDigest !== plan.digest) throw new Error("Prune plan changed; new dry-run approval required");
      const id = randomUUID(), operation = path.join(this.activeRoot, "operations", id);
      await this.journal(`${operation}.intent.json`, { id, plan });
      const removed: string[] = [];
      // A crash leaves an unresolved durable intent and readiness blocks further work. No automatic retry/deletion.
      for (const s of plan.candidates) {
        await this.guard(this.activeRoot);
        await this.active.verifySnapshot(s.backupPath);
        const directory = path.dirname(path.join(this.activeRoot, s.storageLocation));
        if (!directory.startsWith(this.activeRoot + "/objects/")) throw new Error("Unsafe prune path");
        await fs.unlink(path.join(directory, "snapshot.json.gz"));
        await fs.unlink(path.join(directory, "manifest.json"));
        await fs.rmdir(directory);
        const parent = await fs.open(path.dirname(directory), "r"); try { await parent.sync(); } finally { await parent.close(); }
        removed.push(s.backupPath);
      }
      await this.journal(`${operation}.result.json`, { id, completedAt: new Date().toISOString(), planDigest: plan.digest, removed });
      return { dryRun: false, id, removed, bytes: plan.bytes };
    });
  }
}
