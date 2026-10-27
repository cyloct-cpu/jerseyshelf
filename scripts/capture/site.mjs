/** Public HTML crawler. Does not execute source scripts or submit source forms. */
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root } from '../../apps/api/config.mjs';
const base=new URL('https://www.chenyikan.shop/');
const runId=new Date().toISOString().replace(/[:.]/g,'-'),dest=path.join(root,'data/source',runId);
mkdirSync(dest,{recursive:true});mkdirSync(path.join(root,'data/normalized'),{recursive:true});
const manifest={source:base.href,startedAt:new Date().toISOString(),pages:[],assets:[],failures:[],complete:false};
const digest=b=>createHash('sha256').update(b).digest('hex');
const decode=s=>s.replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'");
const pending=[base.href],seen=new Set(),assetUrls=new Set();
const maxPages=Number(process.env.CAPTURE_MAX_PAGES||20000);
async function get(url){let last;for(let i=0;i<2;i++){try{const r=await fetch(url,{headers:{'User-Agent':'BallworldMigration/1.0 (public content archive)'},signal:AbortSignal.timeout(15000),redirect:'error'});if(!r.ok)throw new Error('HTTP '+r.status);return{bytes:Buffer.from(await r.arrayBuffer()),type:r.headers.get('content-type')||''};}catch(err){last=err;}}throw last;}
function resolve(raw,from){try{return new URL(decode(raw),from);}catch{return null;}}
function writeManifest(){writeFileSync(path.join(root,'data/manifests/crawl-'+runId+'.json'),JSON.stringify(manifest,null,2));}
function discover(html,url){
  for(const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)){const u=resolve(m[1],url);if(u?.origin===base.origin&&/^\/(collections|products|pages|blogs)(\/|$)/.test(u.pathname)){u.hash='';if(!seen.has(u.href))pending.push(u.href);}}
  for(const m of html.matchAll(/(?:src|data-src|href|poster)=["']([^"']+)["']/gi)){const u=resolve(m[1],url);if(u&&/\.(png|jpe?g|webp|gif|css|woff2?)(\?|$)/i.test(u.href))assetUrls.add(u.href);}
  for(const m of html.matchAll(/url\(["']?([^)'"\s]+)["']?\)/gi)){const u=resolve(m[1],url);if(u)assetUrls.add(u.href);}
  for(const m of html.matchAll(/(?:srcset|data-srcset)=["']([^"']+)["']/gi))for(const entry of m[1].split(',')){const u=resolve(entry.trim().split(/\s+/)[0],url);if(u)assetUrls.add(u.href);}
}
const structured=[];
try{
  // A failed homepage stops this run; no fabricated content or guessed product endpoints.
  const first=await get(base.href);writeFileSync(path.join(dest,'home.html'),first.bytes);manifest.pages.push({url:base.href,file:'home.html'});seen.add(base.href);pending.shift();
  discover(first.bytes.toString('utf8'),base.href);
  const parseSchema=html=>{for(const m of html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)){try{structured.push(JSON.parse(m[1]));}catch{}}};
  parseSchema(first.bytes.toString('utf8'));
  // Standard sitemap, if present, improves coverage. Missing sitemap is reported.
  try{const map=await get(new URL('/sitemap.xml',base).href);writeFileSync(path.join(dest,'sitemap.xml'),map.bytes);const maps=[];for(const m of map.bytes.toString().matchAll(/<loc>([^<]+)<\/loc>/g)){const u=resolve(m[1],base.href);if(u?.origin!==base.origin)continue;if(/\.xml$/.test(u.pathname))maps.push(u.href);else pending.push(u.href);}for(const mapUrl of maps){const nested=await get(mapUrl);for(const m of nested.bytes.toString().matchAll(/<loc>([^<]+)<\/loc>/g)){const u=resolve(m[1],base.href);if(u?.origin===base.origin)pending.push(u.href);}}}catch(err){manifest.failures.push({url:new URL('/sitemap.xml',base).href,error:err.message});}
  while(pending.length&&seen.size<maxPages){const url=pending.shift();if(seen.has(url))continue;seen.add(url);const u=new URL(url);if(u.origin!==base.origin||!/^\/(collections|products|pages|blogs)(\/|$)/.test(u.pathname))continue;
    try{const page=await get(url),file=digest(url)+'.html';writeFileSync(path.join(dest,file),page.bytes);manifest.pages.push({url,file});const html=page.bytes.toString('utf8');discover(html,url);parseSchema(html);}
    catch(err){manifest.failures.push({url,error:err.message});}
    if(seen.size%20===0){writeManifest();console.log('已采集页面 '+manifest.pages.length+'，失败 '+manifest.failures.length);}
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  const assetDir=path.join(dest,'assets');mkdirSync(assetDir,{recursive:true});
  const allowed=new Set([base.hostname,'img.staticdj.com']);
  for(const url of assetUrls){const u=new URL(url);if(u.protocol!=='https:'||!allowed.has(u.hostname)){manifest.failures.push({url,error:'Asset host requires review before download'});continue;}
    try{const asset=await get(url),ext=path.extname(u.pathname).toLowerCase(),file=digest(asset.bytes)+(/^[.][a-z0-9]{2,5}$/.test(ext)?ext:'.bin');if(!existsSync(path.join(assetDir,file)))writeFileSync(path.join(assetDir,file),asset.bytes);manifest.assets.push({url,file:'assets/'+file,sha256:digest(asset.bytes),bytes:asset.bytes.length,contentType:asset.type});}
    catch(err){manifest.failures.push({url,error:err.message});}
  }
  writeFileSync(path.join(dest,'structured-data.json'),JSON.stringify(structured,null,2));
  manifest.queueRemaining=pending.length;manifest.complete=pending.length===0&&manifest.failures.length===0;
  console.log('采集结束，结构化资料尚需清洗和核验；此脚本不把采集成功等同于完整复刻。');
}catch(err){manifest.failures.push({url:base.href,error:err.message});console.error('首页采集失败：'+err.message);process.exitCode=1;}
manifest.finishedAt=new Date().toISOString();writeManifest();console.log('报告：data/manifests/crawl-'+runId+'.json');
