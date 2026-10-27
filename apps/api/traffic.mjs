import { db, transaction } from './db.mjs';
import { random, hash } from './security.mjs';
import { text, InputError } from '../../packages/contracts/validation.mjs';
import { config } from './config.mjs';
export const ONLINE_WINDOW_MS=45000;
export function trafficDay(at=Date.now()){
  const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date(at));
  return ['year','month','day'].map(k=>parts.find(p=>p.type===k).value).join('-');
}
export function visitorIdentity(req,res){
  let token=String(req.headers.cookie||'').split(';').map(c=>c.trim()).find(c=>c.startsWith('bw_visitor='))?.slice(11);
  if(!token||!/^[a-f0-9]{64}$/.test(token)){
    token=random();const cookie=`bw_visitor=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${config.secure?'; Secure':''}`;
    const current=res.getHeader('Set-Cookie');res.setHeader('Set-Cookie',[...(Array.isArray(current)?current:current?[current]:[]),cookie]);
  }
  return hash(token);
}
export function trafficPath(path){return /^\/orders\/[^/]+$/.test(path)?'/orders':path;}
function pageInfo(path){
  if(['/','/search','/cart','/checkout','/account','/account/register','/blogs','/orders'].includes(path))return {path,productId:null};
  let match=path.match(/^\/products\/([a-z0-9-]+)$/);
  if(match){const p=db.prepare('SELECT id FROM products WHERE slug=? AND active=1').get(match[1]);if(p)return {path,productId:p.id};}
  match=path.match(/^\/collections\/([a-z0-9-]+)$/);
  if(match&&db.prepare('SELECT id FROM collections WHERE slug=? AND deleted_at IS NULL').get(match[1]))return {path,productId:null};
  match=path.match(/^\/(pages|blogs)\/([a-z0-9-]+)$/);
  if(match&&(db.prepare('SELECT id FROM pages WHERE slug=? AND kind=? AND published=1').get(match[2],match[1]==='pages'?'page':'article')||(match[1]==='pages'&&['returns-refund-policy','privacy-statement','terms-of-service'].includes(match[2]))))return {path,productId:null};
  throw new InputError('统计页面不存在',404);
}
export function currentTraffic(productId=null,at=Date.now()){
  const since=at-ONLINE_WINDOW_MS;
  return {online:db.prepare('SELECT COUNT(DISTINCT visitor_hash) n FROM traffic_presence WHERE last_seen>?').get(since).n,productOnline:productId?db.prepare('SELECT COUNT(DISTINCT visitor_hash) n FROM traffic_presence WHERE product_id=? AND last_seen>?').get(productId,since).n:0,windowSeconds:ONLINE_WINDOW_MS/1000};
}
let nextCleanup=0;
export function recordTraffic(visitor,input,at=Date.now()){
  const pageId=text(input.pageId,'页面标识',64),path=text(input.path,'页面路径',350),action=text(input.action,'统计动作',12);
  if(!/^[a-f0-9-]{16,64}$/.test(pageId)||!['enter','heartbeat','leave'].includes(action))throw new InputError('统计参数无效');
  return transaction(()=>{
    const existing=db.prepare('SELECT path,product_id FROM traffic_views WHERE visitor_hash=? AND page_id=?').get(visitor,pageId);
    if(existing&&existing.path!==path)throw new InputError('页面标识不能用于其它页面');
    if(action==='leave'){
      db.prepare('DELETE FROM traffic_presence WHERE visitor_hash=? AND page_id=?').run(visitor,pageId);
      return currentTraffic(existing?.product_id,at);
    }
    const info=pageInfo(path);
    if(action==='enter')db.prepare('INSERT OR IGNORE INTO traffic_views(visitor_hash,page_id,path,product_id,visit_day,viewed_at) VALUES(?,?,?,?,?,?)').run(visitor,pageId,path,info.productId,trafficDay(at),at);
    else if(!existing)throw new InputError('请先登记页面访问');
    db.prepare('INSERT INTO traffic_presence(visitor_hash,page_id,path,product_id,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(visitor_hash,page_id) DO UPDATE SET last_seen=excluded.last_seen').run(visitor,pageId,path,info.productId,at);
    if(at>=nextCleanup){db.prepare('DELETE FROM traffic_presence WHERE last_seen<=?').run(at-ONLINE_WINDOW_MS);nextCleanup=at+60000;}
    return currentTraffic(info.productId,at);
  });
}
export function trafficSummary(at=Date.now()){
  const day=trafficDay(at),since=at-ONLINE_WINDOW_MS;
  const today=db.prepare('SELECT COUNT(*) pageViews,COUNT(DISTINCT visitor_hash) visitors FROM traffic_views WHERE visit_day=?').get(day);
  const products=db.prepare('SELECT COUNT(*) productViews,COUNT(DISTINCT visitor_hash) productVisitors FROM traffic_views WHERE visit_day=? AND product_id IS NOT NULL').get(day);
  const ranking=db.prepare('SELECT p.id,p.title,p.slug,COUNT(v.id) views,COUNT(DISTINCT v.visitor_hash) visitors,(SELECT COUNT(DISTINCT a.visitor_hash) FROM traffic_presence a WHERE a.product_id=p.id AND a.last_seen>?) online FROM products p JOIN traffic_views v ON v.product_id=p.id WHERE v.visit_day=? GROUP BY p.id ORDER BY views DESC,p.id LIMIT 30').all(since,day);
  return {day,...currentTraffic(null,at),...today,...products,products:ranking,updatedAt:new Date(at).toISOString()};
}
