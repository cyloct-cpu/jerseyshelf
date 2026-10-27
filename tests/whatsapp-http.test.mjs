import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import path from 'node:path';
const root=path.resolve('.'),dir=mkdtempSync(path.join(root,'tests/.tmp-whatsapp-http-')),port=40500+process.pid%1000,base='http://127.0.0.1:'+port;
let child,db,variant,pid,orderId,customerId,output='';
class Client{cookie='';csrf='';async get(url,options={}){const response=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:this.cookie,...options.headers}});for(const c of response.headers.getSetCookie())if(c.startsWith('bw_session='))this.cookie=c.split(';')[0];const body=await response.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:response.status,location:response.headers.get('location'),body};}post(url,input={},csrf=this.csrf){return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...input})});}}
const admin=new Client(),buyer=new Client(),stranger=new Client();
const config={mode:'link',phone:'+1 202 555 0100',name:'Fixture merchant'};
const ok=r=>assert.equal(r.status,303,r.body+'\n'+output);
before(async()=>{child=spawn(process.execPath,['apps/api/server.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATABASE_PATH:path.join(dir,'store.sqlite'),MEDIA_PATH:path.join(dir,'media'),ADMIN_EMAIL:'wa-admin@example.com',ADMIN_PASSWORD:'fixture-password-12345',WHATSAPP_AUTO_UPDATE:'false',TRANSLATION_AUTO_UPDATE:'false',FX_AUTO_UPDATE:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);let ready=false;for(let i=0;i<150;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,output);db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');const v=db.prepare('SELECT id,product_id FROM variants LIMIT 1').get();variant=v.id;pid=v.product_id;db.prepare('UPDATE variants SET stock=100,active=1 WHERE id=?').run(variant);db.prepare('UPDATE products SET active=1 WHERE id=?').run(pid);await admin.get('/account');ok(await admin.post('/account/login',{email:'wa-admin@example.com',password:'fixture-password-12345'}));await admin.get('/admin/whatsapp');});
after(async()=>{db?.close();if(child?.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-whatsapp-http-'));rmSync(dir,{recursive:true,force:true});});

test('WhatsApp popup forms preserve same-origin POST and malformed origins return 403 instead of 500',async()=>{
 const home=await buyer.get('/');
 // noreferrer makes Chromium submit an opaque Origin: null even to our own server.
 // noopener still isolates the new window; the global same-origin referrer policy
 // keeps private page URLs away from WhatsApp after the server redirects.
 for(const origin of ['null','not-a-url','https://outside.example']){
  const r=await buyer.get('/contact/whatsapp',{method:'POST',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:buyer.csrf})});
  assert.equal(r.status,403,r.body);
 }
 // The following configuration test enables the real HTML entry points.
 assert.equal(home.status,200);
});
test('configuration is admin-only, protected by CSRF and origin; no credentials or merchant phone configured by default',async()=>{assert.equal(db.prepare("SELECT value FROM settings WHERE key='whatsapp'").get(),undefined);assert.equal((await stranger.get('/admin/whatsapp')).status,303);assert.equal((await stranger.post('/admin/whatsapp/config',config)).status,403);assert.equal((await admin.post('/admin/whatsapp/config',config,'wrong')).status,403);assert.equal((await admin.get('/admin/whatsapp/config',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded',Origin:'https://outside.example'},body:new URLSearchParams({csrf:admin.csrf,...config})})).status,403);await buyer.get('/');assert.equal((await buyer.post('/contact/whatsapp')).status,503);ok(await admin.post('/admin/whatsapp/config',config));});
test('floating, product and cart contact forms use fixed merchant, selected variant/customization and no fake order',async()=>{let r=await buyer.get('/?lang=en');assert.match(r.body,/whatsapp-floating/);const slug=db.prepare('SELECT slug FROM products WHERE id=?').get(pid).slug;r=await buyer.get('/products/'+slug+'?lang=en');assert.match(r.body,/formaction="\/contact\/whatsapp"/);assert.match(r.body,/Ask on WhatsApp/);assert.equal((await buyer.post('/contact/whatsapp',{},'wrong')).status,403);r=await buyer.post('/contact/whatsapp',{product_id:pid,variantId:variant,quantity:'2',printingName:'Alex#9',phone:'999999999999'});ok(r);let url=new URL(r.location);assert.equal(url.pathname,'/12025550100');assert.match(url.searchParams.get('text'),/Alex#9/);assert.doesNotMatch(url.searchParams.get('text'),/BW-/);ok(await buyer.post('/cart/add',{variantId:variant,quantity:'1'}));assert.match((await buyer.get('/cart')).body,/WhatsApp/);r=await buyer.post('/contact/whatsapp',{cart:'1'});ok(r);assert.doesNotMatch(new URL(r.location).searchParams.get('text'),/BW-/);});
test('checkout retains invalid fields, stores explicit permission and contact snapshot without sending',async()=>{ok(await admin.post('/admin/customers/config',{order_mode:'external',review_days:'5'}));const page=await buyer.get('/checkout?lang=en');assert.equal(page.status,200);assert.match(page.body,/I agree to receive/);assert.doesNotMatch(page.body,/name="whatsapp_consent" value="1" checked/);const quote=page.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1],data={quote_id:quote,checkoutKey:'wa-http-order',email:'wa-buyer@example.com',name:'Fixture Buyer',country:'US',city:'Boston',address:'PRIVATE ADDRESS',postal:'02110',phone:'+1 202 555 0144',whatsapp_consent:'1'};let r=await buyer.post('/checkout',data);assert.equal(r.status,400);assert.match(r.body,/name="whatsapp_consent" value="1" checked/);assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n,0);r=await buyer.post('/checkout',{...data,whatsapp_phone:'+1 202 555 0123'});ok(r);orderId=r.location.match(/BW-[A-Z0-9-]+/)[0];const o=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);customerId=o.customer_id;assert.equal(o.whatsapp_phone,'12025550123');assert.equal(db.prepare('SELECT granted FROM whatsapp_permissions WHERE customer_id=?').get(customerId).granted,1);assert.equal(db.prepare('SELECT count(*) n FROM whatsapp_messages').get().n,0);assert.ok(db.prepare("SELECT id FROM customer_tasks WHERE order_id=? AND kind='first_contact'").get(orderId));});
test('order contact requires full order permission; tracking-only authorization cannot retrieve private summary',async()=>{await stranger.get('/');assert.equal((await stranger.post('/orders/'+orderId+'/whatsapp')).status,404);ok(await stranger.post('/track',{order_id:orderId,email:'wa-buyer@example.com'}));assert.equal((await stranger.get('/track/'+orderId)).status,200);assert.equal((await stranger.post('/orders/'+orderId+'/whatsapp')).status,404);const page=await buyer.get('/orders/'+orderId);assert.match(page.body,new RegExp('/orders/'+orderId+'/whatsapp'));const r=await buyer.post('/orders/'+orderId+'/whatsapp');ok(r);const text=new URL(r.location).searchParams.get('text');assert.match(text,new RegExp(orderId));assert.doesNotMatch(text,/PRIVATE ADDRESS|wa-buyer@example.com|12025550144/);});
test('admin previews editable customer message, correct order; opening chat does not mark deal or contact',async()=>{const page=await admin.get('/admin/whatsapp/contact?customer='+customerId+'&order='+orderId);assert.equal(page.status,200,page.body);assert.match(page.body,/12025550123/);assert.match(page.body,/name="message"/);const r=await admin.post('/admin/customers/'+customerId+'/whatsapp',{order_id:orderId,message:'Hello fixture buyer'});ok(r);assert.equal(new URL(r.location).pathname,'/12025550123');assert.equal(db.prepare('SELECT whatsapp_status FROM customers WHERE id=?').get(customerId).whatsapp_status,'unknown');assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id=?').get(orderId).payment_status,'unpaid');assert.match((await admin.get('/admin/orders/'+orderId+'?section=follow')).body,/官方|模板预览/);assert.equal((await buyer.post('/admin/whatsapp/messages',{order_id:orderId})).status,403);assert.equal((await admin.post('/admin/whatsapp/messages',{order_id:orderId,confirmed:'1'})).status,400);});
test('webhook route skips browser session/CSRF only; signature and verification token are mandatory',async()=>{const cloud={...config,mode:'cloud',version:'v24.0',phone_id:'123456789',waba_id:'987654321',token:'fixture-token-secret',appSecret:'fixture-app-secret',verifyToken:'fixture-verify-token'};ok(await admin.post('/admin/whatsapp/config',cloud));const secretPage=await admin.get('/admin/whatsapp');assert.doesNotMatch(secretPage.body,/fixture-token-secret|fixture-app-secret|fixture-verify-token/);let r=await fetch(base+'/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=fixture-verify-token&hub.challenge=777');assert.equal(r.status,200);assert.equal(await r.text(),'777');assert.equal(r.headers.has('set-cookie'),false);const raw=JSON.stringify({object:'whatsapp_business_account',entry:[{id:cloud.waba_id,changes:[{field:'messages',value:{metadata:{phone_number_id:cloud.phone_id},messages:[{id:'wamid.fixture.http',from:'12025550123',type:'text',text:{body:'Confirm '+orderId}}]}}]}]}),signature='sha256='+createHmac('sha256',cloud.appSecret).update(raw).digest('hex');r=await fetch(base+'/webhooks/whatsapp',{method:'POST',headers:{'Content-Type':'application/json'},body:raw});assert.equal(r.status,403);for(let i=0;i<2;i++){r=await fetch(base+'/webhooks/whatsapp',{method:'POST',headers:{'Content-Type':'application/json','X-Hub-Signature-256':signature},body:raw});assert.equal(r.status,200);assert.equal(r.headers.has('set-cookie'),false);}assert.equal(db.prepare('SELECT count(*) n FROM whatsapp_messages').get().n,1);assert.equal(db.prepare('SELECT whatsapp_status FROM customers WHERE id=?').get(customerId).whatsapp_status,'connected');});
test('permission revoke is admin/CSRF-protected and only affects the chosen customer number',async()=>{assert.equal((await buyer.post('/admin/whatsapp/revoke',{customer_id:customerId,phone:'12025550123'})).status,403);ok(await admin.post('/admin/whatsapp/revoke',{customer_id:customerId,phone:'12025550123'}));assert.equal(db.prepare('SELECT granted FROM whatsapp_permissions WHERE customer_id=?').get(customerId).granted,0);assert.equal((await admin.get('/admin/customers/'+customerId)).status,200);});


test('frontend and admin WhatsApp popup forms retain noopener without suppressing Origin',async()=>{
 const home=await buyer.get('/');
 const preview=await admin.get('/admin/whatsapp/contact?customer='+customerId+'&order='+orderId);
 assert.match(home.body,/<div class="whatsapp-floating"><a href="https:\/\/wa.me\/12025550100\?text=[^"]+" target="_blank" rel="noopener noreferrer"/);
 for(const page of [preview]){
  assert.equal(page.status,200);
  const forms=[...page.body.matchAll(/<form\b[^>]*target="_blank"[^>]*>/g)].map(m=>m[0]);
  assert.ok(forms.length>0);
  for(const form of forms){assert.match(form,/rel="noopener"/);assert.doesNotMatch(form,/noreferrer/);}
 }
});


test('order contact keeps stored settlement currency and amount instead of recalculating FX',async()=>{
 const old=db.prepare('SELECT currency,total,fx_rate FROM orders WHERE id=?').get(orderId);
 try{
  db.prepare('UPDATE orders SET currency=?,total=?,fx_rate=? WHERE id=?').run('EUR',12345,'0.9',orderId);
  await buyer.get('/orders/'+orderId);
  const r=await buyer.post('/orders/'+orderId+'/whatsapp');ok(r);
  const message=new URL(r.location).searchParams.get('text');
  assert.match(message,/(?:EUR\s*|€)123\.45/);assert.match(message,new RegExp(orderId));
 }finally{db.prepare('UPDATE orders SET currency=?,total=?,fx_rate=? WHERE id=?').run(old.currency,old.total,old.fx_rate,orderId);}
});

test('contact navigation and async form opening keep the merchant fixed and errors readable',async()=>{
 const direct=await buyer.get('/contact/whatsapp?phone=999999999999');ok(direct);
 assert.equal(new URL(direct.location).pathname,'/12025550100');
 const contact=async(input,csrf=buyer.csrf)=>buyer.get('/contact/whatsapp',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...input})});
 const r=await contact({product_id:pid,variantId:variant,quantity:'2',printingName:'Alex#9',phone:'999999999999'});
 assert.equal(r.status,200,r.body);const url=new URL(JSON.parse(r.body).url);
 assert.equal(url.origin,'https://wa.me');assert.equal(url.pathname,'/12025550100');assert.match(url.searchParams.get('text'),/Alex#9/);
 const denied=await contact({},'stale');assert.equal(denied.status,403);assert.ok(JSON.parse(denied.body).error);
 const order=await buyer.get('/orders/'+orderId+'/whatsapp',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:buyer.csrf})});
 assert.equal(order.status,200,order.body);assert.match(new URL(JSON.parse(order.body).url).searchParams.get('text'),new RegExp(orderId));
 const hidden=await stranger.get('/orders/'+orderId+'/whatsapp',{method:'POST',headers:{Accept:'application/json','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:stranger.csrf})});assert.equal(hidden.status,404);assert.ok(JSON.parse(hidden.body).error);
});
