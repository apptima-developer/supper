// Explicit local staging capture; no production, scheduling, prune or remote writes.
import { createServer } from "vite";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parse } from "dotenv";
import assert from "node:assert/strict";
const server = await createServer({ configFile:false,server:{middlewareMode:true},appType:"custom" });
let step="config";
try {
  assert(process.argv[2]==="--staging-only");
  const env=parse(await readFile(".env.supper-staging.local"));
  const url=new URL(env.NEXT_PUBLIC_SUPABASE_URL),anchor=new URL(env.SUPPER_S3_ENDPOINT);
  assert(url.protocol==="https:"&&/^[a-z0-9]+\.supabase\.co$/.test(url.hostname)&&url.pathname==="/"&&!url.username&&!url.password&&!url.search&&!url.hash);
  assert(anchor.hostname===url.hostname.replace(".supabase.co",".storage.supabase.co")&&env.SUPPER_S3_BUCKET==="supper-snapshots-staging");
  assert(env.SUPABASE_SERVICE_ROLE_KEY);
  const {VaultAuthority}=await server.ssrLoadModule("/src/lib/snapshots/vault.ts");
  const {serializeSnapshot,sha256}=await server.ssrLoadModule("/src/lib/snapshots/store.ts");
  const types=await server.ssrLoadModule("/src/lib/types.ts");
  const vault=new VaultAuthority();await vault.readiness();
  const relationalSql=await readFile("scripts/supabase-relational-schema.sql","utf8");
  const migrationFiles=(await readdir("supabase/migrations")).filter(n=>n.endsWith(".sql")).sort();
  const headers={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,Prefer:"count=exact",Range:"0-999"};
  const migrationResponse=await fetch(`${url.origin}/rest/v1/support_schema_migrations?select=version&order=version`,{headers,signal:AbortSignal.timeout(20000)});assert(migrationResponse.ok);
  const applied=new Set((await migrationResponse.json()).map(r=>r.version));
  assert([...applied].every(v=>migrationFiles.some(f=>f.startsWith(v+"_"))),"Unknown staging schema revision");
  const appliedFiles=migrationFiles.filter(f=>applied.has(f.split("_")[0]));
  const tables=[...relationalSql.matchAll(/create table if not exists public\.(\w+)/g)].map(m=>m[1]);assert(tables.length===10);
  for(const file of appliedFiles) for(const match of (await readFile(`supabase/migrations/${file}`,"utf8")).matchAll(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi)) {
    if(!["support_schema_migrations","support_login_rate_limits"].includes(match[1])&&!tables.includes(match[1]))tables.push(match[1]);
  }
  const pending=migrationFiles.filter(f=>!applied.has(f.split("_")[0]));
  assert(pending.every(f=>f==="202607230001_servicenow_write_kernel.sql"),"Unreviewed pending migration");
  assert(env.SERVICENOW_WRITE_ENABLED!=="true"&&env.SERVICENOW_WRITE_ENABLED!=="1","Pending write kernel cannot be active");
  const orderFor=table=>table==="integration_sync_state"?"provider,stream":table==="support_master_data"?"kind":table==="support_report_assets"?"file_name":table==="app_store"?"key":"id";
  const schemas={support_customers:types.customerListSchema,support_tickets:types.ticketListSchema,support_ticket_history:types.historyListSchema,support_audit_log:types.auditListSchema,support_users:types.userListSchema,support_import_batches:types.importBatchListSchema,support_report_jobs:types.reportJobListSchema};
  const readTable=async table=>{
    const response=await fetch(`${url.origin}/rest/v1/${table}?select=*&order=${orderFor(table).split(",").map(k=>k+".asc").join(",")}`,{headers:{apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:`Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,Prefer:"count=exact",Range:"0-999"},signal:AbortSignal.timeout(20000)});
    assert(response.ok);const rows=await response.json();assert(Array.isArray(rows)&&rows.length===Number(response.headers.get("content-range")?.split("/")[1]),"Incomplete capture; explicit pagination required before larger source is supported");
    if(schemas[table])assert(schemas[table].safeParse(rows.map(r=>r.data)).success);
    if(table==="support_users")assert(rows.every(r=>Number.isInteger(r.auth_version)&&r.auth_version>=1));
    return rows;
  };
  const readState=async()=>{
    const state={};
    for(const table of [...tables,"app_store"])state[table]=await readTable(table);
    // Fail closed rather than silently capture unrelated or unsupported app_store keys.
    assert(state.app_store.every(r=>r.key==="imports/mappings.json"||r.key.startsWith("integrations/email-intakes/")||r.key.startsWith("backups/imports/mappings-")),"Review unexpected auxiliary app_store keys");
    return state;
  };
  step="source";const state=await readState();assert(state.support_tickets.length>0&&state.support_users.length>0);
  const stateHash=sha256(serializeSnapshot(state));
  const payload={version:1,backend:"supabase-relational",project:"supper-staging",tables:state};const json=serializeSnapshot(payload);
  const id=randomUUID(),now=new Date(),backupPath=`backups/recovery/business-state-${now.getTime()}-${id}.json`;
  step="vault";const metadata=await vault.save({backupPath,json,createdAt:now.toISOString(),sourceVersion:`supper-staging/business-state/${stateHash}`,category:"manual",relatedImportBatchIds:[]});
  assert((await vault.read(backupPath)).json===json);
  await vault.catalog(`staging-business-${id}`,[backupPath]);const exported=await vault.export(backupPath,`staging-business-${id}.json`);
  const restoredPayload=JSON.parse(await readFile(exported.file,"utf8"));assert(sha256(serializeSnapshot(restoredPayload))===metadata.checksum);
  step="restore";const database=`supper_staging_business_${id.replaceAll("-","")}`;
  const sql=(statement,create=false)=>{
    assert(/^supper_staging_business_[a-f0-9]{32}$/.test(database));if(create)assert(statement===`CREATE DATABASE ${database} TEMPLATE template0;`);
    return execFileSync("docker",["exec","-i","supper-recovery-pg17","psql","-X","-qAt","-U","supper_recovery_admin","-d",create?"postgres":database,"-v","ON_ERROR_STOP=1"],{input:statement,encoding:"utf8",maxBuffer:16*1024*1024,stdio:["pipe","pipe","pipe"]}).trim();
  };
  sql(`CREATE DATABASE ${database} TEMPLATE template0;`,true);
  sql(await readFile("scripts/supabase-app-store.sql","utf8"));sql(relationalSql);
  for(const name of appliedFiles)sql(await readFile(`supabase/migrations/${name}`,"utf8"));
  let inserts="BEGIN; SET LOCAL session_replication_role=replica;";
  for(const [table,rows] of Object.entries(restoredPayload.tables)){
    assert([...tables,"app_store"].includes(table));
    if(rows.length)inserts+=`INSERT INTO public.${table} SELECT * FROM jsonb_populate_recordset(null::public.${table},convert_from(decode('${Buffer.from(JSON.stringify(rows)).toString("hex")}','hex'),'UTF8')::jsonb);`;
  }
  sql(inserts+"COMMIT;");
  step="verify";
  const results={};
  for(const [table,original]of Object.entries(state)){
    const order=orderFor(table);
    const timestampColumns=new Set(JSON.parse(sql(`SELECT coalesce(json_agg(column_name),'[]') FROM information_schema.columns WHERE table_schema='public' AND table_name='${table}' AND data_type LIKE 'timestamp%';`)));
    const restored=JSON.parse(sql(`BEGIN READ ONLY; SELECT coalesce(json_agg(q),'[]') FROM (SELECT * FROM public.${table} ORDER BY ${order})q; ROLLBACK;`));
    // PostgreSQL renders timestamptz offsets differently; normalize only typed top-level timestamp columns.
    const canonicalRows=rows=>rows.map(r=>Object.fromEntries(Object.entries(r).map(([k,v])=>[k,typeof v==="string"&&timestampColumns.has(k)?new Date(v).toISOString():v])));
    assert(serializeSnapshot(canonicalRows(restored))===serializeSnapshot(canonicalRows(original)),"Restored rows differ");
    results[table]={rows:restored.length,allColumnsMatch:true,sha256:sha256(serializeSnapshot(canonicalRows(restored)))};
  }
  assert(sql("SELECT count(*) FROM public.support_tickets t JOIN public.support_customers c ON c.customer_key=t.customer_key;")===String(state.support_tickets.length));
  assert(sql("SELECT count(*) FROM public.support_ticket_history h JOIN public.support_tickets t ON t.id=h.ticket_id OR t.issue_id=h.issue_id;")===String(state.support_ticket_history.length));
  const users=JSON.parse(sql("SELECT coalesce(json_agg(q),'[]') FROM (SELECT data,auth_version FROM public.support_users)q;"));assert(types.userListSchema.safeParse(users.map(r=>({...r.data,authVersion:r.auth_version}))).success);assert(users.some(r=>r.data.active&&r.data.passwordHash));
  const foreignKeys=JSON.parse(sql(`SELECT coalesce(json_agg(q),'[]') FROM (
    SELECT con.conrelid::regclass::text child,con.confrelid::regclass::text parent,
    array_agg(ca.attname ORDER BY keys.n) child_cols,array_agg(pa.attname ORDER BY keys.n) parent_cols
    FROM pg_constraint con CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY keys(c,p,n)
    JOIN pg_attribute ca ON ca.attrelid=con.conrelid AND ca.attnum=keys.c
    JOIN pg_attribute pa ON pa.attrelid=con.confrelid AND pa.attnum=keys.p
    WHERE con.contype='f' AND con.connamespace='public'::regnamespace GROUP BY con.oid
  )q;`));
  for(const fk of foreignKeys){
    assert(/^[a-z_]+(?:\.[a-z_]+)?$/.test(fk.child)&&/^[a-z_]+(?:\.[a-z_]+)?$/.test(fk.parent));
    assert([...fk.child_cols,...fk.parent_cols].every(k=>/^[a-z_]+$/.test(k)));
    const nonnull=fk.child_cols.map(k=>`c.${k} IS NOT NULL`).join(" AND ");
    const join=fk.child_cols.map((k,n)=>`c.${k}=p.${fk.parent_cols[n]}`).join(" AND ");
    assert(sql(`SELECT count(*) FROM ${fk.child} c WHERE ${nonnull} AND NOT EXISTS(SELECT 1 FROM ${fk.parent} p WHERE ${join});`)==="0","Restored foreign-key dependency missing");
  }
  step="stability";assert(sha256(serializeSnapshot(await readState()))===stateHash);
  const evidence={timestamp:new Date().toISOString(),project:"supper-staging",urlSha256:sha256(url.origin),sourceDigest:stateHash,stableAcrossCapture:true,sourceReadOnly:true,snapshot:{backupPath,file:`${vault.activeRoot}/${metadata.storageLocation}`,manifest:`${vault.activeRoot}/${metadata.storageLocation.replace("snapshot.json.gz","manifest.json")}`,catalog:`${vault.activeRoot}/catalogs/staging-business-${id}.json`,export:exported.file,checksum:metadata.checksum,compressedChecksum:metadata.compressedChecksum,compressedBytes:metadata.compressedBytes,uncompressedBytes:metadata.uncompressedBytes},appliedMigrationVersions:[...applied],pendingDisabledMigrations:pending,restore:{database,foreignKeysVerified:foreignKeys.length,allBusinessRowsMatch:true,ticketCustomerJoin:true,historyTicketJoin:true,usersAndAuthVersion:true,tables:results},excluded:["Supabase managed schemas/Auth internals","support_login_rate_limits transient state","support_schema_migrations state reconstructed from versioned SQL","Monthly Report Factory local files are outside Supabase capture"],productionMutation:false,stagingMutation:false,pruneInvoked:false};
  await writeFile("docs/recovery/STAGING_BUSINESS_CAPTURE_EVIDENCE.json",JSON.stringify(evidence,null,2)+"\n");console.log(JSON.stringify(evidence,null,2));
}catch{console.error(`STAGING_BUSINESS_CAPTURE_BLOCKED at ${step}; preserve created artifacts; payload withheld`);process.exitCode=1;}
finally{await server.close();}
