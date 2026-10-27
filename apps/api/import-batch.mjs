import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { db, transaction, now } from './db.mjs';
import { config } from './config.mjs';
import { InputError } from '../../packages/contracts/validation.mjs';
import { saveMedia } from './media.mjs';
import { csvToCatalogData } from './import-csv.mjs';
import { importCatalog } from '../../scripts/import/service.mjs';
import { recordProductChange } from './catalog-sync.mjs';
import { random } from './security.mjs';

// 批次工作区（对齐 KITVAULT 的三步导入）：上传清单+图片 → 校验预览 → 确认入库 → 可回滚。
// 图片按「编号」= 规格 SKU（或商品 slug）自动配对：1..49 按数字顺序作主图集，50+ 作为补充图排在后面。
const WORKSPACE = path.join(path.dirname(config.dbPath), 'imports');
const IMAGE_LIMIT = 8 * 1024 * 1024;
const MAX_IMAGES = 2000;

function batchDir(batchId) { return path.join(WORKSPACE, batchId); }
function imageOrder(name) {
  const base = path.basename(name, path.extname(name));
  const numeric = /^(\d+)$/.exec(base);
  if (!numeric) return { group: 2, rank: Number.MAX_SAFE_INTEGER, name: base };
  const value = Number(numeric[1]);
  return value >= 50 ? { group: 1, rank: value, name: base } : { group: 0, rank: value, name: base };
}
function skuKey(relativePath) {
  // 目录名优先（webkitterRelativePath 如 batch/<SKU>/1.jpg），退回文件名去扩展名（散图 <SKU>.jpg）。
  const normalized = String(relativePath || '').replace(/\\/g, '/');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length >= 2) return segments[segments.length - 2];
  return segments.length ? path.basename(segments[0], path.extname(segments[0])) : '';
}

export function createBatch({ fields, files, actor }) {
  const manifest = files.find(f => /\.(csv|json)$/i.test(f.filename || ''));
  if (!manifest) throw new InputError('请上传清单文件（CSV 或 JSON）');
  const label = String(fields.label || '').trim().slice(0, 100) || new Date().toISOString().slice(0, 10).replaceAll('-', '');
  const draft = fields.draft === '1';
  const overwrite = fields.overwrite === '1';
  const extension = path.extname(manifest.filename || '').toLowerCase();
  let data;
  if (extension === '.json' || (manifest.contentType || '').includes('json')) {
    const parsed = JSON.parse(manifest.data.toString('utf8'));
    if (!Array.isArray(parsed.products)) throw new InputError('JSON 应包含 products 数组');
    data = { collections: Array.isArray(parsed.collections) ? parsed.collections : [], products: parsed.products };
    for (const product of data.products) {
      if (!Array.isArray(product.collections)) throw new InputError('JSON 商品缺少 collections 数组：' + (product.slug || '?'));
    }
  } else {
    data = csvToCatalogData(manifest.data.toString('utf8'));
  }
  if (data.products.length > 2000) throw new InputError('单批次最多 2000 件商品');
  const batchId = 'batch-' + Date.now().toString(36) + '-' + random(2).toUpperCase();
  // 图片按 SKU/编号配对：上传即入媒体库（哈希寻址去重），预览阶段即可展示匹配结果。
  const imageFiles = files.filter(f => f.name === 'images');
  if (imageFiles.length > MAX_IMAGES) throw new InputError('图片最多 ' + MAX_IMAGES + ' 张');
  const imagesBySku = new Map();
  const warnings = [];
  let imagesStored = 0;
  for (const file of imageFiles) {
    if (!/image\/(png|jpeg|webp|gif)/.test(file.contentType)) { warnings.push('已跳过非图片文件：' + file.filename); continue; }
    if (file.data.length > IMAGE_LIMIT) { warnings.push('已跳过超过 8 MB 的图片：' + file.filename); continue; }
    const key = skuKey(file.filename).toLowerCase();
    if (!key) { warnings.push('已跳过无法识别编号的图片：' + file.filename); continue; }
    const media = saveMedia(file.data, path.basename(file.filename), file.contentType, IMAGE_LIMIT);
    if (!imagesBySku.has(key)) imagesBySku.set(key, []);
    imagesBySku.get(key).push({ mediaPath: media.path, order: imageOrder(file.filename) });
    imagesStored++;
  }
  // 配图：任一规格 SKU 命中即归属该商品；上传图替换 CSV 图片列，1..49 主图序、50+ 补充图。
  const imageCounts = new Map();
  for (const product of data.products) {
    const keys = new Set([String(product.slug || '').toLowerCase(), ...product.variants.map(v => String(v.sku || '').toLowerCase())]);
    const collected = [];
    for (const key of keys) for (const image of imagesBySku.get(key) || []) collected.push(image);
    if (collected.length) {
      collected.sort((a, b) => a.order.group - b.order.group || a.order.rank - b.order.rank || a.order.name.localeCompare(b.order.name, 'en', { numeric: true }));
      product.images = collected.map(i => i.mediaPath);
      product.imagesFromUpload = true;
    }
    imageCounts.set(product.slug, collected.length);
  }
  const report = importCatalog(data, { dryRun: true, overwrite, user: actor });
  const dir = batchDir(batchId);
  mkdirSync(dir, { recursive: true });
  const record = {
    batchId, kind: 'upload', label, draft, overwrite, actor, createdAt: now(),
    data, imageCounts: Object.fromEntries(imageCounts), imagesStored, warnings
  };
  writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(record));
  const row = db.prepare('INSERT INTO import_batches(batch_id,kind,label,status,total,created_products,updated_products,skipped_products,images,draft,report,workspace,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(batchId, 'upload', label, 'preview', data.products.length, report.newProducts, report.updatedProducts, report.skippedProducts, imagesStored, draft ? 1 : 0, JSON.stringify(report), dir, actor, now());
  return { batchId, report, imageCounts, imagesStored, rowId: Number(row.lastInsertRowid) };
}

function loadManifest(batchId) {
  if (!/^batch-[a-z0-9-]+$/i.test(batchId)) throw new InputError('批次标识无效', 400);
  const file = path.join(batchDir(batchId), 'manifest.json');
  if (!existsSync(file)) throw new InputError('批次不存在或已过期', 404);
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function commitBatch(batchId, actor) {
  const record = loadManifest(batchId);
  const status = db.prepare('SELECT status FROM import_batches WHERE batch_id=?').get(batchId);
  if (status?.status === 'imported') throw new InputError('该批次已入库，如需撤销请使用回滚', 409);
  // 快照受影响商品的入库前状态（新建为 null），供回滚还原。
  const snapshots = {};
  for (const product of record.data.products) {
    const existing = db.prepare('SELECT * FROM products WHERE slug=?').get(product.slug);
    if (!existing) { snapshots[product.slug] = null; continue; }
    snapshots[product.slug] = {
      product: existing,
      variants: db.prepare('SELECT * FROM variants WHERE product_id=? ORDER BY id').all(existing.id),
      collections: db.prepare('SELECT c.slug FROM collections c JOIN product_collections pc ON pc.collection_id=c.id WHERE pc.product_id=?').all(existing.id).map(r => r.slug)
    };
  }
  const report = importCatalog(record.data, { dryRun: false, overwrite: record.overwrite, user: actor });
  // 草稿模式：仅新建商品下架，需在商品管理手动上架（对齐 KITVAULT 的「导入默认草稿」）。
  let drafted = 0;
  if (record.draft) {
    for (const product of record.data.products) {
      if (snapshots[product.slug] !== null) continue;
      db.prepare('UPDATE products SET active=0 WHERE slug=?').run(product.slug);
      drafted++;
    }
  }
  for (const product of record.data.products) {
    const id = db.prepare('SELECT id FROM products WHERE slug=?').get(product.slug)?.id;
    if (id) recordProductChange(id);
  }
  const created = record.data.products.filter(p => snapshots[p.slug] === null).map(p => p.slug);
  writeFileSync(path.join(batchDir(batchId), 'snapshot.json'), JSON.stringify({ snapshots, created }));
  db.prepare("UPDATE import_batches SET status='imported',created_products=?,updated_products=?,skipped_products=?,report=? WHERE batch_id=?")
    .run(report.newProducts, report.updatedProducts, report.skippedProducts, JSON.stringify({ ...report, drafted, created: created.length }), batchId);
  return { report: { ...report, drafted }, batchId };
}

export function rollbackBatch(batchId, actor) {
  const record = loadManifest(batchId);
  const status = db.prepare('SELECT status FROM import_batches WHERE batch_id=?').get(batchId);
  if (status?.status !== 'imported') throw new InputError('仅已入库的批次可以回滚', 409);
  const snapshotFile = path.join(batchDir(batchId), 'snapshot.json');
  if (!existsSync(snapshotFile)) throw new InputError('批次快照缺失，无法回滚', 409);
  const { snapshots } = JSON.parse(readFileSync(snapshotFile, 'utf8'));
  let restored = 0, removed = 0;
  transaction(() => {
    for (const [slug, snapshot] of Object.entries(snapshots)) {
      const current = db.prepare('SELECT id FROM products WHERE slug=?').get(slug);
      if (!snapshot) {
        // 入库前不存在：整件移除（规格、分类关联、商品行）。
        if (current) {
          db.prepare('DELETE FROM variants WHERE product_id=?').run(current.id);
          db.prepare('DELETE FROM product_collections WHERE product_id=?').run(current.id);
          db.prepare('DELETE FROM products WHERE id=?').run(current.id);
          removed++;
        }
        continue;
      }
      if (!current) continue;
      const before = snapshots[slug].product;
      db.prepare('UPDATE products SET slug=?,title=?,description=?,price=?,compare_price=?,images=?,active=?,updated_at=? WHERE id=?')
        .run(before.slug, before.title, before.description, before.price, before.compare_price, before.images, before.active, now(), current.id);
      db.prepare('DELETE FROM variants WHERE product_id=?').run(current.id);
      for (const variant of snapshots[slug].variants) {
        db.prepare('INSERT INTO variants(id,product_id,sku,label,price,stock,active) VALUES(?,?,?,?,?,?,?)')
          .run(variant.id, current.id, variant.sku, variant.label, variant.price, variant.stock, variant.active);
      }
      db.prepare('DELETE FROM product_collections WHERE product_id=?').run(current.id);
      for (const collectionSlug of snapshots[slug].collections) {
        const collection = db.prepare('SELECT id FROM collections WHERE slug=?').get(collectionSlug);
        if (collection) db.prepare('INSERT OR IGNORE INTO product_collections(product_id,collection_id) VALUES(?,?)').run(current.id, collection.id);
      }
      restored++;
    }
  });
  for (const slug of Object.keys(snapshots)) {
    const id = db.prepare('SELECT id FROM products WHERE slug=?').get(slug)?.id;
    if (id) recordProductChange(id);
  }
  db.prepare("UPDATE import_batches SET status='rolled_back',report=? WHERE batch_id=?")
    .run(JSON.stringify({ rolledBack: true, restored, removed }), batchId);
  return { restored, removed };
}

export function listBatches(limit = 20) {
  return db.prepare('SELECT b.*,u.email actor FROM import_batches b LEFT JOIN users u ON u.id=b.actor_id ORDER BY b.id DESC LIMIT ?').all(limit);
}
