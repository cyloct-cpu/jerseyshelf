import { db, transaction, now, audit } from '../../apps/api/db.mjs';
import { saveProduct } from '../../apps/api/catalog.mjs';
import { customizationEdit } from '../../apps/api/customization.mjs';
import { InputError, text, slug, localImage, int, cents } from '../../packages/contracts/validation.mjs';
import { defaultTeamGroup, validTeamGroup } from '../../packages/contracts/team-taxonomy.mjs';
export function importCatalog(data, {dryRun=true,overwrite=false,user=null}={}) {
  if(!data||!Array.isArray(data.products)||!Array.isArray(data.collections))throw new InputError('文件应包含 collections 和 products 数组');
  if(data.products.length>20000||data.collections.length>1000)throw new InputError('文件内容超出单次导入限制');
  const collections=data.collections.map(c=>({slug:slug(c.slug),name:text(c.name,'分类名称',100),kind:['national','club','other'].includes(c.kind)?c.kind:'other',position:int(c.position||0,'排序',0,100000),image:localImage(c.image||'')}));
  collections.forEach((c,i)=>{const old=db.prepare('SELECT kind,team_group FROM collections WHERE slug=?').get(c.slug);c.team_group=data.collections[i].team_group===undefined?(old?.kind===c.kind?old.team_group:defaultTeamGroup(c.slug,c.kind)):text(data.collections[i].team_group,'洲/联赛',40,false);if(!validTeamGroup(c.kind,c.team_group))throw new InputError('洲/联赛与分类类型不匹配');});
  if(new Set(collections.map(c=>c.slug)).size!==collections.length)throw new InputError('文件包含重复分类标识');
  const known=new Set([...db.prepare('SELECT slug FROM collections').all().map(c=>c.slug),...collections.map(c=>c.slug)]);
  const products=data.products.map(p=>{
    const item={slug:slug(p.slug),title:text(p.title,'商品名称',250),description:text(p.description||'','描述',30000,false),price:String(p.price),compare_price:String(p.compare_price||0),images:(p.images||[]).map(localImage),active:p.active!==false};
    if(p.search_keywords!==undefined)item.search_keywords=text(p.search_keywords,'搜索关键词',2000,false);
    for(const key of ['customization','customization_mode','customization_template'])if(p[key]!==undefined)item[key]=p[key];
    cents(item.price);cents(item.compare_price);
    if(!Array.isArray(p.collections))throw new InputError('商品 collections 应为分类标识数组');
    item.collections=p.collections.map(slug);
    for(const c of item.collections)if(!known.has(c))throw new InputError('未知分类：'+c);
    if(!Array.isArray(p.variants)||!p.variants.length||p.variants.length>100)throw new InputError('每件商品必须提供 1 至 100 个规格，未知规格请停用且库存置零');
    item.variants=p.variants.map(v=>({sku:text(v.sku,'SKU',150),label:text(v.label,'规格',100),price:String(v.price),stock:int(v.stock,'库存',0,1000000),active:v.active!==false}));
    item.variants.forEach(v=>cents(v.price));
    return item;
  });
  if(new Set(products.map(p=>p.slug)).size!==products.length)throw new InputError('文件包含重复商品标识');
  const skuList=products.flatMap(p=>p.variants.map(v=>v.sku));
  if(new Set(skuList).size!==skuList.length)throw new InputError('文件包含重复 SKU');
  for(const c of collections)if(c.image&&!db.prepare('SELECT id FROM media WHERE path=?').get(c.image))throw new InputError('分类图片未导入媒体库：'+c.image);
  for(const p of products){
    for(const img of p.images)if(!db.prepare('SELECT id FROM media WHERE path=?').get(img))throw new InputError('商品图片未导入媒体库：'+img);
    const current=db.prepare('SELECT * FROM products WHERE slug=?').get(p.slug);
    if(current&&!overwrite)continue;
    customizationEdit(p,current);
    for(const v of p.variants){const old=db.prepare('SELECT product_id FROM variants WHERE sku=?').get(v.sku);if(old&&old.product_id!==current?.id)throw new InputError('SKU 已被其他商品使用：'+v.sku);}
  }
  const report={dryRun,collections:collections.length,newProducts:0,updatedProducts:0,skippedProducts:0};
  for(const p of products){const exists=db.prepare('SELECT id FROM products WHERE slug=?').get(p.slug);if(exists)report[overwrite?'updatedProducts':'skippedProducts']++;else report.newProducts++;}
  if(dryRun)return report;
  transaction(()=>{
    for(const c of collections){
      if(overwrite)db.prepare('INSERT INTO collections(slug,name,kind,position,image,team_group) VALUES(?,?,?,?,?,?) ON CONFLICT(slug) DO UPDATE SET name=excluded.name,kind=excluded.kind,position=excluded.position,image=excluded.image,team_group=excluded.team_group').run(c.slug,c.name,c.kind,c.position,c.image,c.team_group);
      else db.prepare('INSERT OR IGNORE INTO collections(slug,name,kind,position,image,team_group) VALUES(?,?,?,?,?,?)').run(c.slug,c.name,c.kind,c.position,c.image,c.team_group);
    }
    for(const p of products){
      const existing=db.prepare('SELECT id FROM products WHERE slug=?').get(p.slug);
      if(existing&&!overwrite)continue;
      const variants=p.variants.map(v=>({...v,id:existing?db.prepare('SELECT id FROM variants WHERE product_id=? AND sku=?').get(existing.id,v.sku)?.id:undefined}));
      const id=saveProduct({...p,id:existing?.id,collections:p.collections.map(s=>db.prepare('SELECT id FROM collections WHERE slug=?').get(s).id),variants},user);
      db.prepare('UPDATE products SET source_status=?,updated_at=? WHERE id=?').run('imported',now(),id);
    }
    audit(user,'catalog.import',JSON.stringify(report));
  });
  return report;
}
