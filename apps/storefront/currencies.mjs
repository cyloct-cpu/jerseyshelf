import { escape as e } from '../api/security.mjs';
import { currencies,currencyMap,currencyName,formatMinor,convertMinor } from '../../packages/contracts/currencies.mjs';
import { availableCurrency,usdFx } from '../api/currencies.mjs';
import { readdirSync } from 'node:fs';
import { fxStatus } from '../api/fx-provider.mjs';
export const usdMoneyMarkup=n=>`<span class="money" data-usd-minor="${n}">$${(n/100).toFixed(2)}</span>`;
export function fixedMoney(n,code='USD',locale='zh-CN'){return `<span class="money" translate="no">${e(formatMinor(n,code,locale))}</span>`;}
export function convertedMoney(n,fx=usdFx,locale='zh-CN'){return fixedMoney(convertMinor(n,fx),fx.currency,locale);}
const flagFiles=new Set(readdirSync(new URL('./public/flags/',import.meta.url)));
const flag=region=>flagFiles.has(region+'.svg')?`<img src="/assets/flags/${region}.svg" alt="" width="30" height="22">`:String.fromCodePoint(...[...region].map(c=>127397+c.charCodeAt(0)));
export function currencyMenu(ctx){
  const code=ctx.fx?.currency||'USD',locale=ctx.locale||'zh-CN',meta=currencyMap.get(code),priority=['USD','EUR','GBP','CAD','AFN'];
  const items=[...currencies].sort((a,b)=>{const x=priority.indexOf(a.code),y=priority.indexOf(b.code);return (x<0?99:x)-(y<0?99:y)||a.code.localeCompare(b.code);});
  const back=ctx.url.pathname+ctx.url.search;
  const status=fxStatus(),label=status.mode==='live'?(status.fresh?'实时汇率':'实时报价暂不可用'):'每日参考汇率'+(status.referenceDate?' · '+(code!=='USD'?ctx.fx.date:status.referenceDate):'');
  return `<details class="currency-menu"><summary aria-label="选择货币"><span class="currency-flag" aria-hidden="true">${flag(meta.flag)}</span><span>${e(currencyName(code,locale))}</span><span aria-hidden="true">⌄</span></summary><div class="currency-options" role="navigation" aria-label="选择货币"><p class="currency-rate-status" data-rate-mode="${status.mode}">${label}${status.mode==='live'&&status.timestamp?` · ${e(new Date(status.timestamp*1000).toLocaleTimeString(locale,{timeZone:'Asia/Shanghai'}))}`:''}</p><input class="currency-search" placeholder="搜索货币或代码" aria-label="搜索货币或代码">${items.map(c=>{const name=currencyName(c.code,locale),enabled=availableCurrency(c.code);return `<a ${enabled?`href="/currency?code=${c.code}&amp;return=${encodeURIComponent(back)}"`:'aria-disabled="true"'} data-currency-option="${e(name+' '+c.code+' '+c.countries.join(' '))}" ${code===c.code?'aria-current="true"':''}><span class="currency-flag" aria-hidden="true">${flag(c.flag)}</span><span>${e(name)} (${c.code})${enabled?'':' · 暂无汇率'}</span></a>`;}).join('')}</div></details>`;
}
export function renderCurrencyMarkup(html,ctx){const fx=ctx.fx||usdFx;return html.replace(/<span class="money" data-usd-minor="(\d+)">[^<]*<\/span>/g,(_,amount)=>convertedMoney(Number(amount),fx,ctx.locale||'zh-CN'));}
