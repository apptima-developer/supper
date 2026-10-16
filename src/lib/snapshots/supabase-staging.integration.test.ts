import { it, expect } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { parse } from "dotenv";
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createS3SnapshotStore } from "./s3-config";
import { sha256, SnapshotNotFoundError } from "./store";

it.skipIf(process.env.SUPPER_PHASE04B_INTEGRATION !== "1")("validates only synthetic Supabase staging objects and cleans its own namespace", async () => {
  const env = parse(await readFile(".env.supper-staging.local"));
  const endpoint = new URL(env.SUPPER_S3_ENDPOINT);
  // Owner supplied this endpoint in the staging-only file; never select application env credentials.
  expect(endpoint.protocol === "https:" && endpoint.hostname.endsWith(".storage.supabase.co") && endpoint.pathname === "/storage/v1/s3" && !endpoint.search && !endpoint.username && !endpoint.password && !endpoint.hash).toBe(true);
  expect(env.SUPPER_S3_BUCKET === "supper-snapshots-staging" && env.SUPPER_S3_REGION === "ap-southeast-1").toBe(true);
  const prefix = `phase04b-synthetic/${randomUUID()}`;
  const store = createS3SnapshotStore({ ...env, NODE_ENV: "test", SUPPER_S3_PATH_STYLE: "1", SUPPER_S3_PREFIX: prefix, SUPPER_SNAPSHOT_ACTIVE_KEY_ID: "synthetic-v1", SUPPER_SNAPSHOT_KEYS_JSON: JSON.stringify({ "synthetic-v1": randomBytes(32).toString("base64") }) });
  const client: S3Client = store.options.client;
  const Bucket = "supper-snapshots-staging";
  const evidence: Record<string, unknown> = { timestamp: new Date().toISOString(), syntheticOnly: true, bucket: Bucket, region: env.SUPPER_S3_REGION, prefix, endpointPath: endpoint.pathname, pathStyle: true, sdkMaxAttempts: 1, productionAccess: false, historicalUploads: 0, disposition: "SUPABASE_S3_STAGING_UNCERTAIN" };
  const send = (command: PutObjectCommand) => client.send(command, { abortSignal: AbortSignal.timeout(15000) });
  const get = async (Key: string) => Buffer.from(await (await client.send(new GetObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(15000) })).Body!.transformToByteArray());
  const status = (e: unknown) => (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  try {
    await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix + "/", MaxKeys: 1 }), { abortSignal: AbortSignal.timeout(15000) });
    evidence.authenticatedList = true;
    const Key = `${prefix}/conditional-probe`;
    await send(new PutObjectCommand({ Bucket, Key, Body: "synthetic-original", Metadata: { purpose: "phase04b-synthetic" }, IfNoneMatch: "*" }));
    const head = await client.send(new HeadObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(15000) });
    expect(head.Metadata?.purpose).toBe("phase04b-synthetic");
    expect((await get(Key)).toString()).toBe("synthetic-original");
    evidence.putGetHeadMetadata = true;
    let rejection: number | undefined;
    try { await send(new PutObjectCommand({ Bucket, Key, Body: "synthetic-replacement", IfNoneMatch: "*" })); } catch (e) { rejection = status(e); }
    const unchanged = (await get(Key)).toString() === "synthetic-original";
    evidence.conditionalDuplicate = { status: rejection ?? null, originalUnchanged: unchanged };
    if (rejection !== 412 || !unchanged) { evidence.disposition = "SUPABASE_S3_STAGING_INCOMPATIBLE"; return; }
    const raceKey = `${prefix}/race`;
    const results = await Promise.all(Array.from({ length: 8 }, async (_, n) => {
      try { await send(new PutObjectCommand({ Bucket, Key: raceKey, Body: `synthetic-${n}`, IfNoneMatch: "*" })); return 200; } catch (e) { return status(e) ?? 0; }
    }));
    evidence.conditionalRace = { successes: results.filter(s => s === 200).length, rejected412: results.filter(s => s === 412).length, statuses: results };
    if (results.filter(s => s === 200).length !== 1 || results.filter(s => s === 412).length !== 7) { evidence.disposition = "SUPABASE_S3_STAGING_INCOMPATIBLE"; return; }
    const input = { backupPath: "backups/core/tickets-1700000000000-aabbccdd.json", json: JSON.stringify([{ id: "phase04b-synthetic", subject: "ทดสอบ synthetic only" }]), createdAt: "2023-11-14T22:13:20.000Z", sourceVersion: "synthetic-v1", category: "automatic" as const, relatedImportBatchIds: [] };
    const saved = await store.saveSnapshot(input);
    expect(saved.checksum).toBe(sha256(input.json));
    expect((await store.getSnapshot(input.backupPath)).json).toBe(input.json);
    expect(await store.getSnapshotMetadata(input.backupPath)).toEqual(saved);
    expect(await store.saveSnapshot(input)).toEqual(saved);
    await expect(store.saveSnapshot({ ...input, json: "[]" })).rejects.toThrow("Immutable snapshot conflict");
    expect(await store.listSnapshots()).toHaveLength(1);
    const catalog = await store.publishRecoveryManifest([input.backupPath]);
    await store.getRecoveryManifest(catalog.key);
    await expect(store.getSnapshot("backups/core/tickets-1700000000001-aabbccdd.json")).rejects.toBeInstanceOf(SnapshotNotFoundError);
    evidence.snapshotRoundtripHashMetadataIdempotencyConflictListCatalogMissing = true;
    evidence.disposition = "SUPABASE_S3_STAGING_COMPATIBLE";
  } catch (e) {
    // Persist only sanitized status/category, never SDK request details or credentials.
    evidence.failure = { status: status(e) ?? null, category: e instanceof SnapshotNotFoundError ? "missing-object" : "provider-or-contract-failure" };
  } finally {
    try {
      let token: string | undefined;
      const keys: string[] = [];
      do {
        const page = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix + "/", ContinuationToken: token }), { abortSignal: AbortSignal.timeout(15000) });
        for (const object of page.Contents ?? []) if (object.Key?.startsWith(prefix + "/")) keys.push(object.Key);
        token = page.NextContinuationToken;
      } while (token);
      for (const Key of keys) await client.send(new DeleteObjectCommand({ Bucket, Key }), { abortSignal: AbortSignal.timeout(15000) });
      const remaining = await client.send(new ListObjectsV2Command({ Bucket, Prefix: prefix + "/" }), { abortSignal: AbortSignal.timeout(15000) });
      evidence.cleanup = { deleted: keys.length, remaining: remaining.Contents?.length ?? 0 };
      if (remaining.Contents?.length) evidence.disposition = "SUPABASE_S3_STAGING_UNCERTAIN";
    } catch { evidence.cleanup = "FAILED"; evidence.disposition = "SUPABASE_S3_STAGING_UNCERTAIN"; }
    client.destroy();
    await writeFile("docs/recovery/PHASE04B_PROVIDER_EVIDENCE.json", JSON.stringify(evidence, null, 2) + "\n");
  }
}, 180000);
