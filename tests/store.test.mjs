import { languages, localeDirection } from '../packages/contracts/locales.mjs';
import { runInNewContext } from 'node:vm';
import { createHash } from 'node:crypto';
import { metaPixelHead, metaPixelNoscript, metaPixelScript } from '../apps/storefront/meta-pixel.mjs';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'tests/.tmp-'+process.pid);const port=31300+(process.pid%1000);const base='http://127.0.0.1:'+port;
let child;
class Client {
  cookie='';csrf='';
  async request(url,options={}){
    const response=await fetch(base+url,{redirect:'manual',...options,headers:{...(this.cookie?{Cookie:this.cookie}:{}),...options.headers}});
    const cookie=response.headers.get('set-cookie');if(cookie){const current=new Map(this.cookie.split(';').map(s=>s.trim()).filter(Boolean).map(s=>{const at=s.indexOf('=');return [s.slice(0,at),s.slice(at+1)];}));for(const value of response.headers.getSetCookie()){const pair=value.split(';')[0],at=pair.indexOf('=');current.set(pair.slice(0,at),pair.slice(at+1));}this.cookie=[...current].map(([key,value])=>key+'='+value).join('; ');}
    const body=await response.text();const match=body.match(/name="csrf" value="([a-f0-9]+)"/);if(match)this.csrf=match[1];
    return {status:response.status,body,location:response.headers.get('location'),headers:response.headers};
  }
  post(url,data={},headers={}){const form=new URLSearchParams({csrf:this.csrf});for(const [key,value]of Object.entries(data))for(const v of Array.isArray(value)?value:[value])form.append(key,v);return this.request(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',...headers},body:form});}
  json(url,data){return this.request(url,{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':this.csrf},body:JSON.stringify(data)});}
}
const admin=new Client(),customer=new Client(),stranger=new Client();let productId,variantId,orderId;
before(async()=>{
  mkdirSync(dir,{recursive:true});
  child=spawn(process.execPath,['apps/api/server.mjs'],{cwd:root,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',DATABASE_PATH:path.join(dir,'test.sqlite'),MEDIA_PATH:path.join(dir,'media'),ADMIN_EMAIL:'admin@local.test',ADMIN_PASSWORD:'test-password-123456',FX_AUTO_UPDATE:'false',TRANSLATION_AUTO_UPDATE:'false'},stdio:['ignore','pipe','pipe']});
  let log='';child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);
  let ready=false;for(let i=0;i<100;i++){try{const r=await fetch(base+'/health');if(r.ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
  assert.ok(ready,'Server did not start: '+log);
});
after(async()=>{
  if(child&&child.exitCode===null){child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000).unref();});}
  const relative=path.relative(path.join(root,'tests'),dir);
  assert.ok(relative.startsWith('.tmp-')&&!relative.includes(path.sep),'Cleanup target must be a direct test temp directory');
  if(existsSync(dir))rmSync(dir,{recursive:true,force:true});
});
function assertMetaPixel(page, consent = false) {
  assert.equal(page.body.split(metaPixelHead).length-1,1,'One Pixel script per document');
  assert.equal(page.body.split(metaPixelNoscript).length-1,consent?1:0,'Noscript requires prior consent');
  assert.ok(page.body.indexOf(metaPixelHead)<page.body.indexOf('</head>'));
  if(consent)assert.ok(page.body.indexOf(metaPixelNoscript)>page.body.indexOf('</head>'));
  assert.match(page.body,/id="meta-consent-panel"/);
  const policy=page.headers.get('content-security-policy');
  const hash=createHash('sha256').update(metaPixelScript).digest('base64');
  assert.ok(policy.includes(`'sha256-${hash}'`),'CSP permits exactly the rendered inline script');
  assert.match(policy,/script-src[^;]*https:\/\/connect\.facebook\.net/);
  assert.match(policy,/img-src[^;]*https:\/\/www\.facebook\.com/);
  assert.match(policy,/connect-src[^;]*https:\/\/www\.facebook\.com/);
  assert.ok(!policy.includes("'unsafe-inline'"));
}

test('Meta Pixel repeated script execution initializes once and queues only one PageView',()=>{
  let loads=0;
  const context={navigator:{},location:{hostname:'jerseyshelf.com'},addEventListener:()=>{},document:{cookie:'js_meta_consent=v1.accepted',readyState:'loading',addEventListener:()=>{},getElementById:()=>null,createElement:()=>({}),getElementsByTagName:()=>[{parentNode:{insertBefore:()=>loads++}}]}};
  context.window=context;
  runInNewContext(metaPixelScript,context);
  runInNewContext(metaPixelScript,context);
  assert.equal(loads,1);
  assert.deepEqual(Array.from(context.fbq.queue,args=>Array.from(args)),[['init','1697741321689628'],['track','PageView']]);
});

test('Meta Pixel covers storefront routes and localized markup',async()=>{
  const visitor=new Client();
  for(const url of ['/','/collections/2026-27-season','/products/2026-27-bayern-munich-away-kit-fan-edition','/search?q=shirt','/cart','/account','/track','/pages/privacy-statement']) {
    const page=await visitor.request(url);assert.equal(page.status,200,url);assertMetaPixel(page);
  }
  for(const code of ['zh-CN','en','ar']){
    const page=await visitor.request('/?lang='+code);
    assert.match(page.body,new RegExp('<html lang="'+code+'"'));
    assertMetaPixel(page);
  }
  visitor.cookie+='; js_meta_consent=v1.accepted';
  assertMetaPixel(await visitor.request('/'),true);
  assertMetaPixel(await visitor.request('/',{headers:{Cookie:visitor.cookie,'Sec-GPC':'1'}}));
  const privacy=await visitor.request('/pages/privacy-statement?lang=en');
  assert.match(privacy.body,/Meta advertising cookies and privacy notice/);
  assert.match(privacy.body,/180 days/);
  assert.equal((await visitor.request('/assets/meta-pixel.css')).status,200);
});

test('商城首页、分类、搜索与未核实规格',async()=>{
  const home=await customer.request('/');assert.equal(home.status,200);assert.match(home.body,/图片待导入/);assert.match(home.body,/2026-27赛季/);
  assert.equal((await customer.request('/collections/2026-27-season')).status,200);
  assert.match((await customer.request('/search?q=不存在的商品')).body,/暂无商品/);
  const page=await customer.request('/products/2026-27-bayern-munich-away-kit-fan-edition');assert.match(page.body,/暂不可购买/);
});

test('已有商品自动显示公共图文描述，四张本地图片可正常读取',async()=>{
  const page=await customer.request('/products/2026-27-bayern-munich-away-kit-fan-edition');
  assert.equal(page.status,200);
  assert.match(page.body,/id="product-description"/);
  assert.match(page.body,/库存有限，欲购从速/);
  assert.match(page.body,/付款后 24-48 小时内发货/);
  assert.match(page.body,/30 天内如有任何不满意/);
  assert.ok(!page.body.includes('8618594028820'));
  const template=page.body.match(/<div class="description-template"[\s\S]*?<\/section>/)[0];
  const sources=[...template.matchAll(/<img src="([^"]+)"/g)].map(m=>m[1]);
  assert.equal(sources.length,4);
  for(const src of sources){
    const r=await fetch(base+src);
    assert.equal(r.status,200);
    assert.match(r.headers.get('content-type'),/^image\/(png|webp)/);
    const bytes=Buffer.from(await r.arrayBuffer());
    assert.ok(bytes.length>9000);
    assert.ok(bytes.subarray(0,4).toString()==='RIFF'||bytes.subarray(1,4).toString()==='PNG');
  }
});
test('后台鉴权、CSRF、跨站请求保护',async()=>{
  assert.equal((await stranger.request('/admin')).status,303);
  await stranger.request('/');assert.equal((await stranger.post('/admin/settings/save',{name:'攻击'})).status,403);
  const missing=await stranger.request('/subscribe',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'email=test%40example.com'});assert.equal(missing.status,403);
  assert.equal((await stranger.post('/subscribe',{email:'test@example.com'},{Origin:'https://other.example'})).status,403);
  await admin.request('/account');assert.equal((await admin.post('/account/login',{email:'admin@local.test',password:'wrong'})).status,401);
  assert.equal((await admin.post('/account/login',{email:'admin@local.test',password:'test-password-123456'})).status,303);
  const dashboard=await admin.request('/admin');assert.equal(dashboard.status,200);
  assert.ok(!dashboard.body.includes(metaPixelHead));
  assert.ok(!dashboard.headers.get('content-security-policy').includes('facebook'));
});
test('后台模块可访问，商品增改和规格库存保存',async()=>{
  for(const p of ['products','collections','media','home','orders','pages','customers','settings','promotions','import','audit'])assert.equal((await admin.request('/admin/'+p)).status,200,p);
  const response=await admin.post('/admin/products/save',{title:'验收商品 <script>',slug:'qa-product',description:'说明\n第二行',price:'3.50',compare_price:'5.00',active:'1',images:'',collections:'25',variants:JSON.stringify([{sku:'QA-SKU',label:'M',price:'3.50',stock:2,active:true}])});
  assert.equal(response.status,303,response.body);productId=Number(response.location.match(/products\/(\d+)/)[1]);
  const edit=await admin.request(response.location);variantId=Number(edit.body.match(/data-field="id" value="(\d+)"/)[1]);
  const p=await customer.request('/products/qa-product');assert.match(p.body,/验收商品 &lt;script&gt;/);assert.match(p.body,/value="1" min="1"/);assert.ok(!p.body.includes('验收商品 <script>'));
  const update=await admin.post('/admin/products/save',{id:productId,title:'验收商品',slug:'qa-product',description:'更新后的描述',price:'3.50',compare_price:'5.00',active:'1',images:'',collections:'25',variants:JSON.stringify([{id:variantId,sku:'QA-SKU',label:'M',price:'3.50',stock:2,active:true}])});assert.equal(update.status,303);
  assert.match((await customer.request('/products/qa-product')).body,/更新后的描述/);
});
test('图片上传拒绝 SVG 和脚本，媒体目录不能遍历',async()=>{
  const r=await admin.json('/admin/media/upload',{name:'x.svg',data:Buffer.from('<svg onload="alert(1)"></svg>').toString('base64')});assert.equal(r.status,400);
  assert.equal((await stranger.request('/media/..%2fbootstrap-admin.txt')).status,404);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==','base64');
  const upload=await admin.json('/admin/media/upload',{name:'test.png',data:png.toString('base64')});assert.equal(upload.status,200);
  const mediaPath=JSON.parse(upload.body).path;assert.match(mediaPath,/^\/media\/[a-f0-9]{64}\.png$/);
  const again=await admin.json('/admin/media/upload',{name:'repeat.png',data:png.toString('base64')});assert.equal(JSON.parse(again.body).path,mediaPath);
  const media=await stranger.request(mediaPath);assert.equal(media.status,200);assert.equal(media.headers.get('content-type'),'image/png');
});
test('商品图片不限数量、允许重复，分类排序持久化与3MB上传限制',async()=>{
  assert.equal((await stranger.request('/admin/media.json')).status,303);
  const files=JSON.parse((await admin.request('/admin/media.json')).body);
  const mediaPath=files[0].path;
  const images=Array(12).fill(mediaPath),roles=['main','side','size','scene',...Array(8).fill('detail')];
  const input={title:'多图商品',slug:'qa-image-product',price:'1.00',compare_price:'0',active:'1',images,image_roles:JSON.stringify(roles),variants:JSON.stringify([{sku:'QA-IMAGE',label:'默认',price:'1.00',stock:1}])};
  const save=await admin.post('/admin/products/save',input);assert.equal(save.status,303,save.body);
  const edit=await admin.request(save.location);
  assert.match(edit.body,/本地上传/);assert.match(edit.body,/素材中心/);assert.match(edit.body,/宽高比例和数量不限/);
  const raw=edit.body.match(/id="image-initial-data" hidden>(.*?)<\/div>/)[1].replaceAll('&quot;','"');
  const saved=JSON.parse(raw);assert.equal(saved.length,12);assert.deepEqual(saved.map(i=>i.path),images);assert.deepEqual(saved.map(i=>i.role),roles);
  const front=await customer.request('/products/qa-image-product');assert.equal(front.status,200);assert.equal([...front.body.matchAll(/data-gallery=/g)].length,12);
  const tooLarge=Buffer.alloc(3*1024*1024+1);Buffer.from([137,80,78,71,13,10,26,10]).copy(tooLarge);
  assert.equal((await admin.json('/admin/media/upload',{name:'large.png',data:tooLarge.toString('base64'),purpose:'product'})).status,400);
  const bad=await admin.post('/admin/products/save',{...input,slug:'qa-image-bad',image_roles:'["main"]'});assert.equal(bad.status,400);
});
test('批量导入预检、执行、幂等与错误时不写入',async()=>{
  const data={collections:[],products:[{slug:'imported-product',title:'导入商品',price:'8.10',compare_price:'10',collections:['2026-27-season'],images:[],variants:[{sku:'IMP-1',label:'L',price:'8.10',stock:5,active:true}]}]};
  const preview=await admin.json('/admin/import',{catalog:data,dryRun:true});assert.equal(preview.status,200);assert.equal(JSON.parse(preview.body).newProducts,1);assert.equal((await customer.request('/products/imported-product')).status,404);
  assert.equal((await admin.json('/admin/import',{catalog:data,dryRun:false})).status,200);
  const again=await admin.json('/admin/import',{catalog:data,dryRun:false});assert.equal(JSON.parse(again.body).skippedProducts,1);
  const bad={...data,products:[{...data.products[0],slug:'must-not-exist',variants:[{sku:'IMP-1',label:'L',price:'8.10',stock:5}]}]};assert.equal((await admin.json('/admin/import',{catalog:bad,dryRun:false})).status,400);assert.equal((await customer.request('/products/must-not-exist')).status,404);
});
test('购物车、服务端金额、库存扣减与重复提交',async()=>{
  assert.equal((await customer.post('/cart/add',{variantId,quantity:3})).status,400);
  assert.equal((await customer.post('/cart/add',{variantId,quantity:1})).status,303);
  assertMetaPixel(await customer.request('/checkout'));
  const input={email:'buyer@example.com',name:'测试客户',country:'CN',city:'上海',address:'验收地址',postal:'200000',phone:'',checkoutKey:'same-checkout-123',total:'0'};
  const order=await customer.post('/checkout',input);assert.equal(order.status,303,order.body);orderId=order.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1];
  const repeated=await customer.post('/checkout',input);assert.equal(repeated.status,303);assert.ok(repeated.location.includes(orderId));
  const detail=await customer.request('/orders/'+orderId);assert.equal(detail.status,200);assert.match(detail.body,/\$13\.50/);assert.match(detail.body,/测试订单/);assertMetaPixel(detail);
  assert.equal((await stranger.request('/orders/'+orderId)).status,404);
  await stranger.request('/products/qa-product');assert.equal((await stranger.post('/cart/add',{variantId,quantity:2})).status,400);
});

test('后台新增及批量导入的商品自动使用同一描述模板',async()=>{
  for(const slug of ['qa-product','imported-product']){
    const page=await customer.request('/products/'+slug);
    assert.equal(page.status,200);
    assert.equal((page.body.match(/class="description-template"/g)||[]).length,1);
    assert.match(page.body,/我们的仓库/);
    assert.match(page.body,/WhatsApp<\/span> 并发送消息/);
    assert.ok(!page.body.includes('商品详细资料待导入'));
  }
  const editor=await admin.request('/admin/products/new');
  assert.match(editor.body,/新增和批量导入商品同样适用/);
});
test('订单取消恢复库存，重复取消不重复补库存',async()=>{
  await admin.request('/admin/orders/'+orderId);
  assert.equal((await admin.post('/admin/orders/update',{id:orderId,action:'cancel'})).status,303);
  assert.equal((await admin.post('/admin/orders/update',{id:orderId,action:'cancel'})).status,400);
  assert.equal((await stranger.post('/cart/add',{variantId,quantity:2})).status,303);
  assert.equal((await stranger.post('/cart/add',{variantId,quantity:1})).status,400);
});
test('注册客户、订单权限和订阅持久化',async()=>{
  const buyer=new Client();await buyer.request('/account/register');assert.equal((await buyer.post('/account/register',{email:'registered@example.com',name:'客户',password:'customer-password-123'})).status,303);
  assert.equal((await buyer.request('/account')).status,200);assert.equal((await buyer.request('/admin')).status,403);assert.equal((await buyer.request('/orders/'+orderId)).status,404);
  assert.equal((await buyer.post('/subscribe',{email:'newsletter@example.com'})).status,303);
  assert.match((await admin.request('/admin/subscribers.csv')).body,/newsletter@example.com/);
});
test('三件免邮、模拟付款、发货和状态转换约束',async()=>{
  const buyer=new Client();const page=await buyer.request('/products/imported-product');const vid=Number(page.body.match(/name="variantId" value="(\d+)" data-price/)[1]);
  assert.equal((await buyer.post('/cart/add',{variantId:vid,quantity:3})).status,303);await buyer.request('/checkout');
  const result=await buyer.post('/checkout',{email:'free@example.com',name:'免邮客户',country:'CN',city:'上海',address:'地址',postal:'200000',checkoutKey:'free-order'});assert.equal(result.status,303);
  const id=result.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1];const discountedOrder=await buyer.request('/orders/'+id);assert.match(discountedOrder.body,/满件优惠：− <\/span>\$5\.00/);assert.match(discountedOrder.body,/合计：<\/span>\$19\.30/);
  assert.equal((await admin.post('/admin/orders/update',{id,action:'ship',tracking:'QA-TRACK'})).status,400);
  assert.equal((await admin.post('/admin/orders/update',{id,action:'test-pay'})).status,303);
  assert.equal((await admin.post('/admin/orders/update',{id,action:'test-pay'})).status,400);
  assert.equal((await admin.post('/admin/orders/update',{id,action:'ship',tracking:'QA-TRACK'})).status,303);
  const detail=await buyer.request('/orders/'+id);assert.match(detail.body,/已发货/);assert.match(detail.body,/QA-TRACK/);
  assert.equal((await admin.post('/admin/orders/update',{id,action:'test-refund'})).status,400);
});
test('首页、设置、正文发布与非法内容校验',async()=>{
  await admin.request('/admin/settings');const set=await admin.post('/admin/settings/save',{name:'验收商城',logo:'',announcement:'验收公告',freeShippingQty:'3',shipping:'10.00',supportEmail:'support@example.com'});assert.equal(set.status,303);
  assert.match((await customer.request('/')).body,/验收公告/);
  await admin.request('/admin/home');const bad=await admin.post('/admin/home/save',{home:JSON.stringify({slides:[{title:'测试',description:'',image:'',href:'javascript:alert(1)'}],sections:[]})});assert.equal(bad.status,400);
  const h=await admin.post('/admin/home/save',{home:JSON.stringify({slides:[{title:'测试首页',description:'测试文案',image:'',href:'/collections/retro'}],sections:[{title:'复古',slug:'retro',enabled:true}]})});assert.equal(h.status,303);assert.match((await customer.request('/')).body,/测试首页/);
  const p=await admin.post('/admin/pages/save',{title:'测试文章',slug:'qa-article',kind:'article',published:'1',body:'<script>alert(1)</script>\n正文'});assert.equal(p.status,303);
  const article=await customer.request('/blogs/qa-article');assert.equal(article.status,200);assert.match(article.body,/&lt;script&gt;alert/);assert.ok(!article.body.includes('<script>alert'));
});
test('模拟退款恢复库存，重复退款被拒绝',async()=>{
  const buyer=new Client();await buyer.request('/');assert.equal((await buyer.post('/cart/add',{variantId,quantity:2})).status,303);await buyer.request('/checkout');
  const order=await buyer.post('/checkout',{email:'refund@example.com',name:'退款测试',country:'CN',city:'上海',address:'地址',postal:'200000',checkoutKey:'refund-order'});assert.equal(order.status,303);const id=order.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1];
  assert.equal((await admin.post('/admin/orders/update',{id,action:'test-pay'})).status,303);
  assert.equal((await admin.post('/admin/orders/update',{id,action:'test-refund'})).status,303);
  assert.equal((await admin.post('/admin/orders/update',{id,action:'test-refund'})).status,400);
  assert.equal((await buyer.post('/cart/add',{variantId,quantity:2})).status,303);
  assert.equal((await buyer.post('/cart/add',{variantId,quantity:1})).status,400);
});
test('国家队按洲、俱乐部按联赛分组，后台筛选与前台菜单同步',async()=>{
  const home=await customer.request('/');assert.match(home.body,/data-team-menu="national"/);assert.match(home.body,/data-team-menu="club"/);assert.ok(!home.body.includes('<summary>球队分类</summary>'));
  for(const title of ['欧洲','美洲','非洲','亚洲','意甲','英超联赛','法甲联赛','德甲','西甲'])assert.ok(home.body.includes('<h3>'+title+'</h3>'),title);
  const europe=JSON.parse((await admin.request('/admin/collections.json?kind=national&team_group=europe')).body);assert.ok(europe.length>=17);assert.ok(europe.every(c=>c.kind==='national'&&c.team_group==='europe'));
  const club=await admin.post('/admin/collections/save',{name:'分组验收俱乐部',slug:'qa-group-club',kind:'club',team_group:'serie-a',position:500});assert.equal(club.status,303,club.body);const id=Number(club.location.match(/collections\/(\d+)/)[1]);
  assert.match((await customer.request('/')).body,/分组验收俱乐部/);
  assert.equal((await admin.post('/admin/collections/save',{id,name:'分组验收俱乐部',slug:'qa-group-club',kind:'club',team_group:'asia',position:500})).status,400);
  assert.equal((await admin.post('/admin/collections/save',{id,name:'分组验收俱乐部',slug:'qa-group-club',kind:'club',team_group:'bundesliga',position:500})).status,303);
  const clubs=JSON.parse((await admin.request('/admin/collections.json?kind=club&team_group=bundesliga')).body);assert.ok(clubs.some(c=>c.id===id));
  assert.match((await admin.request('/admin/products/'+productId)).body,/国家队 · 欧洲/);assert.match((await admin.request('/admin/products/'+productId)).body,/俱乐部 · 德甲/);
});
test('109个语言选项、偏好记忆、RTL、多语言商品保存搜索和安全校验',async()=>{
  const visitor=new Client();
  assert.equal(languages.length,109);assert.equal(new Set(languages.map(([code])=>code)).size,109);
  for(const [locale] of languages){const page=await visitor.request('/cart?lang='+encodeURIComponent(locale));assert.equal(page.status,200,locale);assert.ok(page.body.includes('<html lang="'+locale+'" dir="'+localeDirection(locale)+'">'),locale);}
  const home=await visitor.request('/');assert.equal([...home.body.matchAll(/href="\/language\?lang=/g)].length,languages.length);
  const change=await visitor.request('/language?lang=en&return='+encodeURIComponent('/search?q=jersey&sort=newest&lang=ja'));assert.equal(change.status,303);assert.equal(change.location,'/search?q=jersey&sort=newest');assert.match(visitor.cookie,/bw_lang=en/);
  const english=await visitor.request('/');assert.match(english.body,/<html lang="en" dir="ltr">/);assert.match(english.body,/>National teams<\/summary>/);assert.match(english.body,/placeholder="Search\.\.\."/);
  const cookie='bw_lang=en';visitor.cookie=cookie;assert.match((await visitor.request('/cart')).body,/Your cart is empty/);
  assert.match((await visitor.request('/?lang=ar')).body,/<html lang="ar" dir="rtl">/);
  assert.equal((await visitor.request('/language?lang=bad')).status,400);assert.equal((await visitor.request('/language?lang=en&return='+encodeURIComponent('//evil.example'))).status,400);
  const input={title:'多语言验收商品',slug:'qa-languages',price:'4.00',compare_price:'0',active:'1',images:'',variants:JSON.stringify([{sku:'QA-LANG',label:'M',price:'4.00',stock:2}]),translations:JSON.stringify({en:{title:'Translated jersey',description:'English description <script>alert(1)</script>'},ja:{title:'翻訳ジャージ',description:'日本語の商品説明'}})};
  const save=await admin.post('/admin/products/save',input);assert.equal(save.status,303,save.body);
  visitor.cookie='bw_lang=en';const product=await visitor.request('/products/qa-languages');assert.match(product.body,/Translated jersey/);assert.match(product.body,/English description &lt;script&gt;/);assert.ok(!product.body.includes('<script>alert'));
  assert.match((await visitor.request('/products/qa-languages?lang=ja')).body,/翻訳ジャージ/);assert.match((await visitor.request('/products/qa-languages?lang=fr')).body,/多语言验收商品/);
  const search=await visitor.request('/search?q=Translated');assert.match(search.body,/Translated jersey/);assert.match((await admin.request(save.location)).body,/多语言内容/);
  assert.equal((await admin.post('/admin/products/save',{...input,slug:'qa-lang-invalid',translations:'{"bad":{"title":"X"}}'})).status,400);
});
test('搜索匹配分类中英文别名、运营关键词、描述和SKU并转义通配符',async()=>{
  const collections=JSON.parse((await admin.request('/admin/collections.json')).body),france=collections.find(c=>c.slug==='france');
  const input={title:'Blue training top',description:'description_unique_search',slug:'qa-keyword-search',price:'19',compare_price:'0',active:'1',images:'',collections:[france.id],search_keywords:'高卢雄鸡, Les Bleus, %literal_关键词',variants:JSON.stringify([{sku:'FR-KEYWORD-ONLY',label:'M',price:'19',stock:1}])};
  const save=await admin.post('/admin/products/save',input);assert.equal(save.status,303,save.body);
  const found=async q=>{const response=await customer.request('/search?q='+encodeURIComponent(q));assert.equal(response.status,200);assert.match(response.body,/href="\/products\/qa-keyword-search"/,q);assert.match(response.body,/class="results-search"/);return response.body;};
  for(const q of ['法国','France','法國','フランス','프랑스','Frankreich','فرنسا','高卢雄鸡','Les Bleus','description_unique_search','FR-KEYWORD-ONLY','literal_'])await found(q);
  const count=body=>body.match(/共 (\d+) 条结果/)[1];assert.equal(count(await found('法国')),count(await found('France')));
  assert.ok(!(await customer.request('/search?q='+encodeURIComponent('%'))).body.includes('href="/products/imported-product"'));
  assert.ok(!(await customer.request('/search?q='+encodeURIComponent("' OR 1=1 --"))).body.includes('href="/products/qa-keyword-search"'));
  const edit=await admin.request(save.location);assert.match(edit.body,/name="search_keywords"/);assert.match(edit.body,/高卢雄鸡/);
  assert.equal((await admin.post('/admin/products/save',{...input,slug:'qa-long-keywords',search_keywords:'a'.repeat(2001)})).status,400);
});
test('用户自选货币、JPY/KWD金额、结账锁汇、历史订单和篡改保护',async()=>{
  const {DatabaseSync}=await import('node:sqlite'),currencyDb=new DatabaseSync(path.join(dir,'test.sqlite'));
  const rows=JSON.parse(readFileSync(path.join(root,'data/currency/rates.json'),'utf8'));
  for(const [quote,rate]of [['JPY',150.123],['KWD',0.3]]){const row=rows.find(r=>r.quote===quote);row.rate=rate;row.date=new Date().toISOString().slice(0,10);}
  currencyDb.prepare("INSERT INTO settings(key,value) VALUES('exchange_rates',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(rows));
  const create=await admin.post('/admin/products/save',{title:'货币验收',slug:'qa-currency',price:'1.01',compare_price:'0',active:'1',images:'',variants:JSON.stringify([{sku:'QA-CURRENCY',label:'M',price:'1.01',stock:50}])});assert.equal(create.status,303);
  const buyer=new Client();const page=await buyer.request('/products/qa-currency');const vid=Number(page.body.match(/name="variantId" value="(\d+)"/)[1]);
  const pick=await buyer.request('/currency?code=JPY&return='+encodeURIComponent('/search?q=日本'));assert.equal(pick.status,303);assert.equal(new URL(pick.location,base).searchParams.get('q'),'日本');assert.match(buyer.cookie,/bw_currency=JPY/);
  const display=await buyer.request('/products/qa-currency');assert.match(display.body,/JPY/);assert.match(display.body,/152/);
  assert.match((await buyer.request('/search?q='+encodeURIComponent('货币验收')+'&min=152&max=152')).body,/href="\/products\/qa-currency"/);
  assert.ok(!(await buyer.request('/search?q='+encodeURIComponent('货币验收')+'&min=153')).body.includes('href="/products/qa-currency"'));
  assert.equal((await buyer.post('/cart/add',{variantId:vid,quantity:3})).status,303);
  const checkout=await buyer.request('/checkout'),quote=checkout.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];assert.match(checkout.body,/456/);
  rows.find(r=>r.quote==='JPY').rate=200;currencyDb.prepare("UPDATE settings SET value=? WHERE key='exchange_rates'").run(JSON.stringify(rows));
  const input={email:'currency@example.com',name:'货币测试',country:'JP',city:'Tokyo',address:'Address',postal:'1000000',checkoutKey:'currency-jpy',quote_id:quote,total:'0',currency:'KWD',fx_rate:'0'};
  const order=await buyer.post('/checkout',input);assert.equal(order.status,303,order.body);const oid=order.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1];
  const saved=currencyDb.prepare('SELECT * FROM orders WHERE id=?').get(oid);assert.equal(saved.currency,'JPY');assert.equal(saved.subtotal,456);assert.equal(saved.discount,456);assert.equal(saved.total,0);assert.equal(saved.fx_rate,'150.123');assert.equal(saved.base_total,0);assert.equal(saved.base_discount,303);assert.equal(currencyDb.prepare('SELECT unit_price FROM order_items WHERE order_id=?').get(oid).unit_price,152);
  await buyer.request('/currency?code=KWD');const history=await buyer.request('/orders/'+oid);assert.match(history.body,/结算货币：<\/span><span translate="no">JPY/);assert.match(history.body,/456/);
  assert.equal((await buyer.post('/cart/add',{variantId:vid,quantity:2})).status,303);
  const kwd=await buyer.request('/checkout'),kwdQuote=kwd.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];assert.match(kwd.body,/3\.606/);
  const kwdOrder=await buyer.post('/checkout',{...input,checkoutKey:'currency-kwd',quote_id:kwdQuote});assert.equal(kwdOrder.status,303,kwdOrder.body);const kid=kwdOrder.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1];const ks=currencyDb.prepare('SELECT currency,total,shipping FROM orders WHERE id=?').get(kid);assert.deepEqual({...ks},{currency:'KWD',total:3606,shipping:3000});
  assert.equal((await buyer.request('/currency?code=BAD')).status,400);assert.equal((await buyer.request('/currency?code=EUR&return='+encodeURIComponent('//evil.test'))).status,400);
  assert.equal((await buyer.request('/currency?code=VED')).status,503);
  assert.equal((await buyer.post('/cart/add',{variantId:vid,quantity:1})).status,303);
  const changedPage=await buyer.request('/checkout'),changedQuote=changedPage.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];
  await buyer.request('/currency?code=JPY');assert.equal((await buyer.post('/checkout',{...input,checkoutKey:'changed-currency',quote_id:changedQuote})).status,400);
  const fresh=await buyer.request('/checkout'),freshQuote=fresh.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];currencyDb.prepare('UPDATE checkout_quotes SET expires=0 WHERE id=?').run(freshQuote);assert.equal((await buyer.post('/checkout',{...input,checkoutKey:'expired-currency',quote_id:freshQuote})).status,400);
  currencyDb.close();
});
test('后台实时汇率配置入口、无API不启用、权限和参考模式标识',async()=>{
  const settings=await admin.request('/admin/settings');assert.match(settings.body,/货币与汇率/);assert.match(settings.body,/name="api_key" type="password"/);assert.match(settings.body,/API密钥：未配置/);
  assert.equal((await stranger.post('/admin/currencies/config',{mode:'reference',provider:'currencylayer'})).status,403);
  assert.equal((await admin.post('/admin/currencies/config',{mode:'live',provider:'currencylayer'})).status,400);
  assert.equal((await admin.post('/admin/currencies/config',{mode:'reference',provider:'currencylayer'})).status,303);
  assert.match((await customer.request('/')).body,/data-rate-mode="reference"/);
});
test('分类增删查改、恢复及商品关联保留',async()=>{
  await admin.request('/admin/collections');
  assert.equal((await stranger.post('/admin/collections/delete',{id:25})).status,403);
  const create=await admin.post('/admin/collections/save',{name:'验收分类',slug:'qa-collection',kind:'club',position:'99',image:'',home_featured:'1'});assert.equal(create.status,303);
  const id=Number(create.location.match(/collections\/(\d+)/)[1]);
  assert.match((await admin.request('/admin/collections?q=验收分类')).body,/qa-collection/);
  assert.ok(!(await admin.request('/admin/collections?q=不匹配名称')).body.includes('qa-collection'));
  assert.equal((await admin.post('/admin/home/save',{home:JSON.stringify({slides:[{title:'分类链接验收',description:'',image:'',href:'/collections/qa-collection'}],sections:[{title:'分类模块验收',slug:'qa-collection',enabled:true}],extraImages:[{kind:'feature',title:'分类大图验收',description:'',image:'',href:'/collections/qa-collection'}]})})).status,303);
  assert.equal((await admin.post('/admin/collections/save',{id,name:'改名分类',slug:'qa-collection-new',kind:'club',position:'101',image:'',home_featured:'1'})).status,303);
  const homeEdit=(await admin.request('/admin/home')).body;assert.match(homeEdit,/value="\/collections\/qa-collection-new"/);assert.ok(!homeEdit.includes('value="/collections/qa-collection"'));
  assert.equal((await customer.request('/collections/qa-collection-new')).status,200);
  const edit=await admin.request('/admin/products/'+productId);
  assert.match(edit.body,/刷新分类/);assert.match(edit.body,/搜索可选分类/);
  assert.equal((await admin.post('/admin/products/save',{id:productId,title:'验收商品',slug:'qa-product',description:'关联测试',price:'3.50',compare_price:'5.00',active:'1',images:'',collections:[25,id],variants:JSON.stringify([{id:variantId,sku:'QA-SKU',label:'M',price:'3.50',stock:2,active:true}])})).status,303);
  assert.equal((await admin.post('/admin/collections/delete',{id})).status,303);
  assert.equal((await customer.request('/collections/qa-collection-new')).status,404);
  assert.equal((await customer.request('/products/qa-product')).status,200);
  assert.match((await admin.request('/admin/collections?status=deleted&q=改名分类')).body,/恢复/);
  assert.ok(!JSON.parse((await admin.request('/admin/collections.json')).body).some(c=>c.id===id));
  assert.equal((await admin.post('/admin/products/save',{id:productId,title:'验收商品',slug:'qa-product',description:'删除期间编辑',price:'3.50',compare_price:'5.00',active:'1',images:'',collections:[25],variants:JSON.stringify([{id:variantId,sku:'QA-SKU',label:'M',price:'3.50',stock:2,active:true}])})).status,303);
  assert.equal((await admin.post('/admin/collections/restore',{id})).status,303);
  assert.match((await customer.request('/collections/qa-collection-new')).body,/验收商品/);
  assert.ok(JSON.parse((await admin.request('/admin/collections.json?q=改名分类')).body).some(c=>c.id===id));
});
test('旧版迁移编号冲突可修复，图片分类和来源分类表同时可用',()=>{
  const file=path.join(dir,'legacy.sqlite'),legacy=new DatabaseSync(file);
  legacy.exec(readFileSync(path.join(root,'database/migrations/001-initial.sql'),'utf8'));
  legacy.exec(readFileSync(path.join(root,'database/migrations/002-collection-management.sql'),'utf8'));
  legacy.exec(readFileSync(path.join(root,'database/migrations/003-source-assets.sql'),'utf8'));
  legacy.exec(readFileSync(path.join(root,'database/migrations/005-source-collections.sql'),'utf8'));
  for(const version of [1,2,3,4])legacy.prepare('INSERT INTO migrations VALUES(?,?)').run(version,'legacy');legacy.close();
  const result=spawnSync(process.execPath,['--input-type=module','-e',"import {db} from './apps/api/db.mjs';console.log(JSON.stringify({roles:db.prepare('PRAGMA table_info(products)').all().some(c=>c.name==='image_roles'),source:!!db.prepare('SELECT name FROM sqlite_master WHERE name=?').get('source_collections')}));db.close();"],{cwd:root,env:{...process.env,DATABASE_PATH:file,MEDIA_PATH:path.join(dir,'legacy-media')},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);assert.deepEqual(JSON.parse(result.stdout),{roles:true,source:true});
});

test('尺码、印字和臂章服务端计价，不同定制分行且订单保存快照',async()=>{
  const config={printing:{enabled:true,label:'自定义名称 + 编号',placeholder:'Ronaldo#7',price:'3.00',maxLength:50},patches:{enabled:true,label:'选择臂章',options:[{id:'league',name:'联盟臂章',price:'3.00',image:'',enabled:true},{id:'champions',name:'冠军联赛',price:'5.00',image:'',enabled:true}]}};
  const variants=[{sku:'CUSTOM-S',label:'S',price:'17.00',stock:4,active:true},{sku:'CUSTOM-M',label:'M',price:'18.00',stock:0,active:true}];
  const data={title:'定制验收球衣',slug:'qa-custom-jersey',price:'17.00',compare_price:'35.90',active:'1',images:'',variants:JSON.stringify(variants),customization:JSON.stringify(config)};
  const created=await admin.post('/admin/products/save',data);assert.equal(created.status,303,created.body);const pid=Number(created.location.match(/products\/(\d+)/)[1]);
  const edit=await admin.request(created.location),ids=[...edit.body.matchAll(/data-field="id" value="(\d+)"/g)].map(m=>Number(m[1]));assert.equal(ids.length,2);assert.match(edit.body,/印字与臂章/);
  const buyer=new Client(),page=await buyer.request('/products/qa-custom-jersey');assert.equal([...page.body.matchAll(/type="radio" name="variantId"/g)].length,2);assert.match(page.body,/name="printingName"/);assert.match(page.body,/name="patchIds"/);assert.match(page.body,/data-quantity-step="-1"/);
  assert.equal((await buyer.post('/cart/add',{variantId:ids[0],quantity:1,patchIds:'fake'})).status,400);
  assert.equal((await buyer.post('/cart/add',{variantId:ids[0],quantity:1,patchIds:['league','league']})).status,400);
  assert.equal((await buyer.post('/cart/add',{variantId:ids[0],quantity:1,printingName:'A'.repeat(51)})).status,400);
  assert.equal((await buyer.post('/cart/add',{variantId:ids[1],quantity:1})).status,400);
  const alex={variantId:ids[0],quantity:1,printingName:'Alex#7',patchIds:'league',price:'0.01',extraPrice:0};
  assert.equal((await buyer.post('/cart/add',alex)).status,303);assert.equal((await buyer.post('/cart/add',alex)).status,303);
  assert.equal((await buyer.post('/cart/add',{...alex,printingName:'Sam#9'})).status,303);
  assert.equal((await buyer.post('/cart/add',{...alex,printingName:'Third#1',quantity:2})).status,400,'Aggregate stock must include differently customized lines');
  assert.equal((await buyer.post('/cart/update',{variantId:ids[0],quantity:1})).status,400,'Ambiguous updates must not change both customizations');
  const cart=await buyer.request('/cart'),keys=[...cart.body.matchAll(/name="lineKey" value="([^"]+)"/g)].map(m=>m[1]);assert.equal(keys.length,2);assert.notEqual(keys[0],keys[1]);assert.match(cart.body,/\$23\.00/);assert.match(cart.body,/Alex#7/);assert.match(cart.body,/Sam#9/);
  assert.equal((await buyer.post('/cart/update',{lineKey:keys[0],quantity:1})).status,303);
  assert.equal((await buyer.post('/cart/update',{lineKey:keys[1],remove:'1'})).status,303);assert.ok(!(await buyer.request('/cart')).body.includes('Sam#9'));
  const checkout=await buyer.request('/checkout');assert.match(checkout.body,/Alex#7/);assert.match(checkout.body,/联盟臂章/);
  const key=checkout.body.match(/name="checkoutKey" value="([a-f0-9]+)"/)[1],order=await buyer.post('/checkout',{checkoutKey:key,email:'custom@example.com',name:'定制验收',country:'CN',city:'测试',address:'测试地址',postal:'100000',phone:''});assert.equal(order.status,303,order.body);
  const oid=order.location.match(/orders\/([^?]+)/)[1],read=new DatabaseSync(path.join(dir,'test.sqlite'),{readOnly:true}),item=read.prepare('SELECT * FROM order_items WHERE order_id=?').get(oid);read.close();
  assert.equal(item.unit_price,2300);assert.equal(item.quantity,1);assert.equal(JSON.parse(item.customization).printingName,'Alex#7');assert.equal(JSON.parse(item.customization).patches[0].name,'联盟臂章');
  config.printing.price='9.00';config.patches.options[0].name='已改名的臂章';config.patches.options[0].price='7.00';
  assert.equal((await admin.post('/admin/products/save',{...data,id:pid,variants:JSON.stringify(variants.map((v,i)=>({...v,id:ids[i],stock:i===0?3:0}))),customization:JSON.stringify(config)})).status,303);
  const historical=await buyer.request('/orders/'+oid);assert.match(historical.body,/Alex#7/);assert.match(historical.body,/联盟臂章/);assert.match(historical.body,/\$23\.00/);assert.ok(!historical.body.includes('已改名的臂章'));assert.match((await admin.request('/admin/orders/'+oid)).body,/Alex#7/);
  assert.equal((await buyer.post('/cart/add',alex)).status,303);assert.match((await buyer.request('/cart')).body,/\$33\.00/);
  config.patches.options[0].enabled=false;
  assert.equal((await admin.post('/admin/products/save',{...data,id:pid,variants:JSON.stringify(variants.map((v,i)=>({...v,id:ids[i],stock:i===0?3:0}))),customization:JSON.stringify(config)})).status,303);
  assert.match((await buyer.request('/cart')).body,/定制选项已更改/);
  assert.equal((await buyer.post('/cart/add',alex)).status,400);
});

test('来源尺码只补齐未管理的占位规格，可重复执行且不会复制原站库存',()=>{
  const script="import {db} from './apps/api/db.mjs';import {backfillSourceVariants} from './scripts/import/source-variants.mjs';db.prepare('INSERT INTO source_products VALUES(?,?,?,?)').run('qa-source',1,'qa-source','qa');const input=[{id:'qa-source',variants:[{id:'11111111-1111-1111-1111-111111111111',title:'S',price:'17',available:true}]}];const first=backfillSourceVariants(input),second=backfillSourceVariants(input);const v=db.prepare(\"SELECT * FROM variants WHERE product_id=1 AND sku LIKE 'SRC-%'\").get();console.log(JSON.stringify({first,second,label:v.label,stock:v.stock,active:v.active}));db.close();";
  const result=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:root,env:{...process.env,DATABASE_PATH:path.join(dir,'test.sqlite'),MEDIA_PATH:path.join(dir,'media')},encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const r=JSON.parse(result.stdout);assert.equal(r.first.updatedProducts,1);assert.equal(r.second.updatedProducts,0);assert.equal(r.label,'S');assert.equal(r.stock,0);assert.equal(r.active,1);
});

test('满件优惠后台管理、混合定制件数、报价变化与订单快照',async()=>{
  const rules={enabled:'1',minimumQuantity:['3','8','10'],discountAmount:['5','10','18']};
  assert.equal((await stranger.post('/admin/promotions/save',rules)).status,403);
  assert.equal((await admin.post('/admin/promotions/save',rules,{Origin:'https://other.example'})).status,403);
  assert.equal((await admin.request('/admin/promotions/save',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'enabled=1'})).status,403);
  assert.equal((await admin.post('/admin/promotions/save',{enabled:'1',minimumQuantity:['3','3'],discountAmount:['5','10']})).status,400);
  assert.equal((await admin.post('/admin/promotions/save',rules)).status,303);
  const config={printing:{enabled:true,price:'3',label:'印字'},patches:{enabled:true,options:[{id:'league',name:'联盟臂章',price:'3',image:'',enabled:true}]}};
  const save=await admin.post('/admin/products/save',{title:'优惠定制验收',slug:'promotion-test',price:'17.00',active:'1',images:'',customization:JSON.stringify(config),variants:JSON.stringify([{sku:'PROMO-S',label:'S',price:'17.00',stock:50,active:true}])});assert.equal(save.status,303,save.body);
  const vid=Number((await admin.request(save.location)).body.match(/data-field="id" value="(\d+)"/)[1]);
  const buyer=new Client(),page=await buyer.request('/products/promotion-test');assert.match(page.body,/promotion-banner/);assert.match(page.body,/买3件减/);assert.match(page.body,/件减/);
  assert.equal((await buyer.post('/cart/add',{variantId:vid,quantity:2,printingName:'Alex#7',patchIds:'league'})).status,303);
  assert.equal((await buyer.post('/cart/add',{variantId:vid,quantity:1})).status,303);
  const cart=await buyer.request('/cart');assert.match(cart.body,/discount-line/);assert.match(cart.body,/\$58\.00/);assert.match(cart.body,/\$63\.00/);
  const checkout=await buyer.request('/checkout'),quote=checkout.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];
  assert.equal((await admin.post('/admin/promotions/save',{...rules,discountAmount:['6','10','18']})).status,303);
  const input={email:'promo@example.com',name:'优惠验收',country:'CN',city:'测试',address:'测试地址',postal:'100000',checkoutKey:'promotion-order',quote_id:quote,discount:'99999',total:'0'};
  assert.equal((await buyer.post('/checkout',input)).status,400);
  const fresh=await buyer.request('/checkout');input.quote_id=fresh.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];
  const order=await buyer.post('/checkout',input);assert.equal(order.status,303,order.body);const oid=order.location.match(/orders\/([^?]+)/)[1];
  const read=new DatabaseSync(path.join(dir,'test.sqlite'),{readOnly:true}),saved=read.prepare('SELECT * FROM orders WHERE id=?').get(oid);
  assert.equal(saved.subtotal,6300);assert.equal(saved.discount,600);assert.equal(saved.base_discount,600);assert.equal(saved.shipping,0);assert.equal(saved.total,5700);assert.equal(saved.base_total,5700);assert.equal(JSON.parse(saved.discount_snapshot).amount,600);assert.equal(read.prepare('SELECT stock FROM variants WHERE id=?').get(vid).stock,47);read.close();
  const repeat=await buyer.post('/checkout',input);assert.equal(repeat.status,303);assert.ok(repeat.location.includes(oid));
  assert.equal((await admin.post('/admin/promotions/save',{...rules,enabled:'0'})).status,303);
  assert.ok(!(await buyer.request('/products/promotion-test')).body.includes('promotion-banner'));
  assert.match((await buyer.request('/orders/'+oid)).body,/满件优惠：− <\/span>\$6\.00/);assert.match((await admin.request('/admin/orders/'+oid)).body,/合计：<\/span>\$57\.00/);
  assert.equal((await admin.post('/admin/promotions/save',rules)).status,303);
  assert.equal((await buyer.post('/cart/add',{variantId:vid,quantity:8})).status,303);
  const eight=await buyer.request('/cart');assert.match(eight.body,/\$126\.00/);const lineKey=eight.body.match(/name="lineKey" value="([^"]+)"/)[1];
  assert.equal((await buyer.post('/cart/update',{lineKey,quantity:10})).status,303);assert.match((await buyer.request('/cart')).body,/\$152\.00/);
  assert.equal((await buyer.post('/cart/update',{lineKey,remove:'1'})).status,303);assert.match((await buyer.request('/cart')).body,/购物车为空/);
});
test('全商品默认定制、后台新增/导入继承、模板更新、订单快照和单品覆盖',async()=>{
  const read=new DatabaseSync(path.join(dir,'test.sqlite'),{readOnly:true});
  const templates=JSON.parse(read.prepare("SELECT value FROM settings WHERE key='product_customization_templates'").get().value);
  const inputConfig=c=>({...c,printing:{...c.printing,price:(c.printing.price/100).toFixed(2)},patches:{...c.patches,options:c.patches.options.map(p=>({...p,price:(p.price/100).toFixed(2)}))}});
  assert.equal((await stranger.post('/admin/customization/save',{template:'club',customization:JSON.stringify(inputConfig(templates.club))})).status,403);
  assert.equal((await admin.post('/admin/customization/save',{template:'__proto__',customization:'{}'})).status,400);
  assert.equal((await admin.post('/admin/customization/save',{template:'club',customization:'{broken'})).status,400);
  const disabled=inputConfig(templates.club);disabled.printing.enabled=false;
  assert.equal((await admin.post('/admin/customization/save',{template:'club',customization:JSON.stringify(disabled)})).status,400);
  const badImage=inputConfig(templates.club);badImage.patches.options[0].image='/media/'+'a'.repeat(64)+'.jpg';
  assert.equal((await admin.post('/admin/customization/save',{template:'club',customization:JSON.stringify(badImage)})).status,400);
  const emptyDefaults=await admin.request('/admin/products/new');assert.match(emptyDefaults.body,/value="inherit" selected/);assert.match(emptyDefaults.body,/继承全站模板/);assert.match(emptyDefaults.body,/当前继承：国家队模板/);
  const existing=await customer.request('/products/2026-27-bayern-munich-away-kit-fan-edition');assert.match(existing.body,/name="printingName"/);assert.match(existing.body,/name="patchIds"/);
  assert.equal((await customer.request(templates.club.patches.options[0].image)).status,200);
  const data={title:'默认定制风衣',slug:'qa-default-customization',price:'17.00',active:'1',images:'',variants:JSON.stringify([{sku:'DEFAULT-CUSTOM-S',label:'S',price:'17.00',stock:20,active:true}])};
  assert.equal((await admin.post('/admin/products/save',{...data,customization:'[]'})).status,400);
  const created=await admin.post('/admin/products/save',data);assert.equal(created.status,303,created.body);const pid=Number(created.location.match(/products\/(\d+)/)[1]);
  const vid=read.prepare('SELECT id FROM variants WHERE product_id=?').get(pid).id;
  const saved=read.prepare('SELECT customization_mode,customization_template,customization FROM products WHERE id=?').get(pid);assert.deepEqual({...saved},{customization_mode:'inherit',customization_template:'auto',customization:'{}'});
  const legacyDraft=await admin.post('/admin/products/save',{...data,title:'旧表单草稿',slug:'qa-legacy-custom-draft',customization:JSON.stringify({printing:{enabled:false,price:'0'},patches:{enabled:false,options:[]}}),variants:JSON.stringify([{sku:'LEGACY-DRAFT',label:'S',price:'17',stock:0}])});assert.equal(legacyDraft.status,303,legacyDraft.body);assert.equal(read.prepare("SELECT customization_mode FROM products WHERE slug='qa-legacy-custom-draft'").get().customization_mode,'inherit');assert.match((await customer.request('/products/qa-legacy-custom-draft')).body,/club-league/);
  assert.equal((await admin.post('/admin/products/save',{...data,id:pid,customization_mode:'bad'})).status,400);
  const buyer=new Client(),page=await buyer.request('/products/qa-default-customization');assert.match(page.body,/club-league/);assert.match(page.body,/data-printing-price="300"/);
  assert.equal((await buyer.post('/cart/add',{variantId:vid,quantity:1,printingName:'Alex#7',patchIds:'national-world-cup'})).status,400);
  assert.equal((await buyer.post('/cart/add',{variantId:vid,quantity:2,printingName:'Alex#7',patchIds:'club-league',extraPrice:'0'})).status,303);
  const checkout=await buyer.request('/checkout'),quote=checkout.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];
  const orderData={email:'inherit@example.com',name:'继承验收',country:'CN',city:'测试',address:'测试地址',postal:'100000',checkoutKey:'inherit-order',quote_id:quote};
  const order=await buyer.post('/checkout',orderData);assert.equal(order.status,303,order.body);const oid=order.location.match(/orders\/([^?]+)/)[1];
  const frozen=JSON.parse(read.prepare('SELECT customization FROM order_items WHERE order_id=?').get(oid).customization);assert.equal(frozen.template.key,'club');assert.equal(frozen.template.mode,'inherit');assert.equal(frozen.printingPrice,300);assert.equal(frozen.patches[0].name,'联盟臂章');assert.equal(read.prepare('SELECT total FROM orders WHERE id=?').get(oid).total,5600);
  const waiting=new Client();await waiting.request('/products/qa-default-customization');await waiting.post('/cart/add',{variantId:vid,quantity:1,printingName:'Sam#9',patchIds:'club-league'});const stalePage=await waiting.request('/checkout'),stale=stalePage.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];
  const changed=inputConfig(templates.club);changed.printing.price='4.00';changed.patches.options[0].name='新版联盟臂章';
  assert.equal((await admin.post('/admin/customization/save',{template:'club',customization:JSON.stringify(changed)})).status,303);
  assert.equal((await waiting.post('/checkout',{...orderData,checkoutKey:'stale-template',quote_id:stale})).status,400);
  assert.match((await waiting.request('/cart')).body,/\$24\.00/);assert.equal(read.prepare('SELECT unit_price FROM order_items WHERE order_id=?').get(oid).unit_price,2300);assert.match((await buyer.request('/orders/'+oid)).body,/\$46\.00/);assert.ok(!(await buyer.request('/orders/'+oid)).body.includes('新版联盟臂章'));
  const override={printing:{enabled:true,price:'1',label:'专属印字'},patches:{enabled:true,options:[{id:'own-patch',name:'单品臂章',price:'2',enabled:true}]}};
  const customData={...data,id:pid,customization_mode:'custom',customization:JSON.stringify(override),variants:JSON.stringify([{id:vid,sku:'DEFAULT-CUSTOM-S',label:'S',price:'17.00',stock:18,active:true}])};
  assert.equal((await admin.post('/admin/products/save',customData)).status,303);assert.match((await buyer.request('/products/qa-default-customization')).body,/data-printing-price="100"/);
  changed.printing.price='5.00';await admin.post('/admin/customization/save',{template:'club',customization:JSON.stringify(changed)});assert.match((await buyer.request('/products/qa-default-customization')).body,/data-printing-price="100"/);
  const argentina=read.prepare("SELECT id FROM collections WHERE slug='argentina'").get().id;
  assert.equal((await admin.post('/admin/products/save',{...customData,customization_mode:'inherit',collections:String(argentina),customization:''})).status,303);
  const national=await buyer.request('/products/qa-default-customization');assert.match(national.body,/national-world-cup/);assert.match(national.body,/世界杯臂章/);assert.match(national.body,/data-printing-price="300"/);
  assert.equal((await waiting.post('/checkout',{...orderData,checkoutKey:'changed-template',quote_id:stale})).status,400);assert.match((await waiting.request('/cart')).body,/定制选项已更改/);
  const batch={collections:[],products:[{slug:'qa-inherit-import',title:'导入继承',price:'17',images:[],collections:['argentina'],variants:[{sku:'INHERIT-IMPORT',label:'M',price:'17',stock:2}]}]};
  assert.equal((await admin.json('/admin/import',{catalog:batch,dryRun:true})).status,200);assert.equal((await customer.request('/products/qa-inherit-import')).status,404);
  assert.equal((await admin.json('/admin/import',{catalog:batch,dryRun:false})).status,200);assert.match((await buyer.request('/products/qa-inherit-import')).body,/national-world-cup/);
  batch.products[0].customization_mode='bad';assert.equal((await admin.json('/admin/import',{catalog:batch,dryRun:true,overwrite:true})).status,400);
  const reinit=spawnSync(process.execPath,['--input-type=module','-e',"import {db} from './apps/api/db.mjs';import {initializeCustomizationTemplates,customizationTemplates} from './apps/api/customization.mjs';initializeCustomizationTemplates();initializeCustomizationTemplates();console.log(customizationTemplates().club.printing.price);db.close();"],{cwd:root,env:{...process.env,DATABASE_PATH:path.join(dir,'test.sqlite'),MEDIA_PATH:path.join(dir,'media')},encoding:'utf8'});assert.equal(reinit.status,0,reinit.stderr);assert.equal(reinit.stdout.trim(),'500');
  await admin.post('/admin/customization/save',{template:'club',customization:JSON.stringify(inputConfig(templates.club))});read.close();
});
test('定制继承迁移保留既有配置，重复启动不改变模式',()=>{
  const file=path.join(dir,'customization-migration.sqlite'),legacy=new DatabaseSync(file);
  legacy.exec('CREATE TABLE migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
  const files=['001-initial.sql','002-collection-management.sql','003-source-assets.sql','004-product-image-roles.sql','005-source-collections.sql','006-team-groups.sql','007-product-translations.sql','008-product-search-keywords.sql','009-product-customization.sql','010-multi-currency-orders.sql','011-traffic-analytics.sql','012-quantity-promotions.sql'];
  for(const name of files){legacy.exec(readFileSync(path.join(root,'database/migrations',name),'utf8'));legacy.prepare('INSERT INTO migrations VALUES(?,?)').run(Number(name.slice(0,3)),'test');}
  const own=JSON.stringify({printing:{enabled:false,price:123},patches:{enabled:false,options:[]}});
  legacy.prepare('INSERT INTO products(slug,title,price,customization,updated_at) VALUES(?,?,?,?,?)').run('legacy-custom','原配置',1700,own,'test');legacy.prepare('INSERT INTO products(slug,title,price,updated_at) VALUES(?,?,?,?)').run('legacy-empty','空配置',1700,'test');legacy.close();
  const script="import {db} from './apps/api/db.mjs';console.log(JSON.stringify(db.prepare('SELECT customization_mode,customization_template,customization FROM products ORDER BY id').all()));db.close();";
  const run=()=>spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:root,env:{...process.env,DATABASE_PATH:file,MEDIA_PATH:path.join(dir,'migration-media')},encoding:'utf8'});
  const first=run(),second=run();assert.equal(first.status,0,first.stderr);assert.equal(second.status,0,second.stderr);assert.equal(first.stdout,second.stdout);const rows=JSON.parse(first.stdout);assert.equal(rows[0].customization_mode,'custom');assert.equal(rows[0].customization,own);assert.equal(rows[1].customization_mode,'inherit');assert.equal(rows[1].customization_template,'auto');
});
test('实时流量接口鉴权、CSRF、访客去重及登录后身份保持',async()=>{
  const a=new Client(),b=new Client(),path='/products/qa-product';
  const first=await a.request(path);assert.match(first.body,/data-product-heat-value/);assert.match(first.body,/商品热度（展示值）/);assert.ok(!first.body.includes('data-live-viewer-count'));assert.match(first.body,/name="traffic-path"/);
  assert.ok(first.headers.getSetCookie().some(c=>c.startsWith('bw_visitor=')&&c.includes('HttpOnly')&&c.includes('SameSite=Lax')));
  await b.request(path);assert.notEqual((await b.request('/admin/traffic.json')).status,200);
  const one={pageId:'a'.repeat(32),path,action:'enter'};
  assert.equal((await a.post('/api/traffic',one,{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await a.post('/api/traffic',one,{Origin:'https://outside.example'})).status,403);
  const start=await a.post('/api/traffic',one);assert.equal(start.status,200);assert.equal(JSON.parse(start.body).productOnline,1);
  assert.equal((await a.post('/api/traffic',one)).status,200);
  assert.equal((await a.post('/api/traffic',{...one,action:'heartbeat'})).status,200);
  assert.equal((await a.post('/api/traffic',{...one,pageId:'b'.repeat(32)})).status,200);
  const two=await b.post('/api/traffic',{...one,pageId:'c'.repeat(32)});assert.equal(JSON.parse(two.body).productOnline,2);
  let report=JSON.parse((await admin.request('/admin/traffic.json')).body);assert.equal(report.visitors,2);assert.equal(report.productViews,3);assert.equal(report.products[0].online,2);assert.ok(!JSON.stringify(report).includes('visitor_hash'));
  await a.post('/api/traffic',{...one,action:'leave'});report=JSON.parse((await admin.request('/admin/traffic.json')).body);assert.equal(report.online,2);
  await a.post('/api/traffic',{...one,pageId:'b'.repeat(32),action:'leave'});report=JSON.parse((await admin.request('/admin/traffic.json')).body);assert.equal(report.online,1);
  const identity=a.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('bw_visitor='));await a.request('/account');assert.equal((await a.post('/account/login',{email:'admin@local.test',password:'test-password-123456'})).status,303);
  assert.equal(a.cookie.split(';').map(c=>c.trim()).find(c=>c.startsWith('bw_visitor=')),identity);
  await a.request(path);await a.post('/api/traffic',{...one,pageId:'d'.repeat(32)});report=JSON.parse((await admin.request('/admin/traffic.json')).body);assert.equal(report.visitors,2);assert.equal(report.online,2);
  assert.match((await admin.request('/admin/traffic')).body,/实时访问统计/);
  assert.equal((await a.post('/api/traffic',{...one,pageId:'e'.repeat(32),path:'/admin'})).status,404);
  assert.equal((await a.post('/api/traffic',{...one,pageId:'e'.repeat(32),path:'/products/no-such'})).status,404);
  assert.equal(JSON.parse((await admin.request('/admin/traffic.json')).body).pageViews,4);
});


test('商品推荐排序、手动管理、过滤、新品默认和最近浏览公开卡片',async t=>{
  const read=new DatabaseSync(path.join(dir,'test.sqlite'),{readOnly:true});
  t.after(()=>read.close());
  assert.equal((await stranger.request('/admin/recommendations')).status,303);
  assert.notEqual((await customer.request('/admin/recommendations/products.json?q=QA')).status,200);
  assert.equal((await stranger.post('/admin/recommendations/save',{})).status,403);
  assert.equal((await admin.request('/admin/recommendations')).status,200);
  const settings={recommendations_enabled:'1',recommendations_title:'您可能也喜欢',recommendations_count:6,team_first:'1',recent_enabled:'1',recent_title:'最近浏览',recent_count:6,recent_capacity:30,recent_days:30,show_clear:'1'};
  assert.equal((await admin.post('/admin/recommendations/save',{...settings,recent_capacity:2})).status,400);
  assert.equal((await admin.post('/admin/recommendations/save',settings,{'X-CSRF-Token':'wrong'})).status,403);
  assert.equal((await admin.post('/admin/recommendations/save',settings,{Origin:'https://outside.example'})).status,403);
  assert.equal((await admin.post('/admin/recommendations/save',settings)).status,303);
  const makeCollection=async(name,kind)=>{const r=await admin.post('/admin/collections/save',{name,slug:'discovery-'+name,kind,position:0,team_group:''});assert.equal(r.status,303,r.body);return Number(r.location.match(/collections\/(\d+)/)[1]);};
  const team=await makeCollection('team','club'),type=await makeCollection('type','other'),season=await makeCollection('season','other');
  const image=read.prepare('SELECT path FROM media LIMIT 1').get().path;
  const payloads=new Map();
  async function create(name,cats,extra={}){
    const input={title:'DISC '+name,slug:'discovery-'+name,price:'17',compare_price:'35.90',active:'1',images:image,collections:cats.map(String),variants:JSON.stringify([{sku:'DISC-'+name,label:'S',price:'17',stock:0,active:true}]),...extra};
    const r=await admin.post('/admin/products/save',input);assert.equal(r.status,303,r.body);const id=Number(r.location.match(/products\/(\d+)/)[1]);
    const variant=read.prepare('SELECT * FROM variants WHERE product_id=?').get(id);input.id=id;input.variants=JSON.stringify([{...variant,price:'17',active:!!variant.active}]);payloads.set(id,input);return id;
  }
  const current=await create('current',[team,type,season]),sameTeam=await create('team',[team]),sameType=await create('type',[type]),sameSeason=await create('season',[season]),other=await create('other',[]),inactive=await create('inactive',[team],{active:'0'}),noImage=await create('no-image',[team],{images:''}),stock=await create('stock',[team],{variants:JSON.stringify([{sku:'DISC-stock',label:'S',price:'17',stock:9,active:true}])});
  await create('fallback',[]);
  const recIds=body=>[...(body.match(/id="recommended-products">([\s\S]*?)<\/section>/)?.[1]||'').matchAll(/<article class="product-card" data-product-id="(\d+)"/g)].map(m=>Number(m[1]));
  let page=await customer.request('/products/discovery-current');let ids=recIds(page.body);
  assert.equal(ids.length,6);assert.equal(ids[0],stock);assert.equal(ids[1],sameTeam);assert.ok(ids.indexOf(sameType)<ids.indexOf(sameSeason));assert.ok(!ids.includes(current)&&!ids.includes(inactive)&&!ids.includes(noImage));assert.equal(new Set(ids).size,ids.length);
  assert.match(page.body,/id="recent-products" hidden/);assert.match(page.body,/name="printingName"/);assert.match(page.body,/name="patchIds"/);assert.equal(read.prepare('SELECT recommendation_mode FROM products WHERE id=?').get(current).recommendation_mode,'auto_fill');
  const save=extra=>admin.post('/admin/products/save',{...payloads.get(current),recommendation_mode:'auto_fill',recommendations:JSON.stringify([other,sameType]),...extra});
  assert.equal((await save()).status,303);ids=recIds((await customer.request('/products/discovery-current')).body);assert.deepEqual(ids.slice(0,2),[other,sameType]);assert.equal(ids.length,6);
  assert.equal((await save({recommendation_mode:'manual_only'})).status,303);assert.deepEqual(recIds((await customer.request('/products/discovery-current')).body),[other,sameType]);
  for(const bad of [[current],[other,other],[999999999]])assert.equal((await save({title:'不得保存',recommendations:JSON.stringify(bad)})).status,400);
  assert.equal(read.prepare('SELECT title FROM products WHERE id=?').get(current).title,'DISC current');
  assert.equal((await save({recommendations:JSON.stringify([inactive,noImage,sameType]),recommendation_mode:'manual_only'})).status,303);assert.deepEqual(recIds((await customer.request('/products/discovery-current')).body),[sameType]);
  // Importers and older forms omitting discovery fields preserve manual configuration.
  assert.equal((await admin.post('/admin/products/save',payloads.get(current))).status,303);assert.equal(read.prepare('SELECT recommendation_mode FROM products WHERE id=?').get(current).recommendation_mode,'manual_only');assert.equal(read.prepare('SELECT COUNT(*) n FROM product_recommendations WHERE product_id=?').get(current).n,3);
  const candidates=JSON.parse((await admin.request('/admin/recommendations/products.json?q=DISC&collection=discovery-team&exclude='+current)).body);assert.ok(candidates.products.some(p=>p.id===sameTeam));assert.ok(!candidates.products.some(p=>p.id===current||p.id===other));assert.deepEqual(Object.keys(candidates.products[0]).sort(),['active','id','images','title']);
  assert.equal((await save({recommendations:'[]'})).status,303);
  assert.equal((await admin.post('/admin/recommendations/save',{...settings,only_in_stock:'1'})).status,303);ids=recIds((await customer.request('/products/discovery-current')).body);assert.ok(ids.includes(stock));assert.ok(!ids.includes(sameTeam));
  await admin.post('/admin/recommendations/save',{...settings,team_first:''});ids=recIds((await customer.request('/products/discovery-current')).body);assert.equal(ids[0],sameType);
  await admin.post('/admin/recommendations/save',settings);
  const viewsBefore=read.prepare('SELECT COUNT(*) n FROM traffic_views').get().n;
  const buyer=new Client();let recent=JSON.parse((await buyer.request(`/api/products/recent?ids=${other},${current},${other},${inactive},${noImage},999999999`)).body);assert.deepEqual(recent.ids,[other,current]);assert.match(recent.html,/\$17\.00/);assert.ok(!recent.html.includes('quick-add'));assert.ok(!recent.html.includes('customization'));
  assert.equal((await buyer.request('/api/products/recent?ids=1,x')).status,400);assert.equal((await buyer.request('/api/products/recent?ids='+Array(101).fill(current).join(','))).status,400);
  const updated={...payloads.get(other),title:'Updated <shirt>',price:'19',translations:JSON.stringify({en:{title:'Current translated shirt'}})};assert.equal((await admin.post('/admin/products/save',updated)).status,303);
  recent=JSON.parse((await buyer.request('/api/products/recent?lang=en&ids='+other)).body);assert.match(recent.html,/Current translated shirt/);assert.match(recent.html,/\$19\.00/);
  await buyer.request('/currency?code=GBP');recent=JSON.parse((await buyer.request('/api/products/recent?ids='+other)).body);assert.ok(!recent.html.includes('$19.00'));assert.match(recent.html,/GBP|£/);assert.match(recent.html,/Updated &lt;shirt&gt;/);
  assert.equal(read.prepare('SELECT COUNT(*) n FROM traffic_views').get().n,viewsBefore);
  await admin.post('/admin/recommendations/save',{...settings,recommendations_enabled:'',recent_enabled:''});const hidden=await customer.request('/products/discovery-current');assert.ok(!hidden.body.includes('id="recommended-products"')&&!hidden.body.includes('id="recent-products"'));assert.deepEqual(JSON.parse((await buyer.request('/api/products/recent?ids='+current)).body).ids,[]);
  await admin.post('/admin/recommendations/save',settings);
});


test('所有商品详情使用明确标注的展示热度，资源加载与多语言正常',async()=>{
  const buyer=new Client();
  for(const slug of ['2026-27-bayern-munich-away-kit-fan-edition','qa-product','qa-default-customization']){
    const page=await buyer.request('/products/'+slug);assert.equal(page.status,200);assert.match(page.body,/data-product-heat data-product-id="\d+" hidden/);assert.match(page.body,/商品热度（展示值）：/);assert.match(page.body,/type="module" src="\/assets\/product-heat.js"/);assert.ok(!page.body.includes('人正在浏览此商品'));
  }
  const en=await buyer.request('/products/qa-product?lang=en');assert.match(en.body,/Product interest \(simulated\):/);
  const js=await buyer.request('/assets/product-heat.js');assert.equal(js.status,200);assert.match(js.headers.get('content-type'),/javascript/);assert.match(js.body,/sessionStorage/);assert.match(js.body,/visibilitychange/);
  const contract=await buyer.request('/assets/product-heat-contract.js');assert.equal(contract.status,200);assert.match(contract.body,/simulated-product-heat-v1/);
});

test('自动翻译后台受鉴权和CSRF保护，新发布商品排队，设置与免费连接测试可管理',async()=>{
  const visitor=new Client();assert.equal((await visitor.request('/admin/translations')).status,303);
  assert.equal((await visitor.request('/admin/translations/status.json')).status,303);
  await visitor.request('/');assert.equal((await visitor.post('/admin/translations/config',{enabled:'1',dailyLimit:'4500'})).status,403);
  const page=await admin.request('/admin/translations');assert.equal(page.status,200);assert.match(page.body,/免费翻译接口自动接力/);
  assert.equal((await admin.request('/assets/translations-admin.js')).status,200);
  assert.equal((await admin.post('/admin/translations/config',{enabled:'1',dailyLimit:'99999999'})).status,400);
  assert.equal((await admin.post('/admin/translations/config',{enabled:'1',dailyLimit:'4500'})).status,303);
  const result=await admin.post('/admin/products/save',{title:'自动接口验收球衣',slug:'auto-translation-shirt',description:'自动接口验收商品说明',price:'17',compare_price:'35.9',active:'1',images:'',variants:JSON.stringify([{sku:'TRANSLATE-S',label:'S',price:'17',stock:1,active:true}])});assert.equal(result.status,303,result.body);
  const read=new DatabaseSync(path.join(dir,'test.sqlite'),{readOnly:true});
  assert.equal(read.prepare("SELECT title FROM products WHERE slug='auto-translation-shirt'").get().title,'自动接口验收球衣');
  assert.ok(read.prepare("SELECT id FROM translation_jobs WHERE source_text='自动接口验收球衣' AND target_locale='en' AND status='pending'").get());
  assert.equal((await admin.post('/admin/translations/test')).status,303);
  assert.ok(read.prepare("SELECT id FROM translation_jobs WHERE source_text='首页' AND target_locale='en'").get());
  const status=JSON.parse((await admin.request('/admin/translations/status.json')).body);assert.equal(status.enabled,true);assert.equal(status.dailyLimit,4500);assert.ok(status.counts.some(row=>row.status==='pending'));
  assert.equal((await admin.post('/admin/translations/queue',{locale:'invalid'})).status,400);
  assert.equal((await admin.post('/admin/translations/retry')).status,303);
  assert.equal((await admin.request('/api/translations?text=私人地址&lang=en')).status,404);
  read.close();
});
