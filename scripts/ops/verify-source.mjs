import { readFileSync, statSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { db } from '../../apps/api/db.mjs';
import { root, config } from '../../apps/api/config.mjs';
const dir=path.join(root,'data/source/shoplazza-2026-10-14');
const manifest=JSON.parse(readFileSync(path.join(dir,'manifest.json'),'utf8'));
const catalog=JSON.parse(readFileSync(path.join(dir,'catalog-source.json'),'utf8'));
const siteUrls=JSON.parse(readFileSync(path.join(dir,'sitemap-urls.json'),'utf8'));
const report={sourceProducts:catalog.products.length,sourceCollections:catalog.collections.length,imageUrls:Object.keys(manifest.assets).length,downloadFailures:manifest.failures.length,missingOriginalFiles:[],missingLocalFiles:[],galleryMissing:[],galleryOrderDifferences:[],collectionDifferences:[],unmappedProducts:[],missingSitemapProducts:[]};
const localByHash=new Map(db.prepare('SELECT hash,path,bytes FROM media').all().map(m=>[m.hash,m]));
const sourceHashes=new Map(Object.values(manifest.assets).filter(a=>a.sha256).map(a=>[a.sha256,a.bytes]));
report.uniqueSourceImages=sourceHashes.size;
report.originalImageBytes=[...sourceHashes.values()].reduce((sum,n)=>sum+n,0);
for(const [url,a] of Object.entries(manifest.assets)){
  if(!a.file||!existsSync(path.join(dir,a.file))||statSync(path.join(dir,a.file)).size!==a.bytes){report.missingOriginalFiles.push(url);continue;}
  const m=localByHash.get(a.sha256),file=m&&path.join(config.mediaDir,path.basename(m.path));
  if(!m||!existsSync(file)||statSync(file).size!==a.bytes)report.missingLocalFiles.push(url);
}
const handles=new Set(catalog.products.map(p=>p.handle));
report.missingSitemapProducts=siteUrls.filter(u=>u.includes('/products/')&&!handles.has(u.split('/').pop()));
for(const p of catalog.products){
  const local=db.prepare('SELECT p.* FROM products p JOIN source_products s ON s.product_id=p.id WHERE s.source_id=?').get(p.id);
  if(!local){report.unmappedProducts.push(p.id);continue;}
  if(!['source-imported','homepage-only'].includes(local.source_status))continue;
  const images=JSON.parse(local.images);
  const expected=(p.images||[]).map(i=>{const a=manifest.assets[new URL(i.src,'https://www.chenyikan.shop/').href];return a&&localByHash.get(a.sha256)?.path;});
  if(JSON.stringify(images.slice(0,expected.length))!==JSON.stringify(expected))report.galleryOrderDifferences.push(p.handle);
  for(const i of p.images||[]){const url=new URL(i.src,'https://www.chenyikan.shop/').href,a=manifest.assets[url],m=a&&localByHash.get(a.sha256);if(!m||!images.includes(m.path))report.galleryMissing.push({product:p.handle,url});}
}
for(const c of catalog.collections){
  const local=db.prepare('SELECT c.* FROM collections c JOIN source_collections s ON s.collection_id=c.id WHERE s.source_id=?').get(c.sourceId);
  if(!local){report.collectionDifferences.push({slug:c.slug,error:'Unmapped collection'});continue;}
  if(local.deleted_at)continue;
  const ids=new Set(db.prepare('SELECT s.source_id FROM product_collections pc JOIN source_products s ON s.product_id=pc.product_id WHERE pc.collection_id=?').all(local.id).map(p=>p.source_id));
  const missing=(c.products||[]).filter(id=>!ids.has(id));
  if(missing.length)report.collectionDifferences.push({slug:c.slug,missing});
}
report.totalLocalProducts=db.prepare('SELECT COUNT(*) n FROM products').get().n;
report.uniqueMediaFiles=localByHash.size;
report.productsWithoutImages=db.prepare("SELECT COUNT(*) n FROM products WHERE images='[]'").get().n;
report.seasonProducts=db.prepare("SELECT COUNT(*) n FROM product_collections pc JOIN collections c ON c.id=pc.collection_id WHERE c.slug='2026-27-season'").get().n;
report.ok=report.downloadFailures===0&&['missingOriginalFiles','missingLocalFiles','galleryMissing','galleryOrderDifferences','collectionDifferences','unmappedProducts','missingSitemapProducts'].every(k=>report[k].length===0);
report.verifiedAt=new Date().toISOString();
writeFileSync(path.join(root,'data/manifests/image-verification.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));db.close();if(!report.ok)process.exitCode=1;
