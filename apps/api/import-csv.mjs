import { db, now, audit as auditLog } from './db.mjs';
import { importCatalog } from '../../scripts/import/service.mjs';
import { InputError } from '../../packages/contracts/validation.mjs';

// CSV 批量导入（UTF-8 BOM，Excel 兼容）：一行一个规格，同商品多行共用 slug。
// 解析为规范化结构后复用 importCatalog 的全部校验与写入语义（定制继承、SKU 查重、媒体校验、审计）。
const HEADERS = {
  slug: ['slug', '标识'],
  title: ['title', '名称', '商品名称'],
  description: ['description', '描述'],
  price: ['price', '价格', '价格usd'],
  compare_price: ['compare_price', '原价', '划线价'],
  active: ['active', '上架'],
  collections: ['collections', '分类'],
  images: ['images', '图片'],
  sku: ['sku'],
  label: ['size', '规格', '尺码'],
  variant_price: ['variant_price', '规格价格'],
  stock: ['stock', '库存']
};
const splitList = v => String(v || '').split(/[;；]/).map(s => s.trim()).filter(Boolean);

export function parseCsv(raw) {
  const text = String(raw || '').replace(/^\ufeff/, '');
  if (!text.trim()) throw new InputError('请粘贴 CSV 内容');
  const rows = [];
  let field = '', row = [], quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some(c => c !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some(c => c !== '')) rows.push(row);
  if (rows.length < 2) throw new InputError('CSV 至少需要表头和一行数据');
  return rows;
}
function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((name, index) => {
    const key = String(name || '').trim().toLowerCase();
    for (const [field, aliases] of Object.entries(HEADERS)) {
      if (aliases.includes(key) && map[field] === undefined) { map[field] = index; break; }
    }
  });
  for (const required of ['slug', 'title', 'price', 'sku', 'label', 'stock']) {
    if (map[required] === undefined) throw new InputError('CSV 缺少必需列：' + required + '（可先下载模板）');
  }
  return map;
}
export function csvToCatalogData(raw) {
  const rows = parseCsv(raw);
  const map = mapHeaders(rows[0]);
  const pick = (row, field) => map[field] === undefined ? '' : String(row[map[field]] ?? '').trim();
  const products = new Map();
  const errors = [];
  rows.slice(1).forEach((row, index) => {
    const line = index + 2;
    try {
      const slug = pick(row, 'slug'), title = pick(row, 'title');
      if (!slug) throw new InputError('第 ' + line + ' 行缺少 slug');
      const continuation = !title && products.has(slug);
      if (!title && !continuation) throw new InputError('第 ' + line + ' 行缺少名称（新商品首行必须填写）');
      const sku = pick(row, 'sku'), label = pick(row, 'label');
      if (!sku || !label) throw new InputError('第 ' + line + ' 行缺少 SKU 或规格');
      if (!products.has(slug)) {
        const active = pick(row, 'active');
        const imageList = splitList(pick(row, 'images'));
        for (const image of imageList) {
          if (!/^\/media\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(image)) throw new InputError('第 ' + line + ' 行图片路径无效：' + image + '（应为媒体库 /media/… 路径；列数错位也会导致此错误）');
        }
        products.set(slug, {
          slug, title,
          description: pick(row, 'description'),
          price: pick(row, 'price'),
          compare_price: pick(row, 'compare_price') || '0',
          images: imageList,
          active: active === '' ? true : active === '1' || active === 'true' || active === '是',
          collections: splitList(pick(row, 'collections')),
          variants: []
        });
      }
      const product = products.get(slug);
      const price = pick(row, 'variant_price') || pick(row, 'price');
      const stock = Number(pick(row, 'stock'));
      if (!Number.isFinite(stock) || stock < 0) throw new InputError('第 ' + line + ' 行库存无效');
      product.variants.push({ sku, label, price, stock: Math.floor(stock), active: true });
    } catch (err) {
      if (err instanceof InputError) errors.push(err.message);
      else throw err;
    }
  });
  if (errors.length) throw new InputError(errors.slice(0, 5).join('；') + (errors.length > 5 ? ` 等共 ${errors.length} 处` : ''));
  if (!products.size) throw new InputError('没有可导入的商品行');
  // 分类必须在库中已存在（CSV 不创建分类，避免误建）。
  const known = new Set(db.prepare('SELECT slug FROM collections').all().map(c => c.slug));
  for (const p of products.values()) {
    for (const c of p.collections) if (!known.has(c)) throw new InputError('未知分类：' + c + '（商品 ' + p.slug + '；请先在分类管理创建）');
  }
  return { collections: [], products: [...products.values()] };
}
export function importCsv(raw, { dryRun = true, overwrite = false, user = null, label = '' } = {}) {
  const data = csvToCatalogData(raw);
  const report = importCatalog(data, { dryRun, overwrite, user });
  const recorded = db.prepare('INSERT INTO import_batches(batch_id,kind,label,status,total,created_products,updated_products,skipped_products,report,actor_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run('csv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6), 'csv', label.slice(0, 100), dryRun ? 'preview' : 'imported', data.products.length, report.newProducts, report.updatedProducts, report.skippedProducts, JSON.stringify(report), user, now());
  if (!dryRun) auditLog(user, 'catalog.import_csv', JSON.stringify(report));
  return { report, batchId: Number(recorded.lastInsertRowid) };
}
export const csvTemplate = () => '\ufeffslug,名称,描述,价格,原价,上架,分类,图片,sku,规格,规格价格,库存\r\n'
  + 'qa-csv-home-kit,CSV示例主场球衣,,25.90,39.90,1,2026-27-season,,QA-CSV-H-M,M,25.90,10\r\n'
  + 'qa-csv-home-kit,,,,,,,,QA-CSV-H-L,L,25.90,5\r\n';
