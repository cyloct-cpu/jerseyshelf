import { readFileSync } from 'node:fs';
import { db, putSetting, transaction } from './db.mjs';
import { random, hash } from './security.mjs';
import { currencyMap } from '../../packages/contracts/currencies.mjs';
import { InputError } from '../../packages/contracts/validation.mjs';
import { fxStatus,liveSnapshot,ensureLiveRates } from './fx-provider.mjs';
const initial=JSON.parse(readFileSync(new URL('../../data/currency/rates.json',import.meta.url),'utf8'));
export const usdFx={currency:'USD',rate:'1',minor:2,date:'',source:'USD'};
export function requestCurrency(req,url){const cookie=String(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('bw_currency='))?.slice(12);return currencyMap.has(cookie)?cookie:'USD';}
let cachedValue,cachedRows;
export function ratesData(){if(fxStatus().mode==='live')return liveSnapshot()?.rows||[];const row=db.prepare("SELECT value FROM settings WHERE key='exchange_rates'").get();if(!row)return initial;if(row.value!==cachedValue){cachedValue=row.value;cachedRows=JSON.parse(row.value);}return cachedRows;}
export function currencyFx(code){
  if(!currencyMap.has(code))throw new InputError('货币不支持');
  if(code==='USD')return usdFx;
  const meta=currencyMap.get(code),row=ratesData().find(r=>r.quote===code&&r.base==='USD');
  if(!meta||!row||!Number.isFinite(Number(row.rate))||Number(row.rate)<=0)throw new InputError('该货币暂无可用汇率，请选择其他货币',503);
  const status=fxStatus(),live=status.mode==='live',age=Date.now()-(live?row.timestamp*1000:Date.parse(row.date+'T00:00:00Z'));
  if(!Number.isFinite(age)||age>(live?120000:7*86400000)||age< -(live?30000:86400000))throw new InputError('该货币汇率已过期，请更新汇率或选择美元',503);
  return {currency:code,rate:String(row.rate),minor:meta.minor,date:live?new Date(row.timestamp*1000).toISOString():row.date,source:live?'currencylayer':status.referenceProvider||'Frankfurter'};
}
let availabilitySource,availabilityTime=0,availabilityFreshness,availability=new Map();
export function availableCurrency(code){const rows=ratesData(),status=fxStatus(),freshness=status.mode==='live'?status.fresh:true;if(rows!==availabilitySource||freshness!==availabilityFreshness||Date.now()-availabilityTime>60000){availabilitySource=rows;availabilityFreshness=freshness;availabilityTime=Date.now();availability=new Map();}if(!availability.has(code)){try{currencyFx(code);availability.set(code,true);}catch{availability.set(code,false);}}return availability.get(code);}
export function cartFingerprint(cart){return hash(JSON.stringify({items:cart.items.map(i=>[i.lineKey,i.quantity,i.price,i.customization]),shipping:cart.shipping,discount:cart.discount||0,promotion:cart.promotion||null}));}
export function createQuote(session,cart,fx,source='cart'){const id=random(24);db.prepare('INSERT INTO checkout_quotes(id,session_hash,cart_hash,fx,expires,source) VALUES(?,?,?,?,?,?)').run(id,session.token_hash,cartFingerprint(cart),JSON.stringify(fx),Date.now()+30*60000,source);return id;}
export function settleQuote(input,session,cart,selectedCurrency,source='cart'){
  if(!input.quote_id){if(selectedCurrency!=='USD'||source!=='cart')throw new InputError('请打开结账页确认所选货币金额');return usdFx;}
  const quote=db.prepare('SELECT * FROM checkout_quotes WHERE id=? AND session_hash=?').get(String(input.quote_id),session.token_hash);
  if(!quote||quote.source!==source||quote.expires<Date.now()||quote.cart_hash!==cartFingerprint(cart))throw new InputError('结账报价已过期或商品发生变化，请重新打开结账页');
  const fx=JSON.parse(quote.fx);if(fx.currency!==selectedCurrency)throw new InputError('货币已更改，请重新打开结账页确认金额');return fx;
}
export async function refreshRates(){
  if(fxStatus().mode==='live')return (await ensureLiveRates(true)).rows.length;
  return refreshReferenceRates();
}
// 参考汇率免费源轮换：任一成功即写入；全部失败保留旧快照（历史订单金额不变）。
// open.er-api 与 exchangerate-api 返回 {rates:{EUR:0.9,...}}，需转为本站的行式结构。
const fxSources=[
  {name:'open.er-api',url:'https://open.er-api.com/v6/latest/USD',shape:'object'},
  {name:'exchangerate-api',url:'https://api.exchangerate-api.com/v4/latest/USD',shape:'object'},
  {name:'Frankfurter',url:'https://api.frankfurter.dev/v2/rates?base=USD',shape:'array'},
  {name:'jsdelivr',url:'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json',shape:'jsdelivr'}
];
function normalizeFxPayload(source,payload){
  const date=typeof payload?.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(payload.date)?payload.date:new Date().toISOString().slice(0,10);
  if(source.shape==='array'){
    if(!Array.isArray(payload)||payload.length<100)return null;
    return payload;
  }
  const rates=source.shape==='jsdelivr'?payload?.usd:payload?.rates;
  if(!rates||typeof rates!=='object')return null;
  const rows=[];
  for(const [quote,rate] of Object.entries(rates)){
    if(quote.length!==3||quote!==quote.toUpperCase())continue;
    const value=Number(rate);
    if(!Number.isFinite(value)||value<=0)continue;
    rows.push({date,base:'USD',quote,rate:value});
  }
  return rows.length>=100?rows:null;
}
export async function refreshReferenceRates(fetcher=fetch){
  let lastError;
  for(const source of fxSources){
    try{
      const response=await fetcher(source.url,{signal:AbortSignal.timeout(8000),redirect:'error'});
      if(!response.ok)throw new Error('HTTP '+response.status);
      const rows=normalizeFxPayload(source,await response.json());
      if(!rows)throw new Error('汇率数据无效');
      transaction(()=>{putSetting('exchange_rates',rows);putSetting('exchange_rates_meta',{provider:source.name,fetchedAt:Date.now(),latestDate:rows.map(r=>r.date).sort().at(-1)});});
      return rows.length;
    }catch(err){lastError=err;}
  }
  // 全部源失败时保留已缓存数据（windowsPreferred 兼容由各源直接 fetch，不再走 PowerShell 兜底）。
  throw new Error('全部汇率源不可用：'+(lastError?.message||lastError));
}
let referencePending=null;
export async function ensureDailyRates(){
  if(fxStatus().mode!=='reference')return;
  const updated=fxStatus().referenceUpdatedAt;if(updated&&Date.now()-updated<86400000)return;
  if(referencePending)return referencePending;
  referencePending=refreshReferenceRates().finally(()=>{referencePending=null;});return referencePending;
}
