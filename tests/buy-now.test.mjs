import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'tests/.tmp-buy-now-'+process.pid),basePort=34200+process.pid%1000,base='http://127.0.0.1:'+basePort;
let child,db,variantId,otherId,lastId;
class Client{
  cookies=new Map();csrf='';
  async get(url,options={}){
    const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});
    for(const cookie of r.headers.getSetCookie()){const pair=cookie.split(';')[0],at=pair.indexOf('=');this.cookies.set(pair.slice(0,at),pair.slice(at+1));}
    const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;
    return {status:r.status,body,location:r.headers.get('location')};
  }
  post(url,data={}){const form=new URLSearchParams({csrf:this.csrf});for(const [k,v]of Object.entries(data))for(const item of Array.isArray(v)?v:[v])form.append(k,item);return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});}
}
const fields={email:'qa-buyer@example.com',name:'QA buyer',country:'CN',city:'Shanghai',address:'QA address',postal:'200000',phone:'',note:'QA note <script>alert(1)</script>'};
const hidden=(body,key)=>body.match(new RegExp('name="'+key+'" value="([^"]*)"'))?.[1];
async function buy(client,quantity=1,extra={}){
  const r=await client.post('/checkout/buy-now',{variantId,quantity,...extra});assert.equal(r.status,303,r.body);
  const page=await client.get(r.location);assert.equal(page.status,200,page.body);
  return {url:r.location,id:hidden(page.body,'purchase'),quote_id:hidden(page.body,'quote_id'),checkoutKey:hidden(page.body,'checkoutKey'),body:page.body};
}
const checkoutData=p=>({...fields,purchase:p.id,quote_id:p.quote_id,checkoutKey:p.checkoutKey});
before(async()=>{
  mkdirSync(dir,{recursive:true});
  child=spawn(process.execPath,['apps/api/server.mjs'],{cwd:root,env:{...process.env,PORT:String(basePort),HOST:'127.0.0.1',DATABASE_PATH:path.join(dir,'store.sqlite'),MEDIA_PATH:path.join(dir,'media'),ADMIN_EMAIL:'qa-admin@example.com',ADMIN_PASSWORD:'qa-password-123456',FX_AUTO_UPDATE:'false',TRANSLATION_AUTO_UPDATE:'false'},stdio:['ignore','pipe','pipe']});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,output);
  db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  const add=(slug,price,stock)=>{const id=Number(db.prepare('INSERT INTO products(slug,title,price,updated_at) VALUES(?,?,?,?)').run(slug,slug,price,new Date().toISOString()).lastInsertRowid);return Number(db.prepare('INSERT INTO variants(product_id,sku,label,price,stock) VALUES(?,?,?,?,?)').run(id,slug+'-M','M',price,stock).lastInsertRowid);};
  variantId=add('qa-direct',1000,100);otherId=add('qa-cart',500,20);lastId=add('qa-last',2500,1);
  db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run('exchange_rates',JSON.stringify([{base:'USD',quote:'JPY',rate:150,date:new Date().toISOString().slice(0,10)},{base:'USD',quote:'KWD',rate:.306,date:new Date().toISOString().slice(0,10)}]));
});
after(async()=>{
  db?.close();if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}
  const relative=path.relative(path.join(root,'tests'),dir);assert.ok(relative.startsWith('.tmp-buy-now-')&&!relative.includes(path.sep));rmSync(dir,{recursive:true,force:true});
});

test('dual actions and independent direct checkout preserve the existing cart, including identical variants',async()=>{
  const c=new Client();await c.get('/products/qa-direct');
  const product=await c.get('/products/qa-direct?lang=en');assert.match(product.body,/data-buy-now/);assert.match(product.body,/>Buy now<\/button>/);
  await c.post('/cart/add',{variantId:otherId,quantity:2});await c.post('/cart/add',{variantId,quantity:1});
  const beforeCart=await c.get('/cart'),p=await buy(c,2,{printingName:'Ronaldo#7',patchIds:['club-league','club-champions']});
  assert.match(p.body,/Ronaldo#7/);assert.ok(!p.body.includes('qa-cart'));
  const english=await c.get(p.url+'&lang=en');assert.match(english.body,/Free shipping from/);assert.match(english.body,/>Printing<\/span>/);assert.match(english.body,/>League patch<\/span>/);assert.ok(!english.body.includes('免邮件数'));
  assert.match((await c.get(p.url+'&lang=ar')).body,/dir="rtl"/);
  const stock=db.prepare('SELECT stock FROM variants WHERE id=?').get(variantId).stock;
  const order=await c.post('/checkout',checkoutData(p));assert.equal(order.status,303,order.body);
  const id=order.location.match(/\/orders\/(BW-[A-Z0-9-]+)/)[1],stored=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  assert.equal(stored.subtotal,3800);assert.equal(stored.shipping,1000);assert.equal(stored.total,4800);assert.equal(stored.note,fields.note);
  assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(variantId).stock,stock-2);
  const afterCart=await c.get('/cart');assert.equal(afterCart.body,beforeCart.body);
  const page=await c.get('/orders/'+id);assert.match(page.body,/&lt;script&gt;alert/);assert.ok(!page.body.includes('<script>alert'));
  const stranger=new Client();assert.equal((await stranger.get('/orders/'+id)).status,404);
});
test('purchase identity prevents duplicate orders even with fresh submission keys and simultaneous requests',async()=>{
  const c=new Client();await c.get('/');const p=await buy(c),stock=db.prepare('SELECT stock FROM variants WHERE id=?').get(variantId).stock;
  const results=await Promise.all([c.post('/checkout',checkoutData(p)),c.post('/checkout',{...checkoutData(p),checkoutKey:'new-key'})]);
  assert.ok(results.every(r=>r.status===303));assert.equal(results[0].location,results[1].location);
  const repeat=await c.post('/checkout',{...checkoutData(p),checkoutKey:'another-key'});assert.equal(repeat.location,results[0].location);
  assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(variantId).stock,stock-1);
  assert.equal((await c.get(p.url)).location,results[0].location.split('?')[0]);
});
test('separate tabs retain selections and returning to the product restores quantity and customization',async()=>{
  const c=new Client();await c.get('/');const first=await buy(c,3,{printingName:'Alex#9',patchIds:'club-league'}),second=await buy(c,1,{printingName:'Sam#10'});
  assert.notEqual(first.id,second.id);assert.match((await c.get(first.url)).body,/Alex#9/);assert.match((await c.get(second.url)).body,/Sam#10/);
  const product=await c.get('/products/qa-direct?purchase='+first.id);assert.match(product.body,/name="quantity" value="3"/);assert.match(product.body,/name="printingName" value="Alex#9"/);assert.match(product.body,/value="club-league" checked/);
  assert.equal(db.prepare('SELECT count(*) n FROM orders WHERE id IN (SELECT order_id FROM direct_purchases WHERE id IN (?,?))').get(first.id,second.id).n,0);
});
test('unavailable stock keeps the buy-now label visible but rejects checkout creation',async()=>{
  const c=new Client();await c.get('/');
  const page=await c.get('/products/2026-27-bayern-munich-away-kit-fan-edition');
  assert.match(page.body,/data-buy-now[^>]*disabled>立即购买<\/button>/);
  assert.equal((await c.post('/checkout/buy-now',{variantId,quantity:101})).status,400);
  db.prepare('UPDATE variants SET stock=0 WHERE id=?').run(lastId);
  assert.equal((await c.post('/checkout/buy-now',{variantId:lastId,quantity:1})).status,400);
  db.prepare('UPDATE variants SET stock=1 WHERE id=?').run(lastId);
});
test('quotes are bound to their checkout source, owner, lifetime and live prices',async()=>{
  const c=new Client();await c.get('/');await c.post('/cart/add',{variantId,quantity:1});const cart=await c.get('/checkout'),p=await buy(c);
  assert.equal((await c.post('/checkout',{...checkoutData(p),quote_id:hidden(cart.body,'quote_id')})).status,400);
  assert.equal((await c.post('/checkout',{...fields,checkoutKey:'cart-with-direct',quote_id:p.quote_id})).status,400);
  assert.equal((await c.post('/checkout',{...checkoutData(p),quote_id:''})).status,400);
  const stranger=new Client();await stranger.get('/');assert.equal((await stranger.get(p.url)).status,404);assert.equal((await stranger.post('/checkout',checkoutData(p))).status,404);
  db.prepare('UPDATE checkout_quotes SET expires=0 WHERE id=?').run(p.quote_id);assert.equal((await c.post('/checkout',checkoutData(p))).status,400);
  const fresh=await buy(c);db.prepare('UPDATE variants SET price=1100 WHERE id=?').run(variantId);assert.equal((await c.post('/checkout',checkoutData(fresh))).status,400);db.prepare('UPDATE variants SET price=1000 WHERE id=?').run(variantId);
  db.prepare('UPDATE direct_purchases SET expires=0 WHERE id=?').run(p.id);assert.equal((await c.get(p.url)).status,400);
});
test('validation keeps form fields, renders inline errors, and country-aware postal requirements allow Gulf addresses',async()=>{
  const c=new Client();await c.get('/');const p=await buy(c);
  const bad=await c.post('/checkout',{...checkoutData(p),email:'invalid',name:'Keep this name',note:'Keep this note',country:'XX'});
  assert.equal(bad.status,400);assert.match(bad.body,/id="error-email"/);assert.match(bad.body,/id="error-country"/);assert.match(bad.body,/value="Keep this name"/);assert.match(bad.body,/>Keep this note<\/textarea>/);
  assert.equal(db.prepare('SELECT order_id FROM direct_purchases WHERE id=?').get(p.id).order_id,null);
  const valid=await c.post('/checkout',{...checkoutData(p),country:'AE',postal:'',quote_id:hidden(bad.body,'quote_id')});assert.equal(valid.status,303,valid.body);
});
test('a direct purchase uses only its own quantity for promotions and free shipping',async()=>{
  const c=new Client();await c.get('/');await c.post('/cart/add',{variantId:otherId,quantity:10});
  for(const [quantity,discount]of [[2,0],[3,500],[7,500],[8,1000],[9,1000],[10,1800]]){
    const p=await buy(c,quantity),r=await c.post('/checkout',checkoutData(p));assert.equal(r.status,303,r.body);
    const id=r.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1],order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
    assert.equal(order.base_discount,discount);assert.equal(order.base_shipping,quantity>=3?0:1000);assert.equal(order.base_total,quantity*1000-discount+(quantity>=3?0:1000));
    // Return inventory through the actual admin cancellation flow below, to preserve stock for later cases.
    const admin=new Client();await admin.get('/account');await admin.post('/account/login',{email:'qa-admin@example.com',password:'qa-password-123456'});await admin.get('/admin');assert.equal((await admin.post('/admin/orders/update',{id,action:'cancel'})).status,303);
  }
});
test('last-item competition does not oversell and cancellation restores inventory once',async()=>{
  const a=new Client(),b=new Client();await a.get('/');await b.get('/');const x=await buy(a,1,{variantId:lastId}),y=await buy(b,1,{variantId:lastId});
  const results=await Promise.all([a.post('/checkout',checkoutData(x)),b.post('/checkout',checkoutData(y))]);assert.deepEqual(results.map(r=>r.status).sort(),[303,400]);assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(lastId).stock,0);
  const admin=new Client();await admin.get('/account');await admin.post('/account/login',{email:'qa-admin@example.com',password:'qa-password-123456'});await admin.get('/admin');
  const id=results.find(r=>r.status===303).location.match(/orders\/(BW-[A-Z0-9-]+)/)[1];assert.equal((await admin.post('/admin/orders/update',{id,action:'cancel'})).status,303);assert.equal((await admin.post('/admin/orders/update',{id,action:'cancel'})).status,400);assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(lastId).stock,1);
});
test('currency confirmation and zero/three decimal order totals work for direct purchases',async()=>{
  const c=new Client();await c.get('/');const p=await buy(c);
  await c.get('/currency?code=JPY');assert.equal((await c.post('/checkout',checkoutData(p))).status,400);
  for(const [currency,total]of [['JPY',3000],['KWD',6120]]){
    await c.get('/currency?code='+currency);const next=await buy(c),r=await c.post('/checkout',checkoutData(next));assert.equal(r.status,303,r.body);
    const order=db.prepare('SELECT currency,total FROM orders WHERE id=?').get(r.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1]);assert.equal(order.currency,currency);assert.equal(order.total,total);
  }
});
test('login rotates the session and resumes the same checkout with the existing quote',async()=>{
  const c=new Client();await c.get('/');const p=await buy(c);const auth=await c.get('/account/register?returnTo='+encodeURIComponent(p.url));assert.match(auth.body,/name="returnTo"/);
  const r=await c.post('/account/register',{name:'QA account',email:'qa-customer@example.com',password:'qa-customer-password',returnTo:p.url});assert.equal(r.location,p.url);await c.get(p.url);
  const order=await c.post('/checkout',checkoutData(p));assert.equal(order.status,303,order.body);
  const id=order.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1],saved=db.prepare('SELECT user_id FROM orders WHERE id=?').get(id);assert.ok(saved.user_id);
  assert.equal((await c.get('/orders/'+id)).status,200);
  const outsider=new Client();await outsider.get('/account');const login=await outsider.post('/account/login',{email:'qa-customer@example.com',password:'qa-customer-password',returnTo:'https://example.com'});assert.equal(login.location,'/account');
});
