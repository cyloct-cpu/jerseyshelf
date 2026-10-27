import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import path from 'node:path';

const dir=mkdtempSync(path.resolve('tests/.tmp-shipping-address-')),base='http://127.0.0.1:'+(45000+process.pid%4000);
let child,db,variant,order,output='';
class Client{
 cookie='';csrf='';
 async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:this.cookie,...options.headers}});for(const c of r.headers.getSetCookie())if(c.startsWith('bw_session='))this.cookie=c.split(';')[0];const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body,location:r.headers.get('location')};}
 post(url,input={},csrf=this.csrf){return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...input})});}
}
const buyer=new Client(),other=new Client(),guest=new Client(),admin=new Client();
const hidden=(body,name)=>body.match(new RegExp('name="'+name+'" value="([^"]*)"'))?.[1];
const fields={email:'address-one@example.com',name:'Address Fixture',country:'BH',region:'Capital Governorate',city:'Qofool',address:'Street 10, House 22',address2:'Building A, Apartment 8',postal:'',phone:'+973 12345678',save_address:'1'};
async function checkout(c){await c.get('/');const r=await c.post('/checkout/buy-now',{variantId:variant,quantity:1});assert.equal(r.status,303,r.body);const page=await c.get(r.location);return {page,url:r.location,input:{...fields,purchase:hidden(page.body,'purchase'),quote_id:hidden(page.body,'quote_id'),checkoutKey:hidden(page.body,'checkoutKey')}};}
before(async()=>{
 child=spawn(process.execPath,['apps/api/server.mjs'],{env:{...process.env,HOST:'127.0.0.1',PORT:new URL(base).port,DATABASE_PATH:path.join(dir,'store.sqlite'),MEDIA_PATH:path.join(dir,'media'),ADMIN_EMAIL:'address-admin@example.com',ADMIN_PASSWORD:'fixture-password-12345',FX_AUTO_UPDATE:'false',TRANSLATION_AUTO_UPDATE:'false',WHATSAPP_AUTO_UPDATE:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
 let ready=false;for(let i=0;i<160;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,output);
 db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');const v=db.prepare('SELECT id,product_id FROM variants LIMIT 1').get();variant=v.id;db.prepare('UPDATE variants SET active=1,stock=100 WHERE id=?').run(variant);db.prepare('UPDATE products SET active=1 WHERE id=?').run(v.product_id);
 await admin.get('/account');assert.equal((await admin.post('/account/login',{email:'address-admin@example.com',password:'fixture-password-12345'})).status,303);await admin.get('/admin/customers/settings');assert.equal((await admin.post('/admin/customers/config',{order_mode:'cod',review_days:'5'})).status,303);
 for(const [c,email]of [[buyer,'address-one@example.com'],[other,'address-two@example.com']]){await c.get('/account/register');assert.equal((await c.post('/account/register',{first_name:'Address Fixture',email,password:'fixture-password-12345'})).status,303);}
});
after(async()=>{db?.close();if(child?.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}assert.ok(path.relative(path.resolve('tests'),dir).startsWith('.tmp-shipping-address-'));rmSync(dir,{recursive:true,force:true});});

test('public local suggestions validate country and expose no private addresses',async()=>{
 const r=await guest.get('/api/address/locations?country=BH');assert.equal(r.status,200);const data=JSON.parse(r.body);assert.ok(data.regions.length>0);assert.ok(data.cities.length>0);assert.doesNotMatch(r.body,/Street 10|Apartment 8|address-one@example/);
 assert.equal((await guest.get('/api/address/locations?country=XX')).status,400);
});
test('address validation preserves apartment, selected country and save preference on errors',async()=>{
 const p=await checkout(buyer);const r=await buyer.post('/checkout',{...p.input,phone:''});assert.equal(r.status,400);assert.match(r.body,/value="Building A, Apartment 8"/);assert.match(r.body,/<option value="BH"[^>]* selected/);assert.match(r.body,/name="save_address" value="1" checked/);assert.equal(db.prepare('SELECT count(*) n FROM saved_shipping_addresses').get().n,0);
 assert.match(r.body,/id="error-phone">请输入您的联系电话/);
 const long=await buyer.post('/checkout',{...p.input,address2:'X'.repeat(201)});assert.equal(long.status,400);assert.match(long.body,/id="error-address2"/);
});

test('Bahrain subdivision is required in checkout and custom cities with optional postal codes remain usable',async()=>{
 const p=await checkout(guest),missing=await guest.post('/checkout',{...p.input,region:''});
 assert.equal(missing.status,400);assert.match(missing.body,/id="error-region"/);assert.match(missing.body,/data-region-required="US CA AU IN BH"/);
 assert.match(missing.body,/name="region"[^>]*required[^>]*role="combobox"/);
 assert.match(missing.body,/name="postal"[^>]*maxlength="30"\s+autocomplete=/);
 assert.match(missing.body,/data-location-toggle="city"/);
 assert.equal(db.prepare('SELECT count(*) n FROM orders').get().n,0);
});
test('successful account checkout remembers only validated shipping fields and preserves order snapshot',async()=>{
 const p=await checkout(buyer),r=await buyer.post('/checkout',p.input);assert.equal(r.status,303,r.body);order=r.location.split('?')[0].split('/').pop();const row=db.prepare('SELECT address FROM orders WHERE id=?').get(order);assert.equal(JSON.parse(row.address).line2,fields.address2);
 const saved=JSON.parse(db.prepare('SELECT address FROM saved_shipping_addresses').get().address);assert.equal(saved.address2,fields.address2);assert.equal(saved.city,'Qofool');assert.equal(saved.email,undefined);assert.equal(saved.whatsapp_consent,undefined);
 const again=await checkout(buyer);assert.match(again.page.body,/value="Building A, Apartment 8"/);assert.match(again.page.body,/data-address-saved="1"/);
 const outsider=await checkout(other);assert.doesNotMatch(outsider.page.body,/value="Building A, Apartment 8"/);
});
test('guest opt-in never writes account address; clear requires own session and CSRF',async()=>{
 const p=await checkout(guest);assert.equal((await guest.post('/checkout',{...p.input,email:'address-guest@example.com'})).status,303);assert.equal(db.prepare('SELECT count(*) n FROM saved_shipping_addresses').get().n,1);
 assert.equal((await buyer.post('/account/shipping-address/clear',{},'wrong')).status,403);assert.equal((await guest.post('/account/shipping-address/clear')).status,401);
 assert.equal((await other.post('/account/shipping-address/clear')).status,200);assert.equal(db.prepare('SELECT count(*) n FROM saved_shipping_addresses').get().n,1);
 assert.equal((await buyer.post('/account/shipping-address/clear')).status,200);assert.equal(db.prepare('SELECT count(*) n FROM saved_shipping_addresses').get().n,0);assert.equal(JSON.parse(db.prepare('SELECT address FROM orders WHERE id=?').get(order).address).line2,fields.address2);
});
test('COD confirmation, copy and CSV retain apartment; shipping changes leave original order intact',async()=>{
 const o=db.prepare('SELECT total,currency FROM orders WHERE id=?').get(order);await admin.get('/admin/orders/'+order);
 const input={order_id:order,confirmed:'1',recipient:fields.name,phone:fields.phone,country:'BH',region:fields.region,city:fields.city,address:fields.address,postal:'',cod_currency:o.currency,cod_amount:(o.total/100).toFixed(2)};
 assert.equal((await admin.post('/admin/cod/confirm',{...input,region:''})).status,400);
 assert.equal(db.prepare('SELECT shipping_address FROM orders WHERE id=?').get(order).shipping_address,'');
 assert.equal((await admin.post('/admin/cod/confirm',input)).status,303);let row=db.prepare('SELECT address,shipping_address FROM orders WHERE id=?').get(order);assert.equal(JSON.parse(row.shipping_address).line2,fields.address2);
 const page=await admin.get('/admin/orders/'+order);assert.match(page.body,/Building A, Apartment 8/);const csv=await admin.post('/admin/cod/export',{order_ids:order});assert.equal(csv.status,200);assert.match(csv.body,/Street 10, House 22, Building A, Apartment 8/);
 assert.equal((await admin.post('/admin/cod/confirm',{...input,address2:''})).status,303);row=db.prepare('SELECT address,shipping_address FROM orders WHERE id=?').get(order);assert.equal(JSON.parse(row.shipping_address).line2,'');assert.equal(JSON.parse(row.address).line2,fields.address2);
});
test('unchecking account save on a later order removes saved default without changing historical orders',async()=>{
 let p=await checkout(buyer);assert.equal((await buyer.post('/checkout',p.input)).status,303);assert.equal(db.prepare('SELECT count(*) n FROM saved_shipping_addresses').get().n,1);
 p=await checkout(buyer);assert.equal((await buyer.post('/checkout',{...p.input,save_address:'0'})).status,303);assert.equal(db.prepare('SELECT count(*) n FROM saved_shipping_addresses').get().n,0);
});
