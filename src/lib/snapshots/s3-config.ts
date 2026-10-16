import "server-only";
import { S3Client } from "@aws-sdk/client-s3";
import { S3SnapshotStore } from "./s3";

export function createS3SnapshotStore(env: Record<string, string | undefined>) {
  const required = (key: string) => { const value = env[key]; if (!value) throw new Error(`Missing server snapshot setting: ${key}`); return value; };
  const endpoint = new URL(required("SUPPER_S3_ENDPOINT"));
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  const allowedPath = endpoint.pathname === "/" || (endpoint.hostname.endsWith(".storage.supabase.co") && endpoint.pathname === "/storage/v1/s3");
  if (endpoint.username || endpoint.password || !allowedPath || endpoint.search || endpoint.hash || (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && local && env.NODE_ENV === "test"))) throw new Error("Snapshot storage requires TLS; HTTP is restricted to localhost tests");
  const encoded: unknown = JSON.parse(required("SUPPER_SNAPSHOT_KEYS_JSON"));
  if (!encoded || typeof encoded !== "object" || Array.isArray(encoded)) throw new Error("Invalid server snapshot keyring");
  const keys = Object.fromEntries(Object.entries(encoded).map(([id, key]) => {
    if (typeof key !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(key)) throw new Error("Invalid base64 snapshot key");
    const bytes = Buffer.from(key, "base64"); if (bytes.toString("base64") !== key) throw new Error("Invalid base64 snapshot key");
    return [id, bytes];
  }));
  const client = new S3Client({ endpoint: endpoint.href, region: required("SUPPER_S3_REGION"), credentials: { accessKeyId: required("SUPPER_S3_ACCESS_KEY_ID"), secretAccessKey: required("SUPPER_S3_SECRET_ACCESS_KEY") }, forcePathStyle: env.SUPPER_S3_PATH_STYLE === "1", maxAttempts: 1, requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED" });
  return new S3SnapshotStore({ client, bucket: required("SUPPER_S3_BUCKET"), prefix: required("SUPPER_S3_PREFIX"), keyring: { activeKeyId: required("SUPPER_SNAPSHOT_ACTIVE_KEY_ID"), keys } });
}
