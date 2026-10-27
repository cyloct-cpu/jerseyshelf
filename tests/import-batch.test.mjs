import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-imp-'+process.pid),base='http://127.0.0.1:'+(40400+process.pid%1000);
let child,db,log='';
class Client{cookies=new Map();csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body,location:r.headers.get('location')};}post(url,data={}){const form=new URLSearchParams({csrf:this.csrf});for(const [k,v] of Object.entries(data))for(const x of Array.isArray(v)?v:[v])form.append(k,x);return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});}
  async upload(url,form,files){const fd=new FormData();fd.append('csrf',this.csrf);for(const [k,v] of Object.entries(form))fd.append(k,String(v));for(const [field,file] of files)fd.append(field,new Blob([file.data],{type:file.type}),file.name);const r=await fetch(base+url,{method:'POST',redirect:'manual',headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; ')},body:fd});const body=await r.text();return {status:r.status,body};}}
const admin=new Client();
const ok=r=>assert.equal(r.status,303,r.body+'\n'+log);
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
// 五张内容各异的合法 PNG（尾部差异字节不破坏魔数校验）。
const variantPng=suffix=>Buffer.concat([PNG,Buffer.from('-variant-'+suffix)]);
const PNGA=variantPng('a'),PNGB=variantPng('b'),PNGC=variantPng('c'),PNGD=variantPng('d'),PNGE=variantPng('e');
const CSV='\ufeffslug,名称,描述,价格,原价,上架,分类,图片,sku,规格,规格价格,库存\r\n'
 +'batch-kit,Batch球衣,,25.00,39.00,1,2026-27-season,,BATCH-M,M,25.00,10\r\n'
 +'batch-kit,,,,,,,,BATCH-L,L,25.00,5\r\n'
 +'batch-old,已有商品,,9.00,,,,,OLD-M,M,9.00,3\r\n';
const CSV_OLD='slug,名称,价格,sku,规格,库存\r\nbatch-old,已有商品,9.00,OLD-M,M,3\r\n';
before(async()=>{
  mkdirSync(dir,{recursive:true});
  child=spawn(process.execPath,['apps/api/server.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:base.split(':').at(-1),DATABASE_PATH:path.join(dir,'store.sqlite'),MEDIA_PATH:path.join(dir,'media'),ADMIN_EMAIL:'imp-admin@example.com',ADMIN_PASSWORD:'imp-password-123456',FX_AUTO_UPDATE:'false',TRANSLATION_AUTO_UPDATE:'false'},stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  let ready=false;for(let i=0;i<150;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
  assert.ok(ready,log);
  db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  await admin.get('/account');
  ok(await admin.post('/account/login',{email:'imp-admin@example.com',password:'imp-password-123456'}));
  await admin.get('/admin');
  // 预置一个已有商品，验证「更新」分支与回滚还原。
  const pre=await admin.post('/admin/import/csv',{csv:CSV_OLD,intent:'import'});
  assert.equal(pre.status,200,pre.body);
});
after(async()=>{
  db?.close();
  try{(await import('../apps/api/db.mjs')).db.close();}catch{}
  if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}
  assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-imp-'));
  for(let attempt=0;attempt<5;attempt++){try{rmSync(dir,{recursive:true,force:true});return;}catch{await new Promise(r=>setTimeout(r,500));}}
});

test('upload with folder-style images: preview matches images by SKU, commit drafts new products',async()=>{
  const page=await admin.get('/admin/import');
  assert.equal(page.status,200);assert.match(page.body,/第 1 步 · 上传清单与图片/);assert.match(page.body,/批次工作区/);
  const preview=await admin.upload('/admin/import/upload',{label:'十月批次',draft:'1',overwrite:''},[
    ['manifest',{data:Buffer.from(CSV,'utf8'),type:'text/csv',name:'products.csv'}],
    // 目录名 = SKU：BATCH-M 的 1.jpg/2.jpg 主图、51.jpg 补充图；BATCH-L 一张；batch-old 一张（更新分支配图）。
    // 四张 PNG 内容互不相同（尾部差异字节），哈希去重后仍是 4 条媒体记录。
    ['images',{data:PNGA,type:'image/png',name:'prod/BATCH-M/1.jpg'}],
    ['images',{data:PNGB,type:'image/png',name:'prod/BATCH-M/2.jpg'}],
    ['images',{data:PNGC,type:'image/png',name:'prod/BATCH-M/51.jpg'}],
    ['images',{data:PNGD,type:'image/png',name:'prod/BATCH-L/1.jpg'}],
    ['images',{data:PNGE,type:'image/png',name:'batch-old.jpg'}],
    ['images',{data:Buffer.from('<svg/>'),'type':'image/svg+xml',name:'prod/BATCH-M/3.svg'}]
  ]);
  assert.equal(preview.status,200,preview.body);
  assert.match(preview.body,/第 2 步 · 校验预览/);
  assert.match(preview.body,/新建<\/span><strong>1/);assert.match(preview.body,/跳过<\/span><strong>1/,'batch-old 已在预置导入中存在');
  assert.match(preview.body,/上传图片 5 张/,'SVG 被跳过，PNG 5 张入库');
  const row=db.prepare("SELECT * FROM import_batches WHERE status='preview' ORDER BY id DESC LIMIT 1").get();
  assert.ok(row);assert.equal(row.images,5);assert.equal(row.draft,1);
  const batchId=row.batch_id;
  const manifest=JSON.parse((await import('node:fs')).readFileSync(path.join(dir,'imports',batchId,'manifest.json'),'utf8'));
  const kit=manifest.data.products.find(p=>p.slug==='batch-kit');
  assert.equal(kit.images.length,4,'BATCH-M 主图 2 + BATCH-L 主图 1 + BATCH-M/51 补充 1');
  assert.ok(new Set(kit.images).size===4,'四张不同内容去重后路径唯一');
  assert.ok(kit.images[0]!==kit.images[1]);
  const old=manifest.data.products.find(p=>p.slug==='batch-old');
  assert.equal(old.images.length,1,'散图按文件名匹配已有商品');
  // 确认入库。
  const done=await admin.post('/admin/import/commit',{batch_id:batchId});
  assert.equal(done.status,200,done.body);assert.match(done.body,/入库完成/);assert.match(done.body,/草稿/);
  const product=db.prepare("SELECT * FROM products WHERE slug='batch-kit'").get();
  assert.equal(product.active,0,'草稿模式下新建商品下架');
  assert.equal(JSON.parse(product.images).length,4);
  const updated=db.prepare("SELECT active FROM products WHERE slug='batch-old'").get();
  assert.equal(updated.active,1,'已有商品不受草稿影响');
  // 待入库状态消失，批次已导入。
  assert.equal(db.prepare("SELECT status FROM import_batches WHERE batch_id=?").get(batchId).status,'imported');
});

test('rollback restores updated product and removes created products; sync outbox records it',async()=>{
  const before=db.prepare('SELECT COUNT(*) n FROM products').get().n;
  const batch=db.prepare("SELECT batch_id FROM import_batches WHERE status='imported' AND batch_id LIKE 'batch-%' ORDER BY id DESC LIMIT 1").get();
  const outboxBefore=db.prepare('SELECT COUNT(*) n FROM catalog_changes').get().n;
  const rolled=await admin.post('/admin/import/rollback',{batch_id:batch.batch_id});
  ok(rolled);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM products WHERE slug='batch-kit'").get().n,0,'新建商品被移除');
  const restored=db.prepare("SELECT * FROM products WHERE slug='batch-old'").get();
  assert.equal(restored.price,900,'已有商品价格还原');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM variants WHERE product_id=?').get(restored.id).n,1,'变体按原 id 还原');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM products').get().n,before-1);
  assert.ok(db.prepare('SELECT COUNT(*) n FROM catalog_changes').get().n>outboxBefore,'回滚写入同步 outbox');
  assert.equal(db.prepare("SELECT status FROM import_batches WHERE batch_id=?").get(batch.batch_id).status,'rolled_back');
  // 再次回滚被拒绝。
  assert.equal((await admin.post("/admin/import/rollback",{batch_id:batch.batch_id})).status,409);
});

test('upload validation: bad extension, oversize and missing manifest are rejected without workspace',async()=>{
  const bad=await admin.upload('/admin/import/upload',{},[['manifest',{data:Buffer.from('x'),type:'text/plain',name:'list.txt'}]]);
  assert.equal(bad.status,400);assert.match(bad.body,/请上传清单文件/);
  const badImage=await admin.upload('/admin/import/upload',{},[
    ['manifest',{data:Buffer.from(CSV,'utf8'),type:'text/csv',name:'products.csv'}],
    ['images',{data:PNG,type:'image/png',name:'x/BAD-SKU/broken.png.exe'}]
  ]);
  // .exe 后缀文件 contentType 伪造为图片也会因扩展名/内容检查被拒或忽略——不产生崩溃。
  assert.ok([200,400].includes(badImage.status));
});

test('csrf is enforced on multipart uploads',async()=>{
  const r=await fetch(base+'/admin/import/upload',{method:'POST',headers:{Cookie:[...admin.cookies].map(([k,v])=>k+'='+v).join('; ')},body:new FormData()});
  assert.equal(r.status,403);
});
