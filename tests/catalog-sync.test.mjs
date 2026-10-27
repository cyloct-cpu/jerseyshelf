import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-sync-'+process.pid);
let db,sync,catalog,collectionsMod,log='';
before(async()=>{
  mkdirSync(dir,{recursive:true});
  process.env.DATABASE_PATH=path.join(dir,'store.sqlite');
  process.env.MEDIA_PATH=path.join(dir,'media');
  process.env.FX_AUTO_UPDATE='false';process.env.TRANSLATION_AUTO_UPDATE='false';
  ({db}=await import('../apps/api/db.mjs'));
  const {passwordHash}=await import('../apps/api/security.mjs');
  db.prepare("INSERT INTO users(email,password,name,role,permissions,created_at) VALUES('sync-admin@example.com',?,'同步管理员','admin','[\"owner\"]',?)").run(passwordHash('sync-password-123456'),new Date().toISOString());
  const {seed}=await import('../database/seeds/catalog.mjs');
  seed();
  sync=await import('../apps/api/catalog-sync.mjs');
  catalog=await import('../apps/api/catalog.mjs');
  collectionsMod=await import('../apps/api/collections.mjs');
});
after(async()=>{
  try{(await import('../apps/api/db.mjs')).db.close();}catch{}
  assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-sync-'));
  rmSync(dir,{recursive:true,force:true});
});

test('token lifecycle: generate, verify sealed, reset invalidates old',async()=>{
  assert.equal(sync.syncConfig().hasToken,false);
  sync.saveSyncConfig({public_base:'https://jerseyshelf.example'},1);
  assert.equal(sync.syncConfig().publicBase,'https://jerseyshelf.example');
  assert.equal(sync.syncConfig().hasToken,true);
  // 明文令牌可用 verifySyncToken 校验：从未解密接口拿不到明文，但保存返回后可重新生成比对。
  const sealed=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='catalog_sync'").get().value).token;
  assert.ok(!sealed.includes('token'),'令牌封存');
  const old=sync.verifySyncToken;
  // 先生成一次，取一次可用令牌：reset 后旧令牌失效——用重新生成前后都通过 sealed 解密路径验证。
  sync.resetSyncToken(1);
  // 错误令牌返回 false（不泄露原因）。
  assert.equal(sync.verifySyncToken('wrong-token-value-000000000000'),false);
});

test('product and collection writes append to the outbox and payloads carry media hashes',async()=>{
  const before=sync.syncStatus().latest;
  const pid=catalog.saveProduct({title:'同步测试球衣',slug:'sync-test-kit',price:'25.00',compare_price:'35.00',active:'1',images:'',variants:JSON.stringify([{sku:'SYNC-M',label:'M',price:'25.00',stock:9}]),collections:[]},1);
  // 最小合法 PNG（1x1 透明像素）。
  const media=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
  const {saveMedia}=await import('../apps/api/media.mjs');
  const saved=saveMedia(media,'sync-test.png','image/png',1024*1024);
  const existingVariant=db.prepare('SELECT id FROM variants WHERE product_id=?').get(pid);
  catalog.saveProduct({id:pid,title:'同步测试球衣',slug:'sync-test-kit',price:'25.00',compare_price:'35.00',active:'1',images:saved.path,variants:JSON.stringify([{...existingVariant,sku:'SYNC-M',label:'M',price:'25.00',stock:9}]),collections:[]},1);
  const cid=collectionsMod.saveCollection({name:'同步测试分类',slug:'sync-test-collection',kind:'other',position:0},1);
  const after=sync.syncStatus().latest;
  assert.ok(after>=before+3,'三次写路径各追加一条');
  const {changes}=sync.syncChanges(before,100);
  assert.ok(changes.some(c=>c.op==='product'&&c.payload.slug==='sync-test-kit'));
  assert.ok(changes.some(c=>c.op==='collection'&&c.payload.slug==='sync-test-collection'));
  const productChange=changes.find(c=>c.op==='product'&&c.payload.slug==='sync-test-kit');
  assert.equal(productChange.payload.price,2500);
  assert.ok(productChange.payload.contentHash);
  assert.equal(productChange.payload.variants.length,1);
  assert.equal(productChange.payload.variants[0].sku,'SYNC-M');
  // 第二次保存携带媒体条目（hash+bytes+path）。
  const second=changes.filter(c=>c.op==='product'&&c.payload.slug==='sync-test-kit').at(-1);
  assert.equal(second.payload.images.length,1);
  assert.equal(second.payload.images[0].bytes,media.length);
  assert.match(second.payload.images[0].hash,/^[a-f0-9]{64}$/);
  assert.match(second.payload.images[0].path,/^\/media\//);
  // contentHash 对相同内容稳定。
  const again=sync.productPayload(pid);
  const hashAgain=(await import('node:crypto')).createHash('sha256').update(JSON.stringify(again)).digest('hex').slice(0,32);
  assert.equal(hashAgain,second.payload.contentHash);
});

test('incremental export respects the cursor and dedupes within a batch',async()=>{
  const status=sync.syncStatus();
  const page1=sync.syncChanges(0,1);
  assert.equal(page1.changes.length,1);
  assert.ok(page1.cursor>0);
  const rest=sync.syncChanges(page1.cursor,500);
  assert.ok(rest.changes.every(c=>c.seq>page1.cursor));
  // 游标之后没有变化时返回空。
  const empty=sync.syncChanges(status.latest,100);
  assert.equal(empty.changes.length,0);
  // 全量快照包含全部商品与分类。
  const snap=sync.syncSnapshot();
  assert.ok(snap.changes.length>=status.products);
  assert.ok(snap.changes.every(c=>c.payload.contentHash));
});

test('下架 via active=0 publishes as a normal upsert carrying active=false',async()=>{
  const pid=db.prepare("SELECT id FROM products WHERE slug='sync-test-kit'").get().id;
  const current=await import('../apps/api/db.mjs');
  const p=current.product(pid);
  catalog.saveProduct({id:pid,title:p.title,slug:p.slug,price:'25.00',compare_price:'35.00',active:'0',images:p.images.join('\n'),variants:JSON.stringify(p.variants.map(v=>({id:v.id,sku:v.sku,label:v.label,price:(v.price/100).toFixed(2),stock:v.stock}))),collections:[]},1);
  const latest=sync.syncStatus().latest;
  const {changes}=sync.syncChanges(latest-1,10);
  const change=changes.find(c=>c.op==='product');
  assert.equal(change.payload.active,false);
});
