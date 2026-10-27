import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { translationChunks, parseTranslation, myMemoryTranslate, azureTranslate, baiduTranslate, deeplTranslate, TranslationError } from '../apps/api/translation-provider.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder = mkdtempSync(path.join(root,'tests/.tmp-translations-'));
process.env.DATABASE_PATH = path.join(folder,'test.sqlite');
process.env.TRANSLATION_AUTO_UPDATE = 'false';
const {db,putSetting,product} = await import('../apps/api/db.mjs');
const engine = await import('../apps/api/auto-translation.mjs');
const {localizedProduct,detail,home,orderBody} = await import('../apps/storefront/views.mjs');
const {localizeMarkup,translateText} = await import('../apps/storefront/translations.mjs');
const providers = await import('../apps/api/translation-providers.mjs');
const {translationPanel} = await import('../apps/admin/translations.mjs');
// Avoid creating any media files: the templates below intentionally use no images.
putSetting('product_customization_templates',{club:{printing:{enabled:true,label:'自定义名称 + 编号',placeholder:'Ronaldo#7',price:300,maxLength:500},patches:{enabled:true,label:'选择一款臂章贴片',options:[{id:'league',name:'联盟臂章',price:300,image:'',enabled:true}]}},national:{}});

beforeEach(() => {
  db.exec("DELETE FROM translation_jobs; DELETE FROM translation_usage; DELETE FROM translation_provider_usage; DELETE FROM translation_provider_state; DELETE FROM products; DELETE FROM pages; DELETE FROM settings WHERE key='translation_providers';");
  putSetting('translation_state',{});putSetting('translation_config',{enabled:true,dailyLimit:4500});
  putSetting('site',{name:'球世界-1',announcement:'购买3件或以上商品即可享受免运费',currency:'USD'});
  putSetting('home',{slides:[{title:'2026-27赛季',description:'我们使用与顶级奢侈品牌相同的制造商和优质材料，但我们的产品不赚取任何利润。',image:'',href:'/'}],sections:[]});
  engine.scanPublicTranslationSources();
});
after(() => { db.close();assert.ok(path.relative(path.join(root,'tests'),folder).startsWith('.tmp-translations-'));rmSync(folder,{recursive:true,force:true}); });
function insert(title='自动翻译新球衣',description='商品中文详细说明') {
  const id=Number(db.prepare('INSERT INTO products(slug,title,description,price,updated_at) VALUES(?,?,?,1700,?)').run('translate-'+Date.now(),title,description,new Date().toISOString()).lastInsertRowid);
  engine.scanPublicTranslationSources();return id;
}
const context = {locale:'en',url:new URL('http://localhost/?lang=en'),session:{csrf:'abc',cart:'[]'}};

test('翻译按UTF-8字节分段，不截断中文、emoji或补充平面字符',()=>{
  const text='测试球衣𠮷👕。'.repeat(200),chunks=translationChunks(text);
  assert.ok(chunks.length>1);assert.ok(chunks.every(t=>Buffer.byteLength(t)<=480));
  assert.equal(chunks.join(''),text);assert.ok(chunks.every(t=>!t.includes('\uFFFD')));
});
test('官方响应校验：实体还原、额度耗尽、语言不支持、混入中文与异常结果',()=>{
  const options={source:'球衣',target:'en'};
  assert.equal(parseTranslation({responseStatus:200,responseData:{translatedText:'Children&#39;s &amp; adults'}},options),"Children's & adults");
  assert.throws(()=>parseTranslation({responseStatus:429,responseDetails:'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY. NEXT AVAILABLE IN 00 HOURS 12 MINUTES 30 SECONDS'},options),e=>e.code==='quota'&&e.retryMs===810000);
  assert.throws(()=>parseTranslation({responseStatus:403,responseDetails:'INVALID LANGUAGE PAIR'},options),e=>e.code==='unsupported');
  assert.throws(()=>parseTranslation({responseStatus:200,responseData:{translatedText:'球衣'}},options),e=>e.code==='invalid');
  assert.throws(()=>parseTranslation({responseStatus:500,responseData:{translatedText:'Internal error'}},options));
});
test('免费接口使用固定HTTPS地址，不需要密钥，网络故障有安全错误',async()=>{
  const value=await myMemoryTranslate('测试','zh-CN','en',async(url,options)=>{
    assert.equal(url.origin,'https://api.mymemory.translated.net');assert.equal(url.searchParams.get('q'),'测试');
    assert.equal(url.searchParams.get('langpair'),'zh-CN|en');assert.ok(!url.searchParams.has('key'));assert.equal(options.redirect,'error');
    return {status:200,text:async()=>JSON.stringify({responseStatus:200,responseData:{translatedText:'Test'}})};
  });assert.equal(value,'Test');
  await assert.rejects(()=>myMemoryTranslate('测试','zh-CN','en',async()=>{throw new Error('secret-token');}),e=>e.code==='network'&&!e.message.includes('secret-token'));
});
test('新商品自动排队、去重和持久缓存，原文保持中文',async()=>{
  const id=insert();engine.enqueuePublicTranslations('en');
  const size=db.prepare('SELECT COUNT(*) n FROM translation_jobs').get().n;
  assert.equal(engine.automaticTranslation('自动翻译新球衣','en'),null);assert.equal(engine.automaticTranslation('自动翻译新球衣','en'),null);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM translation_jobs').get().n,size);
  await engine.processTranslationQueue({force:true,maxJobs:100,translate:async(text)=>text==='自动翻译新球衣'?'New translated jersey':'Product description'});
  assert.equal(engine.automaticTranslation('自动翻译新球衣','en'),'New translated jersey');
  assert.equal(product(id).title,'自动翻译新球衣');assert.equal(localizedProduct(product(id),'en').title,'New translated jersey');
  let calls=0;await engine.processTranslationQueue({force:true,translate:async()=>{calls++;}});assert.equal(calls,0);
});
test('原文修改不复用旧缓存，旧任务不发送；人工商品译文优先',async()=>{
  const id=insert('待改标题','');engine.enqueuePublicTranslations('en');
  db.prepare('UPDATE products SET title=? WHERE id=?').run('修改后的新标题',id);engine.enqueuePublicTranslations('en');
  const sent=[];await engine.processTranslationQueue({force:true,maxJobs:100,translate:async(text)=>{sent.push(text);return 'New title';}});
  assert.ok(!sent.includes('待改标题'));assert.ok(sent.includes('修改后的新标题'));
  db.prepare('UPDATE products SET translations=? WHERE id=?').run(JSON.stringify({en:{title:'Merchant-reviewed title'}}),id);
  assert.equal(localizedProduct(product(id),'en').title,'Merchant-reviewed title');
});
test('接口429暂停整个队列，重试不绕过额度等待；恢复后继续',async()=>{
  insert();engine.enqueuePublicTranslations('en');let calls=0;
  await engine.processTranslationQueue({force:true,translate:async()=>{calls++;throw new TranslationError('免费额度已用完','quota',120000);}});
  const until=engine.translationStatus().resumeAt;assert.ok(until>Date.now());
  engine.retryTranslations();await engine.processTranslationQueue({force:true,translate:async()=>{calls++;return 'Wrong';}});assert.equal(calls,1);
  await engine.processTranslationQueue({force:true,clock:()=>until+1,translate:async()=>{calls++;return 'Translated';}});assert.equal(calls,2);
  assert.equal(engine.translationStatus().counts.find(c=>c.status==='ready').count,1);
});
test('每日本地预算限制外部调用，关闭开关停止新增与处理任务',async()=>{
  insert('长标题'.repeat(45),'');engine.enqueuePublicTranslations('en');engine.saveTranslationConfig({enabled:'1',dailyLimit:'100'});
  db.prepare('INSERT INTO translation_usage(day,characters,requests) VALUES(?,100,1)').run(new Date().toISOString().slice(0,10));
  let calls=0;await engine.processTranslationQueue({force:true,translate:async()=>{calls++;return 'Translated';}});assert.equal(calls,0);
  assert.match(engine.translationStatus().lastError,/每日/);
  engine.saveTranslationConfig({dailyLimit:'100'});assert.equal(engine.automaticTranslation('长标题'.repeat(45),'fr'),null);
  assert.ok(!db.prepare("SELECT id FROM translation_jobs WHERE target_locale='fr'").get());
});
test('未注册文字、客户印字、收货地址、请求消息不会进入接口队列',()=>{
  insert();engine.enqueuePublicTranslations('en');const before=db.prepare('SELECT COUNT(*) n FROM translation_jobs').get().n;
  for(const text of ['客户姓名 王先生','客户地址 私人地址','李先生#10','Customer@example.test']){
    assert.equal(engine.automaticTranslation(text,'en'),null);localizeMarkup(`<p>${text}</p>`,'en');
  }
  assert.equal(db.prepare('SELECT COUNT(*) n FROM translation_jobs').get().n,before);
  assert.equal(localizeMarkup('<b translate="no">李先生#10</b><input value="王先生">','en'),'<b translate="no">李先生#10</b><input value="王先生">');
});
test('英文首页、商品标题、公共商品描述和定制选项使用英文，后台原文保留',()=>{
  const id=insert('2026-27赛季拜仁慕尼黑客场球衣 - 球迷版','');
  const homepage=home(context);assert.match(homepage,/We use the same manufacturers/);assert.match(homepage,/Free shipping when/);
  assert.ok(!homepage.includes('我们的产品不赚取任何利润'));assert.match(homepage,/<title>Home · Football World-1<\/title>/);
  const page=detail(product(id),context);assert.match(page,/Bayern Munich Away Jersey/);assert.match(page,/Custom name \+ number/);assert.match(page,/Choose a sleeve patch/);assert.match(page,/Orders ship within 24–48 hours/);assert.match(page,/risk-free purchase/);
  assert.ok(!page.includes('库存有限，欲购从速'));assert.equal(product(id).title,'2026-27赛季拜仁慕尼黑客场球衣 - 球迷版');
});
test('远端译文按纯文字输出，不能注入可执行HTML',async()=>{
  const id=insert('安全测试标题','');engine.enqueuePublicTranslations('en');
  await engine.processTranslationQueue({force:true,maxJobs:100,translate:async()=>'<script>alert(1)</script>'});
  const page=detail(product(id),context);assert.ok(!page.includes('<script>alert(1)</script>'));assert.match(page,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});


test('英语单位和汇率标签完整，私人订单字段即使与词典重名也保持原样',()=>{
  assert.equal(translateText(' / 件','en'),' / item');
  assert.equal(translateText('每日参考汇率 · 2026-10-15','en'),'Daily reference rates · 2026-10-15');
  const body=localizeMarkup(orderBody({id:'BW-TEST',currency:'USD',payment_status:'unpaid',fulfillment_status:'pending',customer_name:'法国',email:'private@example.test',address:{city:'德国'},tracking:'法国',items:[],subtotal:0,shipping:0,total:0}),'en');
  assert.match(body,/<span translate="no">法国 · private@example.test<\/span>/);
  assert.match(body,/<span translate="no">德国<\/span>/);
});

function enableProvider(provider,extra={}) {
  return providers.saveTranslationProvider({provider,enabled:'1',priority:{azure:10,baidu:20,deepl:30,mymemory:40}[provider],limit:{azure:1900000,baidu:45000,deepl:450000,mymemory:4500}[provider],api_key:provider==='deepl'?'test-deepl-secret-key:fx':provider==='mymemory'?'':'test-api-secret-key-123456',app_id:provider==='baidu'?'20261234567890':'',region:provider==='azure'?'eastasia':'',free_plan_confirmed:'1',...extra});
}
function jsonResponse(payload,status=200,headers={}) {return {status,text:async()=>JSON.stringify(payload),headers:{get:name=>headers[name]||null}};}

test('接力：微软额度耗尽→百度额度耗尽→DeepL成功，按接口记账并共用缓存',async()=>{
  enableProvider('azure');enableProvider('baidu');enableProvider('deepl');insert('多接口接力球衣','');engine.enqueuePublicTranslations('en');
  const calls=[];const adapters={azure:async()=>{calls.push('azure');throw new TranslationError('微软免费额度已用完','quota',86400000);},baidu:async()=>{calls.push('baidu');throw new TranslationError('百度免费额度已用完','quota',86400000);},deepl:async()=>{calls.push('deepl');return 'Failover jersey';},mymemory:async()=>{calls.push('mymemory');return 'Wrong provider';}};
  await engine.processTranslationQueue({force:true,adapters});assert.deepEqual(calls,['azure','baidu','deepl']);
  assert.equal(engine.automaticTranslation('多接口接力球衣','en'),'Failover jersey');
  const row=db.prepare("SELECT * FROM translation_jobs WHERE source_text='多接口接力球衣'").get();assert.equal(row.provider,'deepl');assert.equal(row.status,'ready');
  assert.equal(db.prepare('SELECT SUM(requests) n FROM translation_provider_usage').get().n,3);
  assert.deepEqual(db.prepare('SELECT result FROM translation_attempts ORDER BY id').all().map(r=>r.result),['quota','quota','success']);
  await engine.processTranslationQueue({force:true,adapters});assert.equal(calls.length,3);
  insert('下一件接力商品','');engine.enqueuePublicTranslations('en');await engine.processTranslationQueue({force:true,adapters});assert.deepEqual(calls,['azure','baidu','deepl','deepl']);
});
test('单一服务额度等待不阻止新配置服务接手；重试与保存不清除额度等待',async()=>{
  insert('等待配置后继续的球衣','');engine.enqueuePublicTranslations('en');
  await engine.processTranslationQueue({force:true,adapters:{mymemory:async()=>{throw new TranslationError('额度已用完','quota',3600000);}}});
  const until=providers.providerState('mymemory').resume_at;enableProvider('azure');
  assert.equal(providers.providerState('mymemory').resume_at,until);
  await engine.processTranslationQueue({force:true,adapters:{azure:async()=> 'Azure recovery'}});
  assert.equal(engine.automaticTranslation('等待配置后继续的球衣','en'),'Azure recovery');
  engine.retryTranslations();enableProvider('mymemory');assert.equal(providers.providerState('mymemory').resume_at,until);
});
test('密钥错误、网络错误、不支持语言分别跳过，单个任务不污染其他语言',async()=>{
  enableProvider('azure');enableProvider('baidu');enableProvider('deepl');insert('错误分类接力球衣','');engine.enqueuePublicTranslations('en');
  const calls=[];await engine.processTranslationQueue({force:true,adapters:{azure:async()=>{calls.push('azure');throw new TranslationError('密钥不正确','auth');},baidu:async()=>{calls.push('baidu');throw new TranslationError('此语言不支持','unsupported');},deepl:async()=>{calls.push('deepl');throw new TranslationError('连接失败','network');},mymemory:async()=>{calls.push('mymemory');return 'Recovered';}}});
  assert.deepEqual(calls,['azure','baidu','deepl','mymemory']);assert.equal(providers.providerState('azure').reason,'auth');assert.equal(providers.providerState('baidu').reason,'');assert.equal(providers.providerState('deepl').reason,'network');
  enableProvider('azure',{api_key:'replacement-azure-secret-123'});assert.equal(providers.providerState('azure').reason,'');
});
test('接口各自用量达到上限后跳过，其他渠道用量计入预算；日/月周期可恢复',async()=>{
  enableProvider('azure',{limit:'100',external_usage:'99'});enableProvider('deepl');insert('按接口预算接力球衣','');engine.enqueuePublicTranslations('en');
  const calls=[];await engine.processTranslationQueue({force:true,adapters:{azure:async()=>{calls.push('azure');return 'Wrong';},deepl:async()=>{calls.push('deepl');return 'Budget failover';}}});assert.deepEqual(calls,['deepl']);
  const month=Date.UTC(2026,9,31,23,59,59),definition=providers.translationProviders.find(p=>p.id==='azure');
  assert.equal(providers.providerPeriod(definition,month),'2026-10');assert.equal(providers.providerPeriod(definition,month+2000),'2026-11');assert.equal(providers.nextProviderPeriod(definition,month),Date.UTC(2026,10,1));
  const day=providers.translationProviders.find(p=>p.id==='mymemory');assert.equal(providers.nextProviderPeriod(day,month),Date.UTC(2026,10,1));
});
test('全部接口额度耗尽时保留任务与原文，不储存额度提示为译文',async()=>{
  enableProvider('azure');insert('全部额度耗尽球衣','');engine.enqueuePublicTranslations('en');let calls=0;
  const quota=async()=>{calls++;throw new TranslationError('免费额度耗尽','quota',600000);};await engine.processTranslationQueue({force:true,adapters:{azure:quota,mymemory:quota}});
  const row=db.prepare("SELECT * FROM translation_jobs WHERE source_text='全部额度耗尽球衣'").get();assert.equal(row.status,'pending');assert.equal(row.translated_text,'');assert.equal(row.source_text,'全部额度耗尽球衣');
  await engine.processTranslationQueue({force:true,adapters:{azure:quota,mymemory:quota}});assert.equal(calls,2);
});
test('服务端密钥加密保存、页面与状态不回显，免费档与总额上限校验生效',()=>{
  enableProvider('azure');enableProvider('baidu');enableProvider('deepl');
  const stored=db.prepare("SELECT value FROM settings WHERE key='translation_providers'").get().value;
  assert.ok(!stored.includes('test-api-secret-key'));assert.ok(!stored.includes('20261234567890'));assert.equal(providers.providerCredentials('azure').key,'test-api-secret-key-123456');
  const html=translationPanel(context),status=JSON.stringify(engine.translationStatus());assert.ok(!html.includes('test-api-secret-key'));assert.ok(!status.includes('test-api-secret-key'));assert.ok(!status.includes('secret'));
  assert.throws(()=>enableProvider('azure',{limit:'2000001'}));assert.throws(()=>enableProvider('baidu',{limit:'50001',plan:'standard'}));assert.throws(()=>enableProvider('deepl',{api_key:'paid-or-invalid-no-fx'}));assert.throws(()=>enableProvider('azure',{free_plan_confirmed:''}));
  assert.equal(providers.publicProviderStatuses().find(p=>p.id==='azure').configured,true);
});
test('单独连接测试只调用指定的服务，不能用任意文本作为外部翻译代理',async()=>{
  enableProvider('azure');enableProvider('deepl');engine.queueTranslationConnectionTest('deepl');const calls=[];
  await engine.processTranslationQueue({force:true,adapters:{azure:async()=>{calls.push('azure');return 'Wrong';},deepl:async(text)=>{calls.push('deepl');assert.equal(text,'首页');return 'Home';}}});assert.deepEqual(calls,['deepl']);
  assert.throws(()=>engine.queueTranslationConnectionTest('unknown'));assert.equal(engine.automaticTranslation('私人地址与客户姓名','en'),null);
});
test('微软接口：固定官方端点与中文语言映射，403001额度耗尽、密钥错误及限流可识别',async()=>{
  const response=await azureTranslate('球衣','zh-CN','en',{key:'key-secret'},{region:'eastasia'},async(url,options)=>{
    assert.equal(url.origin,'https://api.cognitive.microsofttranslator.com');assert.equal(url.searchParams.get('from'),'zh-Hans');assert.equal(options.headers['Ocp-Apim-Subscription-Key'],'key-secret');assert.equal(options.headers['Ocp-Apim-Subscription-Region'],'eastasia');assert.deepEqual(JSON.parse(options.body),[{Text:'球衣'}]);return jsonResponse([{translations:[{text:'Jersey',to:'en'}]}]);});assert.equal(response,'Jersey');
  await assert.rejects(()=>azureTranslate('球衣','zh-CN','en',{}, {},async()=>jsonResponse({error:{code:403001}},403)),e=>e.code==='quota');
  await assert.rejects(()=>azureTranslate('球衣','zh-CN','en',{}, {},async()=>jsonResponse({error:{code:401001}},401)),e=>e.code==='auth');
  await assert.rejects(()=>azureTranslate('球衣','zh-CN','en',{}, {},async()=>jsonResponse({error:{code:429000}},429,{'retry-after':'90'})),e=>e.code==='rate'&&e.retryMs===90000);
});
test('百度接口：POST签名、中文与韩文代码映射，余额/限流/权限/语种错误分类',async()=>{
  const key='test-private-baidu-key',appId='20261234567890';
  const result=await baiduTranslate('球衣','zh-CN','ko',{key,appId},{},async(url,options)=>{
    assert.equal(url.origin,'https://fanyi-api.baidu.com');assert.equal(options.method,'POST');assert.ok(!url.href.includes(key));const form=new URLSearchParams(options.body);assert.equal(form.get('from'),'zh');assert.equal(form.get('to'),'kor');assert.ok(!options.body.includes(key));assert.match(form.get('sign'),/^[a-f0-9]{32}$/);return jsonResponse({trans_result:[{dst:'저지'}]});});assert.equal(result,'저지');
  for(const [code,expected] of [['54004','quota'],['54003','rate'],['54001','auth'],['58001','unsupported']])await assert.rejects(()=>baiduTranslate('球衣','zh-CN','en',{key,appId},{},async()=>jsonResponse({error_code:code})),e=>e.code===expected);
});
test('DeepL只请求API Free端点，支持456额度切换；不会降级到付费端点',async()=>{
  const result=await deeplTranslate('球衣','zh-CN','en',{key:'key:fx'},{},async(url,options)=>{assert.equal(url.origin,'https://api-free.deepl.com');assert.equal(options.headers.Authorization,'DeepL-Auth-Key key:fx');assert.deepEqual(JSON.parse(options.body),{text:['球衣'],source_lang:'ZH',target_lang:'EN-US'});return jsonResponse({translations:[{text:'Jersey'}]});});assert.equal(result,'Jersey');
  await assert.rejects(()=>deeplTranslate('球衣','zh-CN','en',{key:'key:fx'},{},async()=>jsonResponse({},456)),e=>e.code==='quota');
  await assert.rejects(()=>deeplTranslate('球衣','zh-CN','en',{key:'key:fx'},{},async()=>jsonResponse({},403)),e=>e.code==='auth');
});
