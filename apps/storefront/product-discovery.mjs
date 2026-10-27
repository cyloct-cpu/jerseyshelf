import {escape as e} from '../api/security.mjs';
import {discoverySettings,recommendedProducts} from '../api/recommendations.mjs';
import {renderCurrencyMarkup} from './currencies.mjs';
import {localizeMarkup} from './translations.mjs';
export function discoveryCards(products,ctx,card){
  return localizeMarkup(renderCurrencyMarkup(products.map(p=>card(p,ctx.locale,true)).join(''),ctx),ctx.locale||'zh-CN');
}
export function productDiscovery(p,ctx,card){
  const config=discoverySettings(),recommendations=recommendedProducts(p,config.recommendations);
  return `${recommendations.length?`<section class="section product-discovery" aria-labelledby="recommendations-title"><h2 id="recommendations-title">${e(config.recommendations.title)}</h2><div class="discovery-grid" id="recommended-products">${recommendations.map(p=>card(p,ctx.locale,true)).join('')}</div></section>`:''}${config.recent.enabled?`<section class="section product-discovery" id="recent-products" hidden aria-labelledby="recent-products-title" data-product-id="${p.id}" data-capacity="${config.recent.capacity}" data-days="${config.recent.days}"><div class="discovery-heading"><h2 id="recent-products-title">${e(config.recent.title)}</h2>${config.recent.showClear?'<button type="button" id="clear-recent-products">清空最近浏览</button>':''}</div><div class="discovery-grid" id="recent-products-grid"></div></section><script type="module" src="/assets/recent-products.js"></script>`:''}`;
}
