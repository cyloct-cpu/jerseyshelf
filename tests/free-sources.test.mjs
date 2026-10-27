import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnTestServer} from './helpers/server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-fx-'+process.pid);
let child,base,db,currencies,tp,tprovider,log='';
class Client{cookies=new Map();csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body,location:r.headers.get('location')};}post(url,data={}){const form=new URLSearchParams({csrf:this.csrf});for(const [k,v] of Object.entries(data))for(const x of Array.isArray(v)?v:[v])form.append(k,x);return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});}}
const admin=new Client();
const ok=r=>assert.equal(r.status,303,r.body+'\n'+log);
const arrayPayload=[{date:'2026-10-25',base:'USD',quote:'EUR',rate:0.9},{date:'2026-10-25',base:'USD',quote:'JPY',rate:150},...Array.from({length:120},(_,i)=>({date:'2026-10-25',base:'USD',quote:'X'+String(i).padStart(2,'0'),rate:1+i}))];
const objectPayload={date:'2026-10-26',rates:Object.fromEntries([...Array.from({length:120},(_,i)=>['X'+String(i).padStart(2,'0'),1+i]),['EUR',0.91],['JPY',151]])};
before(async()=>{
  mkdirSync(dir,{recursive:true});
  ({child,base}=await spawnTestServer({root,dir,extraEnv:{ADMIN_EMAIL:'fx-admin@example.com',ADMIN_PASSWORD:'fx-password-1234567'}}));
  db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  process.env.DATABASE_PATH=path.join(dir,'store.sqlite');
  currencies=await import('../apps/api/currencies.mjs');
  tp=await import('../apps/api/translation-providers.mjs');
  tprovider=await import('../apps/api/translation-provider.mjs');
  await admin.get('/account');
  ok(await admin.post('/account/login',{email:'fx-admin@example.com',password:'fx-password-1234567'}));
  await admin.get('/admin');
});
after(async()=>{
  db?.close();
  try{(await import('../apps/api/db.mjs')).db.close();}catch{}
  if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}
  assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-fx-'));rmSync(dir,{recursive:true,force:true});
});

test('reference FX rotates to the next free source when one fails and records the winner',async()=>{
  const calls=[];
  const fetcher=async(url)=>{
    calls.push(String(url));
    if(String(url).includes('open.er-api'))throw new Error('boom');           // 源1失败
    if(String(url).includes('exchangerate-api'))return {ok:true,json:async()=>objectPayload}; // 源2成功（对象结构）
    return {ok:true,json:async()=>arrayPayload};
  };
  const count=await currencies.refreshReferenceRates(fetcher);
  assert.equal(count,102); // 120 个键中 i≥100 的 'X100' 等 4 位键被过滤：100 通用行 + EUR/JPY
  const meta=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='exchange_rates_meta'").get().value);
  assert.equal(meta.provider,'exchangerate-api');
  assert.deepEqual(calls.map(c=>c.includes('open.er-api')?'er':c.includes('exchangerate')?'era':'other'),['er','era']);
  assert.equal(currencies.currencyFx('JPY').source,'exchangerate-api');
  assert.equal(currencies.currencyFx('EUR').rate,'0.91');
});

test('all sources failing keeps the previous snapshot and surfaces an error',async()=>{
  const before=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='exchange_rates'").get().value);
  await assert.rejects(()=>currencies.refreshReferenceRates(async()=>{throw new Error('down');}),/全部汇率源不可用/);
  const after=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='exchange_rates'").get().value);
  assert.deepEqual(before,after);
});

test('keyless translation providers appear enabled and adapters translate via free endpoints',async()=>{
  const statuses=tp.publicProviderStatuses();
  const gf=statuses.find(p=>p.id==='google-free'),lv=statuses.find(p=>p.id==='lingva');
  assert.equal(gf.enabled,false,'默认关闭，避免非官方端点影响既有接力链');
  assert.equal(gf.configured,true);assert.equal(gf.status,'已关闭');
  assert.equal(lv.enabled,false);
  assert.ok(gf.priority<10,'开启后排到接力链最前');
  // 后台一键开启（免密钥，不要求确认免费档）。
  ok(await admin.post('/admin/translations/provider',{provider:'google-free',enabled:'1',priority:'5',limit:'450000'}));
  const statuses2=tp.publicProviderStatuses();
  assert.equal(statuses2.find(p=>p.id==='google-free').enabled,true);
  assert.equal(statuses2.find(p=>p.id==='google-free').status,'可用');
  // Google gtx 适配器：解析 [[['译文','原文'],...],...] 结构。
  const gFetch=async(url)=>{
    const u=String(url);
    assert.match(u,/translate\.googleapis\.com\/translate_a\/single/);
    assert.match(u,/client=gtx/);assert.match(u,/sl=en/);assert.match(u,/tl=zh-CN/);
    return {status:200,retryAfter:'',text:async()=>JSON.stringify([[['你好','hello'],['世界','world']]])};
  };
  assert.equal(await tprovider.googleFreeTranslate('hello world','en','zh-CN',null,{},gFetch),'你好世界');
  // Lingva 适配器：{translation:"..."} 结构。
  const lFetch=async(url)=>{
    assert.match(String(url),/lingva\.ml\/api\/v1\/en\/zh-CN\//);
    return {status:200,retryAfter:'',text:async()=>JSON.stringify({translation:'球衣'})};
  };
  assert.equal(await tprovider.lingvaTranslate('jersey','en','zh-CN',null,{},lFetch),'球衣');
  // 密钥型提供方（baidu）仍要求 appId——不回归。
  await assert.rejects(()=>tprovider.baiduTranslate('x','en','zh-CN',{key:'k'.repeat(16)},{}),/百度/);
});
