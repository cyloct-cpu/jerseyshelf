import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-cod-'+process.pid),base='http://127.0.0.1:'+(39500+process.pid%1000);
let child,db,variant,orderId,otherId,returnId,cancelId,log='';
class Client{cookies=new Map();csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body,location:r.headers.get('location'),disposition:r.headers.get('content-disposition')};}post(url,data={}){const form=new URLSearchParams({csrf:this.csrf});for(const [k,v] of Object.entries(data))for(const x of Array.isArray(v)?v:[v])form.append(k,x);return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});}}
const admin=new Client(),buyer=new Client(),stranger=new Client(),ok=r=>assert.equal(r.status,303,r.body+'\n'+log),stamp=()=>new Date().toISOString();
const fields={email:'cod@example.com',name:'Original Recipient',phone:'+1 202 555 0100',country:'US',region:'MA',city:'Boston',address:'Original address',postal:'02110'};
async function purchase(quantity=1){await buyer.get('/');ok(await buyer.post('/cart/add',{variantId:variant,quantity}));const page=await buyer.get('/checkout');const quote=page.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];const response=await buyer.post('/checkout',{...fields,quote_id:quote,checkoutKey:'cod-'+Math.random()});ok(response);return response.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1];}
const order=id=>db.prepare('SELECT * FROM orders WHERE id=?').get(id);
function confirmation(id,extra={}){const o=order(id);return admin.post('/admin/cod/confirm',{order_id:id,recipient:'Corrected Recipient',phone:fields.phone,country:'US',region:'MA',city:'Boston',postal:'02110',address:'Corrected address',cod_currency:o.currency,cod_amount:(o.total/100).toFixed(2),confirmed:'1',...extra});}
const action=(id,s,kind,extra={})=>admin.post('/admin/cod/action',{order_id:id,shipment_id:s,action:kind,occurred_at:stamp(),evidence:'Fixture carrier verification',...extra});
before(async()=>{
 mkdirSync(dir,{recursive:true});child=spawn(process.execPath,['apps/api/server.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:base.split(':').at(-1),DATABASE_PATH:path.join(dir,'store.sqlite'),MEDIA_PATH:path.join(dir,'media'),ADMIN_EMAIL:'qa-admin@example.com',ADMIN_PASSWORD:'qa-password-123456',FX_AUTO_UPDATE:'false',TRANSLATION_AUTO_UPDATE:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',b=>log+=b);child.stderr.on('data',b=>log+=b);let ready=false;for(let i=0;i<150;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,log);
 db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');variant=db.prepare('SELECT id FROM variants LIMIT 1').get().id;db.prepare('UPDATE variants SET price=1000,stock=100,active=1 WHERE id=?').run(variant);db.prepare('UPDATE products SET active=1 WHERE id=(SELECT product_id FROM variants WHERE id=?)').run(variant);
 await admin.get('/account');ok(await admin.post('/account/login',{email:'qa-admin@example.com',password:'qa-password-123456'}));await admin.get('/admin/customers/settings');
});
after(async()=>{db?.close();if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-cod-'));rmSync(dir,{recursive:true,force:true});});
test('COD setting affects only new orders; required phone/region and checkout messaging are enforced',async()=>{
 const historical=await purchase();assert.equal(order(historical).payment_method,'prepaid');
 ok(await admin.post('/admin/customers/config',{order_mode:'cod',review_days:'5'}));
 await buyer.get('/');ok(await buyer.post('/cart/add',{variantId:variant,quantity:2}));const page=await buyer.get('/checkout?lang=en');assert.match(page.body,/Cash on delivery/);assert.match(page.body,/name="phone"[^>]*required/);assert.doesNotMatch(page.body,/Pay before|waiting for payment/);
 const quote=page.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1],data={...fields,quote_id:quote,checkoutKey:'cod-first'};
 assert.equal((await buyer.post('/checkout',{...data,phone:''})).status,400);assert.equal((await buyer.post('/checkout',{...data,region:''})).status,400);
 const response=await buyer.post('/checkout',data);ok(response);orderId=response.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1];const o=order(orderId);assert.equal(o.order_kind,'external');assert.equal(o.payment_method,'cod');assert.equal(o.payment_status,'unpaid');assert.equal(o.cod_amount,o.total);assert.equal(order(historical).payment_method,'prepaid');assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_tasks WHERE order_id=? AND kind='payment'").get(orderId).n,0);
 otherId=await purchase();returnId=await purchase();cancelId=await purchase();
});
test('shipping confirmation preserves original address and export is authenticated, CSRF protected and formula safe',async()=>{
 for(const section of ['overview','follow','shipping','money','aftersales','history']){
  const page=await admin.get('/admin/orders/'+orderId+'?section='+section);
  assert.equal(page.status,200,section+': '+page.body+log);
  if(section==='follow'){assert.match(page.body,/Original address/);assert.match(page.body,/name="phone"/);}
 }
 assert.equal((await admin.post('/admin/cod/action',{order_id:orderId,action:'dispatch',tracking:'COD11111'})).status,400);
 assert.equal((await confirmation(orderId,{confirmed:'0'})).status,400);
 assert.equal((await confirmation(orderId,{cod_currency:'EUR'})).status,400);
 ok(await confirmation(orderId,{recipient:'=HYPERLINK("bad")',cod_note:'Fixture <script>bad</script>'}));
 assert.equal(JSON.parse(order(orderId).address).line,'Original address');assert.equal(JSON.parse(order(orderId).shipping_address).line,'Corrected address');
 assert.equal((await stranger.post('/admin/cod/export',{order_ids:orderId})).status,403);
 assert.equal((await admin.post('/admin/cod/export',{order_ids:orderId,csrf:'forged'})).status,403);
 const csv=await admin.post('/admin/cod/export',{order_ids:[orderId]});assert.equal(csv.status,200,csv.body);assert.match(csv.disposition,/shipping-orders.csv/);assert.match(csv.body,/Corrected address/);assert.match(csv.body,/'=HYPERLINK/);
 const page=await admin.get('/admin/orders/'+orderId+'?section=follow');assert.equal(page.status,200,page.body+log);assert.match(page.body,/一键复制收货信息/);assert.doesNotMatch(page.body,/<script>bad/);
});
test('CSV backfill reports each row, dispatches unpaid confirmed COD, rejects unmatched rows, and safely skips duplicate replay',async()=>{
 const csv='order_id,tracking_number,carrier,carrier_name\r\n'+orderId+',COD11111,ups,\r\n'+orderId+',COD11111,ups,\r\nBW-NOTFOUND,COD99999,ups,\r\n'+otherId+',COD22222,ups,\r\n';
 const r=await admin.post('/admin/cod/import',{csv});assert.equal(r.status,200,r.body+log);assert.match(r.body,/成功/);assert.match(r.body,/跳过/);assert.match(r.body,/失败/);assert.equal(order(orderId).fulfillment_status,'shipped');assert.equal(order(orderId).payment_status,'unpaid');assert.equal(order(otherId).fulfillment_status,'pending');
 assert.equal(db.prepare('SELECT COUNT(*) n FROM shipments WHERE order_id=?').get(orderId).n,1);
 assert.equal((await admin.post('/admin/customers/receipt',{order_id:orderId})).status,400);
 assert.equal((await admin.post('/admin/cod/import',{csv:'bad,columns\na,b'})).status,400);
});
test('split shipment allocation enforces item quantities and COD total; signing never changes payment status',async()=>{
 const first=db.prepare('SELECT * FROM shipments WHERE order_id=?').get(orderId),item=db.prepare('SELECT * FROM order_items WHERE order_id=?').get(orderId);const date=first.shipped_at.slice(0,16);
 const data={order_id:orderId,shipment_id:first.id,carrier:'ups',carrier_name:'',tracking_number:'COD11111',shipped_at:date,cod_amount:'10.00',['qty_'+item.id]:'1'};
 ok(await admin.post('/admin/shipments/save',data));
 assert.equal((await admin.post('/admin/shipments/save',{...data,shipment_id:'',tracking_number:'COD22222',cod_amount:(order(orderId).cod_amount/100).toFixed(2)})).status,400);
 const remaining=(order(orderId).cod_amount-1000)/100;
 ok(await admin.post('/admin/shipments/save',{...data,shipment_id:'',tracking_number:'COD22222',cod_amount:remaining.toFixed(2)}));
 assert.equal((await action(otherId,first.id,'delivered')).status,400);
 ok(await action(orderId,first.id,'delivered'));assert.equal(order(orderId).payment_status,'unpaid');assert.equal(order(orderId).delivered_at,'');
 const stats=JSON.parse((await admin.get('/admin/cod/stats.json')).body);assert.ok(stats.collection>=1);
 const page=await admin.get('/admin/orders');assert.match(page.body,/部分签收/);
 assert.equal((await admin.post('/admin/shipments/save',data)).status,400);
 assert.equal((await action(orderId,first.id,'collect',{amount:'99'})).status,400);
 ok(await action(orderId,first.id,'collect',{amount:'10'}));assert.equal((await action(orderId,first.id,'collect',{amount:'10'})).status,400);
 const second=db.prepare('SELECT * FROM shipments WHERE order_id=? AND id<>?').get(orderId,first.id);ok(await action(orderId,second.id,'delivered'));assert.ok(order(orderId).delivered_at);assert.equal(order(orderId).payment_status,'unpaid');ok(await action(orderId,second.id,'collect',{amount:remaining.toFixed(2)}));
});
test('remittance tracks gross, fee and net independently; partial amounts and replay never inflate paid balance',async()=>{
 const data={order_id:orderId,currency:'USD',gross:'10',fee:'1',reference:'COD-SETTLEMENT-1',request_key:'COD-KEY-1',occurred_at:stamp(),confirmed:'1'};
 assert.equal((await admin.post('/admin/cod/remit',{...data,confirmed:'0'})).status,400);assert.equal((await admin.post('/admin/cod/remit',{...data,currency:'EUR'})).status,400);
 ok(await admin.post('/admin/cod/remit',data));assert.equal(order(orderId).payment_status,'partial');ok(await admin.post('/admin/cod/remit',data));assert.equal(db.prepare('SELECT COUNT(*) n FROM cod_remittances WHERE order_id=?').get(orderId).n,1);
 assert.equal((await admin.post('/admin/cod/remit',{...data,gross:'9'})).status,409);
 assert.equal((await admin.post('/admin/cod/remit',{...data,gross:'999',reference:'COD-OVER',request_key:'COD-OVER'})).status,400);
 const remainder=(order(orderId).cod_amount-1000)/100;ok(await admin.post('/admin/cod/remit',{...data,gross:remainder.toFixed(2),fee:'0',reference:'COD-SETTLEMENT-2',request_key:'COD-KEY-2'}));assert.equal(order(orderId).payment_status,'paid');assert.equal(db.prepare('SELECT SUM(net) net FROM cod_remittances WHERE order_id=?').get(orderId).net,order(orderId).cod_amount-100);
 const page=await admin.get('/admin/orders/'+orderId+'?section=money');assert.match(page.body,/已回款/);assert.match(page.body,/COD-SETTLEMENT-1/);
});
test('refused and returned packages do not restore inventory before warehouse verification, and restock only happens once',async()=>{
 ok(await confirmation(returnId));ok(await admin.post('/admin/cod/action',{order_id:returnId,action:'dispatch',tracking:'RETURN123'}));const s=db.prepare('SELECT * FROM shipments WHERE order_id=?').get(returnId),before=db.prepare('SELECT stock FROM variants WHERE id=?').get(variant).stock;
 ok(await action(returnId,s.id,'refused'));assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(variant).stock,before);
 ok(await action(returnId,s.id,'returning'));assert.equal((await action(returnId,s.id,'restock',{confirmed:'1'})).status,400);
 ok(await action(returnId,s.id,'returned'));assert.equal((await action(returnId,s.id,'restock',{confirmed:'0'})).status,400);ok(await action(returnId,s.id,'restock',{confirmed:'1'}));assert.equal((await action(returnId,s.id,'restock',{confirmed:'1'})).status,400);assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(variant).stock,before+1);
 const page=await admin.get('/admin/orders/'+returnId);assert.match(page.body,/已退回入库/);
});
test('unshipped COD cancellation restores inventory once and stale shipment warnings are visible',async()=>{
 const before=db.prepare('SELECT stock FROM variants WHERE id=?').get(variant).stock;ok(await admin.post('/admin/cod/action',{order_id:cancelId,action:'cancel'}));assert.equal((await admin.post('/admin/cod/action',{order_id:cancelId,action:'cancel'})).status,400);assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(variant).stock,before+1);
 ok(await confirmation(otherId));ok(await admin.post('/admin/cod/action',{order_id:otherId,action:'dispatch',tracking:'STALE123'}));db.prepare('UPDATE shipments SET updated_at=? WHERE order_id=?').run(new Date(Date.now()-4*86400000).toISOString(),otherId);
 assert.ok(JSON.parse((await admin.get('/admin/cod/stats.json')).body).stale>=1);assert.match((await admin.get('/admin/orders?view=stale')).body,/STALE123/);
});
