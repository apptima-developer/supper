import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { S3Client, CreateBucketCommand, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, request as forwardRequest } from "node:http";
import { execFileSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import { S3SnapshotStore } from "./s3";
import { openSnapshotBytes, sealSnapshotBytes } from "./encryption";
import { sha256, type SnapshotInput } from "./store";
import { migrateManifest } from "./remote-migration";
import { planSnapshotRetention } from "./retention";
import { externalWrite, type SnapshotDatabase } from "./runtime";
import { HttpError } from "../request-security";

const enabled = process.env.SUPPER_PHASE04A_INTEGRATION === "1";
const endpoint = "http://127.0.0.1:19000";
const bucket = "supper-phase04a-synthetic", backupBucket = "supper-phase04a-synthetic-backup";
const clients: S3Client[] = [];
const keyring = { activeKeyId: "synthetic-v1", keys: { "synthetic-v1": randomBytes(32) } };
const credentials = { accessKeyId: process.env.MINIO_ROOT_USER || "", secretAccessKey: process.env.MINIO_ROOT_PASSWORD || "" };
const evidence: Record<string, unknown> = { syntheticOnly: true, actualR2Tested: false, actualAwsTested: false, productionActivation: false };
function client(url = endpoint) {
  const c = new S3Client({ endpoint: url, region: "us-east-1", credentials, forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" }); clients.push(c); return c;
}
function store(prefix = `phase04a/${randomUUID()}`, selectedBucket = bucket, c = client()) { return new S3SnapshotStore({ client: c, bucket: selectedBucket, prefix, keyring, pageSize: 2, retryBaseMs: 5 }); }
function input(n = 0): SnapshotInput {
  return { backupPath: `backups/core/tickets-${1700000000000 + n}-aabbccdd.json`, json: JSON.stringify([{ id: `synthetic-${n}`, text: "Synthetic ไทย", amount: 0.125 }]), createdAt: new Date(1700000000000 + n).toISOString(), sourceVersion: "synthetic-source-v1", category: "automatic", relatedImportBatchIds: [] };
}
const literal = (v: string) => "'" + v.replaceAll("'", "''") + "'";
function sql(statement: string) {
  // Fixed newly-created synthetic database: this harness cannot address any recovery database.
  return execFileSync("docker", ["exec", "-i", "supper-recovery-pg17", "psql", "-X", "-qAt", "-U", "supper_recovery_admin", "-d", "supper_phase04a_synthetic_20261015", "-v", "ON_ERROR_STOP=1"], { input: statement, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 }).trim();
}
function query<T>(statement: string): T[] { return JSON.parse(sql(`BEGIN READ ONLY; SELECT coalesce(json_agg(q),'[]') FROM (${statement}) q; ROLLBACK;`)); }
function jsonSql(value: unknown) { return `convert_from(decode('${Buffer.from(JSON.stringify(value)).toString("hex")}','hex'),'UTF8')::jsonb`; }
function seed(target: string, value: unknown) {
  if (target.startsWith("backups/")) throw new Error("Synthetic database snapshots prohibited");
  sql(`INSERT INTO public.app_store(key,value) VALUES(${literal(target)},${jsonSql(value)}) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=clock_timestamp();`);
}
const database: SnapshotDatabase & { listStoreKeys: (prefix: string) => Promise<string[]> } = {
  getStore: async <T,>(target: string) => query<{ value: T }>(`SELECT value FROM public.app_store WHERE key=${literal(target)}`)[0]?.value,
  getVersionedStore: async target => query<{ value: unknown; updatedAt: string }>(`SELECT value,updated_at::text AS "updatedAt" FROM public.app_store WHERE key=${literal(target)}`)[0],
  setStoreIfUnchanged: async (target, value, version) => {
    if (target.startsWith("backups/")) throw new Error("Synthetic database snapshots prohibited");
    const mutation = version ? `UPDATE public.app_store SET value=${jsonSql(value)},updated_at=greatest(clock_timestamp(),${literal(version)}::timestamptz+interval '1 millisecond') WHERE key=${literal(target)} AND updated_at=${literal(version)}::timestamptz RETURNING key` : `INSERT INTO public.app_store(key,value) VALUES(${literal(target)},${jsonSql(value)}) RETURNING key`;
    if (JSON.parse(sql(`WITH changed AS (${mutation}) SELECT coalesce(json_agg(key),'[]') FROM changed;`)).length !== 1) throw new HttpError(409, "DATASET_CONFLICT", "Dataset changed concurrently");
  },
  listStoreKeys: async prefix => query<{ key: string }>(`SELECT key FROM public.app_store WHERE key LIKE ${literal(prefix + "%")}`).map(r => r.key),
};

describe.skipIf(!enabled)("synthetic local MinIO remote snapshots", () => {
  beforeAll(async () => {
    expect(credentials.accessKeyId).toBeTruthy(); expect(credentials.secretAccessKey).toBeTruthy();
    for (const name of [bucket, backupBucket]) {
      try { await client().send(new CreateBucketCommand({ Bucket: name })); }
      catch (error) { if ((error as Error).name !== "BucketAlreadyOwnedByYou") throw error; }
    }
    expect(query<{ name: string }>("SELECT current_database() AS name")[0].name).toBe("supper_phase04a_synthetic_20261015");
  });
  afterAll(async () => {
    clients.forEach(c => c.destroy()); vi.unstubAllEnvs(); vi.doUnmock("../store");
    await fs.writeFile("/Volumes/Vault/storage/supper/phase04a/integration-evidence.json", JSON.stringify(evidence, null, 2), { mode: 0o600 });
  });

  it("saves encrypted gzip objects, verifies exact SHA-256, paginates and rejects immutable conflicts", async () => {
    const archive = store();
    for (let n = 0; n < 5; n++) await archive.saveSnapshot(input(n));
    const metadata = await archive.verifySnapshot(input().backupPath);
    expect(metadata.checksum).toBe(sha256(input().json));
    expect((await archive.getSnapshot(input().backupPath)).json).toBe(input().json);
    expect(await archive.getSnapshotMetadata(input().backupPath)).toEqual(metadata);
    const raw = Buffer.from(await (await archive.options.client.send(new GetObjectCommand({ Bucket: bucket, Key: metadata.storageLocation }))).Body!.transformToByteArray());
    expect((await fetch(`${endpoint}/${bucket}/${metadata.storageLocation}`)).status).toBe(403);
    expect(raw.length).toBe(metadata.storedBytes); expect(raw.includes(Buffer.from("Synthetic"))).toBe(false);
    expect(raw.includes(Buffer.from(input().backupPath))).toBe(false);
    const page = await archive.listSnapshotPage(); expect(page.snapshots).toHaveLength(2); expect(page.continuationToken).toBeTruthy();
    expect(await archive.listSnapshots()).toHaveLength(5);
    await expect(archive.saveSnapshot({ ...input(), json: "[]" })).rejects.toThrow("Immutable snapshot conflict");
    await expect(archive.deleteSnapshot(input().backupPath)).rejects.toThrow("disabled");
    await expect(archive.saveSnapshot({ ...input(10000), sourceVersion: "x".repeat(1024 * 1024) })).rejects.toThrow("metadata size");
    await expect(archive.getSnapshot("backups/../../auth/users-1700000000000-aabbccdd.json")).rejects.toThrow();
    evidence.roundTripEncryptionGzipShaPaginationImmutable = true;
  });

  it("publishes once across independent clients and confirms actual If-None-Match 412 conflicts", async () => {
    const prefix = `phase04a/${randomUUID()}`;
    await Promise.all(Array.from({ length: 8 }, () => store(prefix).saveSnapshot(input())));
    expect(await store(prefix).listSnapshots()).toHaveLength(1);
    const probe = `${prefix}/conditional-probe`;
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => client().send(new PutObjectCommand({ Bucket: bucket, Key: probe, Body: "synthetic conditional probe", IfNoneMatch: "*" }))));
    expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
    for (const outcome of outcomes) if (outcome.status === "rejected") expect(outcome.reason.$metadata.httpStatusCode).toBe(412);
    evidence.conditionalPublication = { concurrentClients: 8, successfulProbeWrites: 1, rejected412: 7 };
  });

  it("recovers bounded retries from real TCP resets including a committed PUT with lost response", async () => {
    let beforeCommit = 0, afterCommit = 0, stalledRead = 0;
    const proxy = createServer((request, response) => {
      if (beforeCommit < 2) { beforeCommit++; request.socket.destroy(); return; }
      if (request.method === "GET" && request.url?.includes("/objects/") && !stalledRead) { stalledRead++; response.writeHead(200, { "Content-Length": "100" }); response.write("partial"); return; }
      const upstream = forwardRequest({ hostname: "127.0.0.1", port: 19000, method: request.method, path: request.url, headers: request.headers }, remote => {
        if (request.method === "PUT" && remote.statusCode === 200 && !afterCommit) { afterCommit++; remote.resume(); response.destroy(); return; }
        response.writeHead(remote.statusCode || 502, remote.headers); remote.pipe(response);
      });
      upstream.on("error", () => response.destroy()); request.pipe(upstream);
    });
    await new Promise<void>(resolve => proxy.listen(0, "127.0.0.1", resolve));
    const address = proxy.address(); if (!address || typeof address === "string") throw new Error("Local proxy unavailable");
    const c = client(`http://127.0.0.1:${address.port}`), archive = store(undefined, bucket, c);
    try {
      await archive.saveSnapshot(input());
      expect((await archive.getSnapshot(input().backupPath)).json).toBe(input().json);
      expect(await archive.listSnapshots()).toHaveLength(1);
      expect(beforeCommit).toBe(2); expect(afterCommit).toBe(1); expect(stalledRead).toBe(1);
      evidence.networkFailureRetries = { tcpResetsBeforeCommit: beforeCommit, committedResponseLost: afterCommit, stalledResponseBodies: stalledRead, verifiedObjects: 1 };
    } finally { c.destroy(); proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve())); }
    const unavailable = new S3SnapshotStore({ ...store().options, client: client("http://127.0.0.1:1"), attempts: 2, retryBaseMs: 1 });
    await expect(unavailable.saveSnapshot(input())).rejects.toThrow("publication failed");
  }, 60000);

  it("reconstructs deleted synthetic indexes and publishes independently readable versioned recovery catalogs", async () => {
    const archive = store(), metadata = await archive.saveSnapshot(input());
    const index = metadata.storageLocation.replace("/objects/", "/index/").replace(".snapshot", ".manifest");
    await archive.options.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: index }));
    expect(await archive.listSnapshots()).toEqual([]);
    expect(await archive.reconstructManifests()).toBe(1);
    expect(await archive.listSnapshots()).toHaveLength(1);
    const catalog = await archive.publishRecoveryManifest([input().backupPath]);
    expect(catalog.count).toBe(1); expect(await archive.publishRecoveryManifest([input().backupPath])).toEqual(catalog);
    expect((await new S3SnapshotStore(archive.options).getRecoveryManifest(catalog.key)).snapshots).toEqual([metadata]);
    await expect(archive.getRecoveryManifest("../unsafe.manifest")).rejects.toThrow("Invalid recovery");
    evidence.reconstructionAndVersionedCatalog = true;
  });

  it("copies a frozen synthetic set to a separate bucket and resumes after checkpoint interruption", async () => {
    const source = store(), destination = store(undefined, backupBucket);
    const manifest = [];
    for (let n = 0; n < 3; n++) manifest.push(await source.saveSnapshot({ ...input(n), category: n === 0 ? "manual" : "import", relatedImportBatchIds: ["synthetic-batch"] }));
    await source.saveSnapshot(input(99));
    const checkpointFile = `/Volumes/Vault/storage/supper/phase04a/synthetic-checkpoint-${randomUUID()}.json`;
    await expect(migrateManifest(manifest, source, destination, async progress => { await fs.writeFile(checkpointFile, JSON.stringify(progress), { mode: 0o600 }); throw new Error("synthetic interruption"); })).rejects.toThrow("interruption");
    expect(JSON.parse(await fs.readFile(checkpointFile, "utf8")).verified).toBe(1);
    const checkpoints: number[] = [];
    expect(await migrateManifest(manifest, source, destination, async p => { checkpoints.push(p.verified); })).toEqual({ verified: 3, failed: 0 });
    expect(checkpoints).toEqual([1, 2, 3]); expect(await destination.listSnapshots()).toHaveLength(3);
    expect(await migrateManifest(manifest, source, destination, async () => undefined)).toEqual({ verified: 3, failed: 0 });
    for (const m of manifest) expect((await destination.verifySnapshot(m.backupPath)).checksum).toBe(m.checksum);
    expect(planSnapshotRetention(await destination.listSnapshots(), { maxHotCount: 0, maxHotBytes: 0, protectedPaths: new Set(manifest.map(m => m.backupPath)) }).cold).toEqual([]);
    await expect(migrateManifest([{ ...manifest[0], checksum: "0".repeat(64) }], source, destination, async () => undefined)).rejects.toThrow("Frozen source");
    const corruptKey = manifest[0].storageLocation;
    const raw = Buffer.from(await (await source.options.client.send(new GetObjectCommand({ Bucket: bucket, Key: corruptKey }))).Body!.transformToByteArray()); raw[raw.length - 1] ^= 1;
    await source.options.client.send(new PutObjectCommand({ Bucket: bucket, Key: corruptKey, Body: raw }));
    await source.options.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: manifest[1].storageLocation }));
    await expect(source.verifySnapshot(manifest[0].backupPath)).rejects.toThrow("authenticated");
    await expect(source.verifySnapshot(manifest[1].backupPath)).rejects.toThrow("not found");
    const recovered = store();
    expect(await migrateManifest(await destination.listSnapshots(), destination, recovered, async () => undefined)).toEqual({ verified: 3, failed: 0 });
    for (const m of manifest) expect((await recovered.verifySnapshot(m.backupPath)).checksum).toBe(m.checksum);
    evidence.independentBucketCopyAndResume = { selected: 3, excludedTestObjects: 1, protected: 3, recoveredMissingAndCorruptIntoFreshNamespace: true };
  });

  it("checks gzip CRC and raw SHA-256 even when a synthetic fault is re-encrypted with a valid key", async () => {
    for (const failure of ["crc", "sha256"]) {
      const archive = store(), metadata = await archive.saveSnapshot(input());
      const raw = Buffer.from(await (await archive.options.client.send(new GetObjectCommand({ Bucket: bucket, Key: metadata.storageLocation }))).Body!.transformToByteArray());
      const context = `${bucket}\0${metadata.storageLocation}`, plaintext = openSnapshotBytes(raw, context, keyring);
      const size = plaintext.readUInt32BE(0), original = JSON.parse(plaintext.subarray(4, size + 4).toString("utf8"));
      const compressed = Buffer.from(plaintext.subarray(size + 4));
      if (failure === "crc") { compressed[compressed.length - 8] ^= 1; original.compressedChecksum = sha256(compressed); }
      else original.checksum = "0".repeat(64);
      const manifest = Buffer.from(JSON.stringify(original)), length = Buffer.alloc(4); length.writeUInt32BE(manifest.length);
      const modified = sealSnapshotBytes(Buffer.concat([length, manifest, compressed]), context, keyring);
      expect(modified.length).toBe(raw.length);
      await archive.options.client.send(new PutObjectCommand({ Bucket: bucket, Key: metadata.storageLocation, Body: modified }));
      await expect(archive.verifySnapshot(input().backupPath)).rejects.toThrow(failure === "sha256" ? "content checksum" : undefined);
    }
    evidence.gzipCrcAndRawShaIndependentChecks = true;
  });

  it("retains old encryption keys across rotation and fails closed for missing or corrupted objects", async () => {
    const archive = store(), metadata = await archive.saveSnapshot(input());
    const next = randomBytes(32), rotated = new S3SnapshotStore({ ...archive.options, keyring: { activeKeyId: "synthetic-v2", keys: { ...keyring.keys, "synthetic-v2": next } } });
    expect((await rotated.getSnapshot(input().backupPath)).json).toBe(input().json);
    await rotated.saveSnapshot(input()); await rotated.saveSnapshot(input(1));
    const retired = new S3SnapshotStore({ ...archive.options, keyring: { activeKeyId: "synthetic-v2", keys: { "synthetic-v2": next } } });
    await expect(retired.getSnapshot(input().backupPath)).rejects.toThrow("key unavailable");
    expect((await retired.getSnapshot(input(1).backupPath)).json).toBe(input(1).json);
    await expect(archive.getSnapshot(input(999).backupPath)).rejects.toThrow("not found");
    const wrongBucket = new S3SnapshotStore({ ...archive.options, bucket: `missing-${randomUUID()}` });
    await expect(wrongBucket.getSnapshot(input().backupPath)).rejects.toThrow("read failed");
    const raw = Buffer.from(await (await archive.options.client.send(new GetObjectCommand({ Bucket: bucket, Key: metadata.storageLocation }))).Body!.transformToByteArray()); raw[raw.length - 1] ^= 1;
    // Privileged fault injection targets only this random synthetic namespace, never historical archives.
    await archive.options.client.send(new PutObjectCommand({ Bucket: bucket, Key: metadata.storageLocation, Body: raw }));
    await expect(archive.getSnapshot(input().backupPath)).rejects.toThrow("authenticated");
    evidence.rotationMissingCorrupt = true;
  });

  it("rejects a stale concurrent PostgreSQL writer, then safely rebases an explicit retry without lost updates", async () => {
    for (const target of ["core/tickets.json", "core/customers.json", "audit/audit-log.json"]) {
      seed(target, []);
      let reads = 0, release!: () => void; const bothRead = new Promise<void>(resolve => { release = resolve; });
      const raced: SnapshotDatabase = { ...database, getVersionedStore: async key => { const current = await database.getVersionedStore(key); if (++reads === 2) release(); await bothRead; return current; } };
      const prefix = `phase04a/${randomUUID()}`;
      const outcomes = await Promise.allSettled([externalWrite(target, ["a"], raced, store(prefix)), externalWrite(target, ["b"], raced, store(prefix))]);
      expect(outcomes.filter(o => o.status === "fulfilled")).toHaveLength(1);
      const failed = outcomes.find(o => o.status === "rejected"); expect(failed?.status === "rejected" && failed.reason.status).toBe(409);
      const winner = await database.getStore<string[]>(target), missing = winner![0] === "a" ? "b" : "a";
      await externalWrite(target, [...winner!, missing], database, store(prefix));
      expect((await database.getStore<string[]>(target))!.sort()).toEqual(["a", "b"]);
      expect(await database.listStoreKeys("backups/")).toEqual([]);
    }
    evidence.databaseCasAcrossIndependentClients = { datasets: ["tickets", "customers", "audit"], winnersPerRace: 1, explicit409ConflictsPerRace: 1, finalUpdatesPreservedPerDataset: 2, postgresSnapshots: 0 };
  });

  it("enforces CAS across eight independent PostgreSQL client processes without shared locks", async () => {
    const target = "core/customers.json"; seed(target, []);
    const baseline = (await database.getVersionedStore(target))!;
    const changed = await Promise.all(Array.from({ length: 8 }, (_, n) => new Promise<number>((resolve, reject) => {
      const process = spawn("docker", ["exec", "-i", "supper-recovery-pg17", "psql", "-X", "-qAt", "-U", "supper_recovery_admin", "-d", "supper_phase04a_synthetic_20261015", "-v", "ON_ERROR_STOP=1"]);
      let output = ""; process.stdout.on("data", data => { output += data; }); process.stderr.resume();
      process.on("error", reject); process.on("close", code => { if (code !== 0) reject(new Error("Independent synthetic CAS process failed")); else resolve(Number(output.trim())); });
      process.stdin.end(`WITH changed AS (UPDATE public.app_store SET value=${jsonSql([`synthetic-${n}`])},updated_at=greatest(clock_timestamp(),${literal(baseline.updatedAt)}::timestamptz+interval '1 millisecond') WHERE key=${literal(target)} AND updated_at=${literal(baseline.updatedAt)}::timestamptz RETURNING key) SELECT count(*) FROM changed;`);
    })));
    expect(changed.filter(n => n === 1)).toHaveLength(1); expect(changed.filter(n => n === 0)).toHaveLength(7);
    evidence.independentPostgresProcesses = { processes: 8, successfulConditionalUpdates: 1, staleUpdatesRejected: 7 };
  });

  it("restores Settings and import rollback through the remote backend, preserving authorization/audit and fail-closed behavior", async () => {
    const archive = store();
    for (const target of ["core/tickets.json", "core/ticket-history.json", "audit/audit-log.json"]) seed(target, []);
    const mapping = { snow: { synthetic: "before" }, supportdesk: { customerAliases: {} } }; seed("imports/mappings.json", mapping);
    vi.resetModules(); vi.doMock("../store", () => database);
    const env = { NODE_ENV: "test", DATA_BACKEND: "supabase", SUPPER_EXTERNAL_SNAPSHOTS: "1", SUPPER_SNAPSHOT_PROVIDER: "s3", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321", SUPPER_S3_ENDPOINT: endpoint, SUPPER_S3_REGION: "us-east-1", SUPPER_S3_PATH_STYLE: "1", SUPPER_S3_BUCKET: bucket, SUPPER_S3_PREFIX: archive.options.prefix, SUPPER_S3_ACCESS_KEY_ID: credentials.accessKeyId, SUPPER_S3_SECRET_ACCESS_KEY: credentials.secretAccessKey, SUPPER_SNAPSHOT_ACTIVE_KEY_ID: keyring.activeKeyId, SUPPER_SNAPSHOT_KEYS_JSON: JSON.stringify(Object.fromEntries(Object.entries(keyring.keys).map(([id, key]) => [id, key.toString("base64")]))) };
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const jsonStore = await import("../json-store"), repositories = await import("../repositories"), { restoreBackupAsAdmin } = await import("../backup-service"), types = await import("../types"), { importMappingsSchema } = await import("../import-mappings");
    await jsonStore.writeJsonAtomic("imports/mappings.json", { ...mapping, snow: { synthetic: "after" } }, importMappingsSchema);
    const [backup] = await jsonStore.listBackups(); expect(backup).toBeTruthy();
    const session = { userId: "synthetic-admin", username: "synthetic-admin", name: "Synthetic", role: "admin" as const, authVersion: 1 };
    await expect(restoreBackupAsAdmin({ ...session, role: "support" }, backup, { restore: jsonStore.restoreBackup, audit: repositories.writeAudit })).rejects.toMatchObject({ status: 403 });
    await restoreBackupAsAdmin(session, backup, { restore: jsonStore.restoreBackup, audit: repositories.writeAudit });
    expect(await database.getStore("imports/mappings.json")).toEqual(mapping);
    expect((await database.getStore<Array<{ action: string }>>("audit/audit-log.json"))![0].action).toBe("restore");
    for (let n = 0; n < 3; n++) {
      for (const target of ["core/tickets.json", "core/ticket-history.json", "audit/audit-log.json"]) seed(target, []);
      const backups = await jsonStore.captureExternalImportBackups(`synthetic-import-${n}`); expect(backups).toHaveLength(3);
      await repositories.writeAudit({ action: "import", entity: "ticket", entityId: `synthetic-${n}`, actor: session.username, details: {} });
      await repositories.restoreImportedCoreDataBackup(backups);
      expect(await database.getStore("audit/audit-log.json")).toEqual([]);
      for (const path of backups) expect((await archive.verifySnapshot(path)).relatedImportBatchIds).toEqual([`synthetic-import-${n}`]);
    }
    const current = await database.getVersionedStore("imports/mappings.json");
    await expect(jsonStore.restoreBackup("backups/imports/mappings-1700000000000-deadbeef.json")).rejects.toThrow();
    const broken = await archive.saveSnapshot({ ...input(9999), backupPath: "backups/imports/mappings-1700000009999-deadbeef.json", json: JSON.stringify(mapping), createdAt: new Date(1700000009999).toISOString() });
    const corrupt = Buffer.from(await (await archive.options.client.send(new GetObjectCommand({ Bucket: bucket, Key: broken.storageLocation }))).Body!.transformToByteArray()); corrupt[corrupt.length - 1] ^= 1;
    await archive.options.client.send(new PutObjectCommand({ Bucket: bucket, Key: broken.storageLocation, Body: corrupt }));
    await expect(jsonStore.restoreBackup(broken.backupPath)).rejects.toThrow("authenticated");
    expect(await database.getVersionedStore("imports/mappings.json")).toEqual(current);
    await jsonStore.writeJsonAtomic("core/tickets.json", [], types.ticketListSchema);
    expect(await database.listStoreKeys("backups/")).toEqual([]);
    evidence.settingsAndImportRollback = { adminRestore: true, deniedNonAdmin: true, databaseAudit: true, completedSyntheticBatchRollbacks: 3, missingAndCorruptFailClosed: true, postgresSnapshots: 0 };
    vi.unstubAllEnvs(); vi.doUnmock("../store");
  }, 60000);
});
