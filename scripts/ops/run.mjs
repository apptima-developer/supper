import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { parse } from 'dotenv';
import pg from 'pg';
import { capacityStatus } from './policy.mjs';
const home=path.dirname(fileURLToPath(import.meta.url));
const repo='/Volumes/Vault/atm/supper/.integration/supper-ai-development';
const vault='/Volumes/Vault/storage/supper';
const project='gpzmmxckiywkdqxqlkct';
const mode=process.argv[2];
if(!['backup','monitor','notify-test','simulate-vault-unavailable'].includes(mode))throw new Error('Use backup|monitor|notify-test|simulate-vault-unavailable');
await fs.mkdir(home,{recursive:true,mode:0o700});
const log=async entry=>{await fs.appendFile(path.join(home,'operations.jsonl'),JSON.stringify({timestamp:new Date().toISOString(),...entry})+'\n',{mode:0o600});};
const lock=path.join(home,'running.lock');let handle;
let client;let available=false;let stage='configuration';
try {
 const configFile=path.join(home,'production.env');const stat=await fs.lstat(configFile);
 if(stat.isSymbolicLink()||(stat.mode&0o077))throw Error('Unsafe configuration');
 const env=parse(await fs.readFile(configFile));
 const notify=async(subject,body)=>{
  await log({mode,event:'notification_attempt',subject});
  const result=await child('/usr/bin/python3',[path.join(home,'mail.py')],JSON.stringify({subject,body}),{...process.env,...env});
  const accepted=result.code===0&&result.stdout.trim()==='EMAIL_ACCEPTED';
  await log({mode,event:'notification_result',result:accepted?'SMTP_ACCEPTED':result.stdout.trim()==='EMAIL_NOT_CONFIGURED'?'EMAIL_NOT_CONFIGURED':'EMAIL_DELIVERY_FAILED'});
  return accepted;
 };
 // Failure alerts must work while Vault and the repository are absent.
 const guard=async()=>{const [volume,parent,root]=await Promise.all([fs.stat('/Volumes/Vault'),fs.stat('/Volumes'),fs.lstat(vault)]);if(volume.dev===parent.dev||!root.isDirectory()||root.isSymbolicLink()||await fs.realpath(vault)!==vault)throw Error('Unavailable Vault');await fs.access(path.join(vault,'snapshot-archives/local-vault'));};
 await log({mode,event:'start'});
 if(mode==='notify-test'){stage='Email delivery';if(!await notify('[SUPPER] Operations notification test','SUPPER Production operational email test. No business data or credentials included. Timestamp: '+new Date().toISOString()))throw Error('Notification not delivered');}
 else {
  try {
   stage='JOB_LOCKED: inspect previous operation';handle=await fs.open(lock,'wx',0o600);
   stage='Vault unavailable';if(mode==='simulate-vault-unavailable')throw Error('Controlled unavailable simulation');
   if(mode!=='monitor'){await guard();available=true;}
   stage='Production database connection';const url=new URL(env.DATABASE_URL);
   if(!['postgres:','postgresql:'].includes(url.protocol)||!['aws-0-ap-southeast-1.pooler.supabase.com','db.'+project+'.supabase.co'].includes(url.hostname))throw Error('Wrong database endpoint');
   url.search=''; // Explicit TLS settings must not be overridden by URI query options.
   if(new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname!==project+'.supabase.co'||!(decodeURIComponent(url.username)==='postgres.'+project||url.hostname==='db.'+project+'.supabase.co'))throw Error('Wrong Production identity');
   client=new pg.Client({connectionString:url.toString(),ssl:{rejectUnauthorized:true,ca:await fs.readFile(path.join(home,'supabase-ca.crt'))},connectionTimeoutMillis:20000,statement_timeout:60000});await client.connect();
   await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   if(mode==='monitor'){
    stage='Database capacity measurement';const {rows}=await client.query('SELECT pg_database_size(current_database())::text bytes');await client.query('COMMIT');
    let state={warned:false};try{state=JSON.parse(await fs.readFile(path.join(home,'capacity-state.json')));}catch(e){if(e.code!=='ENOENT')throw e;}
    const result=capacityStatus(Number(rows[0].bytes),Number(env.CAPACITY_MB||500),Number(env.WARNING_PERCENT||80),state.warned===true);
    let delivered=true;if(result.sendAlert)delivered=await notify('[SUPPER] Production Database Capacity Warning',`SUPPER Production\nDatabase: ${(result.databaseBytes/1e6).toFixed(2)} MB / ${result.capacityMb} MB\nUsage: ${result.usagePercent.toFixed(2)}%\nWarning threshold: ${result.warningPercent}%\nTimestamp: ${new Date().toISOString()}\nReview database growth before capacity exhaustion.`);
    // A failed notification stays armed and is retried on the next daily check.
    const next={warned:result.warned&&delivered};await fs.writeFile(path.join(home,'capacity-state.tmp'),JSON.stringify(next),{mode:0o600});await fs.rename(path.join(home,'capacity-state.tmp'),path.join(home,'capacity-state.json'));
    await log({mode,event:'capacity',...result,notificationDelivered:result.sendAlert?delivered:null});console.log(JSON.stringify(result));if(!delivered)throw Error('Capacity notification failed');
   } else {
    stage='Production capture';const base=await fs.readFile(path.join(repo,'scripts/supabase-relational-schema.sql'),'utf8');const versions=(await client.query('SELECT version FROM public.support_schema_migrations ORDER BY version')).rows.map(r=>r.version);const known=(await fs.readdir(path.join(repo,'supabase/migrations'))).filter(f=>f.endsWith('.sql'));
    if(versions.some(v=>!known.some(f=>f.startsWith(v+'_'))))throw Error('Unknown migration');
    const tables=new Set([...base.matchAll(/create table if not exists public\.(\w+)/gi)].map(m=>m[1]));
    for(const f of known.filter(f=>versions.includes(f.split('_')[0])))for(const m of (await fs.readFile(path.join(repo,'supabase/migrations',f),'utf8')).matchAll(/create\s+table\s+if\s+not\s+exists\s+public\.(\w+)/gi))if(!['support_schema_migrations','support_login_rate_limits'].includes(m[1]))tables.add(m[1]);
    if(tables.size!==30)throw Error('Review changed business table coverage');tables.add('app_store');
    const state={};for(const table of tables){if(!/^[a-z_]+$/.test(table))throw Error('Unsafe identifier');state[table]=(await client.query(`SELECT * FROM public.${table}`)).rows;}
    if(!state.support_tickets.length||!state.support_users.length)throw Error('Incomplete business state');await client.query('COMMIT');await guard();
    stage='Vault save/integrity';const result=await child(process.execPath,[path.join(repo,'scripts/ops/vault-save.mjs')],JSON.stringify({version:1,backend:'supabase-relational',project,capturedAt:new Date().toISOString(),appliedMigrationVersions:versions,tables:state}),{...process.env,NODE_ENV:'production'},repo);
    if(result.code!==0)throw Error('Vault capture failed');const saved=JSON.parse(result.stdout.trim());await log({mode,event:'snapshot',...saved,tableCounts:Object.fromEntries(Object.entries(state).map(([k,v])=>[k,v.length]))});console.log(JSON.stringify(saved));
   }
  } catch {
   if(mode!=='monitor')await notify('[SUPPER] Weekly Production Backup Failed',`SUPPER Production backup failed\nTimestamp: ${new Date().toISOString()}\nReason: ${stage}\nVault available: ${available}\nProduction modified: no\n${mode==='simulate-vault-unavailable'?'Controlled failure-path test.':''}`);
   throw Error(stage);
  }
 }
 await log({mode,result:'PASS'});
} catch {await log({mode,result:'FAIL',reason:stage,productionModified:false});console.error('OPS_FAILED: '+stage);process.exitCode=1;}
finally {if(client)await client.end().catch(()=>{});if(handle){await handle.close();await fs.unlink(lock);}}
function child(command,args,input,env,cwd=home){return new Promise(resolve=>{const c=spawn(command,args,{env,cwd,stdio:['pipe','pipe','pipe']});let stdout='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',()=>{});c.on('error',()=>resolve({code:1,stdout:''}));c.on('close',code=>resolve({code,stdout}));c.stdin.on('error',()=>{});c.stdin.end(input);});}
