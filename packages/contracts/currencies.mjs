import { readFileSync } from 'node:fs';
export const currencies=JSON.parse(readFileSync(new URL('../../data/currency/currencies.json',import.meta.url),'utf8'));
export const currencyMap=new Map(currencies.map(c=>[c.code,c]));
const displayNames=new Map();
export function currencyName(code,locale='zh-CN'){if(!displayNames.has(locale))displayNames.set(locale,new Intl.DisplayNames([locale],{type:'currency'}));const name=displayNames.get(locale).of(code);return name===code?currencyMap.get(code)?.name||code:name;}
export function formatMinor(amount,code='USD',locale='zh-CN'){
  const minor=currencyMap.get(code)?.minor??2;
  if(code==='USD')return '$'+(amount/100).toFixed(2);
  return new Intl.NumberFormat(locale,{style:'currency',currency:code,currencyDisplay:'code',minimumFractionDigits:minor,maximumFractionDigits:minor}).format(amount/10**minor);
}
export function convertMinor(usdMinor,fx){
  if(!Number.isSafeInteger(usdMinor)||usdMinor<0)throw new Error('Invalid base amount');
  const [whole,fraction='']=Number(fx.rate).toFixed(12).split('.'),numerator=BigInt(whole+fraction),denominator=100n*10n**BigInt(fraction.length);
  const scaled=BigInt(usdMinor)*numerator*10n**BigInt(fx.minor);
  const amount=Number((scaled+denominator/2n)/denominator);if(!Number.isSafeInteger(amount))throw new Error('Converted amount exceeds safe range');return amount;
}
export function convertCart(cart,fx){
  const items=cart.items.map(i=>({...i,price:convertMinor(i.price,fx),lineTotal:convertMinor(i.price,fx)*i.quantity}));
  const subtotal=items.reduce((sum,i)=>sum+i.lineTotal,0),shipping=convertMinor(cart.shipping,fx),baseDiscount=cart.discount||0;
  // A discount capped at the entire USD subtotal remains fully capped after
  // per-unit currency rounding; never leave a small balance on a free basket.
  const discount=baseDiscount>0&&baseDiscount===cart.subtotal?subtotal:Math.min(subtotal,convertMinor(baseDiscount,fx)),total=subtotal-discount+shipping;
  if(!Number.isSafeInteger(total))throw new Error('Order amount exceeds safe range');
  return {...cart,items,subtotal,discount,shipping,total};
}
export function parseCurrencyAmount(value,fx){
  const text=String(value).trim();if(!/^\d{1,12}(?:\.\d{1,3})?$/.test(text))throw new Error('价格格式错误');
  const [whole,fraction='']=text.split('.');if(fraction.slice(fx.minor).replaceAll('0',''))throw new Error('价格小数位超出货币精度');
  const amount=Number(whole)*10**fx.minor+Number(fraction.slice(0,fx.minor).padEnd(fx.minor,'0')||0);if(!Number.isSafeInteger(amount))throw new Error('价格超出范围');return amount;
}
