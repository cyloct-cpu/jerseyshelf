import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { config, root } from './config.mjs';
import { passwordHash, random } from './security.mjs';
import { normalizeSearch } from '../../packages/contracts/search-keywords.mjs';
import { convertMinor } from '../../packages/contracts/currencies.mjs';
mkdirSync(path.dirname(config.dbPath), { recursive: true });
mkdirSync(config.mediaDir, { recursive: true });
export const db = new DatabaseSync(config.dbPath);
db.function('search_normalize',{deterministic:true},normalizeSearch);
db.function('currency_convert',{deterministic:true},(amount,rate,minor)=>convertMinor(amount,{rate,minor}));
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
db.exec('CREATE TABLE IF NOT EXISTS migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
for(const file of readdirSync(path.join(root,'database/migrations')).filter(f=>/^\d+-.*\.sql$/.test(f)).sort()){
  const version=Number(file.split('-')[0]);
  const applied=!!db.prepare('SELECT version FROM migrations WHERE version=?').get(version);
  // Compatibility: an earlier source-collection migration temporarily used version 4.
  // Check the actual schema before skipping the separately added image-role migration.
  const needsRolesRepair=applied&&file==='004-product-image-roles.sql'&&!db.prepare('PRAGMA table_info(products)').all().some(c=>c.name==='image_roles');
  if(applied&&!needsRolesRepair)continue;
  db.exec('BEGIN IMMEDIATE');
  try{db.exec(readFileSync(path.join(root,'database/migrations',file),'utf8'));if(!applied)db.prepare('INSERT INTO migrations VALUES(?,?)').run(version,new Date().toISOString());db.exec('COMMIT');}catch(err){db.exec('ROLLBACK');throw err;}
}
export const now = () => new Date().toISOString();
let transactionDepth = 0;
export function transaction(fn) {
  if (transactionDepth) return fn();
  db.exec('BEGIN IMMEDIATE');
  transactionDepth++;
  try { const out = fn(); db.exec('COMMIT'); return out; } catch (err) { db.exec('ROLLBACK'); throw err; } finally { transactionDepth--; }
}
export function settings() { return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r=>[r.key,JSON.parse(r.value)])); }
export function putSetting(key, value) { db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
export function audit(user, action, target) { db.prepare('INSERT INTO audit_log(user_id,action,target,created_at) VALUES(?,?,?,?)').run(user,action,String(target),now()); }
export function product(idOrSlug) {
  let p = db.prepare(typeof idOrSlug === 'number' ? 'SELECT * FROM products WHERE id=?' : 'SELECT * FROM products WHERE slug=?').get(idOrSlug);
  if(!p&&typeof idOrSlug==='string')p=db.prepare('SELECT p.* FROM products p JOIN source_products s ON s.product_id=p.id WHERE s.source_slug=?').get(idOrSlug);
  if (!p) return null;
  p.images = JSON.parse(p.images); p.variants = db.prepare('SELECT * FROM variants WHERE product_id=? ORDER BY id').all(p.id);
  p.collections = db.prepare('SELECT c.* FROM collections c JOIN product_collections pc ON pc.collection_id=c.id WHERE pc.product_id=? AND c.deleted_at IS NULL ORDER BY c.position').all(p.id);
  return p;
}
export function init() {
  if (!db.prepare("SELECT id FROM users WHERE role='admin'").get()) {
    const pass = process.env.ADMIN_PASSWORD || random(12);
    if(pass.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters');
    const login = process.env.ADMIN_EMAIL || 'admin@local.test';
    db.prepare("INSERT INTO users(email,password,name,role,permissions,created_at) VALUES(?,?,?,'admin','[\"owner\"]',?)").run(login,passwordHash(pass),'管理员',now());
    if (!process.env.ADMIN_PASSWORD) writeFileSync(path.join(root,'storage/bootstrap-admin.txt'),`本地后台：http://127.0.0.1:${config.port}/admin\n邮箱：${login}\n密码：${pass}\n此文件属于本地凭据，不得上传或提交版本库。\n`, { mode: 0o600 });
  }
  if (!db.prepare('SELECT key FROM settings WHERE key=?').get('site')) {
    putSetting('site', {name:'球世界-1',currency:'USD',freeShippingQty:3,shipping:1000,announcement:'购买3件或以上商品即可享受免运费',supportEmail:'',logo:''});
    putSetting('home', {slides:[{title:'2026-27赛季',description:'我们使用与顶级奢侈品牌相同的制造商和优质材料，但我们的产品不赚取任何利润。',image:'',href:'/collections/2026-27-season'},{title:'复古的',description:'数百种与顶级奢侈品牌出自同一制造商的产品，价格无与伦比。',image:'',href:'/collections/retro'}],sections:[{title:'2026-27赛季',slug:'2026-27-season',enabled:true},{title:'复古的',slug:'retro',enabled:true},{title:'风衣',slug:'trench-coat',enabled:true}]});
  }
}
