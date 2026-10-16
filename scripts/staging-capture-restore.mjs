// One explicit staging-only capture/restore validation; no scheduling, prune or remote writes.
import { createServer } from "vite";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse } from "dotenv";
import assert from "node:assert/strict";
const server = await createServer({ configFile: false, server: { middlewareMode: true }, appType: "custom" });
let step = "configuration";
try {
  assert(process.argv[2] === "--staging-only", "Explicit staging-only invocation required");
  const env = parse(await readFile(".env.supper-staging.local"));
  const url = new URL(env.NEXT_PUBLIC_SUPABASE_URL), s3 = new URL(env.SUPPER_S3_ENDPOINT);
  assert(url.protocol === "https:" && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash);
  assert(/^[a-z0-9]+\.supabase\.co$/.test(url.hostname));
  // S3 config is used only as the Owner-approved staging project identity anchor, never for storage.
  assert(s3.hostname === url.hostname.replace(".supabase.co", ".storage.supabase.co") && env.SUPPER_S3_BUCKET === "supper-snapshots-staging");
  assert(env.SUPABASE_SERVICE_ROLE_KEY);
  const { VaultAuthority, VAULT_ROOT } = await server.ssrLoadModule("/src/lib/snapshots/vault.ts");
  const { serializeSnapshot, sha256 } = await server.ssrLoadModule("/src/lib/snapshots/store.ts");
  const { ticketListSchema } = await server.ssrLoadModule("/src/lib/types.ts");
  const { ticketEffortHours, ticketOwnerList, ticketSeverityLabel } = await server.ssrLoadModule("/src/lib/domain.ts");
  const vault = new VaultAuthority(); await vault.readiness();
  const captureSource = async () => {
    const response = await fetch(`${url.origin}/rest/v1/support_tickets?select=*&order=id.asc`, {
      headers: { apikey: env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`, Prefer: "count=exact", Range: "0-999" }, signal: AbortSignal.timeout(20000),
    });
    assert(response.ok);
    const rows = await response.json(); const total = Number(response.headers.get("content-range")?.split("/")[1]);
    assert(Array.isArray(rows) && rows.length > 0 && rows.length === total, "Incomplete or empty source");
    assert(new Set(rows.map(r => r.id)).size === rows.length);
    assert(rows.every(r => r.id === r.data?.id && r.issue_id === r.data?.issueId));
    assert(ticketListSchema.safeParse(rows.map(r => r.data)).success, "SUPPER ticket schema validation failed");
    return rows;
  };
  step = "source-read";
  const source = await captureSource();
  const sourceHash = sha256(serializeSnapshot(source));
  const json = serializeSnapshot(source.map(r => r.data));
  const started = new Date(), id = randomUUID(), backupPath = `backups/core/tickets-${started.getTime()}-${id}.json`;
  step = "vault-capture";
  const metadata = await vault.save({ backupPath, json, createdAt: started.toISOString(), sourceVersion: `supper-staging/public.support_tickets/${sourceHash}`, category: "manual", relatedImportBatchIds: [] });
  const verified = await vault.read(backupPath);
  assert(verified.json === json && metadata.checksum === sha256(json));
  const catalogName = `staging-capture-${id}`; await vault.catalog(catalogName,[backupPath]);
  const recovery = await vault.export(backupPath, `${catalogName}.json`);
  assert(sha256(await readFile(recovery.file)) === metadata.checksum);
  step = "isolated-restore";
  const database = `supper_staging_restore_${id.replaceAll("-", "")}`;
  const sql = (statement, create = false) => {
    assert(/^supper_staging_restore_[a-f0-9]{32}$/.test(database));
    if (create) assert(statement === `CREATE DATABASE ${database} TEMPLATE template0;`);
    return execFileSync("docker", ["exec","-i","supper-recovery-pg17","psql","-X","-qAt","-U","supper_recovery_admin","-d",create ? "postgres" : database,"-v","ON_ERROR_STOP=1"], { input: statement, encoding: "utf8", maxBuffer: 8*1024*1024, stdio: ["pipe","pipe","pipe"] }).trim();
  };
  sql(`CREATE DATABASE ${database} TEMPLATE template0;`,true);
  sql("CREATE TABLE public.app_store (key text PRIMARY KEY,value jsonb NOT NULL,updated_at timestamptz NOT NULL DEFAULT now());");
  assert(sql("SELECT count(*) FROM public.app_store;") === "0");
  // Restore ONLY from verified Vault export, not the in-memory source or a second API read.
  const exported = await readFile(recovery.file);
  sql(`INSERT INTO public.app_store(key,value) VALUES ('core/tickets.json',convert_from(decode('${exported.toString("hex")}','hex'),'UTF8')::jsonb);`);
  step = "restore-verification";
  const restored = JSON.parse(sql("BEGIN READ ONLY; SELECT value::text FROM public.app_store WHERE key='core/tickets.json'; ROLLBACK;"));
  const schema = ticketListSchema.safeParse(restored); assert(schema.success);
  const restoredHash = sha256(serializeSnapshot(restored)); assert(restoredHash === metadata.checksum);
  assert(restored.length === source.length);
  const lookupId = Buffer.from(restored[0].id).toString("hex");
  assert(sql(`BEGIN READ ONLY; SELECT count(*) FROM public.app_store,jsonb_array_elements(value) item WHERE key='core/tickets.json' AND item->>'id'=convert_from(decode('${lookupId}','hex'),'UTF8'); ROLLBACK;`) === "1");
  for(const ticket of schema.data) {
    assert(Number.isFinite(ticketEffortHours(ticket)));
    assert(Array.isArray(ticketOwnerList(ticket)));
    assert(typeof ticketSeverityLabel(ticket.severity) === "string");
  }
  step = "source-stability";
  assert(sha256(serializeSnapshot(await captureSource())) === sourceHash, "Source changed during capture validation");
  const evidence = {
    disposition: "STAGING_CAPTURE_RESTORE_READY", timestamp: new Date().toISOString(),
    source: { project: "supper-staging", urlSha256: sha256(url.origin), table: "public.support_tickets", projection: "data (all rows, ordered by relational id)", rowCount: source.length, fullRowDigest: sourceHash, unchangedAcrossValidation: true, access: "GET only" },
    snapshot: { backupPath, file: `${vault.activeRoot}/${metadata.storageLocation}`, manifest: `${vault.activeRoot}/${metadata.storageLocation.replace("snapshot.json.gz","manifest.json")}`, catalog: `${vault.activeRoot}/catalogs/${catalogName}.json`, checksum: metadata.checksum, compressedChecksum: metadata.compressedChecksum, compressedBytes: metadata.compressedBytes, uncompressedBytes: metadata.uncompressedBytes, export: recovery.file, category: "manual", integrity: "PASS" },
    restore: { container: "supper-recovery-pg17", database, table: "public.app_store", key: "core/tickets.json", method: "fresh isolated local PostgreSQL database, insert verified Vault export", rowCount: restored.length, canonicalHash: restoredHash, schemaValidation: true, exactBusinessDataEquality: true, lookupQuery: true, domainEffortOwnerSeverity: true, relationalSchemaReinstatement: false },
    productionMutation: false, stagingMutation: false, historicalSnapshotMutation: false, pruneInvoked: false,
    excluded: ["other SUPPER datasets/tables", "relational denormalized columns/indexes/policies (source digest recorded, business JSON restored)", "Supabase Auth/service schemas", "object storage and external attachments"],
  };
  step = "evidence";
  const privateRoot = `${VAULT_ROOT}/staging-capture-validation`; await vault.guard();
  try { await mkdir(privateRoot,{mode:0o700}); } catch(e) { if(e.code!=="EEXIST")throw e; }
  await vault.guard(privateRoot);
  await writeFile(`${privateRoot}/${id}.json`,JSON.stringify(evidence,null,2)+"\n",{flag:"wx",mode:0o600});
  await writeFile("docs/recovery/STAGING_CAPTURE_RESTORE_EVIDENCE.json",JSON.stringify(evidence,null,2)+"\n");
  console.log(JSON.stringify(evidence,null,2));
} catch {
  // Never log Supabase/SQL errors or assertion operands containing business data or credentials.
  console.error(`STAGING_CAPTURE_RESTORE_BLOCKED at ${step}; preserve any created Vault snapshot and isolated database for review`);process.exitCode=1;
} finally { await server.close(); }
