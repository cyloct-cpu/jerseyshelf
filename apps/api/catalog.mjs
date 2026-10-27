import { db, product, now, transaction, audit } from './db.mjs';
import { text, int, cents, slug, localImage, InputError } from '../../packages/contracts/validation.mjs';
import { validLocale } from '../../packages/contracts/locales.mjs';
import { searchTerms, expandSearchTerm, literalLike } from '../../packages/contracts/search-keywords.mjs';
import { parseCurrencyAmount } from '../../packages/contracts/currencies.mjs';
import { customizationEdit } from './customization.mjs';
import { recordProductChange } from './catalog-sync.mjs';
import {parseProductRecommendations,saveProductRecommendations} from './recommendations.mjs';
export function catalog(query = {}, admin = false,fx=null) {
  const where = [admin ? '1=1' : 'p.active=1']; const params=[];
  if(admin&&query.exclude){where.push('p.id<>?');params.push(int(query.exclude,'排除商品 ID',1));}
  if(query.q){
    const collections=db.prepare('SELECT id,name,slug FROM collections WHERE deleted_at IS NULL').all();
    for(const term of searchTerms(query.q)){
      const {words,ids}=expandSearchTerm(term,collections),matches=[];
      for(const word of words){const pattern=literalLike(word);matches.push("(search_normalize(p.title) LIKE ? ESCAPE '\\' OR search_normalize(p.description) LIKE ? ESCAPE '\\' OR search_normalize(p.search_keywords) LIKE ? ESCAPE '\\' OR EXISTS(SELECT 1 FROM json_each(p.translations) tr WHERE search_normalize(json_extract(tr.value,'$.title')) LIKE ? ESCAPE '\\' OR search_normalize(json_extract(tr.value,'$.description')) LIKE ? ESCAPE '\\') OR EXISTS(SELECT 1 FROM variants v WHERE v.product_id=p.id AND search_normalize(v.sku) LIKE ? ESCAPE '\\') OR EXISTS(SELECT 1 FROM product_collections pc JOIN collections c ON c.id=pc.collection_id WHERE pc.product_id=p.id AND c.deleted_at IS NULL AND (search_normalize(c.name) LIKE ? ESCAPE '\\' OR search_normalize(c.slug) LIKE ? ESCAPE '\\')))");params.push(...Array(8).fill(pattern));}
      if(ids.length){matches.push(`EXISTS(SELECT 1 FROM product_collections pc WHERE pc.product_id=p.id AND pc.collection_id IN (${ids.map(()=>'?').join(',')}))`);params.push(...ids);}
      where.push('('+matches.join(' OR ')+')');
    }
  }
  if(query.collection){where.push('EXISTS(SELECT 1 FROM product_collections pc JOIN collections c ON c.id=pc.collection_id WHERE pc.product_id=p.id AND c.slug=? AND c.deleted_at IS NULL)');params.push(query.collection);}
  for(const [key,operator] of [['min','>='],['max','<=']])if(query[key]){
    if(fx){let amount;try{amount=parseCurrencyAmount(query[key],fx);}catch(err){throw new InputError(err.message);}where.push(`currency_convert(p.price,?,?)${operator}?`);params.push(fx.rate,fx.minor,amount);}
    else{where.push(`p.price${operator}?`);params.push(cents(query[key]));}
  }
  const sort={price_asc:'p.price ASC,p.id ASC',price_desc:'p.price DESC,p.id ASC',newest:'p.id DESC',title:'p.title ASC,p.id ASC'}[query.sort] || 'p.id ASC';
  const count=db.prepare('SELECT COUNT(*) n FROM products p WHERE '+where.join(' AND ')).get(...params).n;
  const page=int(query.page || 1,'页码',1,10000); const size=admin?30:24;
  const products=db.prepare('SELECT p.* FROM products p WHERE '+where.join(' AND ')+' ORDER BY '+sort+' LIMIT ? OFFSET ?').all(...params,size,(page-1)*size).map(p=>({...p,images:JSON.parse(p.images)}));
  return {products,count,page,pages:Math.ceil(count/size)};
}
export function saveProduct(input, user) {
  const id=input.id?int(input.id,'商品 ID',1):null;
  if(id && !product(id))throw new InputError('商品不存在',404);
  const data={slug:slug(input.slug),title:text(input.title,'商品标题',250),description:text(input.description||'','商品描述',30000,false),price:cents(input.price),compare:cents(input.compare_price||'0','原价'),images:(Array.isArray(input.images)?input.images:String(input.images||'').split(/\r?\n/)).filter(Boolean).map(localImage),active:input.active==='1'||input.active===true?1:0};
  const searchKeywords=input.search_keywords===undefined?(id?product(id).search_keywords:''):text(input.search_keywords,'搜索关键词',2000,false);
  const customization=customizationEdit(input,id?product(id):null);
  const recommendations=parseProductRecommendations(input,id);
  let translations=input.translations===undefined?(id?JSON.parse(product(id).translations||'{}'):{}):(typeof input.translations==='string'?JSON.parse(input.translations):input.translations);
  if(!translations||Array.isArray(translations)||typeof translations!=='object')throw new InputError('多语言内容格式错误');
  const cleanTranslations={};
  for(const [locale,value]of Object.entries(translations)){
    if(!validLocale(locale)||locale==='zh-CN'||!value||Array.isArray(value)||typeof value!=='object')throw new InputError('多语言内容包含无效语言');
    cleanTranslations[locale]={title:text(value.title||'','翻译标题',250,false),description:text(value.description||'','翻译描述',30000,false)};
  }
  const suppliedRoles = input.image_roles === undefined ? null : (typeof input.image_roles === 'string' ? JSON.parse(input.image_roles) : input.image_roles);
  if(suppliedRoles && (!Array.isArray(suppliedRoles) || suppliedRoles.length !== data.images.length))throw new InputError('图片分类与图片数量不一致');
  const roles=data.images.map((_,i)=>i===0?'main':(suppliedRoles?.[i]||'detail'));
  if(roles.some(role=>!['main','side','size','detail','scene','unclassified'].includes(role)) || roles.slice(1).includes('main'))throw new InputError('图片分类无效');
  for(const image of data.images){
    const media=db.prepare('SELECT id,bytes FROM media WHERE path=?').get(image);
    if(!media)throw new InputError('图片未导入媒体库：'+image);
    // Existing associations remain editable even when older files exceed the new upload limit.
    if(media.bytes>3*1024*1024 && !(id && product(id).images.includes(image)))throw new InputError('商品图片每张不能超过 3 MB');
  }
  const cats=(Array.isArray(input.collections)?input.collections:input.collections?[input.collections]:[]).map(x=>int(x,'分类 ID',1));
  for(const cat of cats)if(!db.prepare('SELECT id FROM collections WHERE id=? AND deleted_at IS NULL').get(cat))throw new InputError('分类不存在或已删除');
  const variants=typeof input.variants==='string'?JSON.parse(input.variants):input.variants;
  if(!Array.isArray(variants)||!variants.length||variants.length>100)throw new InputError('请填写 1 至 100 个规格');
  const parsed=variants.map(v=>({id:v.id?int(v.id,'规格 ID',1):null,sku:text(v.sku,'SKU',150),label:text(v.label,'规格',100),price:cents(v.price),stock:int(v.stock,'库存',0,1000000),active:v.active===false||v.active==='0'?0:1}));
  if(new Set(parsed.map(v=>v.sku)).size!==parsed.length)throw new InputError('SKU 不能重复');
  if(new Set(parsed.filter(v=>v.id).map(v=>v.id)).size!==parsed.filter(v=>v.id).length)throw new InputError('规格 ID 不能重复');
  return transaction(()=>{
    let pid=id;
    if(id) db.prepare('UPDATE products SET slug=?,title=?,description=?,price=?,compare_price=?,images=?,active=?,updated_at=? WHERE id=?').run(data.slug,data.title,data.description,data.price,data.compare,JSON.stringify(data.images),data.active,now(),id);
    else pid=Number(db.prepare('INSERT INTO products(slug,title,description,price,compare_price,images,active,source_status,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(data.slug,data.title,data.description,data.price,data.compare,JSON.stringify(data.images),data.active,'manual',now()).lastInsertRowid);
    db.prepare('DELETE FROM product_collections WHERE product_id=? AND collection_id IN (SELECT id FROM collections WHERE deleted_at IS NULL)').run(pid);
    for(const cat of new Set(cats)) db.prepare('INSERT INTO product_collections VALUES(?,?)').run(pid,cat);
    db.prepare('UPDATE variants SET active=0 WHERE product_id=?').run(pid);
    for(const v of parsed){
      if(v.id){
        const old=db.prepare('SELECT product_id FROM variants WHERE id=?').get(v.id);
        if(!old || old.product_id!==pid)throw new InputError('规格不属于此商品');
        db.prepare('UPDATE variants SET sku=?,label=?,price=?,stock=?,active=? WHERE id=?').run(v.sku,v.label,v.price,v.stock,v.active,v.id);
      }else db.prepare('INSERT INTO variants(product_id,sku,label,price,stock,active) VALUES(?,?,?,?,?,?)').run(pid,v.sku,v.label,v.price,v.stock,v.active);
    }
    db.prepare('UPDATE products SET source_status=?,image_roles=?,translations=?,search_keywords=?,customization=?,customization_mode=?,customization_template=? WHERE id=?').run('managed',JSON.stringify(roles),JSON.stringify(cleanTranslations),searchKeywords,JSON.stringify(customization.config),customization.mode,customization.template,pid);
    saveProductRecommendations(pid,recommendations);
    recordProductChange(pid);
    audit(user,'product.save',pid); return pid;
  });
}
