import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parse } from 'dotenv';
const repo=process.cwd(),dir=path.join(os.homedir(),'Library/Application Support/SUPPER/ops');
if(Intl.DateTimeFormat().resolvedOptions().timeZone!=='Asia/Bangkok')throw Error('Set Mac timezone to Asia/Bangkok before installing calendar jobs');
await fs.mkdir(dir,{recursive:true,mode:0o700});await fs.chmod(dir,0o700);
for(const file of ['package.json','run.mjs','policy.mjs','policy.test.mjs','mail.py','supabase-ca.crt'])await fs.copyFile(path.join(repo,'scripts/ops',file),path.join(dir,file));
const config=path.join(dir,'production.env');
try{await fs.access(config);}catch{
 const source=parse(await fs.readFile('/Volumes/Vault/atm/supper/03 - source code & scripts/supper/.env.supper-production.local'));
 const values={NEXT_PUBLIC_SUPABASE_URL:source.NEXT_PUBLIC_SUPABASE_URL,DATABASE_URL:source.DATABASE_URL,CAPACITY_MB:'500',WARNING_PERCENT:'80',SMTP_HOST:'',SMTP_PORT:'587',SMTP_USERNAME:'',SMTP_PASSWORD:'',SMTP_FROM:''};
 await fs.writeFile(config,Object.entries(values).map(([k,v])=>`${k}=${JSON.stringify(v)}`).join('\n')+'\n',{mode:0o600,flag:'wx'});
}
execFileSync('npm',['install','--omit=dev','--ignore-scripts','--no-audit','--no-fund'],{cwd:dir,stdio:'pipe'});
await fs.copyFile(path.join(dir,'package-lock.json'),path.join(repo,'scripts/ops/package-lock.json'));
const agents=path.join(os.homedir(),'Library/LaunchAgents');await fs.mkdir(agents,{recursive:true});
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');
for(const [suffix,mode,calendar]of [['backup','backup','<key>Weekday</key><integer>0</integer><key>Hour</key><integer>2</integer><key>Minute</key><integer>30</integer>'],['capacity','monitor','<key>Hour</key><integer>3</integer><key>Minute</key><integer>0</integer>']]){
 const label='com.supper.ops.'+suffix,file=path.join(agents,label+'.plist');
 const plist=`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array><string>${escape(process.execPath)}</string><string>${escape(path.join(dir,'run.mjs'))}</string><string>${mode}</string></array><key>WorkingDirectory</key><string>${escape(dir)}</string><key>StartCalendarInterval</key><dict>${calendar}</dict><key>EnvironmentVariables</key><dict><key>TZ</key><string>Asia/Bangkok</string><key>PATH</key><string>/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict><key>StandardOutPath</key><string>${escape(path.join(dir,'launchd-'+suffix+'.out.log'))}</string><key>StandardErrorPath</key><string>${escape(path.join(dir,'launchd-'+suffix+'.err.log'))}</string><key>ProcessType</key><string>Background</string></dict></plist>`;
 await fs.writeFile(file,plist,{mode:0o600});execFileSync('/usr/bin/plutil',['-lint',file]);
 try{execFileSync('/bin/launchctl',['bootout',`gui/${process.getuid()}/${label}`],{stdio:'pipe'});}catch{}
 execFileSync('/bin/launchctl',['bootstrap',`gui/${process.getuid()}`,file],{stdio:'pipe'});
 console.log('Installed '+label);
}
console.log('Private config/log directory: '+dir);
