// Live smoke checks use public product images; no orders, messages or inventory changes.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import path from 'node:path';
for(const line of readFileSync('/etc/jerseyshelf.env','utf8').split(/\r?\n/)){const m=line.match(/^([A-Z_]+)=(.*)$/);if(m)process.env[m[1]]=m[2].replace(/^['"]|['"]$/g,'');}
const root='/www/wwwroot/jerseyshelf';
const {db}=await import(pathToFileURL(root+'/apps/api/db.mjs').href);
const {random,hash}=await import(pathToFileURL(root+'/apps/api/security.mjs').href);
const {saveImageSearchConfig,imageSearchStatus}=await import(pathToFileURL(root+'/apps/api/image-search.mjs').href);
const base='https://jerseyshelf.com';
const state=root+'/storage/image-search';
class Client{
 cookie='';csrf='';
 async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',signal:AbortSignal.timeout(30000),...options,headers:{Cookie:this.cookie,...options.headers}});for(const c of r.headers.getSetCookie())if(c.startsWith('bw_session='))this.cookie=c.split(';')[0];const body=await r.text();this.csrf=body.match(/(?:name="csrf" value|data-csrf)="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body};}
 upload(bytes,preview=false){return this.get('/api/image-search'+(preview?'?preview=1':''),{method:'POST',headers:{'Content-Type':'image/jpeg',Accept:'application/json','X-CSRF-Token':this.csrf},body:bytes});}
}
const adminId=db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get().id;
const token=random(),tokenHash=hash(token),csrf=random();
db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,cart,expires) VALUES(?,?,?,?,?)').run(tokenHash,adminId,csrf,'[]',Date.now()+300000);
const admin=new Client();admin.cookie='bw_session='+token;admin.csrf=csrf;
const checks=[];
const verify=(condition,label)=>{assert.ok(condition,label);checks.push(label);};
let enabled=false;
try{
 const index=JSON.parse(readFileSync(state+'/index.json','utf8'));
 const active=db.prepare('SELECT id FROM products WHERE active=1').all();
 const covered=new Set(index.records.flatMap(r=>r.products));
 verify(active.every(p=>covered.has(p.id)),'all_active_products_covered');
 const before=await admin.get('/admin/image-search');verify(before.status===200,'admin_page_200');
 const samples=index.records.filter(r=>/\.(?:webp|png|jpe?g)$/i.test(r.path));
 const selected=[samples[0],samples[Math.floor(samples.length/2)],samples.at(-1)];
 const sampleResults=[];
 for(const row of selected){const bytes=readFileSync(path.join(root,'storage/media',row.path.slice(7)));const result=await admin.upload(bytes,true);verify(result.status===200,'private_preview_upload_200');const data=JSON.parse(result.body);const page=await admin.get('/search?image='+data.id);verify(page.status===200,'private_preview_results_200');const matches=db.prepare(`SELECT slug FROM products WHERE active=1 AND id IN (${row.products.map(()=>'?').join(',')})`).all(...row.products);verify(matches.some(p=>page.body.includes('/products/'+p.slug)),'private_preview_expected_style_found');sampleResults.push({productIds:row.products,ms:data.ms});}
 saveImageSearchConfig({enabled:'1',min_score:'0.90'},adminId);enabled=true;
 const guest=new Client(),stranger=new Client();
 const home=await guest.get('/');verify(home.status===200&&home.body.includes('class="image-search-link"'),'public_header_camera');
 const search=await guest.get('/search?mode=image');verify(search.status===200&&search.body.includes('image-search-file')&&!search.body.includes('管理员预览：'),'public_image_search_page');
 const en=await guest.get('/search?mode=image&lang=en');verify(en.status===200&&en.body.includes('Find styles'),'english_image_search_page');
 const bytes=readFileSync(path.join(root,'storage/media',selected[0].path.slice(7)));
 const upload=await guest.upload(bytes);verify(upload.status===200,'public_upload_200');const data=JSON.parse(upload.body);
 const result=await guest.get('/search?image='+data.id);verify(result.status===200&&result.body.includes('products-grid'),'public_results_200');
 verify((await stranger.get('/search?image='+data.id)).status===410,'query_session_isolation');
 const filtered=await guest.get('/search?image='+data.id+'&min=999999');verify(filtered.status===200&&filtered.body.includes('暂未找到足够相似'),'candidate_filter_does_not_fall_back');
 verify((await guest.upload(Buffer.from('not a valid image'))).status===400,'invalid_image_rejected');
 verify((await guest.get('/api/image-search',{method:'POST',headers:{'Content-Type':'image/png',Accept:'application/json','X-CSRF-Token':'forged'},body:bytes})).status===403,'csrf_enforced');
 verify((await guest.get('/search?q=shirt')).status===200,'text_search_200');
 verify((await guest.get('/cart')).status===200,'cart_200');
 for(const asset of ['/assets/image-search.js','/assets/image-search.css','/assets/store.css'])verify((await guest.get(asset)).status===200,'asset_200:'+asset);
 const report={passed:true,at:new Date().toISOString(),generation:index.generation,coverageMode:index.coverageMode,images:index.records.length,activeProducts:active.length,checks,sampleResults,publicMs:data.ms,independentPhotoAcceptancePassed:false};
 writeFileSync(state+'/production-smoke.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({passed:true,checks:checks.length,images:index.records.length,products:active.length,sampleResults,publicMs:data.ms,status:imageSearchStatus()}));
}catch(error){
 if(enabled)saveImageSearchConfig({min_score:'0.90'},adminId);
 throw error;
}finally{
 db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash);
}
