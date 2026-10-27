import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,copyFileSync,linkSync,existsSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=mkdtempSync(path.join(root,'tests/.tmp-image-search-')),state=path.join(dir,'state');
const source=path.join(root,'storage/image-search'),python=process.env.IMAGE_SEARCH_TEST_PYTHON;
const inference=!!python&&existsSync(path.join(source,'index.json'));
const port=42000+process.pid%1500,base='http://127.0.0.1:'+port;
let child,db,log='',sample,second,ids;
class Client{cookie='';csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:this.cookie,...options.headers}});for(const v of r.headers.getSetCookie())if(v.startsWith('bw_session='))this.cookie=v.split(';')[0];const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body,location:r.headers.get('location')};}post(url,data){return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:this.csrf,...data})});}upload(bytes,extra={}){return this.get('/api/image-search'+(extra.preview?'?preview=1':''),{method:'POST',headers:{'Content-Type':'image/webp','Accept':'application/json','X-CSRF-Token':extra.csrf??this.csrf,...extra.headers},body:bytes});}}
const admin=new Client(),guest=new Client(),other=new Client();
before(async()=>{
 mkdirSync(state,{recursive:true});
 if(inference){const info=JSON.parse(readFileSync(path.join(source,'index.json'),'utf8'));sample=info.records[0];second=info.records.find(r=>r.path!==sample.path);info.records=info.records.map(r=>({...r,products:[r.path===sample.path?1:2]}));info.partial=false;writeFileSync(path.join(state,'index.json'),JSON.stringify(info));copyFileSync(path.join(source,info.vectors),path.join(state,info.vectors));mkdirSync(path.join(state,'model'));for(const name of ['vision.onnx','manifest.json','preprocessor_config.json'])linkSync(path.join(source,'model',name),path.join(state,'model',name));}
 child=spawn(process.execPath,['apps/api/server.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATABASE_PATH:path.join(dir,'store.sqlite'),MEDIA_PATH:path.join(root,'storage/media'),ADMIN_EMAIL:'image-admin@example.com',ADMIN_PASSWORD:'image-test-password-123',FX_AUTO_UPDATE:'false',TRANSLATION_AUTO_UPDATE:'false',IMAGE_SEARCH_AUTO_UPDATE:'false',IMAGE_SEARCH_STATE:state,IMAGE_SEARCH_PYTHON:python||'missing-python-executable',PYTHONPATH:path.join(source,'runtime')},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
 let ready=false;for(let i=0;i<150;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,log);
 db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
 ids=db.prepare('select id from products order by id limit 2').all().map(r=>r.id);
 if(inference){assert.deepEqual(ids,[1,2]);db.prepare('update products set images=?,price=1000,active=1 where id=1').run(JSON.stringify([sample.path]));db.prepare('update products set images=?,price=2000,active=1 where id=2').run(JSON.stringify([second.path]));}
 await guest.get('/');await other.get('/');await admin.get('/account');assert.equal((await admin.post('/account/login',{email:'image-admin@example.com',password:'image-test-password-123'})).status,303);await admin.get('/admin/image-search');
});
after(async()=>{db?.close();if(child?.exitCode===null){child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000).unref();});}assert.ok(dir.startsWith(path.join(root,'tests/.tmp-image-search-')));rmSync(dir,{recursive:true,force:true});});
test('图片入口默认关闭，文字搜索仍可使用；后台仅管理员可访问',async()=>{
 const home=await guest.get('/');assert.equal(home.status,200);assert.doesNotMatch(home.body,/class="image-search-link"/);
 assert.equal((await guest.get('/search?q=shirt')).status,200);
 assert.equal((await guest.get('/search?mode=image')).status,503);
 assert.equal((await guest.get('/admin/image-search')).status,303);
 const preview=await admin.get('/search?mode=image');assert.equal(preview.status,200);assert.match(preview.body,/管理员预览/);
 const en=await admin.get('/search?mode=image&lang=en');assert.match(en.body,/Search by image/);assert.match(en.body,/Find styles/);
});
test('上传接口校验CSRF、来源、请求类型及大小，预览权限不能由访客冒用',async()=>{
 assert.equal((await guest.upload(Buffer.from('x'),{csrf:'wrong'})).status,403);
 assert.equal((await guest.upload(Buffer.from('x'),{headers:{Origin:'https://unrelated.invalid'}})).status,403);
 assert.equal((await guest.upload(Buffer.from('x'),{headers:{'Content-Type':'image/svg+xml'}})).status,415);
 assert.equal((await guest.upload(Buffer.alloc(8*1024*1024+1))).status,413);
 assert.equal((await guest.upload(Buffer.from('x'),{preview:true})).status,503);
});
test('不允许以试验索引或缺少验收记录的索引开放访客搜索',async()=>{
 const response=await admin.post('/admin/image-search/config',{enabled:'1',min_score:'0.65'});assert.equal(response.status,400);assert.equal((await guest.get('/search?mode=image')).status,503);
 assert.equal((await admin.post('/admin/image-search/config',{min_score:'NaN'})).status,400);
});
let queryId;
test('真实视觉模型拒绝伪装文件，并在预览中找回图库商品',{skip:!inference},async()=>{
 assert.equal((await admin.upload(Buffer.from('not-an-image'),{preview:true})).status,400);
 const result=await admin.upload(readFileSync(path.join(root,'storage/media',sample.path.slice(7))),{preview:true});assert.equal(result.status,200,result.body+log);queryId=JSON.parse(result.body).id;
 const page=await admin.get('/search?image='+queryId);assert.equal(page.status,200,page.body);assert.match(page.body,/products-grid/);assert.match(page.body,new RegExp('href="/products/'+db.prepare('select slug from products where id=1').get().slug+'"'));
 assert.equal((await other.get('/search?image='+queryId)).status,410);assert.equal((await admin.get('/search?image=missing')).status,410);
});
test('筛选仅针对图片候选集，下架和换图立即剔除，不回退全库',{skip:!inference},async()=>{
 let r=await admin.get('/search?image='+queryId+'&min=999999');assert.equal(r.status,200);assert.match(r.body,/暂未找到足够相似/);assert.doesNotMatch(r.body,/class="product-card"/);
 r=await admin.get('/search?image='+queryId+'&collection=nonexistent');assert.doesNotMatch(r.body,/class="product-card"/);
 db.prepare('update products set active=0').run();r=await admin.get('/search?image='+queryId);assert.match(r.body,/暂未找到足够相似/);
 db.prepare("update products set active=1,images='[]'").run();r=await admin.get('/search?image='+queryId);assert.match(r.body,/暂未找到足够相似/);
});
test('纯色图片不给出伪匹配；并发识别有明确上限',{skip:!inference},async()=>{
 const blank=await admin.upload(readFileSync(path.join(root,'tests/fixtures/image-search-blank.png')),{preview:true});assert.equal(blank.status,200,blank.body);
 const empty=await admin.get('/search?image='+JSON.parse(blank.body).id);assert.match(empty.body,/暂未找到足够相似/);
 const bytes=readFileSync(path.join(root,'storage/media',sample.path.slice(7)));
 const responses=await Promise.all([admin.upload(bytes,{preview:true}),admin.upload(bytes,{preview:true})]);assert.deepEqual(responses.map(r=>r.status).sort(),[200,429]);
});
test('负责人明确授权可按相似款模式发布，记录必须匹配完整索引版本',{skip:!inference},async()=>{
 const index=JSON.parse(readFileSync(path.join(state,'index.json'),'utf8'));
 writeFileSync(path.join(state,'release-approval.json'),JSON.stringify({ownerApproved:true,mode:'similar_styles',generation:'wrong'}));
 assert.equal((await admin.post('/admin/image-search/config',{enabled:'1',min_score:'0.90'})).status,400);
 writeFileSync(path.join(state,'release-approval.json'),JSON.stringify({ownerApproved:true,mode:'similar_styles',generation:index.generation,accepted:false,reason:'Explicit owner launch request despite known cross-view limits'}));
 assert.equal((await admin.post('/admin/image-search/config',{enabled:'1',min_score:'0.90'})).status,303);
 const home=await guest.get('/');assert.match(home.body,/class="image-search-link"/);
 assert.equal((await guest.get('/search?mode=image')).status,200);
 const upload=await guest.upload(readFileSync(path.join(root,'storage/media',sample.path.slice(7))));assert.equal(upload.status,200,upload.body);
 const id=JSON.parse(upload.body).id;assert.equal((await guest.get('/search?image='+id)).status,200);
 assert.equal((await other.get('/search?image='+id)).status,410);
 assert.equal((await admin.post('/admin/image-search/config',{min_score:'0.90'})).status,303);
 assert.equal((await guest.get('/search?mode=image')).status,503);
});
