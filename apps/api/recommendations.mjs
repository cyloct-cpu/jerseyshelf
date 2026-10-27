import {db,settings,putSetting,transaction,audit} from './db.mjs';
import {InputError,int,text} from '../../packages/contracts/validation.mjs';
import {productProfile,profileSimilarity} from '../../packages/contracts/product-profile.mjs';
db.function('discovery_similarity',{deterministic:true},(title,slug,baseTitle,baseSlug)=>profileSimilarity(productProfile(title,slug),productProfile(baseTitle,baseSlug)));
export function discoverySettings(){
  const saved=settings().product_discovery||{};
  return {recommendations:{enabled:true,title:'您可能也喜欢',count:6,onlyInStock:false,teamFirst:true,...saved.recommendations},recent:{enabled:true,title:'最近浏览',count:6,capacity:30,days:30,showClear:true,...saved.recent}};
}
export function saveDiscoverySettings(input,user){
  const yes=v=>v==='1'||v===true;
  const config={recommendations:{enabled:yes(input.recommendations_enabled),title:text(input.recommendations_title,'推荐标题',60),count:int(input.recommendations_count,'推荐展示数',1,12),onlyInStock:yes(input.only_in_stock),teamFirst:yes(input.team_first)},recent:{enabled:yes(input.recent_enabled),title:text(input.recent_title,'最近浏览标题',60),count:int(input.recent_count,'最近浏览展示数',1,12),capacity:int(input.recent_capacity,'历史保存数量',1,100),days:int(input.recent_days,'历史保留天数',1,365),showClear:yes(input.show_clear)}};
  if(config.recent.capacity<config.recent.count)throw new InputError('历史保存数量不能小于展示数量');
  transaction(()=>{putSetting('product_discovery',config);audit(user,'discovery.settings','product_discovery');});
}
export function manualRecommendations(id){return id?db.prepare('SELECT p.*,r.position FROM product_recommendations r JOIN products p ON p.id=r.recommended_product_id WHERE r.product_id=? ORDER BY r.position,p.id').all(id).map(parseProduct):[];}
function parseProduct(p){return {...p,images:JSON.parse(p.images)};}
export function parseProductRecommendations(input,id){
  if(input.recommendations===undefined&&input.recommendation_mode===undefined)return null;
  if(!['auto_fill','manual_only'].includes(input.recommendation_mode))throw new InputError('推荐模式无效');
  let ids=input.recommendations||[];
  if(typeof ids==='string'){try{ids=JSON.parse(ids);}catch{throw new InputError('推荐商品格式错误');}}
  if(!Array.isArray(ids)||ids.length>30)throw new InputError('手动推荐最多 30 件商品');
  ids=ids.map(value=>int(value,'推荐商品 ID',1));
  if(new Set(ids).size!==ids.length)throw new InputError('推荐商品不能重复');
  for(const target of ids){if(target===id)throw new InputError('不能推荐当前商品');if(!db.prepare('SELECT id FROM products WHERE id=?').get(target))throw new InputError('推荐商品不存在');}
  return {mode:input.recommendation_mode,ids};
}
export function saveProductRecommendations(id,config){
  if(!config)return;
  db.prepare('UPDATE products SET recommendation_mode=? WHERE id=?').run(config.mode,id);
  db.prepare('DELETE FROM product_recommendations WHERE product_id=?').run(id);
  const insert=db.prepare('INSERT INTO product_recommendations VALUES(?,?,?)');
  config.ids.forEach((target,i)=>insert.run(id,target,i));
}
const eligible=stock=>`p.active=1 AND json_array_length(p.images)>0 AND COALESCE(json_extract(p.images,'$[0]'),'')<>''${stock?' AND EXISTS(SELECT 1 FROM variants v WHERE v.product_id=p.id AND v.active=1 AND v.stock>0)':''}`;
export function recommendedProducts(p,config=discoverySettings().recommendations){
  if(!config.enabled)return [];
  const pinned=db.prepare(`SELECT p.* FROM product_recommendations r JOIN products p ON p.id=r.recommended_product_id WHERE r.product_id=? AND p.id<>? AND ${eligible(config.onlyInStock)} ORDER BY r.position,p.id LIMIT ?`).all(p.id,p.id,config.count).map(parseProduct);
  if(pinned.length>=config.count||p.recommendation_mode==='manual_only')return pinned;
  const rows=db.prepare(`WITH overlap AS (
    SELECT pc.product_id,MAX(CASE WHEN c.kind IN ('club','national') THEN 1 ELSE 0 END) team,
      SUM(CASE WHEN c.kind IN ('club','national') THEN 0 WHEN c.name LIKE '%赛季%' OR c.slug LIKE '%season%' THEN 1 ELSE 10 END) category
    FROM product_collections pc JOIN collections c ON c.id=pc.collection_id
    WHERE c.deleted_at IS NULL AND pc.collection_id IN (SELECT collection_id FROM product_collections WHERE product_id=?) GROUP BY pc.product_id
  ), popularity AS (SELECT product_id,COUNT(DISTINCT visitor_hash) visits FROM traffic_views WHERE viewed_at>=? AND product_id IS NOT NULL GROUP BY product_id)
  SELECT p.*,discovery_similarity(p.title,p.slug,?,?) profile_score FROM products p LEFT JOIN overlap o ON o.product_id=p.id LEFT JOIN popularity v ON v.product_id=p.id
  WHERE p.id<>? AND ${eligible(config.onlyInStock)}
  ORDER BY ${config.teamFirst?'COALESCE(o.team,0) DESC,profile_score DESC,COALESCE(o.category,0) DESC':'profile_score DESC,COALESCE(o.category,0) DESC,COALESCE(o.team,0) DESC'},COALESCE(v.visits,0) DESC,p.id DESC LIMIT ?`).all(p.id,Date.now()-30*86400000,p.title,p.slug,p.id,config.count+30).map(parseProduct);
  const seen=new Set(pinned.map(p=>p.id));
  return [...pinned,...rows.filter(p=>!seen.has(p.id))].slice(0,config.count);
}
export function recentProductCards(rawIds,config=discoverySettings().recent){
  if(!config.enabled)return [];
  if(typeof rawIds!=='string'||rawIds.length>1200||!/^\d+(,\d+)*$/.test(rawIds))throw new InputError('浏览商品 ID 格式错误');
  const values=rawIds.split(',');if(values.length>100)throw new InputError('一次最多读取 100 件商品');
  const ids=[...new Set(values.map(id=>int(id,'商品 ID',1)))];
  const rows=db.prepare(`SELECT p.* FROM products p WHERE p.id IN (${ids.map(()=>'?').join(',')}) AND ${eligible(false)}`).all(...ids).map(parseProduct);
  const byId=new Map(rows.map(p=>[p.id,p]));return ids.map(id=>byId.get(id)).filter(Boolean).slice(0,config.count);
}
