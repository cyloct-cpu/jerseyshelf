import { readFileSync } from 'node:fs';
import { db, settings, putSetting, transaction, audit } from './db.mjs';
import { saveMedia } from './media.mjs';
import { customizationConfig, parseCustomizationConfig, resolveCustomization } from '../../packages/contracts/customization.mjs';
import { InputError } from '../../packages/contracts/validation.mjs';

export const templateNames={club:'俱乐部模板',national:'国家队模板'};
const settingKey='product_customization_templates';
export function initializeCustomizationTemplates(){
  if(db.prepare('SELECT key FROM settings WHERE key=?').get(settingKey))return;
  const image=saveMedia(readFileSync(new URL('../../database/seeds/assets/armband.jpg',import.meta.url)),'默认臂章.jpg','https://img.staticdj.com/70579c8274404a3dba8d33d3d2b9c466.jpg').path;
  const create=(kind,names)=>({printing:{enabled:true,label:'自定义名称 + 编号',placeholder:'Ronaldo#7',price:300,maxLength:500},patches:{enabled:true,label:'选择一款臂章贴片',options:names.map(([id,name])=>({id:kind+'-'+id,name,price:300,image,enabled:true}))}});
  transaction(()=>putSetting(settingKey,{club:create('club',[['league','联盟臂章'],['champions','冠军联赛'],['other','其他联赛补丁']]),national:create('national',[['world-cup','世界杯臂章'],['continental','洲际杯臂章'],['other','其他联赛补丁']])}));
}
export function customizationTemplates(){
  const value=settings()[settingKey];
  if(!value)throw new Error('商品定制模板尚未初始化');
  return value;
}
export function automaticTemplate(product){
  const collections=Array.isArray(product.collections)?product.collections:product.id?db.prepare('SELECT c.kind FROM collections c JOIN product_collections pc ON c.id=pc.collection_id WHERE pc.product_id=? AND c.deleted_at IS NULL').all(product.id):[];
  return collections.some(c=>c.kind==='national')&&!collections.some(c=>c.kind==='club')?'national':'club';
}
export function customizationContext(product){
  const mode=product.customization_mode||'inherit';
  if(mode==='custom')return {mode,key:'product-'+product.id,label:'单品自定义',config:customizationConfig(product.customization)};
  const key=product.customization_template&&product.customization_template!=='auto'?product.customization_template:automaticTemplate(product);
  return {mode,key,label:templateNames[key],config:customizationConfig(customizationTemplates()[key])};
}
export function resolveProductCustomization(product,input={}){
  const context=customizationContext(product);
  return {...resolveCustomization(context.config,input),template:{key:context.key,mode:context.mode,label:context.label}};
}
function validateImages(config){
  for(const option of config.patches.options)if(option.image&&!db.prepare('SELECT id FROM media WHERE path=?').get(option.image))throw new InputError('臂章图片未导入媒体库');
}
export function customizationEdit(input,current=null){
  // Older import/API clients supplied a full configuration before modes existed.
  let supplied=input.customization!==undefined&&input.customization!=='';
  if(supplied&&!current&&input.customization_mode===undefined){
    let legacy;try{legacy=parseCustomizationConfig(input.customization);}catch(error){if(error instanceof SyntaxError)throw new InputError('定制配置格式错误');throw error;}
    // An old, still-open new-product form used to submit disabled empty fields.
    // Treat that untouched draft as inheritance; explicit custom mode remains available.
    supplied=!!(legacy.printing.enabled||legacy.patches.enabled||legacy.patches.options.length);
  }
  const mode=input.customization_mode??(supplied?'custom':current?.customization_mode||'inherit');
  const template=input.customization_template??current?.customization_template??'auto';
  if(!['inherit','custom'].includes(mode)||!['auto','club','national'].includes(template))throw new InputError('商品定制模式或模板无效');
  let config=JSON.parse(current?.customization||'{}');
  if(mode==='custom'&&input.customization!==undefined&&input.customization!==''){
    try{config=parseCustomizationConfig(input.customization);}catch(error){if(error instanceof SyntaxError)throw new InputError('定制配置格式错误');throw error;}
    validateImages(config);
  }else if(mode==='custom'&&!Object.keys(config).length)throw new InputError('请填写单品定制配置');
  return {mode,template,config};
}
export function saveCustomizationTemplate(input,user){
  if(!Object.hasOwn(templateNames,input.template))throw new InputError('定制模板不存在');
  let config;try{config=parseCustomizationConfig(input.customization);}catch(error){if(error instanceof SyntaxError)throw new InputError('定制配置格式错误');throw error;}
  if(!config.printing.enabled||!config.patches.enabled||!config.patches.options.some(p=>p.enabled))throw new InputError('全站模板须保留印字和至少一个可用臂章；个别商品可切换单品自定义');
  validateImages(config);
  transaction(()=>{const templates=customizationTemplates();templates[input.template]=config;putSetting(settingKey,templates);audit(user,'customization.template-save',input.template);});
}
