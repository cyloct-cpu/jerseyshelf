import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'tests','.tmp-traffic-'+process.pid);mkdirSync(dir,{recursive:true});
process.env.DATABASE_PATH=path.join(dir,'traffic.sqlite');process.env.MEDIA_PATH=path.join(dir,'media');
const {db}=await import('../apps/api/db.mjs');
const {recordTraffic,currentTraffic,trafficSummary,trafficDay,ONLINE_WINDOW_MS}=await import('../apps/api/traffic.mjs');
db.prepare('INSERT INTO products(slug,title,price,updated_at) VALUES(?,?,?,?)').run('traffic-product','流量验收商品',100,'qa');
const visitor='a'.repeat(64),page='1'.repeat(32),productPath='/products/traffic-product',at=Date.UTC(2026,9,14,12);
beforeEach(()=>db.exec('DELETE FROM traffic_presence; DELETE FROM traffic_views;'));
after(()=>{db.close();const relative=path.relative(path.join(root,'tests'),dir);assert.ok(relative.startsWith('.tmp-traffic-')&&!relative.includes(path.sep));if(existsSync(dir))rmSync(dir,{recursive:true,force:true});});
test('同浏览器多标签去重，刷新累计PV，心跳不增加PV，关闭只移除当前标签',()=>{
  recordTraffic(visitor,{pageId:page,path:productPath,action:'enter'},at);
  recordTraffic(visitor,{pageId:page,path:productPath,action:'enter'},at+100);
  recordTraffic(visitor,{pageId:page,path:productPath,action:'heartbeat'},at+15000);
  recordTraffic(visitor,{pageId:'2'.repeat(32),path:productPath,action:'enter'},at+16000);
  let s=trafficSummary(at+16000);assert.equal(s.online,1);assert.equal(s.visitors,1);assert.equal(s.pageViews,2);assert.equal(s.productViews,2);assert.equal(s.products[0].online,1);
  recordTraffic('b'.repeat(64),{pageId:'3'.repeat(32),path:productPath,action:'enter'},at+17000);assert.equal(currentTraffic(1,at+17000).productOnline,2);
  recordTraffic(visitor,{pageId:page,path:productPath,action:'leave'},at+18000);assert.equal(currentTraffic(1,at+18000).productOnline,2);
  recordTraffic(visitor,{pageId:'2'.repeat(32),path:productPath,action:'leave'},at+19000);assert.equal(currentTraffic(1,at+19000).productOnline,1);
  assert.equal(trafficSummary(at+19000).visitors,2);
});
test('在线人数45秒过期，恢复心跳重新上线且历史访问不丢失',()=>{
  recordTraffic(visitor,{pageId:page,path:productPath,action:'enter'},at);
  assert.equal(currentTraffic(1,at+ONLINE_WINDOW_MS-1).productOnline,1);
  assert.equal(currentTraffic(1,at+ONLINE_WINDOW_MS).productOnline,0);
  assert.equal(trafficSummary(at+ONLINE_WINDOW_MS).pageViews,1);
  recordTraffic(visitor,{pageId:page,path:productPath,action:'heartbeat'},at+ONLINE_WINDOW_MS+1);
  assert.equal(currentTraffic(1,at+ONLINE_WINDOW_MS+1).productOnline,1);assert.equal(trafficSummary(at+ONLINE_WINDOW_MS+1).pageViews,1);
});
test('今日统计以北京时间跨日，跨日心跳不重复制造访问',()=>{
  const midnight=Date.UTC(2026,9,14,16);assert.equal(trafficDay(midnight-1),'2026-10-14');assert.equal(trafficDay(midnight),'2026-10-15');
  recordTraffic(visitor,{pageId:page,path:productPath,action:'enter'},midnight-1000);
  recordTraffic(visitor,{pageId:page,path:productPath,action:'heartbeat'},midnight+1000);
  assert.equal(trafficSummary(midnight+1000).pageViews,0);assert.equal(trafficSummary(midnight+1000).online,1);
  recordTraffic(visitor,{pageId:'4'.repeat(32),path:'/',action:'enter'},midnight+2000);assert.equal(trafficSummary(midnight+2000).visitors,1);
});
test('无效商品、后台路径、查询字符串和页面标识复用不会污染统计',()=>{
  recordTraffic(visitor,{pageId:page,path:productPath,action:'enter'},at);
  for(const invalid of ['/admin','/products/missing','/search?q=private'])assert.throws(()=>recordTraffic(visitor,{pageId:'5'.repeat(32),path:invalid,action:'enter'},at));
  assert.throws(()=>recordTraffic(visitor,{pageId:page,path:'/',action:'enter'},at));
  assert.throws(()=>recordTraffic(visitor,{pageId:'6'.repeat(32),path:'/',action:'heartbeat'},at));
  assert.equal(trafficSummary(at).pageViews,1);
});
