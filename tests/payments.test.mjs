import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnTestServer} from './helpers/server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-pay-'+process.pid);
let child,base,db,payments,log='';
class Client{cookies=new Map();csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body,location:r.headers.get('location')};}post(url,data={}){const form=new URLSearchParams({csrf:this.csrf});for(const [k,v] of Object.entries(data))for(const x of Array.isArray(v)?v:[v])form.append(k,x);return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});}}
const admin=new Client(),buyer=new Client();
const ok=r=>assert.equal(r.status,303,r.body+'\n'+log);
const WEBHOOK_SECRET='whsec_abcdefghijklmnop';
const fields={email:'pay@example.com',name:'Pay Tester',phone:'+1 202 555 0100',country:'US',region:'MA',city:'Boston',address:'1 Pay Street',postal:'02110'};
let variant,orderId;
const order=()=>db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
const sign=(body,timestamp=Math.floor(Date.now()/1000))=>{const t=String(timestamp);return 't='+t+',v1='+createHmac('sha256',WEBHOOK_SECRET).update(t+'.'+body,'utf8').digest('hex');};
const postWebhook=async(body,signature)=>fetch(base+'/webhooks/stripe',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':signature||''},body});

before(async()=>{
  mkdirSync(dir,{recursive:true});
  ({child,base}=await spawnTestServer({root,dir,extraEnv:{ADMIN_EMAIL:'pay-admin@example.com',ADMIN_PASSWORD:'pay-password-123456'}}));
  db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  process.env.DATABASE_PATH=path.join(dir,'store.sqlite');
  payments=await import('../apps/api/payments.mjs');  variant=db.prepare('SELECT id FROM variants LIMIT 1').get().id;
  db.prepare('UPDATE variants SET price=1000,stock=100,active=1 WHERE id=?').run(variant);
  db.prepare('UPDATE products SET active=1 WHERE id=(SELECT product_id FROM variants WHERE id=?)').run(variant);
  await admin.get('/account');
  ok(await admin.post('/account/login',{email:'pay-admin@example.com',password:'pay-password-123456'}));
  await admin.get('/admin');
});
after(async()=>{
  db?.close();
  try{(await import('../apps/api/db.mjs')).db.close();}catch{}
  if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}
  assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-pay-'));rmSync(dir,{recursive:true,force:true});
});

test('webhooks are rejected without a configured signature secret (no verification bypass)',async()=>{
  const body=JSON.stringify({id:'evt_1',type:'checkout.session.completed',data:{object:{status:'complete',payment_status:'paid',metadata:{order_id:'BW-NOPE'}}}});
  assert.equal((await postWebhook(body,'')).status,400);
  assert.equal((await postWebhook(body,'t=123,v1=deadbeef')).status,400);
  assert.equal((await fetch(base+'/webhooks/paypal',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,400);
});

test('payment config requires permission and CSRF, secrets are stored without echoing',async()=>{
  assert.equal((await admin.post('/admin/payments/save',{enabled:'1',stripe_secret_key:'short'})).status,400);
  ok(await admin.post('/admin/payments/save',{enabled:'1',stripe_secret_key:'sk_test_abcdefghijklmnop',stripe_webhook_secret:WEBHOOK_SECRET,stripe_public_key:'pk_test_abcdefghijklmnop',paypal_client_id:'pay-client-id-12345678',paypal_client_secret:'pay-client-secret-1234567890'}));
  const stored=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='payment'").get().value);
  assert.equal(stored.enabled,true);
  assert.ok(stored.stripe.secret&&!stored.stripe.secret.includes('sk_test_abcdefghijklmnop'),'secret stored sealed');
  assert.ok(stored.stripe.webhookSecret&&!stored.stripe.webhookSecret.includes(WEBHOOK_SECRET));
  const page=await admin.get('/admin/payments');assert.equal(page.status,200);assert.match(page.body,/在线支付/);assert.doesNotMatch(page.body,/sk_test_abcdefghijklmnop/);assert.doesNotMatch(page.body,new RegExp(WEBHOOK_SECRET));
});

test('online order mode creates external unpaid order and shows a pay button',async()=>{
  ok(await admin.post('/admin/customers/config',{order_mode:'online',review_days:'5'}));
  await buyer.get('/');
  ok(await buyer.post('/cart/add',{variantId:variant,quantity:1}));
  const page=await buyer.get('/checkout');
  const quote=page.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];
  const response=await buyer.post('/checkout',{...fields,quote_id:quote,checkoutKey:'pay-online-1'});
  ok(response);orderId=response.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1];
  const o=order();
  assert.equal(o.payment_method,'online');assert.equal(o.order_kind,'external');assert.equal(o.payment_status,'unpaid');
  const detail=await buyer.get('/orders/'+orderId);
  assert.equal(detail.status,200);assert.match(detail.body,/checkout\/pay/);assert.match(detail.body,/使用 Stripe 支付/);assert.match(detail.body,/使用 PayPal 支付/);
});

test('signed webhook settles the order idempotently; bad signatures are refused',async()=>{
  const body=JSON.stringify({id:'evt_2',type:'checkout.session.completed',data:{object:{status:'complete',payment_status:'paid',payment_intent:'pi_test_123',metadata:{order_id:orderId}}}});
  const first=await postWebhook(body,sign(body));
  assert.equal(first.status,200,await first.text());
  assert.equal(order().payment_status,'paid');assert.equal(order().payment_provider,'stripe');assert.ok(order().paid_at);
  const receipt=db.prepare('SELECT * FROM order_receipts WHERE order_id=?').get(orderId);
  assert.equal(receipt.method,'Stripe 在线支付');assert.equal(receipt.amount,order().total);
  // 重放同一事件：幂等，不产生第二条收款记录。
  assert.equal((await postWebhook(body,sign(body))).status,200);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM order_receipts WHERE order_id=?').get(orderId).n,1);
  // 篡改负载后旧签名必须失效。
  const tampered=JSON.stringify({id:'evt_2b',type:'checkout.session.completed',data:{object:{status:'complete',payment_status:'paid',payment_intent:'pi_evil',metadata:{order_id:orderId}}}});
  assert.equal((await postWebhook(tampered,sign(body))).status,400);
  // 时间戳超出 5 分钟容差。
  assert.equal((await postWebhook(body,sign(body,Math.floor(Date.now()/1000)-3600))).status,400);
});

test('paid online order exposes no pay button and admin panel lists the session',async()=>{
  const detail=await buyer.get('/orders/'+orderId);
  assert.equal(detail.status,200);assert.doesNotMatch(detail.body,/checkout\/pay/);
  assert.match(detail.body,/款项已通过支付服务商自动确认/);
  const panel=await admin.get('/admin/payments');assert.equal(panel.status,200);assert.match(panel.body,/近期支付会话/);
});

test('checkout pay endpoint rejects non-online orders and unauthenticated callers',async()=>{
  ok(await admin.post('/admin/customers/config',{order_mode:'test',review_days:'5'}));
  const stranger=new Client();await stranger.get('/');
  ok(await stranger.post('/cart/add',{variantId:variant,quantity:1}));
  const page=await stranger.get('/checkout');const quote=page.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];
  const response=await stranger.post('/checkout',{...fields,email:'other@example.com',quote_id:quote,checkoutKey:'pay-test-2'});
  ok(response);const testOrderId=response.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1];
  assert.equal((await stranger.post('/checkout/pay',{order_id:testOrderId,provider:'stripe'})).status,400);
  const other=new Client();await other.get('/');
  assert.equal((await other.post('/checkout/pay',{order_id:orderId,provider:'stripe'})).status,404);
});

test('stripe session creation sends correct API form and stores a session row (mocked transport)',async()=>{
  let captured;
  const fetcher=async(url,init)=>{
    captured={url:String(url),init};
    return {ok:true,json:async()=>({id:'cs_test_mock123',url:'https://checkout.stripe.com/c/pay/cs_test_mock123'})};
  };
  const o=order();
  const result=await payments.createStripeCheckoutSession({...o,total:1500,currency:'USD'},'https://shop.example',fetcher);
  assert.equal(result.redirect,'https://checkout.stripe.com/c/pay/cs_test_mock123');
  assert.match(captured.url,/api\.stripe\.com\/v1\/checkout\/sessions$/);
  const body=String(captured.init.body);
  assert.match(body,/mode=payment/);assert.match(body,/line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=1500/);assert.match(body,/client_reference_id='?\+?/);
  assert.ok(body.includes(encodeURIComponent('metadata[order_id]')));
  const row=db.prepare('SELECT * FROM payment_sessions WHERE id=?').get(result.id);
  assert.equal(row.provider,'stripe');assert.equal(row.provider_ref,'cs_test_mock123');assert.equal(row.amount,1500);assert.equal(row.status,'pending');
  // 会话路径结算幂等：重复 settle（即使引用不同）不重复入账。
  const first=payments.settlePaymentSession(result.id,'pi_mock_capture');
  assert.equal(first,orderId);
  assert.equal(payments.settlePaymentSession(result.id,'pi_other'),orderId);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM order_receipts WHERE order_id=?').get(orderId).n,1);
});
