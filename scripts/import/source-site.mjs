/** Idempotent original-media backfill. Existing operator content and stock are preserved. */
import { readFileSync, readdirSync, existsSync, writeFileSync, openSync, readSync, closeSync, statSync, linkSync, copyFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { db, transaction, now, settings, putSetting, audit } from '../../apps/api/db.mjs';
import { saveMedia } from '../../apps/api/media.mjs';
import { root, config } from '../../apps/api/config.mjs';
import { cents } from '../../packages/contracts/validation.mjs';
import { defaultTeamGroup } from '../../packages/contracts/team-taxonomy.mjs';
const sourceDir=path.join(root,'data/source/shoplazza-2026-10-14');
const catalog=JSON.parse(readFileSync(path.join(sourceDir,'catalog-source.json'),'utf8'));
const home=existsSync(path.join(sourceDir,'home-source.json'))?JSON.parse(readFileSync(path.join(sourceDir,'home-source.json'),'utf8')):catalog.home;
const imagesOnly=process.argv.includes('--images-only');
const absolute=u=>new URL(u,'https://www.chenyikan.shop/').href;
const map=new Map();const issues=[];
function registerCaptured(a){
  if(!/^[a-f0-9]{64}$/.test(a.sha256)||!/^assets\/[a-f0-9]{64}\.[a-z0-9]+$/.test(a.file))throw new Error('Invalid captured image reference');
  const source=path.join(sourceDir,a.file),size=statSync(source).size;
  if(size!==a.bytes||!size||size>64*1024*1024)throw new Error('Captured image size mismatch');
  const head=Buffer.alloc(12),fd=openSync(source,'r');try{readSync(fd,head,0,12,0);}finally{closeSync(fd);}
  let ext,type;
  if(head.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))){ext='png';type='image/png';}
  else if(head[0]===255&&head[1]===216&&head[2]===255){ext='jpg';type='image/jpeg';}
  else if(head.subarray(0,4).toString()==='RIFF'&&head.subarray(8,12).toString()==='WEBP'){ext='webp';type='image/webp';}
  else if(/^GIF8[79]a$/.test(head.subarray(0,6).toString())){ext='gif';type='image/gif';}
  else throw new Error('Unsupported original image type');
  const mediaPath='/media/'+a.sha256+'.'+ext,target=path.join(config.mediaDir,path.basename(mediaPath));
  if(!existsSync(target)){try{linkSync(source,target);}catch{copyFileSync(source,target);}}
  db.prepare('INSERT OR IGNORE INTO media(path,name,content_type,bytes,hash,source_url,created_at) VALUES(?,?,?,?,?,?,?)').run(mediaPath,path.basename(new URL(a.url).pathname),type,size,a.sha256,a.url,now());
  return {path:mediaPath};
}
let newMedia=0,existingMedia=0,createdProducts=0,updatedProductImages=0;
const assetFiles=readdirSync(path.join(sourceDir,'asset-index')).filter(f=>f.endsWith('.json'));
for(let offset=0;offset<assetFiles.length;offset+=100){transaction(()=>{for(const file of assetFiles.slice(offset,offset+100)){
  const a=JSON.parse(readFileSync(path.join(sourceDir,'asset-index',file),'utf8'));
  if(!a.file||!a.sha256||!existsSync(path.join(sourceDir,a.file)))continue;
  const existing=db.prepare('SELECT path FROM media WHERE hash=?').get(a.sha256);
  if(existing){map.set(a.url,existing.path);existingMedia++;continue;}
  try{const m=registerCaptured(a);map.set(a.url,m.path);newMedia++;}catch(err){issues.push({url:a.url,error:err.message});}
}});if(offset%1000===0)console.log('媒体登记 '+Math.min(offset+100,assetFiles.length)+'/'+assetFiles.length);}
const national=new Set('argentina mexico netherlands england japan portugal italy france germany brazil spain wales belgium denmark turkiye switzerland croatia sweden finland ireland poland norway jamaica uruguay paraguay chile canada panama guatemala morocco senegal tunisia algeria ivory-coast cameroon ghana egypt nigeria south-korea iraq qatar iran australia saudi-arabian jordan'.split(' '));
const nonTeam=new Set('2026-27-season 2025-26-season 2024-25-season kids-size retro autumn-and-winter-series trench-coat shorts-f9eg national-team club-team africa america asia europe serie-a premier-league ligue-1 bundesliga la-liga other-teams brazilian-club league more-links more-links-5clo home privacy-statement terms-of-service returns-refund-policy'.split(' '));
transaction(()=>{
  if(!imagesOnly){
    for(const c of catalog.collections){
      const saved=c.sourceId&&db.prepare('SELECT collection_id FROM source_collections WHERE source_id=?').get(c.sourceId);
      const alias={'2025-26-season':'2025-26season','shorts-f9eg':'shorts'}[c.slug];
      let old=saved?db.prepare('SELECT * FROM collections WHERE id=?').get(saved.collection_id):db.prepare('SELECT * FROM collections WHERE slug=?').get(c.slug);
      if(!old&&alias){old=db.prepare('SELECT * FROM collections WHERE slug=?').get(alias);if(old){db.prepare('UPDATE collections SET slug=? WHERE id=?').run(c.slug,old.id);old.slug=c.slug;}}
      const img=map.get(absolute(home.collectionImages?.[c.slug]||''))||'';
      if(old){if(!old.image&&img)db.prepare('UPDATE collections SET image=? WHERE id=?').run(img,old.id);}
      else {const kind=national.has(c.slug)?'national':nonTeam.has(c.slug)?'other':'club';db.prepare('INSERT INTO collections(slug,name,kind,position,image,home_featured,team_group) VALUES(?,?,?,?,?,0,?)').run(c.slug,c.name.slice(0,100),kind,1000,img,defaultTeamGroup(c.slug,kind)||(kind==='club'?'other-clubs':''));}
      const cid=old?.id||db.prepare('SELECT id FROM collections WHERE slug=?').get(c.slug).id;
      if(c.sourceId)db.prepare('INSERT OR IGNORE INTO source_collections VALUES(?,?,?)').run(c.sourceId,cid,c.slug);
    }
  }
  for(const p of catalog.products){
    const sourceSlug=p.handle;
    if(!sourceSlug||!p.title){issues.push({sourceId:p.id,error:'Missing product title or slug'});continue;}
    const raw=(p.images||[]).map(i=>i.src).filter(Boolean);const available=raw.map(u=>map.get(absolute(u))).filter(Boolean);
    const mapped=db.prepare('SELECT product_id FROM source_products WHERE source_id=?').get(p.id);
    let local=mapped?db.prepare('SELECT * FROM products WHERE id=?').get(mapped.product_id):db.prepare('SELECT * FROM products WHERE slug=?').get(sourceSlug);
    if(!local&&imagesOnly)continue;
    if(!local){
      const localSlug=sourceSlug.length>250?sourceSlug.slice(0,210).replace(/-+$/,'')+'-'+p.id:sourceSlug;
      const id=Number(db.prepare('INSERT INTO products(slug,title,description,price,compare_price,images,active,source_url,source_status,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(localSlug,p.title.slice(0,250),p.description||'',cents(String(p.price||'0')),cents(String(p.compare_at_price||'0')),JSON.stringify(available),p.published===false?0:1,'https://www.chenyikan.shop/products/'+sourceSlug,'source-imported',now()).lastInsertRowid);
      local=db.prepare('SELECT * FROM products WHERE id=?').get(id);createdProducts++;
      for(const v of p.variants||[]){
        // Source stock belongs to the source store. New-store stock starts at zero.
        const sku='SRC-'+v.id;
        const vid=Number(db.prepare('INSERT INTO variants(product_id,sku,label,price,stock,active) VALUES(?,?,?,?,0,?)').run(id,sku,(v.title||'默认规格').slice(0,100),cents(String(v.price||p.price||'0')),v.available===false?0:1).lastInsertRowid);
        db.prepare('INSERT OR IGNORE INTO source_variants VALUES(?,?)').run(v.id,vid);
      }
      if(!p.variants?.length)db.prepare('INSERT INTO variants(product_id,sku,label,price,stock,active) VALUES(?,?,?,?,0,0)').run(id,'SRC-UNKNOWN-'+p.id,'规格待核实',local.price);
    }else{
      const old=JSON.parse(local.images),merged=['source-imported','homepage-only'].includes(local.source_status)?[...available,...old.filter(u=>!available.includes(u))]:old;
      if(JSON.stringify(merged)!==JSON.stringify(old)){db.prepare('UPDATE products SET images=?,updated_at=? WHERE id=?').run(JSON.stringify(merged),now(),local.id);updatedProductImages++;}
    }
    db.prepare('INSERT INTO source_products(source_id,product_id,source_slug,imported_at) VALUES(?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET imported_at=excluded.imported_at').run(p.id,local.id,sourceSlug,now());
    if(!imagesOnly)for(const slug of p._collections||[]){const source=catalog.collections.find(c=>c.slug===slug);const link=source?.sourceId&&db.prepare('SELECT collection_id FROM source_collections WHERE source_id=?').get(source.sourceId);const c=link?db.prepare('SELECT id FROM collections WHERE id=? AND deleted_at IS NULL').get(link.collection_id):db.prepare('SELECT id FROM collections WHERE slug=? AND deleted_at IS NULL').get(slug);if(c)db.prepare('INSERT OR IGNORE INTO product_collections VALUES(?,?)').run(local.id,c.id);}
  }
  for(const [slug,url] of Object.entries(home.collectionImages||{})){
    const img=map.get(absolute(url));if(img)db.prepare("UPDATE collections SET image=? WHERE slug=? AND image='' AND deleted_at IS NULL").run(img,slug);
  }
  const current=settings().home;
  for(const slide of current.slides){
    const s=home.slides?.find(s=>s.href===slide.href);
    const img=s&&map.get(absolute(s.image));if(img&&!slide.image)slide.image=img;
  }
  if(!current.extraImages?.length)current.extraImages=(home.extraImages||[]).map(i=>({...i,image:map.get(absolute(i.image))||''})).filter(i=>i.image);
  putSetting('home',current);audit(null,'source.media-import',JSON.stringify({createdProducts,updatedProductImages,newMedia}));
});
const report={importedAt:now(),imagesOnly,sourceProducts:catalog.products.length,createdProducts,updatedProductImages,newMedia,existingMedia,totalMedia:db.prepare('SELECT COUNT(*) n FROM media').get().n,totalProducts:db.prepare('SELECT COUNT(*) n FROM products').get().n,productsWithoutImages:db.prepare("SELECT COUNT(*) n FROM products WHERE images='[]'").get().n,issues};
writeFileSync(path.join(root,'data/manifests/source-import.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));db.close();
