import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {existsSync,readFileSync,mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-cons-'+process.pid),consumerDir=path.join(dir,'consumer');
const script=path.resolve(root,'../独立站/scripts/sync-from-jerseyshelf.mjs');
let server,base,db,token='';
const run=(env,extra=[])=>new Promise(resolve=>{
  execFile(process.execPath,[script,'--base',base,'--token',env.token,'--data',path.join(consumerDir,'data'),'--media',path.join(consumerDir,'data','media'),...extra],{cwd:root,env:{...process.env},timeout:60000,maxBuffer:1024*1024},(error,stdout,stderr)=>{
    resolve({code:error?error.code||1:0,stdout,stderr:String(stderr||'')});
  });
});
before(async()=>{
  mkdirSync(consumerDir,{recursive:true});
  process.env.DATABASE_PATH=path.join(dir,'store.sqlite');
  process.env.MEDIA_PATH=path.join(dir,'media');
  const {spawnTestServer}=await import('./helpers/server.mjs');
  server=await spawnTestServer({root,dir,extraEnv:{ADMIN_EMAIL:'cons-admin@example.com',ADMIN_PASSWORD:'cons-password-123456'}});
  base=server.base;
  db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  // 与服务器进程共享同一数据库：在测试进程内完成同步配置与令牌生成。
  const sync=await import('../apps/api/catalog-sync.mjs');
  sync.saveSyncConfig({public_base:base},1);
  const sealed=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='catalog_sync'").get().value).token;
  const {unsealFrom}=await import('../apps/api/secrets.mjs');
  token=unsealFrom('catalog-sync-credentials',sealed);
  assert.match(token,/^[a-f0-9]{48}$/);
  // 种子商品无图：挂一张真图（走 saveMedia+saveProduct，同时验证 outbox 钩子）。
  const catalogMod=await import('../apps/api/catalog.mjs');
  const {saveMedia}=await import('../apps/api/media.mjs');
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
  const media=saveMedia(png,'sync-e2e.png','image/png',1024*1024);
  const {db:mainDb}=await import('../apps/api/db.mjs');
  const target=mainDb.prepare('SELECT id FROM products ORDER BY id LIMIT 1').get();
  const variant=mainDb.prepare('SELECT id,sku,label,price,stock FROM variants WHERE product_id=? LIMIT 1').get(target.id);
  catalogMod.saveProduct({id:target.id,title:'同步E2E球衣',slug:mainDb.prepare('SELECT slug FROM products WHERE id=?').get(target.id).slug,price:'25.00',compare_price:'0',active:'1',images:media.path,variants:JSON.stringify([{id:variant.id,sku:variant.sku,label:variant.label,price:(variant.price/100).toFixed(2),stock:variant.stock}]),collections:[]},1);
});
after(async()=>{
  try{(await import('../apps/api/db.mjs')).db.close();}catch{}
  if(server?.child&&server.child.exitCode===null){server.child.kill();await new Promise(r=>{server.child.once('exit',r);setTimeout(r,3000).unref();});}
  assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-cons-'));
  // Windows 上服务器/杀毒进程可能短暂持有 sqlite 句柄：尽力清理，残留无害。
  for(let attempt=0;attempt<10;attempt++){
    try{rmSync(dir,{recursive:true,force:true});return;}catch{await new Promise(r=>setTimeout(r,1000));}
  }
  console.warn('临时目录未能完全清理（Windows 文件锁），可手动删除：'+dir);
});

test('wrong token is rejected by the main site',async()=>{
  const bad=await run({token:'f'.repeat(48)});
  assert.ok(bad.code!==0,'错误令牌必须以非零退出');
  assert.match(bad.stderr+bad.stdout,/同步失败/);
});

test('full snapshot pull writes catalog jsonl and hash-named media',async()=>{
  const first=await run({token},['--full']);
  assert.equal(first.code,0,first.stdout+first.stderr);
  assert.match(first.stdout,/同步完成/);
  const state=JSON.parse(readFileSync(path.join(consumerDir,'data/sync/state.json'),'utf8'));
  assert.ok(Number.isFinite(state.cursor));
  const catalog=readFileSync(path.join(consumerDir,'data/sync/catalog.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(catalog.some(r=>r.payload.kind==='product'));
  assert.ok(catalog.some(r=>r.payload.kind==='collection'));
  const product=catalog.find(r=>r.payload.kind==='product'&&r.payload.images.length);
  assert.ok(product,'种子库含图片商品');
  for(const image of product.payload.images){
    assert.ok(image.localName,'媒体已落盘登记');
    assert.ok(existsSync(path.join(consumerDir,'data/media',image.localName)),'媒体文件存在');
    assert.ok(image.localName.startsWith(image.hash.slice(0,8)),'以哈希命名');
  }
  // 幂等重跑：全部跳过。
  const second=await run({token});
  assert.equal(second.code,0);
  assert.match(second.stdout,/内容未变跳过/);
});

test('price change on the main site flows to the consumer incrementally',async()=>{
  const state0=JSON.parse(readFileSync(path.join(consumerDir,'data/sync/state.json'),'utf8'));
  const {db:mainDb}=await import('../apps/api/db.mjs');
  const product=mainDb.prepare('SELECT id,slug,price FROM products LIMIT 1').get();
  mainDb.prepare('UPDATE products SET price=price+500 WHERE id=?').run(product.id);
  mainDb.prepare('INSERT INTO catalog_changes(product_id,op,created_at) VALUES(?,?,?)').run(product.id,'product',new Date().toISOString());
  const runInc=await run({token});
  assert.equal(runInc.code,0,runInc.stdout+runInc.stderr);
  const lines=readFileSync(path.join(consumerDir,'data/sync/catalog.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const row=lines.filter(r=>r.payload.kind==='product'&&r.payload.slug===product.slug).at(-1);
  assert.equal(row.payload.price,product.price+500,'改价已同步');
  const state1=JSON.parse(readFileSync(path.join(consumerDir,'data/sync/state.json'),'utf8'));
  assert.ok(state1.cursor>state0.cursor,'游标推进');
});
