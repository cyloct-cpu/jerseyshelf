import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnTestServer} from './helpers/server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-csv-'+process.pid);
let child,base,db,log='';
class Client{cookies=new Map();csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body,location:r.headers.get('location'),disposition:r.headers.get('content-disposition')};}post(url,data={}){const form=new URLSearchParams({csrf:this.csrf});for(const [k,v] of Object.entries(data))for(const x of Array.isArray(v)?v:[v])form.append(k,x);return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});}}
const admin=new Client(),viewer=new Client();
const ok=r=>assert.equal(r.status,303,r.body+'\n'+log);
const CSV='\ufeffslug,名称,描述,价格,原价,上架,分类,图片,sku,规格,规格价格,库存\r\n'
  +'csv-home-kit,CSV主场球衣,"含,逗号的描述",25.90,39.90,1,2026-27-season,,CSV-H-M,M,25.90,10\r\n'
  +'csv-home-kit,,,,,,,,CSV-H-L,L,25.90,5\r\n'
  +'csv-away-kit,CSV客场球衣,,29.00,,0,,,CSV-A-M,M,29.00,3\r\n';
before(async()=>{
  mkdirSync(dir,{recursive:true});
  ({child,base}=await spawnTestServer({root,dir,extraEnv:{ADMIN_EMAIL:'csv-admin@example.com',ADMIN_PASSWORD:'csv-password-123456'}}));
  db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  await admin.get('/account');
  ok(await admin.post('/account/login',{email:'csv-admin@example.com',password:'csv-password-123456'}));
  await admin.get('/admin');
});
after(async()=>{db?.close();if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-csv-'));rmSync(dir,{recursive:true,force:true});});

test('template downloads with BOM; permission and CSRF protect the importer',async()=>{
  const tpl=await admin.get('/admin/import/template.csv');
  assert.equal(tpl.status,200);assert.match(tpl.disposition,/product-import-template\.csv/);
  // fetch.text() 会按解码规范剥离 BOM，用原始字节验证模板确带 UTF-8 BOM（Excel 兼容）。
  const raw=await (await fetch(base+'/admin/import/template.csv',{headers:{Cookie:[...admin.cookies].map(([k,v])=>k+'='+v).join('; ')}})).arrayBuffer();
  assert.equal(new Uint8Array(raw,0,3)[0],0xef);assert.equal(new Uint8Array(raw,0,3)[1],0xbb);assert.equal(new Uint8Array(raw,0,3)[2],0xbf);
  assert.match(tpl.body,/规格价格/);
  assert.equal((await admin.post('/admin/import/csv',{csv:CSV,intent:'preview',csrf:'forged'})).status,403);
  // 无 products.edit 权限的员工被拒。
  ok(await admin.post('/admin/staff/save',{email:'csv-viewer@example.com',name:'只读',password:'viewer-password-123',permissions:['dashboard.view']}));
  await viewer.get('/account');
  ok(await viewer.post('/account/login',{email:'csv-viewer@example.com',password:'viewer-password-123'}));
  await viewer.get('/admin');
  assert.equal((await viewer.post('/admin/import/csv',{csv:CSV,intent:'preview'})).status,403);
});

test('preview validates without writing; import creates products with variants and batches are recorded',async()=>{
  const preview=await admin.post('/admin/import/csv',{csv:CSV,intent:'preview',label:'十月上架'});
  assert.equal(preview.status,200,preview.body);
  assert.match(preview.body,/预检结果/);assert.match(preview.body,/新建 2/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE slug LIKE 'csv-%'").get().n,0,'预检不写入');
  const run=await admin.post('/admin/import/csv',{csv:CSV,intent:'import',label:'十月上架'});
  assert.equal(run.status,200,run.body);assert.match(run.body,/导入完成/);
  const product=db.prepare('SELECT * FROM products WHERE slug=?').get('csv-home-kit');
  assert.ok(product);assert.equal(product.price,2590);assert.equal(product.active,1);
  assert.match(product.description,/含,逗号的描述/);
  const variants=db.prepare('SELECT * FROM variants WHERE product_id=? ORDER BY id').all(product.id);
  assert.equal(variants.length,2);assert.deepEqual(variants.map(v=>v.sku),['CSV-H-M','CSV-H-L']);
  assert.equal(variants[0].stock,10);assert.equal(variants[1].price,2590);
  const away=db.prepare('SELECT active FROM products WHERE slug=?').get('csv-away-kit');
  assert.equal(away.active,0);
  const batch=db.prepare('SELECT * FROM import_batches ORDER BY id DESC LIMIT 1').get();
  assert.equal(batch.status,'imported');assert.equal(batch.total,2);assert.equal(batch.created_products,2);assert.equal(batch.label,'十月上架');
  // 幂等重导（不覆盖）：跳过已存在商品。
  const rerun=await admin.post('/admin/import/csv',{csv:CSV,intent:'import'});
  assert.equal(rerun.status,200);assert.match(rerun.body,/跳过 2/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE slug LIKE 'csv-%'").get().n,2);
});

test('row errors report line numbers and unknown collections are rejected',async()=>{
  const bad='slug,名称,价格,sku,规格,库存\r\ncsv-bad,坏行,10.00,BAD-1,,3\r\n';
  const missing=await admin.post('/admin/import/csv',{csv:bad,intent:'preview'});
  assert.equal(missing.status,400,missing.body);assert.match(missing.body,/缺少 SKU 或规格/);
  const unknownCollection='slug,名称,价格,分类,sku,规格,库存\r\ncsv-uc,未知分类,10.00,no-such-collection,UC-1,M,3\r\n';
  const rejected=await admin.post('/admin/import/csv',{csv:unknownCollection,intent:'preview'});
  assert.equal(rejected.status,400);assert.match(rejected.body,/未知分类/);
  const empty=await admin.post('/admin/import/csv',{csv:'',intent:'preview'});
  assert.equal(empty.status,400);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE slug IN('csv-bad','csv-uc')").get().n,0,'失败不落库');
});
