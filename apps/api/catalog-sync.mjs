import { db, putSetting, audit, now } from './db.mjs';
import { config } from './config.mjs';
import { InputError } from '../../packages/contracts/validation.mjs';
import { sealTo, unsealFrom } from './secrets.mjs';
import { random } from './security.mjs';
import { createHash } from 'node:crypto';

// 商品主从同步（主站出口）：catalog_changes 作为 outbox，消费端按 seq 增量拉取。
// 媒体条目携带 hash+bytes+相对路径：同机共享 media 目录时消费端零复制，跨机时按 URL 拉取、哈希命名落盘。
const SETTING = 'catalog_sync';
const KEY_NAME = 'catalog-sync-credentials';

export function syncConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(SETTING);
  const s = row ? JSON.parse(row.value) : {};
  return { hasToken: !!s.token, publicBase: s.publicBase || '' };
}
export function saveSyncConfig(input, actor) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(SETTING);
  const s = row ? JSON.parse(row.value) : {};
  if (typeof input.public_base === 'string' && input.public_base.trim()) {
    const base = input.public_base.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(base)) throw new InputError('站点公开地址格式无效');
    s.publicBase = base;
  }
  if (!s.publicBase) s.publicBase = process.env.PUBLIC_BASE_URL || '';
  if (input.regenerate === '1' || !s.token) {
    s.token = sealTo(KEY_NAME, random(24));
    audit(actor, 'sync.token', 'regenerated');
  }
  putSetting(SETTING, s);
  audit(actor, 'sync.config', s.publicBase || 'base');
  return syncConfig();
}
export function verifySyncToken(input) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(SETTING);
  const s = row ? JSON.parse(row.value) : {};
  if (!s.token) throw new InputError('同步尚未配置令牌', 503);
  const current = unsealFrom(KEY_NAME, s.token, '同步令牌无法读取，请在后台重新生成');
  return String(input || '') === current;
}
export function resetSyncToken(actor) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(SETTING);
  const s = row ? JSON.parse(row.value) : {};
  s.token = sealTo(KEY_NAME, random(24));
  putSetting(SETTING, s);
  audit(actor, 'sync.token', 'reset');
}

// ---------- outbox 记录（商品/分类所有写路径调用；幂等、只追加） ----------
export function recordProductChange(productId) {
  const exists = db.prepare('SELECT id FROM products WHERE id=?').get(productId);
  if (!exists) return;
  db.prepare('INSERT INTO catalog_changes(product_id,op,created_at) VALUES(?,?,?)').run(productId, 'product', now());
}
export function recordCollectionChange(collectionId) {
  const exists = db.prepare('SELECT id FROM collections WHERE id=?').get(collectionId);
  if (!exists) return;
  db.prepare('INSERT INTO catalog_changes(product_id,op,created_at) VALUES(?,?,?)').run(collectionId, 'collection', now());
}

// ---------- 载荷组装 ----------
export function mediaEntry(path) {
  const m = db.prepare('SELECT * FROM media WHERE path=?').get(path);
  if (!m) return null;
  return { hash: m.hash, name: m.name, contentType: m.content_type, bytes: m.bytes, path: m.path };
}
export function productPayload(productId) {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(productId);
  if (!p) return null;
  const variants = db.prepare('SELECT sku,label,price,stock,active FROM variants WHERE product_id=? ORDER BY id').all(p.id);
  const collections = db.prepare('SELECT c.slug FROM collections c JOIN product_collections pc ON pc.collection_id=c.id WHERE pc.product_id=?').all(p.id).map(r => r.slug);
  let customization = {};
  try { customization = JSON.parse(p.customization || '{}'); } catch {}
  let translations = {};
  try { translations = JSON.parse(p.translations || '{}'); } catch {}
  return {
    kind: 'product', slug: p.slug, title: p.title, description: p.description,
    price: p.price, comparePrice: p.compare_price, active: !!p.active,
    images: JSON.parse(p.images || '[]').map(img => mediaEntry(img)).filter(Boolean),
    searchKeywords: p.search_keywords || '',
    customization, translations,
    recommendationMode: p.recommendation_mode || 'auto_fill',
    collections,
    variants: variants.map(v => ({ ...v, active: !!v.active })),
    contentHash: null
  };
}
export function collectionPayload(collectionId) {
  const c = db.prepare('SELECT * FROM collections WHERE id=?').get(collectionId);
  if (!c) return null;
  return {
    kind: 'collection', slug: c.slug, name: c.name, kindKey: c.kind, position: c.position,
    image: c.image ? mediaEntry(c.image) : null, teamGroup: c.team_group || '', deleted: !!c.deleted_at
  };
}
function hashPayload(payload) {
  // 内容哈希在 syncChanges/syncSnapshot 内联计算；此函数保留给将来的单实体重算。
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
}

// ---------- 增量出口 ----------
export function syncChanges(cursor = 0, limit = 200) {
  const rows = db.prepare('SELECT seq,product_id,op FROM catalog_changes WHERE seq>? ORDER BY seq LIMIT ?').all(cursor, Math.min(limit, 500));
  const changes = [];
  const seen = new Map();
  for (const row of rows) {
    const key = row.op + ':' + row.product_id;
    // 同一批内同一实体只保留最新一条，但游标推进到最后一条的 seq。
    const payload = row.op === 'product' ? productPayload(row.product_id) : collectionPayload(row.product_id);
    if (!payload) continue;
    payload.contentHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32);
    seen.set(key, { seq: row.seq, op: row.op, payload });
  }
  const deduped = [...seen.values()].sort((a, b) => a.seq - b.seq);
  const lastSeq = rows.length ? rows[rows.length - 1].seq : cursor;
  const count = db.prepare('SELECT COALESCE(MAX(seq),0) n FROM catalog_changes').get().n;
  return { changes: deduped, cursor: lastSeq, latest: count, publicBase: syncConfig().publicBase };
}
export function syncSnapshot() {
  const products = db.prepare('SELECT id FROM products').all().map(r => productPayload(r.id)).filter(Boolean);
  const collections = db.prepare('SELECT id FROM collections').all().map(r => collectionPayload(r.id)).filter(Boolean);
  for (const p of products) p.contentHash = createHash('sha256').update(JSON.stringify(p)).digest('hex').slice(0, 32);
  for (const c of collections) c.contentHash = createHash('sha256').update(JSON.stringify(c)).digest('hex').slice(0, 32);
  const latest = db.prepare('SELECT COALESCE(MAX(seq),0) n FROM catalog_changes').get().n;
  return { changes: [...collections.map(c => ({ seq: 0, op: 'collection', payload: c })), ...products.map(p => ({ seq: 0, op: 'product', payload: p }))], cursor: latest, latest, publicBase: syncConfig().publicBase };
}
export function syncStatus() {
  return {
    ...syncConfig(),
    pending: db.prepare('SELECT COUNT(*) n FROM catalog_changes').get().n,
    latest: db.prepare('SELECT COALESCE(MAX(seq),0) n FROM catalog_changes').get().n,
    products: db.prepare('SELECT COUNT(*) n FROM products').get().n
  };
}
