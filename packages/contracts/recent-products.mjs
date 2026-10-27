export const HISTORY_KEY='bw_recent_products_v1';
const day=86400000;
export function normalizeHistory(value,{capacity=30,days=30}={},now=Date.now()){
  let rows=value;
  if(typeof rows==='string'){try{rows=JSON.parse(rows);}catch{return [];}}
  if(!Array.isArray(rows))return [];
  const seen=new Set();
  return rows.slice(0,1000).filter(row=>row&&Number.isSafeInteger(row.productId)&&row.productId>0&&row.productId<=1000000000&&Number.isSafeInteger(row.viewedAt)&&row.viewedAt>now-days*day&&row.viewedAt<=now+300000)
    .sort((a,b)=>b.viewedAt-a.viewedAt).filter(row=>{if(seen.has(row.productId))return false;seen.add(row.productId);return true;})
    .slice(0,Math.max(1,Math.min(100,capacity))).map(({productId,viewedAt})=>({productId,viewedAt}));
}
export function recordRecent(value,productId,options={},now=Date.now()){
  const rows=normalizeHistory(value,options,now).filter(row=>row.productId!==productId);
  return normalizeHistory([{productId,viewedAt:now},...rows],options,now);
}
// Storage can be denied in private or restricted browsers. Keep a per-page fallback.
export function historyStore(storage,options={}){
  let memory=[],unavailable=false;
  return {
    read(now=Date.now()){if(!unavailable){try{memory=normalizeHistory(storage.getItem(HISTORY_KEY),options,now);}catch{unavailable=true;}}memory=normalizeHistory(memory,options,now);return memory;},
    visit(id,now=Date.now()){memory=recordRecent(this.read(now),id,options,now);if(!unavailable){try{storage.setItem(HISTORY_KEY,JSON.stringify(memory));}catch{unavailable=true;}}return memory;},
    clear(){memory=[];try{storage.removeItem(HISTORY_KEY);}catch{unavailable=true;}return memory;}
  };
}
