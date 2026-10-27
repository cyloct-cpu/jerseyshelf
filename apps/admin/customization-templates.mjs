import { escape as e } from '../api/security.mjs';
import { csrf } from '../storefront/views.mjs';
import { customizationTemplates,templateNames } from '../api/customization.mjs';
import { customizationFields } from './product-customization.mjs';

export function templateEditor(ctx){
  const selected=Object.hasOwn(templateNames,ctx.url.searchParams.get('template'))?ctx.url.searchParams.get('template'):'club';
  const c=customizationTemplates()[selected];
  return `<section class="panel stack"><h2>全站商品定制模板</h2><p>所有继承此模板的商品会同步更新，后台新增和批量导入商品默认继承。单品自定义商品保持独立，历史订单保留成交时的快照。</p><form method="get" action="/admin/customization" class="actions"><label>选择模板<select name="template">${Object.entries(templateNames).map(([key,label])=>`<option value="${key}" ${selected===key?'selected':''}>${label}</option>`).join('')}</select></label><button>切换模板</button></form></section><form id="customization-template-form" action="/admin/customization/save" method="post" class="panel stack">${csrf(ctx.session)}<input type="hidden" name="template" value="${selected}"><input type="hidden" name="customization" id="customization-json"><h2>${e(templateNames[selected])}</h2><p>金额按 USD / 件维护，顾客选择其它货币时自动换算。全站模板须保留印字及至少一个可用臂章。</p>${customizationFields(c)}<button class="button">保存全站模板</button><span role="alert" id="form-error"></span></form><script src="/assets/customization.js" defer></script>`;
}
