import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-tracking-'+process.pid),base='http://127.0.0.1:'+(36300+process.pid%1000);
let child,db,itemId,shipmentId,output='';
class Client{
 cookies=new Map();csrf='';
 async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body,location:r.headers.get('location')};}
 post(url,data={}){return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:this.csrf,...data})});}
}
const admin=new Client(),buyer=new Client(),stranger=new Client();
before(async()=>{
 mkdirSync(dir,{recursive:true});child=spawn(process.execPath,['apps/api/server.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:base.split(':').at(-1),DATABASE_PATH:path.join(dir,'store.sqlite'),MEDIA_PATH:path.join(dir,'media'),ADMIN_EMAIL:'qa-admin@example.com',ADMIN_PASSWORD:'qa-password-123456',FX_AUTO_UPDATE:'false',TRANSLATION_AUTO_UPDATE:'false'},stdio:['ignore','pipe','pipe']});
 child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);let ready=false;
 for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,60));}assert.ok(ready,output);
 db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
 const at=new Date().toISOString();
 db.prepare('INSERT INTO orders(id,email,customer_name,address,subtotal,shipping,total,idempotency_key,created_at,payment_status) VALUES(?,?,?,?,?,?,?,?,?,?)').run('BW-QA-TRACK','buyer@example.com','Private Customer',JSON.stringify({line:'SECRET ADDRESS',phone:'SECRET PHONE'}),1000,0,1000,'qa-tracking',at,'test_paid');
 const pid=Number(db.prepare('INSERT INTO products(slug,title,price,updated_at) VALUES(?,?,?,?)').run('qa-track-shirt','QA shirt',500,at).lastInsertRowid);
 const vid=Number(db.prepare('INSERT INTO variants(product_id,sku,label,price,stock) VALUES(?,?,?,?,?)').run(pid,'QA-M','M',500,20).lastInsertRowid);
 itemId=Number(db.prepare('INSERT INTO order_items(order_id,variant_id,title,variant_label,sku,unit_price,quantity) VALUES(?,?,?,?,?,?,?)').run('BW-QA-TRACK',vid,'QA shirt','M','QA-M',500,2).lastInsertRowid);
 await admin.get('/account');assert.equal((await admin.post('/account/login',{email:'qa-admin@example.com',password:'qa-password-123456'})).status,303);await admin.get('/admin/orders/BW-QA-TRACK');
});
after(async()=>{db?.close();if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-tracking-'));rmSync(dir,{recursive:true,force:true});});
test('guest lookup grants shipment-only access, validates CSRF, and expires',async()=>{
 const page=await buyer.get('/track?lang=en');assert.match(page.body,/Track your order/);assert.match(page.body,/Checkout email/);
 assert.equal((await stranger.get('/track/BW-QA-TRACK')).status,404);
 assert.equal((await buyer.post('/track',{order_id:'BW-QA-TRACK',email:'buyer@example.com',csrf:'invalid'})).status,403);
 assert.equal((await buyer.post('/track',{order_id:'BW-QA-TRACK',email:'wrong@example.com'})).status,404);
 const found=await buyer.post('/track',{order_id:'bw-qa-track',email:'BUYER@example.com'});assert.equal(found.status,303);assert.equal(found.location,'/track/BW-QA-TRACK');
 const result=await buyer.get(found.location);assert.equal(result.status,200);assert.doesNotMatch(result.body,/SECRET ADDRESS|SECRET PHONE|Private Customer|buyer@example.com/);
 assert.equal((await buyer.get('/orders/BW-QA-TRACK')).status,404);
 assert.equal((await stranger.get('/track/BW-QA-TRACK')).status,404);
 db.prepare('UPDATE tracking_access SET expires=0').run();assert.equal((await buyer.get(found.location)).status,404);
});
test('dispatch creates package and quantity allocations, safe corrections and split quantities are enforced',async()=>{
 const dispatch=await admin.post('/admin/orders/update',{id:'BW-QA-TRACK',action:'ship',tracking:'QA111111'});assert.equal(dispatch.status,303,dispatch.body);
 const initial=db.prepare('SELECT * FROM shipments WHERE order_id=?').get('BW-QA-TRACK');shipmentId=initial.id;
 assert.equal(db.prepare('SELECT quantity FROM shipment_items WHERE shipment_id=?').get(shipmentId).quantity,2);
 const data={order_id:'BW-QA-TRACK',shipment_id:String(shipmentId),carrier:'ups',tracking_number:'QA111111',shipped_at:new Date().toISOString().slice(0,16),['qty_'+itemId]:'1'};
 assert.equal((await buyer.post('/admin/shipments/save',data)).status,403);
 const saved=await admin.post('/admin/shipments/save',data);assert.equal(saved.status,303,saved.body+output);
 const duplicate=await admin.post('/admin/shipments/save',{...data,shipment_id:''});assert.equal(duplicate.status,400);
 const over=await admin.post('/admin/shipments/save',{...data,shipment_id:'',tracking_number:'QA222222',['qty_'+itemId]:'2'});assert.equal(over.status,400);
 assert.equal(db.prepare('SELECT count(*) n FROM shipments').get().n,1);
 assert.equal((await admin.post('/admin/shipments/save',{...data,shipment_id:'',tracking_number:'QA222222'})).status,303);
 db.prepare('INSERT INTO shipment_events(shipment_id,status,description,occurred_at,created_at) VALUES(?,?,?,?,?)').run(shipmentId,'in_transit','Old number event',new Date().toISOString(),new Date().toISOString());
 assert.equal((await admin.post('/admin/shipments/save',{...data,tracking_number:'QA333333'})).status,303);
 assert.equal(db.prepare('SELECT count(*) n FROM shipment_events WHERE shipment_id=?').get(shipmentId).n,0);
 assert.ok(db.prepare('SELECT count(*) n FROM shipment_changes WHERE shipment_id=?').get(shipmentId).n>=2);
 const audit=JSON.parse(db.prepare('SELECT before_json FROM shipment_changes WHERE shipment_id=? ORDER BY id DESC').get(shipmentId).before_json);assert.equal(audit.items[0].quantity,1);
 const page=await admin.get('/admin/orders/BW-QA-TRACK?section=shipping');assert.match(page.body,/包裹管理/);assert.match(page.body,/更正记录/);
 await buyer.post('/track',{order_id:'BW-QA-TRACK',email:'buyer@example.com'});const tracking=await buyer.get('/track/BW-QA-TRACK');assert.equal(tracking.status,200);assert.match(tracking.body,/QA333333/);assert.match(tracking.body,/https:\/\/www.ups.com\/track/);assert.match(tracking.body,/https:\/\/www.ups.com\/track\?tracknum=QA222222/);assert.doesNotMatch(tracking.body,/SECRET ADDRESS|SECRET PHONE/);
});
test('lookup attempts are rate limited',async()=>{const client=new Client();await client.get('/track');let result;for(let i=0;i<16;i++)result=await client.post('/track',{order_id:'BW-MISSING',email:'none@example.com'});assert.equal(result.status,429);});
