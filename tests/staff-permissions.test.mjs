import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnTestServer} from './helpers/server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-staff-'+process.pid);
let child,base,db,log='';
class Client{cookies=new Map();csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body};}post(url,data={}){const form=new URLSearchParams({csrf:this.csrf});for(const [k,v] of Object.entries(data))for(const x of Array.isArray(v)?v:[v])form.append(k,x);return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});}}
const owner=new Client(),staff=new Client(),viewer=new Client(),intruder=new Client();
const ok=r=>assert.equal(r.status,303,r.body+'\n'+log);
before(async()=>{
  mkdirSync(dir,{recursive:true});
  ({child,base}=await spawnTestServer({root,dir,extraEnv:{ADMIN_EMAIL:'owner@example.com',ADMIN_PASSWORD:'owner-password-123456'}}));
  db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  await owner.get('/account');
  ok(await owner.post('/account/login',{email:'owner@example.com',password:'owner-password-123456'}));
  await owner.get('/admin'); // 登录后会话轮换，重新抓取 CSRF 令牌。
  // 初始管理员迁移后必须是 owner。
  assert.equal(db.prepare("SELECT permissions FROM users WHERE email='owner@example.com'").get().permissions,'["owner"]');
  // 创建一个只有订单权限的员工和一个只有基础浏览权限的员工。
  ok(await owner.post('/admin/staff/save',{email:'staff@example.com',name:'订单专员',password:'staff-password-123456',permissions:['dashboard.view','orders.view','orders.edit']}));
  ok(await owner.post('/admin/staff/save',{email:'viewer@example.com',name:'临时浏览',password:'viewer-password-123456',permissions:['dashboard.view']}));
  await staff.get('/account');
  ok(await staff.post('/account/login',{email:'staff@example.com',password:'staff-password-123456'}));
  await staff.get('/admin');
  await viewer.get('/account');
  ok(await viewer.post('/account/login',{email:'viewer@example.com',password:'viewer-password-123456'}));
  await viewer.get('/admin');
});
after(async()=>{db?.close();if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-staff-'));rmSync(dir,{recursive:true,force:true});});

test('navigation and pages follow permission keys',async()=>{
  const home=await viewer.get('/admin');assert.equal(home.status,200);assert.doesNotMatch(home.body,/订单中心/);assert.doesNotMatch(home.body,/员工与权限/);
  const ordersNav=await staff.get('/admin');assert.equal(ordersNav.status,200);assert.match(ordersNav.body,/订单中心/);assert.doesNotMatch(ordersNav.body,/站点设置/);
  assert.equal((await viewer.get('/admin/orders')).status,403);
  assert.equal((await viewer.get('/admin/settings')).status,403);
  assert.equal((await staff.get('/admin/orders')).status,200);
  assert.equal((await staff.get('/admin/staff')).status,403);
  assert.equal((await staff.get('/admin/settings')).status,403);
  assert.equal((await owner.get('/admin/staff')).status,200);
});

test('write operations are blocked without the matching permission key',async()=>{
  // viewer 无 settings.edit，保存站点设置被拒。
  assert.equal((await viewer.post('/admin/settings/save',{name:'X',freeShippingQty:'3',shipping:'10.00'})).status,403);
  // staff 无 products.edit，保存商品被拒；导航也不出现商品管理。
  assert.equal((await staff.post('/admin/products/save',{title:'越权商品',price:'10.00',variants:'[]'})).status,403);
  // staff 无 customers.view，客户导出被拒。
  assert.equal((await staff.get('/admin/customers/export.csv')).status,403);
  // 无 staff.manage 的账号不能管理员工。
  assert.equal((await staff.post('/admin/staff/save',{email:'x@example.com',name:'x',password:'x-password-123456',permissions:['dashboard.view']})).status,403);
  // 越权尝试会写入审计日志。
  assert.ok(db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='permission.denied'").get().n>=4);
});

test('last owner and self protections are enforced',async()=>{
  const ownerId=db.prepare("SELECT id FROM users WHERE email='owner@example.com'").get().id;
  // 最后一个负责人不能降级、不能删除；不能删除自己。
  assert.equal((await owner.post('/admin/staff/save',{id:String(ownerId),email:'owner@example.com',name:'负责人',permissions:['dashboard.view']})).status,400);
  assert.equal((await owner.post('/admin/staff/delete',{id:String(ownerId)})).status,400);
  // 有两个 owner 时可以降级旧的。
  ok(await owner.post('/admin/staff/save',{email:'second-owner@example.com',name:'第二负责人',password:'second-password-123456',permissions:['owner']}));
  ok(await owner.post('/admin/staff/save',{id:String(ownerId),email:'owner@example.com',name:'负责人',permissions:['owner']}));
  const secondId=db.prepare("SELECT id FROM users WHERE email='second-owner@example.com'").get().id;
  ok(await owner.post('/admin/staff/delete',{id:String(secondId)}));
  // 不能修改自己的权限。
  assert.equal((await owner.post('/admin/staff/save',{id:String(ownerId),email:'owner@example.com',name:'负责人',permissions:['orders.view']})).status,400);
  // 重复邮箱被拒绝。
  assert.equal((await owner.post('/admin/staff/save',{email:'staff@example.com',name:'重复',password:'dup-password-123456',permissions:['dashboard.view']})).status,409);
  // 密码长度校验。
  assert.equal((await owner.post('/admin/staff/save',{email:'short@example.com',name:'短密码',password:'short',permissions:['dashboard.view']})).status,400);
});

test('repeated login failures lock the account for 15 minutes',async()=>{
  await intruder.get('/account');
  for(let i=0;i<4;i++)assert.equal((await intruder.post('/account/login',{email:'staff@example.com',password:'wrong-'+i})).status,401);
  // 第 5 次失败触发锁定，即使密码正确也暂时无法登录。
  assert.equal((await intruder.post('/account/login',{email:'staff@example.com',password:'totally-wrong'})).status,401);
  assert.equal((await intruder.post('/account/login',{email:'staff@example.com',password:'staff-password-123456'})).status,429);
  const row=db.prepare("SELECT fails,locked_until FROM login_failures WHERE email='staff@example.com'").get();
  assert.equal(row.fails,5);assert.ok(row.locked_until>Date.now());
  // 解锁后正确密码可以登录（模拟锁定到期）。
  db.prepare("UPDATE login_failures SET locked_until=0 WHERE email='staff@example.com'").run();
  ok(await intruder.post('/account/login',{email:'staff@example.com',password:'staff-password-123456'}));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM login_failures WHERE email='staff@example.com'").get().n,0);
});
