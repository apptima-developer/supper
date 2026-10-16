import { expect, it } from "vitest";
import { createS3SnapshotStore } from "./s3-config";
import { externalSnapshotStore } from "./runtime";
import { randomBytes } from "node:crypto";
const settings = () => ({ NODE_ENV: "test", SUPPER_S3_ENDPOINT: "http://127.0.0.1:19000", SUPPER_S3_REGION: "us-east-1", SUPPER_S3_ACCESS_KEY_ID: "synthetic-access", SUPPER_S3_SECRET_ACCESS_KEY: "synthetic-secret", SUPPER_S3_BUCKET: "synthetic-snapshots", SUPPER_S3_PREFIX: "phase04a", SUPPER_SNAPSHOT_ACTIVE_KEY_ID: "test", SUPPER_SNAPSHOT_KEYS_JSON: JSON.stringify({ test: randomBytes(32).toString("base64") }) });
it("requires private server credentials, TLS outside localhost tests and a complete encryption keyring", () => {
  expect(createS3SnapshotStore(settings()).provider).toBe("s3-compatible");
  expect(() => createS3SnapshotStore({ ...settings(), NODE_ENV: "production" })).toThrow("TLS");
  expect(() => createS3SnapshotStore({ ...settings(), SUPPER_S3_ENDPOINT: "http://remote.example.test" })).toThrow("TLS");
  expect(() => createS3SnapshotStore({ ...settings(), SUPPER_S3_ENDPOINT: "https://user:secret@remote.example.test" })).toThrow("TLS");
  expect(() => createS3SnapshotStore({ ...settings(), SUPPER_S3_SECRET_ACCESS_KEY: "" })).toThrow("Missing server");
  expect(() => createS3SnapshotStore({ ...settings(), SUPPER_SNAPSHOT_KEYS_JSON: '{}' })).toThrow("keyring");
  expect(() => createS3SnapshotStore({ ...settings(), SUPPER_S3_PREFIX: "../unsafe" })).toThrow("bucket/prefix");
});
it("keeps production/Vercel activation blocked and permits only synthetic localhost remote tests", () => {
  const env = { ...settings(), SUPPER_EXTERNAL_SNAPSHOTS: "1", SUPPER_SNAPSHOT_PROVIDER: "s3", NEXT_PUBLIC_SUPABASE_URL: "http://127.0.0.1:54321" };
  expect(externalSnapshotStore(env)).toBeInstanceOf((createS3SnapshotStore(env)).constructor);
  expect(externalSnapshotStore(env)).toBe(externalSnapshotStore(env));
  expect(() => externalSnapshotStore({ ...env, VERCEL: "1" })).toThrow("restricted");
  expect(() => externalSnapshotStore({ ...env, NODE_ENV: "production" })).toThrow("restricted");
  expect(() => externalSnapshotStore({ ...env, SUPPER_S3_ENDPOINT: "https://remote.example.test" })).toThrow("synthetic localhost");
});

it("accepts the Supabase S3 service path without accepting arbitrary endpoint paths", () => {
  const store = createS3SnapshotStore({ ...settings(), SUPPER_S3_ENDPOINT: "https://synthetic.storage.supabase.co/storage/v1/s3", SUPPER_S3_PATH_STYLE: "1" });
  expect(store.provider).toBe("s3-compatible");
  store.options.client.destroy();
  for (const endpoint of ["https://remote.example.test/storage/v1/s3", "https://synthetic.storage.supabase.co/other", "https://synthetic.storage.supabase.co/storage/v1/s3?secret=x"]) {
    expect(() => createS3SnapshotStore({ ...settings(), SUPPER_S3_ENDPOINT: endpoint })).toThrow("TLS");
  }
});
