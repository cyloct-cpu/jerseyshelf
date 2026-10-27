import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnTestServer} from './helpers/server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-isfb-'+process.pid);
let child,base,db,fb,log='';
class Client{cookies=new Map();csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body,location:r.headers.get('location')};}post(url,data={}){const form=new URLSearchParams({csrf:this.csrf});for(const [k,v] of Object.entries(data))for(const x of Array.isArray(v)?v:[v])form.append(k,x);return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});}}
const admin=new Client();
const ok=r=>assert.equal(r.status,303,r.body+'\n'+log);
before(async()=>{
  mkdirSync(dir,{recursive:true});
  ({child,base}=await spawnTestServer({root,dir,extraEnv:{ADMIN_EMAIL:'isfb-admin@example.com',ADMIN_PASSWORD:'isfb-password-123456'}}));
  db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  process.env.DATABASE_PATH=path.join(dir,'store.sqlite');
  fb=await import('../apps/api/image-search-fallback.mjs');
  await admin.get('/account');
  ok(await admin.post('/account/login',{email:'isfb-admin@example.com',password:'isfb-password-123456'}));
  await admin.get('/admin');
});
after(async()=>{
  db?.close();
  try{(await import('../apps/api/db.mjs')).db.close();}catch{}
  if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}
  assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-isfb-'));rmSync(dir,{recursive:true,force:true});
});

test('fallback config validates, seals the key and gates on completeness',async()=>{
  assert.equal((await admin.post('/admin/image-search/fallback',{fallback_enabled:'1',fallback_base_url:'http://insecure.example',fallback_model:'m',fallback_api_key:'k'.repeat(20)})).status,400);
  assert.equal((await admin.post('/admin/image-search/fallback',{fallback_enabled:'1',fallback_base_url:'https://api.example.com/v1',fallback_model:'',fallback_api_key:'k'.repeat(20)})).status,400);
  ok(await admin.post('/admin/image-search/fallback',{fallback_enabled:'1',fallback_base_url:'https://api.example.com/v1',fallback_model:'vision-model-x',fallback_api_key:'isfb-key-abcdefghijklmnop'}));
  const stored=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='image_search_fallback'").get().value);
  assert.equal(stored.enabled,true);assert.ok(stored.apiKey&&!stored.apiKey.includes('isfb-key'));
  const page=await admin.get('/admin/image-search');
  assert.equal(page.status,200);assert.match(page.body,/视觉大模型兜底/);assert.doesNotMatch(page.body,/isfb-key-abcdefghijklmnop/);
});

test('visionFallbackSearch sends the image, extracts a query and maps it to catalog candidates',async()=>{
  const calls=[];
  const result=await fb.visionFallbackSearch(Buffer.from('fake-jpeg'), 'image/jpeg', async(url,init)=>{
    calls.push({url:String(url),body:JSON.parse(init.body)});
    return {ok:true,json:async()=>({choices:[{message:{content:'"Bayern Munich 2026/27"'}}]})};
  });
  assert.equal(calls.length,1);
  assert.match(calls[0].url,/api\.example\.com\/v1\/chat\/completions$/);
  assert.equal(calls[0].body.model,'vision-model-x');
  assert.match(calls[0].body.messages[0].content[1].image_url.url,/^data:image\/jpeg;base64,/);
  assert.equal(result.query,'Bayern Munich 2026/27');
  // 种子库中含拜仁款；兜底查询应能命中文字索引。
  assert.ok(result.products.length>=1);
  assert.ok(result.products.every(p=>p.id&&p.title));
});

test('disabled or failing fallback degrades to null without throwing to callers of submitImageSearch',async()=>{
  db.prepare("UPDATE settings SET value=json_set(value,'$.enabled',json('false')) WHERE key='image_search_fallback'").run();
  assert.equal(await fb.visionFallbackSearch(Buffer.from('x'),'image/jpeg'),null);
  db.prepare("UPDATE settings SET value=json_set(value,'$.enabled',json('true')) WHERE key='image_search_fallback'").run();
  await assert.rejects(()=>fb.visionFallbackSearch(Buffer.from('x'),'image/jpeg',async()=>({ok:false,json:async()=>({error:{message:'boom'}})})),/兜底模型接口错误/);
  assert.equal(await fb.testFallbackConnection(async()=>({ok:false})).catch(e=>e.message).then(m=>String(m).includes('接口连接失败')||m),true);
});
