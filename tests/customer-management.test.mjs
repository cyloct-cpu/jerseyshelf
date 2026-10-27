import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),folder=mkdtempSync(path.join(root,'tests/.tmp-customers-'));
const port=37000+process.pid%1000,base='http://127.0.0.1:'+port;
let child,db,variantId,log='',buyerId,formalId,guestId;
class Client{cookie='';csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:this.cookie,...options.headers}});for(const c of r.headers.getSetCookie())if(c.startsWith('bw_session='))this.cookie=c.split(';')[0];const body=await r.text(),token=body.match(/name="csrf" value="([a-f0-9]+)"/);if(token)this.csrf=token[1];return {status:r.status,body,location:r.headers.get('location')};}post(url,data={},csrf=this.csrf){return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf,...data})});}}
const admin=new Client(),buyer=new Client(),guest=new Client(),stranger=new Client();
const row=contact=>db.prepare('SELECT * FROM customers WHERE email=?').get(contact);
const stamp=()=>new Date().toISOString();
const expectOK=r=>assert.equal(r.status,303,r.body+'\n'+log);
async function purchase(client,contact,key,extra={}){await client.get('/');expectOK(await client.post('/cart/add',{variantId,quantity:'1'}));const checkout=await client.get('/checkout');assert.equal(checkout.status,200,checkout.body);const quote=checkout.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];const data={email:contact,name:'Order Recipient',country:'US',city:'Boston',address:'Fixture address',postal:'02110',phone:'+1 202 555 0148',checkoutKey:key,quote_id:quote,...extra};const r=await client.post('/checkout',data);expectOK(r);return {id:r.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1],data};}
const receipt=(id,amount,extra={})=>admin.post('/admin/customers/receipt',{order_id:id,kind:'receipt',currency:'USD',amount,method:'Fixture bank',reference:'reference-'+Math.random(),occurred_at:stamp(),request_key:'receipt-'+Math.random(),confirmed:'1',...extra});
before(async()=>{
 child=spawn(process.execPath,['apps/api/server.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATABASE_PATH:path.join(folder,'test.sqlite'),MEDIA_PATH:path.join(folder,'media'),ADMIN_EMAIL:'admin@local.test',ADMIN_PASSWORD:'test-password-123456',FX_AUTO_UPDATE:'false',TRANSLATION_AUTO_UPDATE:'false'},stdio:['ignore','pipe','pipe']});child.stdout.on('data',v=>log+=v);child.stderr.on('data',v=>log+=v);
 let ready=false;for(let i=0;i<120;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}assert.ok(ready,log);
 db=new DatabaseSync(path.join(folder,'test.sqlite'));db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
 const v=db.prepare('SELECT v.id,v.product_id FROM variants v LIMIT 1').get();variantId=v.id;db.prepare('UPDATE variants SET stock=50,active=1,price=1000 WHERE id=?').run(v.id);db.prepare('UPDATE products SET active=1 WHERE id=?').run(v.product_id);
 await admin.get('/account');expectOK(await admin.post('/account/login',{email:'admin@local.test',password:'test-password-123456'}));await admin.get('/admin/customers');
});
after(async()=>{db?.close();if(child?.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}const relative=path.relative(path.join(root,'tests'),folder);assert.ok(relative.startsWith('.tmp-customers-')&&!relative.includes(path.sep));rmSync(folder,{recursive:true,force:true});});

test('客户所有入口受管理员鉴权、CSRF和跨站保护',async()=>{
 for(const url of ['/admin/customers','/admin/customers/new','/admin/customers/1','/admin/customers/status.json','/admin/customers/export.csv','/admin/customers/settings'])assert.equal((await stranger.get(url)).status,303,url);
 assert.equal((await stranger.post('/admin/customers/save',{email:'bad@example.com'})).status,403);
 assert.equal((await admin.post('/admin/customers/save',{email:'bad@example.com'},'forged')).status,403);
 assert.equal((await admin.get('/admin/customers/save',{method:'POST',headers:{Origin:'https://outside.example','Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:admin.csrf,email:'bad@example.com'})})).status,403);
});
test('邮箱注册自动建档、记录姓名时间、待核实且未成交，只有一个首次跟进',async()=>{
 await buyer.get('/account/register');expectOK(await buyer.post('/account/register',{email:'registered@example.com',name:'Registered Buyer',password:'fixture-password-12345',whatsapp_phone:'+44 7700 900123'}));buyerId=row('registered@example.com').id;
 const c=row('registered@example.com');assert.equal(c.name,'Registered Buyer');assert.equal(c.phone,'447700900123');assert.equal(c.whatsapp_status,'unknown');
 assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_tasks WHERE customer_id=? AND kind='first_contact'").get(c.id).n,1);
 const r=await admin.get('/admin/customers?view=registered');assert.equal(r.status,200,r.body);assert.match(r.body,/Registered Buyer/);assert.match(r.body,/未成交/);
 assert.equal((await buyer.get('/admin/customers/export.csv')).status,403);
});
test('仅邮箱订阅归入来源，不伪造注册时间，不自动创建账户',async()=>{
 expectOK(await stranger.post('/subscribe',{email:'subscription@example.com'}));expectOK(await stranger.post('/subscribe',{email:'subscription@example.com'}));
 const c=row('subscription@example.com');assert.equal(c.source,'subscribe');assert.equal(c.name,'');assert.equal(db.prepare('SELECT COUNT(*) n FROM customers WHERE email=?').get(c.email).n,1);assert.equal(db.prepare('SELECT id FROM users WHERE email=?').get(c.email),undefined);
 const page=await admin.get('/admin/customers/'+c.id);assert.match(page.body,/首次|注册/);assert.match(page.body,/无|有邮箱订阅记录/);
});
test('WhatsApp未知、确认未联系、已联系分别统计，核实有记录且更换号码回到未知',async()=>{
 expectOK(await admin.post('/admin/customers/whatsapp',{customer_id:buyerId,status:'not_contacted',note:'已核对，未建立对话'}));let stats=JSON.parse((await admin.get('/admin/customers/status.json')).body);assert.equal(stats.unconnected,1);
 expectOK(await admin.post('/admin/customers/whatsapp',{customer_id:buyerId,status:'connected',note:'已收到尺码确认消息'}));assert.equal(row('registered@example.com').whatsapp_status,'connected');
 assert.equal((await admin.post('/admin/customers/whatsapp',{customer_id:buyerId,status:'connected',note:''})).status,400);
 expectOK(await admin.post('/admin/customers/save',{id:buyerId,name:'Registered Buyer',email:'registered@example.com',phone:'+44 7700 900124',tags:'重点意向',owner:'Fixture agent'}));assert.equal(row('registered@example.com').whatsapp_status,'unknown');
 assert.equal((await admin.post('/admin/customers/save',{id:buyerId,name:'Buyer',email:'changed@example.com'})).status,400);
 expectOK(await admin.post('/admin/customers/whatsapp',{customer_id:buyerId,status:'connected',note:'更换号码后重新确认'}));
});
test('默认测试下单仍保留库存逻辑，测试付款不算成交也不产生真实新订单提醒',async()=>{
 const made=await purchase(buyer,'registered@example.com','test-order');expectOK(await admin.post('/admin/orders/update',{id:made.id,action:'test-pay'}));
 assert.equal(db.prepare('SELECT order_kind FROM orders WHERE id=?').get(made.id).order_kind,'test');const stats=JSON.parse((await admin.get('/admin/customers/status.json')).body);assert.equal(stats.new_orders,0);assert.ok(stats.registered>=1);
 assert.equal((await receipt(made.id,'1.00')).status,400);
});
test('正式订单关联注册客户，提交不是成交，首次联系和付款任务幂等',async()=>{
 expectOK(await admin.post('/admin/customers/config',{order_mode:'external',review_days:'5'}));const made=await purchase(buyer,'registered@example.com','formal-order');formalId=made.id;
 const o=db.prepare('SELECT * FROM orders WHERE id=?').get(formalId);assert.equal(o.order_kind,'external');assert.equal(o.customer_id,buyerId);assert.equal(o.payment_status,'unpaid');
 expectOK(await buyer.post('/checkout',made.data));assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_tasks WHERE order_id=? AND kind='first_contact'").get(formalId).n,1);
 assert.equal((await admin.get('/admin/customers?view=new_orders')).body.includes('Registered Buyer'),true);
 assert.equal((await admin.get('/admin/orders/'+formalId)).status,200);assert.match((await admin.get('/orders/'+formalId)).body,/不会自动扣款/);
});
test('游客直接下单自动建立档案及待联系提醒；注册相同邮箱不认领游客订单',async()=>{
 const made=await purchase(guest,'guest@example.com','guest-direct');guestId=made.id;const c=row('guest@example.com');assert.ok(c);assert.equal(c.whatsapp_status,'unknown');assert.equal(c.phone,'12025550148');assert.equal(db.prepare('SELECT user_id FROM orders WHERE id=?').get(guestId).user_id,null);
 assert.ok((await admin.get('/admin/customers?view=new_orders')).body.includes('guest@example.com'));
 const impersonator=new Client();await impersonator.get('/account/register');expectOK(await impersonator.post('/account/register',{email:'guest@example.com',name:'Same Email Account',password:'fixture-password-12345'}));assert.equal((await impersonator.get('/orders/'+guestId)).status,404);assert.ok(!(await impersonator.get('/account')).body.includes(guestId));
});
test('首次联系必须有真实结果；可记录沟通完成并设置下一次时间',async()=>{
 const task=db.prepare("SELECT * FROM customer_tasks WHERE order_id=? AND kind='first_contact'").get(formalId);
 assert.equal((await admin.post('/admin/customers/task-update',{customer_id:buyerId,task_id:task.id,action:'done',result:'点击打开'})).status,400);
 assert.equal((await admin.post('/admin/customers/contact',{customer_id:buyerId,task_id:task.id,channel:'whatsapp',outcome:'no_reply',body:'未回复'})).status,400);
 const next=new Date(Date.now()+86400000).toISOString();expectOK(await admin.post('/admin/customers/contact',{customer_id:buyerId,order_id:formalId,task_id:task.id,channel:'whatsapp',outcome:'contacted',body:'客户已确认尺码，等待付款',next_at:next,next_kind:'payment'}));assert.equal(db.prepare('SELECT status FROM customer_tasks WHERE id=?').get(task.id).status,'done');assert.ok(row('registered@example.com').last_contact_at);
});
test('收款须核实、同币种、精度正确、不可超收；重放不重复记款，收齐才成交',async()=>{
 assert.equal((await receipt(formalId,'1.00',{confirmed:''})).status,400);assert.equal((await receipt(formalId,'1.001')).status,400);assert.equal((await receipt(formalId,'1.00',{currency:'JPY'})).status,400);
 const part={request_key:'stable-receipt-key',reference:'bank-part-001'};expectOK(await receipt(formalId,'3.00',part));expectOK(await receipt(formalId,'3.00',part));assert.equal(db.prepare('SELECT COUNT(*) n FROM order_receipts WHERE order_id=?').get(formalId).n,1);assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id=?').get(formalId).payment_status,'partial');
 assert.equal((await receipt(formalId,'99999')).status,400);assert.equal((await receipt(formalId,'4.00',part)).status,409);
 const o=db.prepare('SELECT * FROM orders WHERE id=?').get(formalId);expectOK(await receipt(formalId,((o.total-300)/100).toFixed(2)));assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id=?').get(formalId).payment_status,'paid');
 const page=await admin.get('/admin/customers/'+buyerId);assert.match(page.body,/有已核实成交 1 单/);assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_tasks WHERE order_id=? AND kind='payment' AND status='pending'").get(formalId).n,0);
});
test('发货、实际收货和回访分别处理；重复确认不重复生成回访',async()=>{
 expectOK(await admin.post('/admin/orders/update',{id:formalId,action:'ship',tracking:'FIXTURE-TRACK-1'}));assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_tasks WHERE order_id=? AND kind='review'").get(formalId).n,0);
 const at=stamp();expectOK(await admin.post('/admin/orders/update',{id:formalId,action:'delivered',delivered_at:at}));assert.equal((await admin.post('/admin/orders/update',{id:formalId,action:'delivered',delivered_at:at})).status,400);
 const tasks=db.prepare("SELECT * FROM customer_tasks WHERE order_id=? AND kind='review'").all(formalId);assert.equal(tasks.length,1);assert.equal(Date.parse(tasks[0].due_at)-Date.parse(at),5*86400000);assert.ok((await admin.get('/admin/customers?view=review')).body.includes('Registered Buyer'));
});
test('售后关联正确订单，处理历史保留，解决后关闭任务并能重新开启',async()=>{
 expectOK(await admin.post('/admin/customers/case',{customer_id:buyerId,order_id:formalId,category:'size',subject:'Fixture size enquiry',due_at:stamp(),owner:'Support agent'}));const item=db.prepare('SELECT * FROM customer_cases WHERE customer_id=?').get(buyerId);
 assert.equal((await admin.post('/admin/customers/case',{customer_id:buyerId,order_id:guestId,category:'other',subject:'wrong owner',due_at:stamp()})).status,400);
 expectOK(await admin.post('/admin/customers/case-update',{customer_id:buyerId,case_id:item.id,status:'resolved',body:'已与客户协商处理'}));assert.equal(db.prepare('SELECT status FROM customer_tasks WHERE dedupe_key=?').get('case:'+item.id).status,'done');
 expectOK(await admin.post('/admin/customers/case-update',{customer_id:buyerId,case_id:item.id,status:'processing',body:'客户补充反馈，重新处理'}));assert.equal(db.prepare('SELECT status FROM customer_tasks WHERE dedupe_key=?').get('case:'+item.id).status,'pending');assert.match((await admin.get('/admin/customers?view=aftersale')).body,/Registered Buyer/);
});
test('退款保留流水，不自动恢复已发货库存；不能超退',async()=>{
 const before=db.prepare('SELECT stock FROM variants WHERE id=?').get(variantId).stock;expectOK(await receipt(formalId,'1.00',{kind:'refund',reference:'refund-001'}));assert.equal(db.prepare('SELECT payment_status FROM orders WHERE id=?').get(formalId).payment_status,'part_refunded');assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(variantId).stock,before);assert.equal((await receipt(formalId,'999.00',{kind:'refund'})).status,400);assert.ok(db.prepare('SELECT paid_at FROM orders WHERE id=?').get(formalId).paid_at);assert.match((await admin.get('/admin/customers/'+buyerId)).body,/有已核实成交 1 单/);
});
test('取消正式未付款订单仅恢复一次库存，并关闭对应普通待办',async()=>{
 const before=db.prepare('SELECT stock FROM variants WHERE id=?').get(variantId).stock;expectOK(await admin.post('/admin/orders/update',{id:guestId,action:'cancel'}));assert.equal(db.prepare('SELECT stock FROM variants WHERE id=?').get(variantId).stock,before+1);assert.equal((await admin.post('/admin/orders/update',{id:guestId,action:'cancel'})).status,400);assert.equal(db.prepare("SELECT COUNT(*) n FROM customer_tasks WHERE order_id=? AND status='pending'").get(guestId).n,0);
});
test('筛选、归档恢复、停止普通跟进、CSV防公式和页面防注入',async()=>{
 expectOK(await admin.post('/admin/customers/save',{name:'=Fixture <script>alert(1)</script>',email:'export@example.com',phone:'',tags:'批发',do_not_contact:'1'}));const c=row('export@example.com');assert.equal((await admin.post('/admin/customers/task',{customer_id:c.id,kind:'purchase',due_at:stamp()})).status,400);
 let page=await admin.get('/admin/customers?q=export%40example.com');assert.match(page.body,/&lt;script&gt;/);assert.ok(!page.body.includes('=Fixture <script>'));
 const csv=await admin.get('/admin/customers/export.csv?q=export%40example.com');assert.equal(csv.status,200);assert.ok(csv.body.includes("'=Fixture"));assert.ok(!csv.body.includes('Fixture address'));
 expectOK(await admin.post('/admin/customers/archive',{customer_id:c.id}));assert.ok(!(await admin.get('/admin/customers?q=export%40example.com')).body.includes('=Fixture'));assert.ok((await admin.get('/admin/customers?view=archived')).body.includes('=Fixture'));expectOK(await admin.post('/admin/customers/archive',{customer_id:c.id,restore:'1'}));
 const stats=await admin.get('/admin/customers/status.json');assert.ok(!stats.body.includes('export@example.com'));assert.ok(!stats.body.includes('Fixture address'));
});
test('历史关联初始化幂等，不改变订单授权、收款和已有跟进',()=>{
 const tasks=db.prepare('SELECT COUNT(*) n FROM customer_tasks').get().n,events=db.prepare('SELECT COUNT(*) n FROM customer_events').get().n;
 const run=spawnSync(process.execPath,['--input-type=module','-e',"const {initializeCustomers}=await import('./apps/api/customers.mjs');initializeCustomers();initializeCustomers();const {db}=await import('./apps/api/db.mjs');db.close();"],{cwd:root,env:{...process.env,DATABASE_PATH:path.join(folder,'test.sqlite'),MEDIA_PATH:path.join(folder,'media')},encoding:'utf8'});assert.equal(run.status,0,run.stderr);assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_tasks').get().n,tasks);assert.equal(db.prepare('SELECT COUNT(*) n FROM customer_events').get().n,events);assert.equal(db.prepare('SELECT user_id FROM orders WHERE id=?').get(guestId).user_id,null);
});

 test('归档客户重新下正式订单会恢复档案，订单待联系不会遗漏',async()=>{
  expectOK(await admin.post('/admin/customers/archive',{customer_id:buyerId}));
  const made=await purchase(buyer,'registered@example.com','reactivated-order');
  assert.equal(row('registered@example.com').archived_at,null);
  assert.ok((await admin.get('/admin/customers?view=new_orders')).body.includes('Registered Buyer'));
  assert.equal((await admin.get('/admin/customers?q=%25')).body.includes('Registered Buyer'),false);
 });

 test('注册昵称及邮箱自动显示为只读，未下单不要求填写订单号',async()=>{
  const client=new Client();await client.get('/account/register');expectOK(await client.post('/account/register',{email:'auto-profile@example.com',name:'Auto Nickname',password:'fixture-password-12345'}));
  const c=row('auto-profile@example.com'),page=await admin.get('/admin/customers/'+c.id);assert.equal(page.status,200,page.body);
  assert.match(page.body,/客户昵称（注册信息）<input value="Auto Nickname" readonly/);
  assert.match(page.body,/name="email"[^>]*value="auto-profile@example.com"[^>]*readonly/);
  assert.match(page.body,/尚未下单，无需填写订单号/);
  expectOK(await admin.post('/admin/customers/save',{id:c.id,name:'Manual contact name',nickname:'Forged nickname'}));
  assert.equal(row(c.email).email,c.email);assert.equal(db.prepare('SELECT name FROM users WHERE email=?').get(c.email).name,'Auto Nickname');
 });
 test('已保存收货姓名、国家及原始手机自动填入，订单号自动关联并默认选中',async()=>{
  const made=await purchase(buyer,'registered@example.com','autofill-shipping',{name:'Shipping Contact Alice',country:'GB',city:'London',postal:'NW1 6XE',phone:'07700 900123'});
  const c=row('registered@example.com');assert.equal(c.name,'Shipping Contact Alice');assert.equal(c.country,'GB');assert.equal(c.mobile,'07700 900123');assert.equal(c.phone,'447700900124');
  const page=await admin.get('/admin/customers/'+c.id);assert.equal(page.status,200,page.body);assert.match(page.body,/客户昵称（注册信息）<input value="Registered Buyer" readonly/);
  assert.match(page.body,/name="name" value="Shipping Contact Alice"/);assert.match(page.body,/name="mobile" value="07700 900123"/);assert.match(page.body,/name="country" value="GB"/);
  assert.ok(page.body.includes('<option value="'+made.id+'" selected>'));assert.ok(page.body.includes('最近关联订单：<a href="/admin/orders/'+made.id+'">'+made.id));
 });
 test('手动补充的姓名、地区和手机保留，恢复自动填充后采用最新收货资料',async()=>{
  expectOK(await admin.post('/admin/customers/save',{id:buyerId,name:'Merchant corrected name',country:'Manual region',mobile:'Manual phone'}));
  const made=await purchase(buyer,'registered@example.com','autofill-preserve',{name:'New Shipping Name',country:'US',phone:'+1 202 555 0199'});
  let c=row('registered@example.com');assert.equal(c.name,'Merchant corrected name');assert.equal(c.country,'Manual region');assert.equal(c.mobile,'Manual phone');
  expectOK(await admin.post('/admin/customers/restore-auto',{customer_id:buyerId}));c=row('registered@example.com');assert.equal(c.name,'New Shipping Name');assert.equal(c.country,'US');assert.equal(c.mobile,'+1 202 555 0199');
  assert.equal(c.email,'registered@example.com');assert.equal(db.prepare('SELECT name FROM users WHERE email=?').get(c.email).name,'Registered Buyer');
  assert.equal((await admin.post('/admin/customers/save',{id:buyerId,email:'forged@example.com'})).status,400);
  assert.equal(db.prepare('SELECT customer_id FROM orders WHERE id=?').get(made.id).customer_id,buyerId);
 });
 test('历史资料同步可重复执行，补全资料不会创建重复客户或改变订单权限',()=>{
  const before=db.prepare('SELECT COUNT(*) n FROM customers').get().n;
  const run=spawnSync(process.execPath,['--input-type=module','-e',"const {initializeCustomers}=await import('./apps/api/customers.mjs');initializeCustomers();initializeCustomers();const {db}=await import('./apps/api/db.mjs');db.close();"],{cwd:root,env:{...process.env,DATABASE_PATH:path.join(folder,'test.sqlite'),MEDIA_PATH:path.join(folder,'media')},encoding:'utf8'});assert.equal(run.status,0,run.stderr);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM customers').get().n,before);assert.equal(db.prepare('SELECT user_id FROM orders WHERE id=?').get(guestId).user_id,null);
  assert.equal(row('auto-profile@example.com').name,'Manual contact name');
 });
