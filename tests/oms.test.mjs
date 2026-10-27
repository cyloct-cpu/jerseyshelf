import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnTestServer} from './helpers/server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-oms-'+process.pid);
let child,base,db,oms,t17,log='';
class Client{cookies=new Map();csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body,location:r.headers.get('location')};}post(url,data={}){const form=new URLSearchParams({csrf:this.csrf});for(const [k,v] of Object.entries(data))for(const x of Array.isArray(v)?v:[v])form.append(k,x);return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});}}
const admin=new Client(),buyer=new Client();
const ok=r=>assert.equal(r.status,303,r.body+'\n'+log);
const fields={email:'oms@example.com',name:'OMS Tester',phone:'+1 202 555 0100',country:'US',region:'MA',city:'Boston',address:'1 OMS Street',postal:'02110'};
let variant,orderId;
const order=()=>db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);

// 模拟 OMS 服务端：按 API 形状返回可控响应。
function mockOms(calls){
  return async(url,init)=>{
    calls.push({url:String(url),body:JSON.parse(init.body)});
    if(String(url).endsWith('CreateLogisticsOrder')){
      const reference=calls.at(-1).body.reference_no;
      // 模拟异步取号：创建成功但不返回运单号，由后续 GetTrackingNumber 补拉。
      return {ok:true,json:async()=>({Code:1,Msg:'ok',Data:{order_number:'OMS-'+reference.slice(-6),tracking_number:''}})};
    }
    if(String(url).endsWith('GetOrderTrack'))return {ok:true,json:async()=>({Code:1,Msg:'ok',Data:[{no:JSON.parse(init.body).number.split(',')[0],oriNumber:'TRK88888888',newTrack:'已签收',newTrackDate:new Date().toISOString().slice(0,19).replace('T',' '),newTrackLocation:'Boston',events:[{time:new Date().toISOString().slice(0,19).replace('T',' '),content:'已签收',location:'Boston'},{time:new Date(Date.now()-86400000).toISOString().slice(0,19).replace('T',' '),content:'运输中',location:'New York'}]}]})};
    if(String(url).endsWith('getShippingMethod'))return {ok:true,json:async()=>({Code:1,Data:[{service_id:1,service_code:'sagawa',service_name:'日本佐川'}]})};
    if(String(url).endsWith('GetWarehouse'))return {ok:true,json:async()=>({Code:1,Data:[{og_id:7,og_name:'深圳仓'}]})};
    return {ok:true,json:async()=>({Code:1,Data:{}})};
  };
}

before(async()=>{
  mkdirSync(dir,{recursive:true});
  ({child,base}=await spawnTestServer({root,dir,extraEnv:{ADMIN_EMAIL:'oms-admin@example.com',ADMIN_PASSWORD:'oms-password-123456',OMS_AUTO_UPDATE:'false'}}));
  db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  process.env.DATABASE_PATH=path.join(dir,'store.sqlite');
  oms=await import('../apps/api/oms.mjs');
  t17=await import('../apps/api/tracking17.mjs');
  variant=db.prepare('SELECT id FROM variants LIMIT 1').get().id;
  db.prepare('UPDATE variants SET price=1000,stock=100,active=1 WHERE id=?').run(variant);
  db.prepare('UPDATE products SET active=1 WHERE id=(SELECT product_id FROM variants WHERE id=?)').run(variant);
  await admin.get('/account');
  ok(await admin.post('/account/login',{email:'oms-admin@example.com',password:'oms-password-123456'}));
  await admin.get('/admin');
});
after(async()=>{
  db?.close();
  try{(await import('../apps/api/db.mjs')).db.close();}catch{}
  if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}
  assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-oms-'));rmSync(dir,{recursive:true,force:true});
});

async function purchaseCod(){
  ok(await admin.post('/admin/customers/config',{order_mode:'cod',review_days:'5'}));
  await buyer.get('/');
  ok(await buyer.post('/cart/add',{variantId:variant,quantity:2}));
  const page=await buyer.get('/checkout');const quote=page.body.match(/name="quote_id" value="([a-f0-9]+)"/)[1];
  const response=await buyer.post('/checkout',{...fields,quote_id:quote,checkoutKey:'oms-'+Math.random()});
  ok(response);return response.location.match(/orders\/(BW-[A-Z0-9-]+)/)[1];
}

test('config requires credentials to enable and stores password sealed; http warns',async()=>{
  assert.equal((await admin.post('/admin/oms/save',{enabled:'1',base_url:'',customer_code:'',customer_pwd:''})).status,400);
  assert.equal((await admin.post('/admin/oms/save',{enabled:'1',base_url:'ftp://x',customer_code:'c1',customer_pwd:'p1-secret-123456'})).status,400);
  ok(await admin.post('/admin/oms/save',{enabled:'1',base_url:'http://oms.example.com:7772',customer_code:'CUST001',customer_pwd:'oms-secret-password',default_og_id:'7',default_service_code:'sagawa',default_weight_kg:'0.3',cod_remind_days:'14'}));
  const stored=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='oms'").get().value);
  assert.equal(stored.enabled,true);assert.ok(stored.customerPwd&&!stored.customerPwd.includes('oms-secret-password'));
  const page=await admin.get('/admin/oms');assert.equal(page.status,200);assert.match(page.body,/HTTP，客户代码与密码将以明文传输/);assert.doesNotMatch(page.body,/oms-secret-password/);
  // 非 orders.edit 权限不可进入。
  ok(await admin.post('/admin/staff/save',{email:'viewer@oms.test',name:'只读',password:'viewer-password-123',permissions:['dashboard.view']}));
  const viewer=new Client();await viewer.get('/account');
  assert.equal((await viewer.post('/account/login',{email:'viewer@oms.test',password:'viewer-password-123'})).status,303);
  await viewer.get('/admin');
  assert.equal((await viewer.get('/admin/oms')).status,403);
});

test('COD confirmation enqueues an OMS push which creates the order and links tracking (mocked transport)',async()=>{
  orderId=await purchaseCod();
  const o=order();assert.equal(o.payment_method,'cod');assert.equal(o.fulfillment_status,'pending');
  const calls=[];
  const confirm=await admin.post('/admin/cod/confirm',{order_id:orderId,recipient:'OMS Recipient',phone:fields.phone,country:'US',region:'MA',city:'Boston',postal:'02110',address:'1 OMS Street',cod_currency:o.currency,cod_amount:(o.total/100).toFixed(2),confirmed:'1'});
  ok(confirm);
  // 确认后自动入队 create。
  const job=db.prepare("SELECT * FROM oms_queue WHERE order_id=? AND op='create'").get(orderId);
  assert.ok(job,'create job enqueued');
  await oms.drainQueue(mockOms(calls));
  const create=calls.find(c=>String(c.url).endsWith('CreateLogisticsOrder'));
  assert.ok(create,'CreateLogisticsOrder called');
  assert.equal(create.body.reference_no,orderId);
  assert.equal(create.body.customer_code,'CUST001');
  assert.equal(create.body.country_code,'US');
  assert.equal(create.body.COD,o.total/100);
  assert.ok(create.body.Consignee.consignee_telephone);
  assert.ok(create.body.ItemArr.length>0);
  const rec=db.prepare('SELECT * FROM oms_orders WHERE order_id=?').get(orderId);
  assert.ok(rec.oms_order_number);
  assert.equal(rec.tracking_number,'');
  // 异步取号：track 任务补拉运单号并回填 shipments/orders。
  const trackJob=db.prepare("SELECT * FROM oms_queue WHERE order_id=? AND op='track' AND status='pending'").get(orderId);
  assert.ok(trackJob,'track job enqueued after create without tracking');
  db.prepare("UPDATE oms_queue SET next_attempt=0 WHERE status='pending'").run(); // 压缩退避等待
  await oms.drainQueue(async(url,init)=>({ok:true,json:async()=>({Code:1,Data:{tracking_number:'TRK88888888',order_number:rec.oms_order_number,label_url:'https://oms.example/label.pdf'}})}));
  assert.equal(db.prepare('SELECT tracking_number FROM oms_orders WHERE order_id=?').get(orderId).tracking_number,'TRK88888888');
  const shipment=db.prepare("SELECT * FROM shipments WHERE order_id=? AND tracking_number='TRK88888888'").get(orderId);
  assert.ok(shipment);assert.equal(shipment.provider,'oms');assert.equal(shipment.provider_reference,rec.oms_order_number);
  assert.equal(order().fulfillment_status,'shipped');assert.equal(order().tracking,'TRK88888888');
  assert.ok(db.prepare('SELECT url FROM oms_labels WHERE order_id=?').get(orderId));
  assert.equal(db.prepare("SELECT status FROM oms_queue WHERE order_id=? AND op='create'").get(orderId).status,'done');
});

test('track sync maps Chinese statuses to shipment states and delivered sticks to the order',async()=>{
  const calls=[];
  const result=await oms.syncOmsTracks(mockOms(calls));
  assert.equal(result.synced,1);
  const shipment=db.prepare("SELECT * FROM shipments WHERE order_id=? AND tracking_number='TRK88888888'").get(orderId);
  assert.equal(shipment.status,'delivered');
  const events=db.prepare('SELECT COUNT(*) n FROM shipment_events WHERE shipment_id=?').get(shipment.id).n;
  assert.ok(events>=2,'events recorded');
  assert.notEqual(order().delivered_at,'');
  // 幂等：重复同步不重复事件。
  await oms.syncOmsTracks(mockOms([]));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shipment_events WHERE shipment_id=?').get(shipment.id).n,events);
});

test('failed jobs back off and dead-letter after retries',async()=>{
  const id=await oms.enqueueOms(orderId,'track');
  let attempts=0;
  for(let round=0;round<6;round++){
    attempts++;
    await oms.drainQueue(async()=>({ok:false,json:async()=>({Code:0,Msg:'服务不可用'})}));
    const job=db.prepare('SELECT * FROM oms_queue WHERE id=?').get(id);
    if(job.status==='failed')break;
    db.prepare('UPDATE oms_queue SET next_attempt=0 WHERE id=?').run(id); // 压缩退避时间加速测试
  }
  const job=db.prepare('SELECT * FROM oms_queue WHERE id=?').get(id);
  assert.equal(job.status,'failed');assert.ok(job.attempts>=5);assert.match(job.last_error,/OMS/);
});

test('17TRACK config sealed; sync writes events and delivered status for manual shipments',async()=>{
  ok(await admin.post('/admin/tracking17/save',{api_key:'key-17track-abcdefghijklmnop'}));
  const stored=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='tracking17'").get().value);
  assert.ok(stored.apiKey&&!stored.apiKey.includes('key-17track'));
  // 手工运单走 17TRACK 补拉。
  const otherId=await purchaseCod();
  ok(await admin.post('/admin/cod/confirm',{order_id:otherId,recipient:'T17 Recipient',phone:fields.phone,country:'US',region:'MA',city:'Boston',postal:'02110',address:'2 T17 Street',cod_currency:order().currency,cod_amount:(order().total/100).toFixed(2),confirmed:'1'}));
  db.prepare("UPDATE oms_queue SET status='done' WHERE order_id=?").run(otherId);
  ok(await admin.post('/admin/orders/update',{id:otherId,action:'ship',tracking:'TRK170001'}));
  const nowIso=new Date().toISOString();
  const payload={
    code:0,
    data:{
      accept:[
        {
          number:'TRK170001',
          track_info:{
            _:{
              latest_status:{status:'Delivered'},
              event:[{time_iso:nowIso,description:'Delivered - Signed for by recipient',location:'Boston US'}]
            }
          }
        }
      ]
    }
  };
  const fetcher=async()=>({ok:true,json:async()=>payload});
  const result=await t17.syncTracking17(true,fetcher);
  assert.ok(result.synced>=1);
  const shipment=db.prepare("SELECT * FROM shipments WHERE order_id=? AND tracking_number='TRK170001'").get(otherId);
  assert.equal(shipment.status,'delivered');
  const ev=db.prepare('SELECT COUNT(*) n FROM shipment_events WHERE shipment_id=?').get(shipment.id).n;
  assert.ok(ev>=1);
});
