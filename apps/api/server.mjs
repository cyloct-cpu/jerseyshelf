import { metaPixelHead, withMetaPixelCsp, hasMetaConsent, metaPrivacyNotice } from '../storefront/meta-pixel.mjs';
import {addressLocations,savedShippingAddress,clearShippingAddress} from './shipping-address.mjs';
import {centerStats,legacyCenterView,compatibleCodStats,compatibleServiceStats} from './order-center.mjs';
import {serviceCase} from './aftersales.mjs';
import {createDifferenceRefund,initializeFollowups,saveFollowup,createService,updateService,recordServiceRefund,reconciliation,recordActualCollection,saveServiceRules,serviceStats,saveServiceAttachment} from './aftersales.mjs';
import {confirmCod,codAction,remitCod,exportShipping,importTracking,codStats} from './cod.mjs';
import {importPanel} from '../admin/cod.mjs';
import http from 'node:http';
import {lookupTracking,canTrack,saveShipment,ensureShipment} from './shipments.mjs';
import {trackingForm,trackingBody} from '../storefront/tracking.mjs';
import path from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { clientAddress } from '../../packages/contracts/client-address.mjs';
import { config, root } from './config.mjs';
import { db, init, settings, putSetting, now, product, audit, transaction } from './db.mjs';
import { seed } from '../../database/seeds/catalog.mjs';
import { random, hash, passwordHash, passwordVerify, escape as e, limited } from './security.mjs';
import { InputError, email, text, int, slug, localImage, safeLink, cents } from '../../packages/contracts/validation.mjs';
import { catalog, saveProduct } from './catalog.mjs';
import { listCollections, saveCollection, changeCollectionState } from './collections.mjs';
import { cartSummary, addCartLine, changeCartLine, createOrder, getOrder, canReadOrder, updateOrder, createDirectPurchase, directPurchase, checkoutSelection } from './orders.mjs';
import { saveMedia } from './media.mjs';
import { importCatalog } from '../../scripts/import/service.mjs';
import * as store from '../storefront/views.mjs';
import { descriptionAssets } from '../storefront/product-description.mjs';
import * as admin from '../admin/views.mjs';
import { requestCurrency, currencyFx, createQuote, refreshRates, ensureDailyRates, usdFx } from './currencies.mjs';
import { fxStatus,ensureLiveRates,saveFxConfig } from './fx-provider.mjs';
import { requestLocale, validLocale } from '../../packages/contracts/locales.mjs';
import { visitorIdentity, recordTraffic, trafficSummary } from './traffic.mjs';
import { parseQuantityPromotion } from '../../packages/contracts/promotions.mjs';
import { initializeCustomizationTemplates,saveCustomizationTemplate } from './customization.mjs';
import {saveDiscoverySettings,recentProductCards} from './recommendations.mjs';
import { startTranslationWorker, scanPublicTranslationSources, enqueuePublicTranslations, translationStatus, saveTranslationConfig, retryTranslations, queueTranslationConnectionTest, saveTranslationProvider } from './auto-translation.mjs';
import {initializeCustomers,linkRegisteredCustomer,linkSubscriber,saveCustomer,saveWhatsapp,archiveCustomer,logContact,saveTask,updateTask,saveCase,updateCase,saveCustomerConfig,customerStats} from './customers.mjs';
import {recordReceipt,updateExternalOrder} from './customer-payments.mjs';
import {restoreAutomaticProfile} from './customer-profile.mjs';
import {whatsappNumber} from '../../packages/contracts/customers.mjs';
import {customerListPanel,customerDetailPanel,customerProfileForm,customerSettingsPanel,customerExport} from '../admin/customers.mjs';
import {waConfig,saveWaConfig} from './whatsapp-config.mjs';
import {storeContactUrl,customerContactUrl,checkWaConnection,enqueueWaMessage,revokeWaPermission,orderMessage,truncateWaText} from './whatsapp.mjs';
import {startWaWorker} from './whatsapp-queue.mjs';
import {verifyWaWebhook,receiveWaWebhook} from './whatsapp-webhook.mjs';
import {whatsappPanel,waContactPanel,waComposePanel} from '../admin/whatsapp.mjs';
import {whatsappButton} from '../storefront/whatsapp.mjs';
import {imageSearchEnabled,submitImageSearch,imageSearchResults,saveImageSearchConfig,rebuildImageSearch,startImageSearchSync} from './image-search.mjs';
import {imageSearchAdmin} from '../admin/image-search.mjs';
import {contactLink} from '../../packages/contracts/customers.mjs';
import {registerAccount,updateAccountContact,initializeRegistrationProfiles} from './account-registration.mjs';
import {recordAccountContactClick,revokeRegistrationPermission} from './account-permissions.mjs';
import {registrationBody,welcomeBody} from '../storefront/account-registration.mjs';
import {requirePerm,adminPermission,saveStaff,deleteStaff} from './permissions.mjs';
import {loginLocked,recordLoginFailure,clearLoginFailures,LOCK_MINUTES} from './login-guard.mjs';
import {staffPanel} from '../admin/staff.mjs';
import {paymentsPanel} from '../admin/payments.mjs';
import {paymentConfig,savePaymentConfig,testPaymentConnection,startOrderPayment,paymentRedirect,retrieveStripeSession,capturePaypalOrder,getPaymentSession,verifyStripeSignature,stripeWebhookSecret,handleStripeEvent,verifyPaypalWebhook,handlePaypalEvent} from './payments.mjs';
import {omsPanel} from '../admin/oms.mjs';
import {emailPanel} from '../admin/email.mjs';
import {emailConfig,saveEmailConfig,sendTestEmail,startEmailWorker} from './mailer.mjs';
import {importCsv,csvTemplate} from './import-csv.mjs';
import {csvImportPanel,importErrorPanel,importPreviewPanel,importDonePanel} from '../admin/import-csv.mjs';
import {createBatch,commitBatch,rollbackBatch,listBatches} from './import-batch.mjs';
import {parseMultipart} from './multipart.mjs';
import {saveFallbackConfig,testFallbackConnection} from './image-search-fallback.mjs';
import {syncConfig,saveSyncConfig,verifySyncToken,syncChanges,syncSnapshot,syncStatus} from './catalog-sync.mjs';
import {syncAdmin} from '../admin/sync.mjs';
import {omsConfig,saveOmsConfig,omsManualAction,startOmsWorker} from './oms.mjs';
import {saveTracking17Config,syncTracking17,tracking17Config} from './tracking17.mjs';
import {oauthConfig,googleEnabled,googleAuthUrl,exchangeGoogleCode,googleJwks,verifyGoogleIdToken,googleLoginOrRegister,saveOauthConfig} from './oauth.mjs';
init();seed();initializeCustomizationTemplates();initializeCustomers();initializeRegistrationProfiles();initializeFollowups();startTranslationWorker();startWaWorker();startOmsWorker();startEmailWorker();
startImageSearchSync();
const cookieOptions=`; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${config.secure?'; Secure':''}`;
function session(req,res){
  const cookie=String(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('bw_session='))?.slice(11);
  let s=cookie&&/^[a-f0-9]{64}$/.test(cookie)?db.prepare('SELECT * FROM sessions WHERE token_hash=? AND expires>?').get(hash(cookie),Date.now()):null;
  if(!s){const token=random();s={token_hash:hash(token),user_id:null,csrf:random(),cart:'[]',expires:Date.now()+604800000};db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,cart,expires) VALUES(?,?,?,?,?)').run(s.token_hash,s.user_id,s.csrf,s.cart,s.expires);res.setHeader('Set-Cookie','bw_session='+token+cookieOptions);}
  return s;
}
function rotate(res,s,userId){
  const token=random(),next={...s,token_hash:hash(token),csrf:random(),user_id:userId,expires:Date.now()+604800000};
  transaction(()=>{
    db.prepare('DELETE FROM sessions WHERE token_hash=?').run(s.token_hash);
    db.prepare('INSERT INTO sessions(token_hash,user_id,csrf,cart,expires) VALUES(?,?,?,?,?)').run(next.token_hash,next.user_id,next.csrf,next.cart,next.expires);
    db.prepare('UPDATE guest_order_access SET session_hash=? WHERE session_hash=?').run(next.token_hash,s.token_hash);
    db.prepare('UPDATE direct_purchases SET session_hash=? WHERE session_hash=?').run(next.token_hash,s.token_hash);
    db.prepare('UPDATE checkout_quotes SET session_hash=? WHERE session_hash=?').run(next.token_hash,s.token_hash);
  });
  res.setHeader('Set-Cookie','bw_session='+token+cookieOptions);return next;
}
const checkoutReturn=value=>typeof value==='string'&&/^\/checkout(?:\?purchase=[a-f0-9]{48})?$/.test(value)?value:null;
function renderCheckout(res,ctx,input=undefined,error=undefined){
  const id=input?input.purchase:ctx.url.searchParams.has('purchase')?ctx.url.searchParams.get('purchase'):undefined;
  const selection=checkoutSelection(ctx.session,id);
  if(selection.purchase?.order_id){redirect(res,'/orders/'+selection.purchase.order_id);return;}
  if(!selection.cart.items.length){redirect(res,'/cart');return;}
  ctx.purchase=selection.purchase;
  ctx.quoteId=createQuote(ctx.session,selection.cart,ctx.fx,selection.source);
  ctx.checkoutInput=input;ctx.checkoutErrors=error?.fields;ctx.checkoutError=error?.message;
  ctx.savedShippingAddress=savedShippingAddress(ctx.user);
  // Reuse a submitted key on validation errors; refreshed purchase pages are protected by purchase identity too.
  ctx.checkoutKey=typeof input?.checkoutKey==='string'?input.checkoutKey:undefined;
  send(res,store.checkout(selection.cart,ctx),error?.status||200);
}
function send(res,body,status=200,type='text/html; charset=utf-8'){if(type.startsWith('text/html')&&typeof body==='string'&&body.includes(metaPixelHead))res.setHeader('Content-Security-Policy',withMetaPixelCsp(res.getHeader('Content-Security-Policy')));res.writeHead(status,{'Content-Type':type});res.end(body);}
function json(res,obj,status=200){send(res,JSON.stringify(obj),status,'application/json; charset=utf-8');}
function redirect(res,url,message=''){res.writeHead(303,{Location:url+(message?(url.includes('?')?'&':'?')+'message='+encodeURIComponent(message):'')});res.end();}
async function readBody(req){
  let size=0,chunks=[];
  for await(const chunk of req){size+=chunk.length;if(size>12*1024*1024)throw new InputError('请求体超过 12 MB',413);chunks.push(chunk);}
  const raw=Buffer.concat(chunks).toString('utf8');
  if(String(req.headers['content-type']).includes('application/json')){try{return JSON.parse(raw);}catch{throw new InputError('JSON 格式错误');}}
  if(!String(req.headers['content-type']).includes('application/x-www-form-urlencoded'))throw new InputError('不支持的请求格式',415);
  const out={};for(const [key,value] of new URLSearchParams(raw)){if(Object.hasOwn(out,key))out[key]=Array.isArray(out[key])?[...out[key],value]:[out[key],value];else Object.defineProperty(out,key,{value,writable:true,enumerable:true,configurable:true});}return out;
}
function updateCart(s,cart){db.prepare('UPDATE sessions SET cart=? WHERE token_hash=?').run(JSON.stringify(cart),s.token_hash);}
const staticFiles={
  '/assets/meta-pixel.css':['apps/storefront/public/meta-pixel.css','text/css'],
  '/assets/store.css':['apps/storefront/public/store.css','text/css'],
  '/assets/store.js':['apps/storefront/public/store.js','text/javascript'],
  '/assets/image-search.js':['apps/storefront/public/image-search.js','text/javascript'],
  '/assets/image-search.css':['apps/storefront/public/image-search.css','text/css'],
  '/assets/shipping-address.js':['apps/storefront/public/shipping-address.js','text/javascript'],
  '/assets/admin.css':['apps/admin/public/admin.css','text/css'],
  '/assets/admin.js':['apps/admin/public/admin.js','text/javascript'],
  '/assets/customers-admin.js':['apps/admin/public/customers-admin.js','text/javascript'],
  '/assets/translations-admin.js':['apps/admin/public/translations-admin.js','text/javascript'],
  '/assets/promotions.js':['apps/admin/public/promotions.js','text/javascript'],
  '/assets/customization.js':['apps/admin/public/customization.js','text/javascript'],
  '/assets/recommendations.js':['apps/admin/public/recommendations.js','text/javascript'],
  '/assets/recent-products.js':['apps/storefront/public/recent-products.js','text/javascript'],
  '/assets/recent-products-contract.js':['packages/contracts/recent-products.mjs','text/javascript'],
  '/assets/product-heat.js':['apps/storefront/public/product-heat.js','text/javascript'],
  '/assets/product-heat-contract.js':['packages/contracts/product-heat.mjs','text/javascript']
};
function csv(v){let s=String(v);if(/^[=+\-@\t\r]/.test(s))s="'"+s;return '"'+s.replace(/"/g,'""')+'"';}
for(const asset of descriptionAssets)staticFiles['/assets/product-description/'+asset.name]=['apps/storefront/public/product-description/'+asset.name,asset.name.endsWith('.webp')?'image/webp':'image/png'];
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','same-origin');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self' https://wa.me");
  res.setHeader('Cache-Control','no-store');
  let ctx;
  try{
    const url=new URL(req.url,'http://localhost');const pathname=decodeURIComponent(url.pathname);
    if(pathname==='/webhooks/whatsapp'){
      if(req.method==='GET'){send(res,verifyWaWebhook(url.searchParams),200,'text/plain; charset=utf-8');return;}
      if(req.method!=='POST')throw new InputError('不支持的方法',405);
      let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>256*1024)throw new InputError('回调请求过大',413);chunks.push(chunk);}
      receiveWaWebhook(Buffer.concat(chunks),req.headers['x-hub-signature-256']);json(res,{ok:true});return;
    }
    // 支付回调：先限流，再验签（密钥未配置时直接拒绝，绝不降级为不验签），后处理。
    if(pathname==='/webhooks/stripe'||pathname==='/webhooks/paypal'){
      if(req.method!=='POST')throw new InputError('不支持的方法',405);
      const stripeHook=pathname==='/webhooks/stripe';
      let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;if(bytes>256*1024)throw new InputError('回调请求过大',413);chunks.push(chunk);}
      const raw=Buffer.concat(chunks).toString('utf8'),hookIp=clientAddress(req,config.trustLocalProxy);
      if(limited((stripeHook?'wh-stripe:':'wh-paypal:')+hookIp,60,60000))throw new InputError('请求过于频繁',429);
      if(stripeHook){verifyStripeSignature(raw,req.headers['stripe-signature'],stripeWebhookSecret());handleStripeEvent(raw);}
      else{await verifyPaypalWebhook(raw,req.headers);handlePaypalEvent(JSON.parse(raw));}
      json(res,{ok:true});return;
    }
    if(req.method==='GET'&&pathname==='/api/address/locations'){json(res,addressLocations(url.searchParams.get('country')));return;}
    if(req.method==='GET'&&pathname==='/api/sync/catalog'){
      if(!verifySyncToken(url.searchParams.get('token')))throw new InputError('同步令牌无效',401);
      if(limited('sync:'+clientAddress(req,config.trustLocalProxy),30,60000))throw new InputError('同步请求过于频繁',429);
      const cursor=int(url.searchParams.get('cursor')||0,'游标',0);
      const full=url.searchParams.get('full')==='1';
      const result=full?syncSnapshot():syncChanges(cursor,int(url.searchParams.get('limit')||200,'条数',1,500));
      if(!result.publicBase)result.publicBase=(config.secure?'https://':'http://')+String(req.headers.host||'');
      json(res,result);
      return;
    }
    if(req.method==='GET'&&pathname==='/health'){json(res,{ok:true});return;}
    if(req.method==='GET'&&/^\/assets\/flags\/[A-Z]{2}\.svg$/.test(pathname)){const flagFile=path.join(root,'apps/storefront/public/flags',path.basename(pathname));if(!existsSync(flagFile))throw new InputError('图标不存在',404);res.setHeader('Cache-Control','public, max-age=86400');send(res,readFileSync(flagFile),200,'image/svg+xml');return;}
    if(req.method==='GET'&&pathname==='/currency'){
      const code=url.searchParams.get('code');if(code!=='USD')await ensureLiveRates();currencyFx(code);
      const back=url.searchParams.get('return')||'/';if(!back.startsWith('/')||back.startsWith('//')||/[\\\r\n]/.test(back))throw new InputError('返回地址无效');
      const destination=new URL(back,'http://local.test');if(destination.origin!=='http://local.test')throw new InputError('返回地址无效');
      res.setHeader('Set-Cookie',`bw_currency=${code}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${config.secure?'; Secure':''}`);redirect(res,destination.pathname+destination.search+destination.hash);return;
    }
    if(req.method==='GET'&&pathname==='/language'){
      const locale=url.searchParams.get('lang');if(!validLocale(locale))throw new InputError('语言不支持');
      const back=url.searchParams.get('return')||'/';
      if(!back.startsWith('/')||back.startsWith('//')||/[\\\r\n]/.test(back))throw new InputError('返回地址无效');
      const destination=new URL(back,'http://local.test');if(destination.origin!=='http://local.test')throw new InputError('返回地址无效');
      destination.searchParams.delete('lang');
      res.setHeader('Set-Cookie',`bw_lang=${locale}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${config.secure?'; Secure':''}`);
      redirect(res,destination.pathname+destination.search+destination.hash);return;
    }
    if(req.method==='GET'&&staticFiles[pathname]){const [file,type]=staticFiles[pathname];send(res,readFileSync(path.join(root,file)),200,type+'; charset=utf-8');return;}
    if(req.method==='GET'&&/^\/media\/[a-f0-9]{64}\.(png|jpg|webp|gif)$/.test(pathname)){
      const m=db.prepare('SELECT * FROM media WHERE path=?').get(pathname);const file=path.join(config.mediaDir,path.basename(pathname));
      if(!m||!existsSync(file))throw new InputError('图片不存在',404);res.setHeader('Cache-Control','public, max-age=31536000, immutable');
      const width=url.searchParams.get('width'),derived=path.join(config.mediaDir,'derived',m.hash+'-'+width+'.webp');
      if(['480','960'].includes(width)&&existsSync(derived)){send(res,readFileSync(derived),200,'image/webp');return;}
      send(res,readFileSync(file),200,m.content_type);return;
    }
    const s=session(req,res);const user=s.user_id?db.prepare('SELECT id,email,name,role,customer_id,permissions FROM users WHERE id=?').get(s.user_id):null;
    if(req.method==='GET'&&!pathname.startsWith('/admin')&&!pathname.startsWith('/api/'))visitorIdentity(req,res);
    ctx={session:s,user,url,locale:requestLocale(req,url),fx:usdFx};
    ctx.metaMarketingConsent=hasMetaConsent(req.headers.cookie)&&req.headers['sec-gpc']!=='1';
    if(!pathname.startsWith('/admin')){const selected=requestCurrency(req,url);try{await ensureLiveRates();}catch(err){if(selected!=='USD')throw err;}ctx.fx=currencyFx(selected);}
    if(pathname.startsWith('/admin')&&user?.role!=='admin'){
      if(req.method==='GET'&&!user){redirect(res,'/account?message='+encodeURIComponent('请使用管理员账户登录'));return;}
      throw new InputError('需要管理员权限',403);
    }
    if(user?.role==='admin'){const required=adminPermission(pathname,req.method);if(required)requirePerm(user,required);}
    // A bookmarked contact URL is a normal navigation, without a form body.
    if(req.method==='GET'&&pathname==='/contact/whatsapp'){
      redirect(res,storeContactUrl({locale:ctx.locale}));return;
    }
    if(req.method==='POST'){
      const origin=req.headers.origin;
      if(origin){let source;try{source=new URL(origin);}catch{throw new InputError('跨站请求已拒绝',403);}if(!['http:','https:'].includes(source.protocol)||source.host!==req.headers.host)throw new InputError('跨站请求已拒绝',403);}
      if(pathname==='/api/image-search'){
        if(req.headers['x-csrf-token']!==s.csrf)throw new InputError('表单已过期，请刷新页面后重试',403);
        if(!['image/jpeg','image/png','image/webp'].includes(String(req.headers['content-type']).split(';')[0]))throw new InputError('请上传 JPG、PNG 或 WebP 图片',415);
        if(Number(req.headers['content-length'])>8*1024*1024)throw new InputError('图片不能超过 8 MB',413);
        let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>8*1024*1024)throw new InputError('图片不能超过 8 MB',413);chunks.push(chunk);}
        const result=await submitImageSearch(Buffer.concat(chunks),s.token_hash,clientAddress(req,config.trustLocalProxy),{preview:user?.role==='admin'&&url.searchParams.get('preview')==='1'});json(res,result);return;
      }
      if(pathname==='/admin/import/upload'){
        // 批量导入上传（清单+图片打包），multipart 上限 100 MB，仅 products.edit 可达（见权限门控）。
        if(limited('import-upload:'+s.token_hash,10,60000))throw new InputError('上传过于频繁，请稍后重试',429);
        let size=0;const chunks=[];
        for await(const chunk of req){size+=chunk.length;if(size>100*1024*1024)throw new InputError('上传内容超过 100 MB 限制',413);chunks.push(chunk);}
        const {fields,files}=parseMultipart(Buffer.concat(chunks),req.headers['content-type']);
        if(fields.csrf!==s.csrf)throw new InputError('表单已过期，请刷新页面后重试',403);
        let result;
        try{result=createBatch({fields,files,actor:user.id});}
        catch(err){
          if(!(err instanceof InputError))throw err;
          send(res,admin.adminShell('上传校验未通过',importErrorPanel(ctx,err.message),ctx),err.status||400);return;
        }
        send(res,admin.adminShell('第 2 步 · 校验预览',importPreviewPanel(ctx,result,fields),ctx));return;      }
      const input=await readBody(req);
      if((req.headers['x-csrf-token']||input.csrf)!==s.csrf)throw new InputError('表单已过期，请刷新页面后重试',403);
      const ip=clientAddress(req,config.trustLocalProxy);
      if(pathname==='/admin/image-search/config'){saveImageSearchConfig(input,user.id);redirect(res,'/admin/image-search','以图搜款设置已保存');return;}
      if(pathname==='/admin/image-search/fallback'){saveFallbackConfig(input,user.id);redirect(res,'/admin/image-search','视觉兜底配置已保存');return;}
      if(pathname==='/admin/image-search/fallback-test'){
        if(limited('is-fb-test:'+user.id,5))throw new InputError('测试过于频繁，请稍后重试',429);
        let message;try{message=await testFallbackConnection();}catch(err){if(!(err instanceof InputError))throw err;message='测试未通过：'+err.message;}
        redirect(res,'/admin/image-search',message);return;
      }
      if(pathname==='/admin/image-search/rebuild'){rebuildImageSearch(user.id);redirect(res,'/admin/image-search','图库索引更新请求已提交');return;}
      if(pathname==='/contact/whatsapp'){
        if(limited('wa-contact:'+s.token_hash,20))throw new InputError('联系操作过于频繁',429);
        const destination=storeContactUrl({...input,locale:ctx.locale},input.cart==='1'?cartSummary(JSON.parse(s.cart)):null);recordAccountContactClick(user);if(req.headers.accept==='application/json')json(res,{url:destination});else redirect(res,destination);return;
      }
      const contactOrder=pathname.match(/^\/orders\/(BW-[A-Z0-9-]+)\/whatsapp$/);
      if(contactOrder){const o=getOrder(contactOrder[1]);if(!o||!canReadOrder(o,user,s))throw new InputError('订单不存在',404);if(limited('wa-order:'+s.token_hash,20))throw new InputError('联系操作过于频繁',429);const c=waConfig();if(c.mode==='off'||!c.phone)throw new InputError('店铺WhatsApp尚未配置',503);const destination=contactLink(c.phone,truncateWaText(orderMessage(o,ctx.locale),1200));if(req.headers.accept==='application/json')json(res,{url:destination});else redirect(res,destination);return;}
      const contactCustomer=pathname.match(/^\/admin\/customers\/(\d+)\/whatsapp$/);
      if(contactCustomer){redirect(res,customerContactUrl(contactCustomer[1],input.order_id,user.id,input.message));return;}
      if(pathname==='/admin/whatsapp/config'){saveWaConfig(input,user.id);redirect(res,'/admin/whatsapp','WhatsApp设置已保存');return;}
      if(pathname==='/admin/whatsapp/check'){if(limited('wa-check:'+user.id,6))throw new InputError('检查过于频繁，请稍后重试',429);await checkWaConnection(user.id);redirect(res,'/admin/whatsapp','账号号码归属与模板读取检查通过，未发送消息');return;}
      if(pathname==='/admin/whatsapp/messages'){if(input.confirmed!=='1'||! /^[a-f0-9]{64}$/.test(input.preview_hash||''))throw new InputError('请从订单模板预览核对并确认发送');if(limited('wa-send:'+user.id,30))throw new InputError('提交过于频繁',429);enqueueWaMessage(input.order_id,input.kind,input.request_key,user.id,input.preview_hash);redirect(res,'/admin/orders/'+encodeURIComponent(input.order_id),'消息已排队，发送结果请查看消息记录');return;}
      if(pathname==='/admin/whatsapp/revoke'){revokeWaPermission(input,user.id);redirect(res,'/admin/customers/'+input.customer_id,'WhatsApp联系许可已撤回');return;}
      if(pathname==='/api/traffic'){
        const visitor=visitorIdentity(req,res);
        if(limited('traffic:'+visitor,120,60000))throw new InputError('统计请求过于频繁',429);
        json(res,recordTraffic(visitor,input));return;
      }
      if(pathname==='/track'){
        if(limited('tracking:'+ip,15)||limited('tracking-session:'+s.token_hash,10))throw new InputError('查询过于频繁，请稍后再试',429);
        try{const id=lookupTracking(input,s);redirect(res,'/track/'+encodeURIComponent(id));}
        catch(err){if(!(err instanceof InputError))throw err;send(res,store.shell('订单查询',trackingForm(ctx,err.message),ctx),err.status);}return;
      }
      if(pathname==='/admin/service/followup'){const id=saveFollowup(input,user.id);redirect(res,'/admin/orders/'+encodeURIComponent(id)+'?section=follow','跟进已保存');return;}
      if(pathname==='/admin/service/create'){const id=createService(input,user.id);redirect(res,'/admin/service/'+id,'售后单已创建');return;}
      if(pathname==='/admin/service/update'){const id=updateService(input,user.id);redirect(res,'/admin/service/'+id,'售后处理已记录');return;}
      if(pathname==='/admin/service/refund'){const id=recordServiceRefund(input,user.id);redirect(res,'/admin/service/'+id,'实际退款已核实登记');return;}
      if(pathname==='/admin/service/difference-refund'){const id=createDifferenceRefund(input,user.id);redirect(res,'/admin/service/'+id,'多收退款申请已建立，待人工审核');return;}
      if(pathname==='/admin/service/difference'){const id=reconciliation(input,user.id);redirect(res,'/admin/orders/'+encodeURIComponent(id)+'?section=money','物流差额已记录');return;}
      if(pathname==='/admin/service/collection'){const id=recordActualCollection(input,user.id);redirect(res,'/admin/orders/'+encodeURIComponent(id)+'?section=money','实际代收已核实');return;}
      if(pathname==='/admin/service/rules'){saveServiceRules(input,user.id);redirect(res,'/admin/orders?tab=aftersales','审核规则已保存');return;}
      if(pathname==='/admin/service/attachment'){const id=saveServiceAttachment(input,user.id);json(res,{id});return;}
      if(pathname==='/admin/cod/confirm'){const id=confirmCod(input,user.id);redirect(res,'/admin/orders/'+encodeURIComponent(id)+'?section=follow','货到付款资料已确认');return;}
      if(pathname==='/admin/cod/action'){const id=codAction(input,user.id);redirect(res,'/admin/orders/'+encodeURIComponent(id)+'?section=shipping','货到付款状态已登记');return;}
      if(pathname==='/admin/cod/remit'){const id=remitCod(input,user.id);redirect(res,'/admin/orders/'+encodeURIComponent(id)+'?section=money','物流回款已核实');return;}
      if(pathname==='/admin/cod/export'){const csv=exportShipping(input.order_ids||[],user.id);res.setHeader('Content-Disposition','attachment; filename="shipping-orders.csv"');send(res,csv,200,'text/csv; charset=utf-8');return;}
      if(pathname==='/admin/cod/import'){const result=importTracking(input,user.id);send(res,admin.adminShell('运单回填结果',importPanel(ctx,result),ctx));return;}
      if(pathname==='/admin/shipments/save'){const id=saveShipment(input,user.id);redirect(res,'/admin/orders/'+encodeURIComponent(id)+'?section=shipping','包裹已保存');return;}
      if(pathname==='/account/login'){
        if(limited('login:'+ip,20))throw new InputError('登录尝试过多，请稍后再重试',429);
        const login=email(input.email),pass=text(input.password,'密码',200);
        if(loginLocked(login))throw new InputError(`失败次数过多，该账号已临时锁定，请约 ${LOCK_MINUTES} 分钟后再试`,429);
        const u=db.prepare('SELECT * FROM users WHERE email=?').get(login);
        if(!u||!passwordVerify(pass,u.password)){recordLoginFailure(login);throw new InputError('邮箱或密码错误',401);}
        clearLoginFailures(login);
        rotate(res,s,u.id);redirect(res,checkoutReturn(input.returnTo)||(u.role==='admin'?'/admin':'/account'));return;
      }
      if(pathname==='/account/register'){
        if(limited('register:'+ip,10))throw new InputError('注册过于频繁',429);
        try{const id=registerAccount(input,ctx.locale);rotate(res,s,id);redirect(res,checkoutReturn(input.returnTo)||'/account/welcome');}
        catch(err){if(!(err instanceof InputError)||![400,409].includes(err.status))throw err;ctx.registrationInput={...input,password:undefined};ctx.registrationErrors=err.fields||{};ctx.registrationError=err.message;send(res,store.shell('创建账户',registrationBody(ctx),ctx),err.status);}return;
      }
      if(pathname==='/account/contact'){
        if(user?.role!=='customer')throw new InputError('请先登录客户账户',403);
        if(limited('account-contact:'+user.id,30))throw new InputError('修改过于频繁，请稍后重试',429);
        try{const result=updateAccountContact(user.id,input,ctx.locale);redirect(res,'/account',result.changed?'号码已保存，请重新勾选并保存授权':'联系资料与授权偏好已保存');}
        catch(err){if(!(err instanceof InputError)||err.status!==400)throw err;ctx.registrationInput={...input,password:undefined};ctx.registrationErrors=err.fields||{};ctx.registrationError=err.message;send(res,store.account(ctx),400);}return;
      }
      if(pathname==='/account/logout'){rotate(res,{...s,cart:'[]'},null);redirect(res,'/');return;}
      if(pathname==='/subscribe'){
        if(limited('subscribe:'+ip,30))throw new InputError('提交过于频繁',429);
        transaction(()=>{const contact=email(input.email);db.prepare('INSERT INTO subscribers(email,created_at,active) VALUES(?,?,1) ON CONFLICT(email) DO UPDATE SET active=1').run(contact,now());linkSubscriber(contact);});redirect(res,'/','订阅已保存');return;
      }
      if(pathname==='/cart/add'){
        updateCart(s,addCartLine(JSON.parse(s.cart),input));redirect(res,'/cart','已加入购物车');return;
      }
      if(pathname==='/cart/update'){
        updateCart(s,changeCartLine(JSON.parse(s.cart),input));redirect(res,'/cart');return;
      }
      if(pathname==='/account/shipping-address/clear'){clearShippingAddress(user);json(res,{ok:true});return;}
      if(pathname==='/checkout/buy-now'){
        if(limited('buy-now:'+s.token_hash,60))throw new InputError('提交过于频繁，请稍后重试',429);
        const id=createDirectPurchase(s,input);redirect(res,'/checkout?purchase='+id);return;
      }
      if(pathname==='/checkout'){
        input.whatsapp_locale=ctx.locale;
        if(limited('checkout:'+s.token_hash,30))throw new InputError('提交订单过于频繁',429);
        try{const id=createOrder(input,s,user,ctx.fx.currency);const o=getOrder(id);redirect(res,'/orders/'+id,o.payment_method==='online'?'订单已创建，请完成在线支付':o.order_kind==='external'?'订单已提交，等待商家联系':'测试订单已创建');}
        catch(error){if(!(error instanceof InputError)||error.status!==400)throw error;renderCheckout(res,ctx,input,error);}return;
      }
      if(pathname==='/checkout/pay'){
        if(limited('pay:'+s.token_hash,20))throw new InputError('支付请求过于频繁，请稍后重试',429);
        const o=getOrder(text(input.order_id,'订单号',80));
        if(!o||!canReadOrder(o,user,s))throw new InputError('订单不存在',404);
        const provider=input.provider==='paypal'?'paypal':'stripe';
        const publicBase=process.env.PUBLIC_BASE_URL||(config.secure?'https://':'http://')+String(req.headers.host||config.host+':'+config.port).replace(/[^a-zA-Z0-9.\-:]/g,'');
        const psId=await startOrderPayment(o.id,provider,publicBase);
        const destination=await paymentRedirect(psId);
        res.writeHead(303,{Location:destination});res.end();return;
      }
      const customerActions={'registration-revoke':revokeRegistrationPermission,save:saveCustomer,'restore-auto':restoreAutomaticProfile,whatsapp:saveWhatsapp,archive:archiveCustomer,contact:logContact,task:saveTask,'task-update':updateTask,case:saveCase,'case-update':updateCase};
      const customerAction=pathname.match(/^\/admin\/customers\/([a-z-]+)$/)?.[1];
      if(Object.hasOwn(customerActions,customerAction)){const id=customerActions[customerAction](input,user.id);redirect(res,'/admin/customers/'+id,'客户记录已保存');return;}
      if(pathname==='/admin/customers/config'){saveCustomerConfig(input,user.id);redirect(res,'/admin/customers/settings','管理设置已保存');return;}
      if(pathname==='/admin/customers/receipt'){const id=recordReceipt(input,user.id);redirect(res,'/admin/orders/'+id,'实际收款/退款核实记录已保存');return;}
      if(pathname==='/admin/translations/provider'){const id=saveTranslationProvider(input);audit(user.id,'translation.provider_save',id);redirect(res,'/admin/translations','接口设置已保存，接力顺序立即生效');return;}
      if(pathname==='/admin/translations/config'){saveTranslationConfig(input);audit(user.id,'translation.config','providers');redirect(res,'/admin/translations','自动翻译设置已保存');return;}
      if(pathname==='/admin/translations/queue'){const count=enqueuePublicTranslations(input.locale||'en');audit(user.id,'translation.queue',input.locale||'en');redirect(res,'/admin/translations','已加入 '+count+' 个新翻译分段，后台自动处理');return;}
      if(pathname==='/admin/translations/test'){queueTranslationConnectionTest(input.provider||'');audit(user.id,'translation.test',input.provider||'chain');redirect(res,'/admin/translations','连接测试已排队，将遵守免费额度等待时间');return;}
      if(pathname==='/admin/translations/retry'){const count=retryTranslations();audit(user.id,'translation.retry',count);redirect(res,'/admin/translations','已重新排队 '+count+' 个失败任务；额度等待仍会保留');return;}
      if(pathname==='/admin/products/save'){
        let pid;try{pid=saveProduct(input,user.id);}catch(err){if(err instanceof SyntaxError)throw new InputError('规格数据格式错误');throw err;}
        scanPublicTranslationSources();enqueuePublicTranslations('en');redirect(res,'/admin/products/'+pid,'商品已保存');return;
      }
      if(pathname==='/admin/collections/save'){
        const id=saveCollection(input,user.id);scanPublicTranslationSources();enqueuePublicTranslations('en');redirect(res,'/admin/collections/'+id,'分类已保存');return;
      }
      if(pathname==='/admin/collections/delete'||pathname==='/admin/collections/restore'){
        const restore=pathname.endsWith('/restore');changeCollectionState(input.id,restore,user.id);redirect(res,'/admin/collections'+(restore?'':'?status=deleted'),restore?'分类已恢复':'分类已删除，可在已删除列表恢复');return;
      }
      if(pathname==='/admin/currencies/config'){const result=await saveFxConfig(input);audit(user.id,result.tested?'currency.connection_test':'currency.config_save',fxStatus().provider);redirect(res,'/admin/settings',result.tested?(result.reference?'Frankfurter连接成功，参考汇率已更新':'连接成功，报价通过实时性检查'):'汇率配置已保存');return;}
      if(pathname==='/admin/currencies/refresh'){await refreshRates();audit(user.id,'currency.refresh',fxStatus().mode==='live'?'currencylayer':'Frankfurter');redirect(res,'/admin/settings','汇率已更新');return;}
      if(pathname==='/admin/customization/save'){saveCustomizationTemplate(input,user.id);scanPublicTranslationSources();enqueuePublicTranslations('en');redirect(res,'/admin/customization?template='+input.template,'全站定制模板已保存');return;}
      if(pathname==='/admin/recommendations/save'){saveDiscoverySettings(input,user.id);redirect(res,'/admin/recommendations','推荐与浏览设置已保存');return;}
      if(pathname==='/admin/promotions/save'){
        const promotion=parseQuantityPromotion(input);
        transaction(()=>{putSetting('quantity_promotion',promotion);audit(user.id,'promotion.save','quantity_promotion');});
        redirect(res,'/admin/promotions','优惠已保存');return;
      }
      if(pathname==='/admin/media/upload'){
        const data=text(input.data,'图片数据',12*1024*1024);if(!/^[A-Za-z0-9+/]+={0,2}$/.test(data))throw new InputError('图片编码无效');
        const media=saveMedia(Buffer.from(data,'base64'),text(input.name,'文件名',200),'',input.purpose==='product'?3*1024*1024:8*1024*1024);audit(user.id,'media.upload',media.id);json(res,{path:media.path,name:media.name,bytes:media.bytes});return;
      }
      if(pathname==='/admin/home/save'){
        let h;try{h=JSON.parse(input.home);}catch{throw new InputError('首页数据格式错误');}
        if(!Array.isArray(h.slides)||!h.slides.length||h.slides.length>10||!Array.isArray(h.sections)||h.sections.length>20)throw new InputError('轮播最多 10 个，推荐模块最多 20 个');
        h.slides=h.slides.map(i=>({title:text(i.title,'标题',100),description:text(i.description||'','文案',1000,false),image:localImage(i.image||''),href:safeLink(i.href)}));
        h.sections=h.sections.map(i=>({title:text(i.title,'模块标题',100),slug:slug(i.slug),enabled:i.enabled===true}));
        if(h.extraImages!==undefined){
          if(!Array.isArray(h.extraImages)||h.extraImages.length>30)throw new InputError('图片模块最多 30 个');
          h.extraImages=h.extraImages.map(i=>({kind:['brand','story','feature'].includes(i.kind)?i.kind:'story',title:text(i.title||'','图片标题',200,false),description:text(i.description||'','图片文案',1000,false),image:localImage(i.image||''),href:i.href?safeLink(i.href):''}));
        }else h.extraImages=settings().home.extraImages||[];
        for(const i of h.sections)if(!db.prepare('SELECT id FROM collections WHERE slug=? AND deleted_at IS NULL').get(i.slug))throw new InputError('推荐模块引用了不存在的分类：'+i.slug);
        putSetting('home',h);scanPublicTranslationSources();enqueuePublicTranslations('en');audit(user.id,'home.save','home');redirect(res,'/admin/home','首页已更新');return;
      }
      if(pathname==='/admin/orders/update'){transaction(()=>{updateOrder(text(input.id,'订单号',100),text(input.action,'操作',30),input.tracking||'',user.id,input.delivered_at||'');if(input.action==='ship')ensureShipment(input.id,input.tracking);if(input.action==='delivered')db.prepare("UPDATE shipments SET status='delivered',updated_at=? WHERE order_id=?").run(now(),input.id);});redirect(res,'/admin/orders/'+encodeURIComponent(input.id)+'?section=shipping','订单已更新');return;}
      if(pathname==='/admin/pages/save'){
        const id=input.id?int(input.id,'页面 ID',1):null,values=[slug(input.slug),text(input.title,'标题',250),text(input.body,'正文',100000),input.kind==='article'?'article':'page',input.published==='1'?1:0];
        if(id){if(!db.prepare('SELECT id FROM pages WHERE id=?').get(id))throw new InputError('页面不存在',404);db.prepare('UPDATE pages SET slug=?,title=?,body=?,kind=?,published=? WHERE id=?').run(...values,id);}else db.prepare('INSERT INTO pages(slug,title,body,kind,published) VALUES(?,?,?,?,?)').run(...values);
        scanPublicTranslationSources();enqueuePublicTranslations('en');audit(user.id,'page.save',id||values[0]);redirect(res,'/admin/pages','内容已保存');return;
      }
      if(pathname==='/admin/settings/save'){
        const site={name:text(input.name,'站点名称',100),logo:localImage(input.logo||''),announcement:text(input.announcement||'','公告',250,false),freeShippingQty:int(input.freeShippingQty,'免邮件数',1,1000),shipping:cents(input.shipping,'运费'),currency:'USD',supportEmail:input.supportEmail?email(input.supportEmail):''};
        putSetting('site',site);scanPublicTranslationSources();enqueuePublicTranslations('en');audit(user.id,'settings.save','site');redirect(res,'/admin/settings','设置已保存');return;
      }
      if(pathname==='/admin/import'){const report=importCatalog(input.catalog,{dryRun:input.dryRun!==false,overwrite:input.overwrite===true,user:user.id});json(res,report);return;}
      if(pathname==='/admin/import/csv'){
        const result=importCsv(text(input.csv,'CSV 内容',4*1024*1024),{dryRun:input.intent!=='import',overwrite:input.overwrite===true,user:user.id,label:text(input.label||'','批次说明',100,false)});
        const r=result.report;
        send(res,admin.adminShell('CSV 导入结果',csvImportPanel(ctx,{...r,dryRun:input.intent!=='import',batchId:result.batchId,overwrite:input.overwrite===true,csv:input.csv,label:input.label||''}),ctx));return;
      }
      if(pathname==='/admin/staff/save'){saveStaff(input,user.id);redirect(res,'/admin/staff','账号已保存');return;}
      if(pathname==='/admin/staff/delete'){deleteStaff(input,user.id);redirect(res,'/admin/staff','账号已删除');return;}
      if(pathname==='/admin/payments/save'){savePaymentConfig(input,user.id);redirect(res,'/admin/payments','支付配置已保存');return;}
      if(pathname==='/admin/payments/test'){
        if(limited('pay-test:'+user.id,6))throw new InputError('测试过于频繁，请稍后重试',429);
        let message;try{message=await testPaymentConnection(input.test==='paypal'?'paypal':'stripe');}catch(err){if(!(err instanceof InputError))throw err;message=err.message;}
        redirect(res,'/admin/payments',message);return;
      }
      if(pathname==='/admin/oms/save'){saveOmsConfig(input,user.id);redirect(res,'/admin/oms','OMS 配置已保存');return;}
      if(pathname==='/admin/tracking17/save'){saveTracking17Config(input,user.id);redirect(res,'/admin/oms','17TRACK 配置已保存');return;}
      if(pathname==='/admin/email/save'){saveEmailConfig(input,user.id);redirect(res,'/admin/email','邮件配置已保存');return;}
      if(pathname==='/admin/sync/save'){saveSyncConfig(input,user.id);redirect(res,'/admin/sync','商品同步配置已保存');return;}
      if(pathname==='/admin/sync/reset'){saveSyncConfig({regenerate:'1',public_base:syncConfig().publicBase},user.id);redirect(res,'/admin/sync','同步令牌已重置，旧令牌立即失效');return;}
      if(pathname==='/admin/oauth/save'){saveOauthConfig(input,user.id);redirect(res,'/admin/settings','Google 登录配置已保存');return;}
      if(pathname==='/admin/email/test'){
        if(limited('email-test:'+user.id,5))throw new InputError('测试邮件发送过于频繁，请稍后重试',429);
        let message;try{await sendTestEmail(input,user.id);}catch(err){if(!(err instanceof InputError))throw err;message='发送失败：'+err.message;}
        redirect(res,'/admin/email',message||'测试邮件已发送，请查收');return;
      }
      if(pathname==='/admin/oms/action'){
        if(limited('oms-action:'+user.id,20))throw new InputError('操作过于频繁，请稍后重试',429);
        let message;
        try{
          if(input.action==='sync'){const r=await syncTracking17(true);message='17TRACK 同步完成：'+r.synced+' 个包裹';}
          else{await omsManualAction(input,user.id);message={push:'已推送 OMS',track:'运单号补拉完成',cancel:'OMS 订单已作废',sync:'OMS 轨迹同步完成'}[input.action]||'操作完成';}
        }catch(err){if(!(err instanceof InputError))throw err;message='操作未完成：'+err.message;}
        redirect(res,'/admin/oms',message);return;
      }
      if(pathname==='/admin/import/commit'){
        const outcome=commitBatch(text(input.batch_id,'批次标识',60),user.id);
        send(res,admin.adminShell('第 3 步 · 入库完成',importDonePanel(ctx,outcome,text(input.batch_id,'批次标识',60)),ctx));return;
      }
      if(pathname==='/admin/import/rollback'){
        const outcome=rollbackBatch(text(input.batch_id,'批次标识',60),user.id);
        redirect(res,'/admin/import',`批次已回滚：还原 ${outcome.restored} 件、移除新建 ${outcome.removed} 件`);
        return;
      }
      throw new InputError('接口不存在',404);
    }
    if(req.method!=='GET')throw new InputError('不支持的方法',405);
    if(pathname==='/admin/whatsapp'){send(res,admin.adminShell('WhatsApp联系与接口',whatsappPanel(ctx),ctx));return;}
    if(pathname==='/admin/whatsapp/contact'){send(res,admin.adminShell('预览WhatsApp联系',waContactPanel(ctx),ctx));return;}
    if(pathname==='/admin/whatsapp/compose'){send(res,admin.adminShell('官方模板预览',waComposePanel(ctx),ctx));return;}
    if(pathname==='/admin/translations/status.json'){const status=translationStatus();json(res,{enabled:status.enabled,lastError:status.lastError,resumeAt:status.resumeAt,counts:status.counts,usage:status.usage,dailyLimit:status.dailyLimit,activeProvider:status.activeProvider,providers:status.providers});return;}
    if(pathname==='/api/products/recent'){const products=recentProductCards(url.searchParams.get('ids'));json(res,{ids:products.map(p=>p.id),html:store.productCardsFragment(products,ctx)});return;}
    if(pathname==='/admin/recommendations/products.json'){const result=catalog(Object.fromEntries(url.searchParams),true);json(res,{count:result.count,page:result.page,pages:result.pages,products:result.products.map(p=>({id:p.id,title:p.title,images:p.images.slice(0,1),active:p.active}))});return;}
    if(pathname==='/admin/traffic.json'){json(res,trafficSummary());return;}
    if(pathname==='/admin/media.json'){json(res,db.prepare('SELECT id,path,name,bytes,content_type FROM media ORDER BY id DESC').all());return;}
    if(pathname==='/'){send(res,store.home(ctx));return;}
    if(pathname==='/search'){
      const query=Object.fromEntries(url.searchParams);
      if(query.image){send(res,store.listing('以图搜款',imageSearchResults(query.image,s.token_hash,query,ctx.fx),ctx));return;}
      if(query.mode==='image'){if(!imageSearchEnabled()&&user?.role!=='admin')throw new InputError('以图搜款暂未开放，请使用文字搜索',503);send(res,store.listing('以图搜款',{products:[],count:0,page:1,pages:0},ctx));return;}
      send(res,store.listing('搜索结果',catalog(query,false,ctx.fx),ctx));return;
    }
    if(pathname==='/admin/image-search'){send(res,admin.adminShell('以图搜款',imageSearchAdmin(ctx),ctx));return;}
    let match=pathname.match(/^\/collections\/([a-z0-9-]+)$/);
    if(match){const c=db.prepare('SELECT * FROM collections WHERE slug=? AND deleted_at IS NULL').get(match[1]);if(!c)throw new InputError('分类不存在',404);send(res,store.listing(c.name,catalog({...Object.fromEntries(url.searchParams),collection:c.slug},false,ctx.fx),ctx));return;}
    match=pathname.match(/^\/products\/([a-z0-9-]+)$/);
    if(match){const p=product(match[1]);if(!p||!p.active)throw new InputError('商品不存在或已下架',404);if(p.slug!==match[1]){redirect(res,'/products/'+p.slug+url.search);return;}if(url.searchParams.has('purchase')){const selection=directPurchase(s,url.searchParams.get('purchase'));if(!p.variants.some(v=>v.id===selection.line.variantId))throw new InputError('购买记录与商品不符',400);ctx.purchaseSelection=selection.line;}send(res,store.detail(p,ctx));return;}
    if(pathname==='/cart'){send(res,store.cartPage(cartSummary(JSON.parse(s.cart)),ctx));return;}
    if(pathname==='/checkout'){renderCheckout(res,ctx);return;}
    if(pathname==='/track'){send(res,store.shell('订单查询',trackingForm(ctx),ctx));return;}
    const trackingMatch=pathname.match(/^\/track\/(BW-[A-Z0-9-]+)$/);
    if(trackingMatch){const o=getOrder(trackingMatch[1]);if(!o||!canTrack(o,user,s))throw new InputError('订单不存在或查询授权已过期，请返回订单查询页重新验证',404);res.setHeader('X-Robots-Tag','noindex, nofollow');send(res,store.shell('物流信息',trackingBody(o),ctx));return;}
    match=pathname.match(/^\/orders\/(BW-[A-Z0-9-]+)$/);
    if(match){const o=getOrder(match[1]);if(!o||!canReadOrder(o,user,s))throw new InputError('订单不存在',404);
      const payCfg=paymentConfig();
      const payForm=o.payment_method==='online'&&o.payment_status==='unpaid'&&o.fulfillment_status!=='cancelled'&&payCfg.enabled?`<form method="post" action="/checkout/pay" class="actions"><input type="hidden" name="csrf" value="${s.csrf}"><input type="hidden" name="order_id" value="${e(o.id)}">${payCfg.stripe.hasSecret?`<button class="button" name="provider" value="stripe">使用 Stripe 支付</button>`:''}${payCfg.paypal.clientId&&payCfg.paypal.hasClientSecret?`<button class="button" name="provider" value="paypal">使用 PayPal 支付</button>`:''}</form>`:'';
      send(res,store.shell('订单详情',`<section class="section narrow"><h1>订单详情</h1>${store.orderBody(o)}${payForm}${whatsappButton(ctx,{orderId:o.id})}<a href="/">继续购物</a></section>`,ctx));return;}
    if(pathname==='/account'){send(res,user?store.account(ctx):store.authPage(ctx));return;}
    if(pathname==='/account/google/start'){
      if(!googleEnabled())throw new InputError('Google 登录未配置',503);
      const state=random(16),nonce=random(16);
      res.setHeader('Set-Cookie',`bw_oauth=${state}.${nonce}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${config.secure?'; Secure':''}`);
      const publicBase=process.env.PUBLIC_BASE_URL||(config.secure?'https://':'http://')+String(req.headers.host||config.host+':'+config.port).replace(/[^a-zA-Z0-9.\-:]/g,'');
      res.writeHead(303,{Location:googleAuthUrl(publicBase,state,nonce)});res.end();return;
    }
    if(pathname==='/account/google/callback'){
      const stateCookie=String(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('bw_oauth='))?.slice(9);
      const state=url.searchParams.get('state')||'';
      if(!stateCookie||!/^[a-f0-9]{32}\.[a-f0-9]{32}$/.test(stateCookie)||stateCookie.split('.')[0]!==state)throw new InputError('登录会话已过期，请重新发起 Google 登录',400);
      const nonce=stateCookie.split('.')[1];
      const code=url.searchParams.get('code')||'';
      if(!code)throw new InputError('未完成 Google 授权',400);
      const publicBase=process.env.PUBLIC_BASE_URL||(config.secure?'https://':'http://')+String(req.headers.host||config.host+':'+config.port).replace(/[^a-zA-Z0-9.\-:]/g,'');
      const idToken=await exchangeGoogleCode(code,publicBase);
      const claims=verifyGoogleIdToken(idToken,{clientId:oauthConfig().google.clientId,nonce,keys:await googleJwks()});
      const userId=googleLoginOrRegister(claims);
      // 令牌校验与建档都成功后才消费一次性状态 Cookie，失败重试不必重新发起授权。
      res.setHeader('Set-Cookie',`bw_oauth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${config.secure?'; Secure':''}`);
      rotate(res,s,userId);redirect(res,'/account','Google 登录成功');return;
    }
    if(pathname==='/account/welcome'){if(user?.role!=='customer'){redirect(res,'/account');return;}send(res,store.shell('账户已创建成功',welcomeBody(ctx),ctx));return;}
    if(pathname==='/account/register'){send(res,store.authPage(ctx,true));return;}
    match=pathname.match(/^\/(pages|blogs)\/([a-z0-9-]+)$/);
    if(match){const p=db.prepare('SELECT * FROM pages WHERE slug=? AND published=1 AND kind=?').get(match[2],match[1]==='blogs'?'article':'page');
      if(match[1]==='pages'&&match[2]==='privacy-statement'){send(res,store.shell(p?.title||'隐私声明',(p?`<section class="section narrow"><h1>${e(p.title)}</h1><div class="plain-content">${e(p.body)}</div></section>`:'')+metaPrivacyNotice(ctx.locale),ctx));return;}
      if(!p){const titles={'returns-refund-policy':'退货及退款政策','privacy-statement':'隐私声明','terms-of-service':'服务条款'};if(match[1]==='pages'&&titles[match[2]]){send(res,store.shell(titles[match[2]],`<section class="section narrow"><h1>${titles[match[2]]}</h1><p>正文待导入，正式运营前需完善。</p></section>`,ctx));return;}throw new InputError('页面不存在',404);}
      send(res,store.shell(p.title,`<section class="section narrow"><h1>${e(p.title)}</h1><div class="plain-content">${e(p.body)}</div></section>`,ctx));return;
    }
    if(pathname==='/blogs'){const pages=db.prepare("SELECT * FROM pages WHERE kind='article' AND published=1 ORDER BY id DESC").all();send(res,store.shell('博客',`<section class="section"><h1>来自博客</h1>${pages.map(p=>`<a href="/blogs/${e(p.slug)}"><h2>${e(p.title)}</h2></a>`).join('')||'<p>暂无文章</p>'}</section>`,ctx));return;}
    if(pathname==='/admin/customers/status.json'){json(res,customerStats());return;}
    if(pathname==='/admin/orders/stats.json'){json(res,centerStats());return;}
    if(pathname==='/admin/service'){const [tab,filter]=url.searchParams.has('view')?legacyCenterView(url.searchParams.get('view')):['aftersales','all'];redirect(res,'/admin/orders?tab='+tab+'&filter='+filter,url.searchParams.get('message')||'');return;}
    if(pathname==='/admin/service/stats.json'){json(res,compatibleServiceStats());return;}
    const serviceFile=pathname.match(/^\/admin\/service\/attachment\/(\d+)$/);if(serviceFile){const file=db.prepare('SELECT content,content_type FROM service_attachments WHERE id=?').get(Number(serviceFile[1]));if(!file)throw new InputError('证据图片不存在',404);send(res,Buffer.from(file.content),200,file.content_type);return;}
    const servicePage=pathname.match(/^\/admin\/service\/(\d+)$/);if(servicePage){const c=serviceCase(servicePage[1]);redirect(res,'/admin/orders/'+encodeURIComponent(c.order_id)+'?section=aftersales&case='+c.id,url.searchParams.get('message')||'');return;}
    if(pathname==='/admin/cod/stats.json'){json(res,compatibleCodStats());return;}
    if(pathname==='/admin/cod/import'){send(res,admin.adminShell('批量回填运单',importPanel(ctx),ctx));return;}
    if(pathname==='/admin/cod/template.csv'){res.setHeader('Content-Disposition','attachment; filename="tracking-import-template.csv"');send(res,'\ufefforder_id,tracking_number,carrier,carrier_name\r\n',200,'text/csv; charset=utf-8');return;}
    if(pathname==='/admin/import/template.csv'){res.setHeader('Content-Disposition','attachment; filename="product-import-template.csv"');send(res,csvTemplate(),200,'text/csv; charset=utf-8');return;}
    if(pathname==='/admin/customers/export.csv'){const csv=customerExport(Object.fromEntries(url.searchParams),user.id);audit(user.id,'customer.export','filtered');res.setHeader('Content-Disposition','attachment; filename="customers.csv"');send(res,csv,200,'text/csv; charset=utf-8');return;}
    if(pathname==='/admin/customers/settings'){send(res,admin.adminShell('客户管理设置',customerSettingsPanel(ctx),ctx));return;}
    if(pathname==='/admin/customers/subscriptions'){send(res,admin.legacySubscribers(ctx));return;}
    if(pathname==='/admin/customers/new'){send(res,admin.adminShell('新增客户','<a href="/admin/customers">← 客户管理</a>'+customerProfileForm({},ctx),ctx));return;}
    const customerMatch=pathname.match(/^\/admin\/customers\/(\d+)$/);
    if(customerMatch){send(res,admin.adminShell('客户详情与跟进',customerDetailPanel(Number(customerMatch[1]),ctx),ctx));return;}
    if(pathname==='/admin/staff'){send(res,admin.adminShell('员工与权限',staffPanel(ctx),ctx));return;}
    if(pathname==='/admin/payments'){send(res,admin.adminShell('在线支付',paymentsPanel(ctx),ctx));return;}
    if(pathname==='/admin/oms'){send(res,admin.adminShell('物流履约对接',omsPanel(ctx),ctx));return;}
    if(pathname==='/admin/email'){send(res,admin.adminShell('邮件通知',emailPanel(ctx),ctx));return;}
    if(pathname==='/admin/sync'){send(res,admin.adminShell('商品同步发布',syncAdmin(ctx),ctx));return;}
    if(pathname==='/checkout/return'){
      const psId=text(url.searchParams.get('ps')||'','支付会话',40);
      const ps=getPaymentSession(psId);
      if(!ps)throw new InputError('支付会话不存在',404);
      if(!canReadOrder(getOrder(ps.order_id),user,s))throw new InputError('订单不存在',404);
      if(ps.provider==='stripe')await retrieveStripeSession(psId);
      else await capturePaypalOrder(psId);
      const fresh=getPaymentSession(psId);
      redirect(res,'/orders/'+ps.order_id,fresh.status==='paid'?'支付完成，款项已自动确认':'支付结果确认中，请稍后刷新查看');
      return;
    }
    if(pathname==='/admin'){send(res,admin.dashboard(ctx));return;}
    if(pathname==='/admin/collections.json'){json(res,listCollections(Object.fromEntries(url.searchParams)));return;}
    if(pathname==='/admin/products'){send(res,admin.productList(catalog(Object.fromEntries(url.searchParams),true),ctx));return;}
    match=pathname.match(/^\/admin\/collections\/(\d+|new)$/);
    if(match){const c=match[1]==='new'?null:db.prepare('SELECT * FROM collections WHERE id=? AND deleted_at IS NULL').get(Number(match[1]));if(match[1]!=='new'&&!c)throw new InputError('分类不存在或已删除',404);send(res,admin.collectionEdit(c,ctx));return;}
    match=pathname.match(/^\/admin\/products\/(\d+|new)$/);
    if(match){const p=match[1]==='new'?null:product(Number(match[1]));if(match[1]!=='new'&&!p)throw new InputError('商品不存在',404);send(res,admin.productEdit(p,ctx));return;}
    const adminPages={'/admin/translations':admin.translationsPage,'/admin/recommendations':admin.recommendationsPage,'/admin/customization':admin.customizationPage,'/admin/promotions':admin.promotionsPage,'/admin/traffic':admin.trafficPage,'/admin/collections':admin.collections,'/admin/media':admin.media,'/admin/home':admin.homeEdit,'/admin/orders':admin.orderList,'/admin/pages':admin.pageList,'/admin/customers':admin.customers,'/admin/settings':admin.settingsEdit,'/admin/import':admin.imports,'/admin/audit':admin.auditPage};
    if(adminPages[pathname]){send(res,adminPages[pathname](ctx));return;}
    match=pathname.match(/^\/admin\/orders\/(BW-[A-Z0-9-]+)$/);
    if(match){const o=getOrder(match[1]);if(!o)throw new InputError('订单不存在',404);send(res,admin.orderEdit(o,ctx));return;}
    match=pathname.match(/^\/admin\/pages\/(\d+|new)$/);
    if(match){const p=match[1]==='new'?null:db.prepare('SELECT * FROM pages WHERE id=?').get(Number(match[1]));if(match[1]!=='new'&&!p)throw new InputError('页面不存在',404);send(res,admin.pageEdit(p,ctx));return;}
    if(pathname==='/admin/subscribers.csv'){res.setHeader('Content-Disposition','attachment; filename="subscribers.csv"');send(res,'\ufeff'+['email,created_at',...db.prepare('SELECT * FROM subscribers WHERE active=1').all().map(row=>[row.email,row.created_at].map(csv).join(','))].join('\r\n'),200,'text/csv; charset=utf-8');return;}
    throw new InputError('页面不存在',404);
  }catch(err){
    const constraint=/UNIQUE constraint/.test(err.message),badJson=err instanceof SyntaxError;
    const status=err.status || (constraint?409:badJson?400:500);
    const message=err instanceof InputError?err.message:constraint?'网址标识、邮箱或 SKU 已存在':badJson?'数据格式错误':'服务器处理失败，请查看本地日志';
    if(status===500)console.error(err);
    if(req.headers.accept==='application/json'||String(req.headers['content-type']).includes('application/json')){json(res,{error:message},status);return;}
    if(ctx?.user?.role==='admin'&&ctx.url.pathname.startsWith('/admin')){send(res,admin.adminShell('操作未完成',`<div class="notice error">${e(message)}</div><p>请返回上一页检查输入，表单内容可保留。</p><a href="/admin/customers">返回客户管理</a>`,ctx),status);}
    else if(ctx){send(res,store.shell('操作未完成',`<section class="section narrow"><h1>${status===404?'页面未找到':'操作未完成'}</h1><div class="notice error">${e(message)}</div><p>请返回上一页检查输入，或刷新页面后重试。</p><a href="/">返回首页</a></section>`,ctx),status);}
    else send(res,'请求无法处理',status,'text/plain; charset=utf-8');
  }
});
server.requestTimeout=30000;
server.listen(config.port,config.host,()=>{const actual=server.address().port;console.log(`商城: http://${config.host}:${actual}/`);console.log(`后台: http://${config.host}:${actual}/admin`);console.log('首次管理员凭据见 storage/bootstrap-admin.txt（如未使用环境变量设置）');});
const clean=setInterval(()=>{db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());db.prepare('DELETE FROM guest_order_access WHERE expires<?').run(Date.now());db.prepare('DELETE FROM checkout_quotes WHERE expires<?').run(Date.now());db.prepare('DELETE FROM direct_purchases WHERE expires<?').run(Date.now()-7*86400000);},60*60*1000);clean.unref();
const fxRefresh=setInterval(()=>ensureDailyRates().catch(()=>console.error('每日参考汇率同步失败，保留已缓存数据。')),60*60*1000);fxRefresh.unref();
if(process.env.FX_AUTO_UPDATE!=='false')ensureDailyRates().catch(()=>console.error('每日参考汇率同步失败，可在后台手动更新。'));
const liveRefresh=setInterval(()=>{if(fxStatus().mode==='live')ensureLiveRates().catch(()=>console.error('实时汇率更新失败，过期报价不可用于新换算。'));},60000);liveRefresh.unref();
const tracking17Refresh=setInterval(()=>{if(tracking17Config().hasApiKey)syncTracking17().catch(()=>{});},30*60*1000);tracking17Refresh.unref();
function stop(){server.close(()=>{db.close();process.exit(0);});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
