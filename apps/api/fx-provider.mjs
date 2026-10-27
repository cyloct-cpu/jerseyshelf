import { readFileSync,writeFileSync,existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes,createCipheriv,createDecipheriv } from 'node:crypto';
import { config } from './config.mjs';
import { db,putSetting,transaction } from './db.mjs';
import { InputError } from '../../packages/contracts/validation.mjs';
import { parseLiveRates } from '../../packages/contracts/live-rates.mjs';
import { execFile } from 'node:child_process';
const keyFile=path.join(path.dirname(config.dbPath),'fx-credentials.key');
function secretKey(create=false){if(!existsSync(keyFile)){if(!create)throw new Error('汇率密钥文件缺失');writeFileSync(keyFile,randomBytes(32),{mode:0o600});}return readFileSync(keyFile);}
function seal(value){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secretKey(true),iv),data=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');}
function unseal(value){try{const data=Buffer.from(value,'base64'),decipher=createDecipheriv('aes-256-gcm',secretKey(),data.subarray(0,12));decipher.setAuthTag(data.subarray(12,28));return Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8');}catch{throw new InputError('实时汇率密钥无法读取，请在后台重新配置',503);}}
function storedConfig(){const row=db.prepare("SELECT value FROM settings WHERE key='fx_config'").get();return row?JSON.parse(row.value):{};}
export function fxConfig(){const stored=storedConfig(),mode=stored.mode||process.env.FX_MODE||'reference';return {mode,provider:mode==='live'?'currencylayer':'frankfurter',pollSeconds:mode==='live'?60:86400,apiKey:process.env.FX_API_KEY||(stored.secret?unseal(stored.secret):'')};}
let snapshotValue,snapshotData;
export function liveSnapshot(){const row=db.prepare("SELECT value FROM settings WHERE key='live_exchange_rates'").get();if(!row)return null;if(row.value!==snapshotValue){snapshotValue=row.value;snapshotData=JSON.parse(row.value);}return snapshotData;}
export function fxStatus(){const stored=storedConfig(),snapshot=liveSnapshot(),mode=stored.mode||process.env.FX_MODE||'reference';const metaRow=db.prepare("SELECT value FROM settings WHERE key='exchange_rates_meta'").get(),meta=metaRow?JSON.parse(metaRow.value):{};return {mode,provider:mode==='live'?'currencylayer':'frankfurter',referenceProvider:meta.provider||'Frankfurter',pollSeconds:mode==='live'?60:86400,keyConfigured:!!(process.env.FX_API_KEY||stored.secret),timestamp:snapshot?.timestamp||null,fresh:!!(snapshot&&Date.now()-snapshot.timestamp*1000<=120000),lastError:lastError||'',referenceUpdatedAt:meta.fetchedAt||null,referenceDate:meta.latestDate||null};}
export async function fetchLiveSnapshot(apiKey,fetcher=fetch){
  if(!apiKey)throw new InputError('尚未配置实时汇率API密钥',400);
  const url=new URL('https://api.currencylayer.com/live');url.searchParams.set('access_key',apiKey);
  let payload;try{const response=await fetcher(url,{signal:AbortSignal.timeout(8000),redirect:'error'});if(!response.ok)throw new Error();payload=await response.json();}
  catch{
    if(process.platform!=='win32'||fetcher!==fetch)throw new InputError('实时汇率服务连接失败，请检查网络和API配置',503);
    try{const raw=await new Promise((resolve,reject)=>{const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',"$fxUrl=[Console]::In.ReadToEnd(); Invoke-RestMethod -Uri $fxUrl -TimeoutSec 15 | ConvertTo-Json -Depth 5 -Compress"],{windowsHide:true,timeout:20000,maxBuffer:1024*1024},(error,stdout)=>error?reject(new Error()):resolve(stdout));child.stdin.on('error',()=>{});child.stdin.end(url.href);});payload=JSON.parse(raw);}catch{throw new InputError('实时汇率服务连接失败，请检查网络和API配置',503);}
  }
  try{return parseLiveRates(payload);}catch(err){throw new InputError(err.message,503);}
}
let pending=null,lastError='',lastAttempt=0;
export async function ensureLiveRates(force=false){
  if(fxStatus().mode!=='live')return null;const cfg=fxConfig();
  const cached=liveSnapshot();if(!force&&cached&&Date.now()-cached.fetchedAt<60000&&Date.now()-cached.timestamp*1000<=120000)return cached;
  if(pending)return pending;
  if(!force&&lastError&&Date.now()-lastAttempt<15000){if(cached&&Date.now()-cached.timestamp*1000<=120000)return cached;throw new InputError(lastError,503);}
  lastAttempt=Date.now();pending=(async()=>{try{const snapshot=await fetchLiveSnapshot(cfg.apiKey);putSetting('live_exchange_rates',snapshot);lastError='';return snapshot;}catch(err){lastError=err.message;if(!force&&cached&&Date.now()-cached.timestamp*1000<=120000)return cached;throw err;}finally{pending=null;}})();return pending;
}
export async function saveFxConfig(input){
  if(!['reference','live'].includes(input.mode)||!['frankfurter','currencylayer'].includes(input.provider)||(input.mode==='live'&&input.provider!=='currencylayer'))throw new InputError('汇率配置无效');
  const old=storedConfig(),typed=String(input.api_key||'').trim();
  if(typed&&input.clear_key==='1')throw new InputError('填写新密钥和删除密钥不能同时选择');
  if(typed&&(!/^[A-Za-z0-9_-]{16,256}$/.test(typed)))throw new InputError('API密钥格式无效');
  const secret=input.clear_key==='1'?'':typed?seal(typed):old.secret||'';
  const needsKey=input.mode==='live'||(input.intent==='test'&&input.provider==='currencylayer');
  const key=needsKey?(process.env.FX_API_KEY||(typed|| (secret?unseal(secret):''))):'';
  let snapshot=null;
  if((input.intent==='test'&&input.provider==='currencylayer')||input.mode==='live')snapshot=await fetchLiveSnapshot(key);
  if(input.intent==='test'&&input.provider==='frankfurter'){const {refreshReferenceRates}=await import('./currencies.mjs');const count=await refreshReferenceRates();return {tested:true,reference:true,count};}
  if(input.intent==='test')return {tested:true,timestamp:snapshot.timestamp};
  transaction(()=>{putSetting('fx_config',{mode:input.mode,provider:input.mode==='live'?'currencylayer':'frankfurter',pollSeconds:input.mode==='live'?60:86400,secret});if(snapshot)putSetting('live_exchange_rates',snapshot);});lastError='';lastAttempt=0;
  return {tested:false};
}
