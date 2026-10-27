import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {createHmac} from 'node:crypto';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnTestServer} from './helpers/server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-mail-'+process.pid);
let child,base,db,mailer,payments,log='';
class Client{cookies=new Map();csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body,location:r.headers.get('location')};}post(url,data={}){const form=new URLSearchParams({csrf:this.csrf});for(const [k,v] of Object.entries(data))for(const x of Array.isArray(v)?v:[v])form.append(k,x);return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});}}
const admin=new Client(),buyer=new Client();
const ok=r=>assert.equal(r.status,303,r.body+'\n'+log);
const fields={email:'mail@example.com',name:'Mail Tester',phone:'+1 202 555 0100',country:'US',region:'MA',city:'Boston',address:'1 Mail Street',postal:'02110'};
let variant,orderId;
const WEBHOOK_SECRET='whsec_mailtest_abcdefghijk';
const order=()=>db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
const sign=(body,timestamp=Math.floor(Date.now()/1000))=>{const t=String(timestamp);return 't='+t+',v1='+createHmac('sha256',WEBHOOK_SECRET).update(t+'.'+body,'utf8').digest('hex');};

before(async()=>{
  mkdirSync(dir,{recursive:true});
  ({child,base}=await spawnTestServer({root,dir,extraEnv:{ADMIN_EMAIL:'mail-admin@example.com',ADMIN_PASSWORD:'mail-password-123456',OMS_AUTO_UPDATE:'false',EMAIL_AUTO_UPDATE:'false'}}));
  db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  process.env.DATABASE_PATH=path.join(dir,'store.sqlite');
  mailer=await import('../apps/api/mailer.mjs');
  payments=await import('../apps/api/payments.mjs');
  variant=db.prepare('SELECT id FROM variants LIMIT 1').get().id;
  db.prepare('UPDATE variants SET price=1000,stock=100,active=1 WHERE id=?').run(variant);
  db.prepare('UPDATE products SET active=1 WHERE id=(SELECT product_id FROM variants WHERE id=?)').run(variant);
  await admin.get('/account');
  ok(await admin.post('/account/login',{email:'mail-admin@example.com',password:'mail-password-123456'}));
  await admin.get('/admin');
  ok(await admin.post('/admin/payments/save',{enabled:'1',stripe_secret_key:'sk_test_abcdefghijklmnop',stripe_webhook_secret:WEBHOOK_SECRET}));
});
after(async()=>{
  db?.close();
  try{(await import('../apps/api/db.mjs')).db.close();}catch{}
  if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}
  assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-mail-'));rmSync(dir,{recursive:true,force:true});
});

test('config sealed; unconfigured queue stays pending without consuming attempts',async()=>{
  assert.equal((await admin.post('/admin/email/save',{enabled:'1',from:'shop@example.com',api_key:'short'})).status,400);
  ok(await admin.post('/admin/email/save',{enabled:'1',from:'JerseyShelf <shop@example.com>',api_key:'re_mailtest_abcdefghijklmnop'}));
  const stored=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='email'").get().value);
  assert.ok(stored.apiKey&&!stored.apiKey.includes('re_mailtest'));
  const page=await admin.get('/admin/email');assert.equal(page.status,200);assert.match(page.body,/邮件通知/);assert.doesNotMatch(page.body,/re_mailtest/);
  // 未开启时队列挂起。
  db.prepare("UPDATE settings SET value=json_set(value,'$.enabled',json('false')) WHERE key='email'").run();
  await mailer.enqueueEmail({dedupeKey:'probe:1',to:'x@example.com',kind:'custom',subject:'挂起',body:'<p>x</p>'});
  await mailer.drainEmail(async()=>{throw new Error('should not send while disabled');});
  const row=db.prepare("SELECT * FROM email_messages WHERE dedupe_key='email:probe:1'").get();
  assert.equal(row.status,'pending');assert.equal(row.attempts,0);
});

test('online payment webhook enqueues a localized confirmation email and worker sends it',async()=>{
  ok(await admin.post('/admin/customers/config',{order_mode:'online',review_days:'5'}));
  db.prepare("UPDATE settings SET value=json_set(value,'$.enabled',json('true')) WHERE key='email'").run();
  await buyer.get('/language?lang=en&return=/');
  await buyer.get('/');
  ok(await buyer.post('/cart/add',{variantId:variant,quantity:1}));
  const page=await buyer.get('/checkout');const quote=page.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];
  const response=await buyer.post('/checkout',{...fields,quote_id:quote,checkoutKey:'mail-online-1'});
  ok(response);orderId=response.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1];
  const body=JSON.stringify({id:'evt_m1',type:'checkout.session.completed',data:{object:{status:'complete',payment_status:'paid',payment_intent:'pi_mail_1',metadata:{order_id:orderId}}}});
  const hook=await fetch(base+'/webhooks/stripe',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':sign(body)},body});
  assert.equal(hook.status,200,await hook.text());
  const queued=db.prepare("SELECT * FROM email_messages WHERE order_id=? AND kind='order_paid'").get(orderId);
  assert.ok(queued,'confirmation email queued');
  assert.equal(queued.status,'pending');assert.equal(queued.to_email,order().email);
  const sent=[];
  await mailer.drainEmail(async(url,init)=>{
    sent.push({url:String(url),payload:JSON.parse(init.body)});
    return {ok:true,json:async()=>({id:'email-id-1'})};
  });
  assert.equal(sent.length,2,'pending probe + confirmation both sent');
  assert.match(sent.at(-1).url,/api\.resend\.com\/emails$/);
  assert.equal(sent.at(-1).payload.to[0],order().email);
  assert.match(sent.at(-1).payload.subject,/Payment confirmed/);
  assert.equal(db.prepare('SELECT status FROM email_messages WHERE id=?').get(queued.id).status,'sent');
  // 幂等：重复事件不会重新入队。
  await fetch(base+'/webhooks/stripe',{method:'POST',headers:{'Content-Type':'application/json','Stripe-Signature':sign(body)},body});
  assert.equal(db.prepare("SELECT COUNT(*) n FROM email_messages WHERE order_id=? AND kind='order_paid'").get(orderId).n,1);
});

test('shipping and refunds enqueue emails with dedupe keys; failed sends retry then dead-letter',async()=>{
  // 发货：外部收款订单人工发货。
  ok(await admin.post('/admin/orders/update',{id:orderId,action:'ship',tracking:'TRK-MAIL-1'}));
  const shipped=db.prepare("SELECT * FROM email_messages WHERE order_id=? AND kind='shipped'").get(orderId);
  assert.ok(shipped);assert.match(shipped.subject,/Shipped/);assert.ok(shipped.body.includes('TRK-MAIL-1'));
  // 退款：人工退款登记触发退款确认。
  await admin.post('/admin/customers/receipt',{order_id:orderId,kind:'refund',amount:'10.00',currency:order().currency,method:'bank',reference:'rf-mail-1',occurred_at:new Date().toISOString().slice(0,19),confirmed:'1',request_key:'mail-refund-1'});
  const refund=db.prepare("SELECT * FROM email_messages WHERE order_id=? AND kind='refund'").get(orderId);
  assert.ok(refund,'refund email queued');
  // 失败重试与死信（跳过其他待发行，专注探针）。
  db.prepare("UPDATE email_messages SET status='skipped' WHERE status='pending' AND dedupe_key<>'email:probe:fail'").run();
  await mailer.enqueueEmail({dedupeKey:'probe:fail',to:'fail@example.com',kind:'custom',subject:'会失败',body:'<p>x</p>'});
  for(let round=0;round<4;round++){
    await mailer.drainEmail(async()=>({ok:false,json:async()=>({message:'boom'})}));
    const row=db.prepare("SELECT * FROM email_messages WHERE dedupe_key='email:probe:fail'").get();
    if(row.status==='failed')break;
    db.prepare('UPDATE email_messages SET next_attempt=0 WHERE id=?').run(row.id);
  }
  const row=db.prepare("SELECT * FROM email_messages WHERE dedupe_key='email:probe:fail'").get();
  assert.equal(row.status,'failed');assert.ok(row.attempts>=3);assert.match(row.last_error,/邮件服务返回错误/);
});
