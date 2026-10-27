import { text, cents, int, localImage, InputError } from './validation.mjs';
export function customizationConfig(value) {
  const c=typeof value==='string'?JSON.parse(value||'{}'):(value||{});
  return {
    printing:{enabled:false,label:'自定义名称 + 编号',placeholder:'罗纳尔多#7',price:0,maxLength:500,...c.printing},
    patches:{enabled:false,label:'选择一款臂章贴片',options:[],...c.patches}
  };
}
export function parseCustomizationConfig(value) {
  const c=typeof value==='string'?JSON.parse(value):value;
  if(!c||Array.isArray(c)||typeof c!=='object')throw new InputError('定制配置格式错误');
  const printing=c.printing||{},patches=c.patches||{};
  if(!Array.isArray(patches.options||[])||(patches.options||[]).length>20)throw new InputError('臂章选项最多 20 个');
  const options=(patches.options||[]).map(p=>{
    const id=text(p.id,'臂章标识',80);
    if(!/^[a-z0-9][a-z0-9-]*$/.test(id))throw new InputError('臂章标识只能包含小写字母、数字和连字符');
    return {id,name:text(p.name,'臂章名称',100),price:cents(p.price||'0','臂章加价'),image:localImage(p.image||''),enabled:p.enabled!==false&&p.enabled!=='0'};
  });
  if(new Set(options.map(p=>p.id)).size!==options.length)throw new InputError('臂章标识不能重复');
  return {printing:{enabled:printing.enabled===true||printing.enabled==='1',label:text(printing.label||'自定义名称 + 编号','印字标题',100),placeholder:text(printing.placeholder||'','印字示例',100,false),price:cents(printing.price||'0','印字加价'),maxLength:int(printing.maxLength||500,'印字字数限制',1,500)},patches:{enabled:patches.enabled===true||patches.enabled==='1',label:text(patches.label||'选择一款臂章贴片','臂章标题',100),options}};
}
export function resolveCustomization(value,input={}) {
  const config=customizationConfig(value),printingName=text(input.printingName||'','名字及号码',500,false);
  if(/[\u0000-\u001f\u007f]/.test(printingName))throw new InputError('名字及号码不能包含控制字符');
  if(printingName&&(!config.printing.enabled||printingName.length>config.printing.maxLength))throw new InputError('印字未启用或内容超过字数限制');
  const ids=Array.isArray(input.patchIds)?input.patchIds:input.patchIds?[input.patchIds]:[];
  if(ids.length>20||new Set(ids).size!==ids.length)throw new InputError('臂章选择重复或数量超出限制');
  const patches=ids.map(id=>{const p=config.patches.options.find(p=>p.id===id&&p.enabled);if(!config.patches.enabled||!p)throw new InputError('所选臂章不存在或已停用');return {...p};});
  const printingPrice=printingName?config.printing.price:0;
  return {printingName,printingPrice,patches,extraPrice:printingPrice+patches.reduce((sum,p)=>sum+p.price,0)};
}
