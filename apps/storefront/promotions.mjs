import { escape as e } from '../api/security.mjs';
import { usdMoneyMarkup as money } from './currencies.mjs';
import { translateText } from './translations.mjs';

export function promotionBanner(config,locale='zh-CN'){
  if(!config?.enabled||!config.tiers.length)return '';
  const tr=text=>e(translateText(text,locale));
  const terms=config.tiers.map(t=>`<span>${tr('买')}${t.quantity}${tr('件减')}${money(t.amount)}</span>`).join('<span class="promotion-separator">，</span>');
  return `<div class="promotion-banner" aria-label="${tr('满件优惠')}"><svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="m12 1 3 3 4 .5.5 4 3 3-3 3-.5 4-4 .5-3 3-3-3-4-.5-.5-4-3-3 3-3 .5-4 4-.5Z"/><path d="m8 16 8-8M8.5 8.5h.01m7 7h.01" stroke="white" stroke-width="2.2" stroke-linecap="round"/></svg><div>${terms}</div></div>`;
}
