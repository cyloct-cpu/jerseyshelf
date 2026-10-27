import {InputError,text} from './validation.mjs';
export const whatsappNames={unknown:'待核实',not_contacted:'确认未联系',connected:'已建立联系',invalid:'号码失效'};
export const taskNames={first_contact:'首次联系',purchase:'购买跟进',payment:'付款跟进',delivery:'配送确认',review:'收货回访',aftersale:'售后跟进'};
export const caseNames={open:'新建',processing:'处理中',waiting:'等待反馈',resolved:'已解决',closed:'已关闭'};
export const taskStatusNames={pending:'待处理',done:'已完成',cancelled:'已取消'};
export function choice(value,options,label){if(!Object.hasOwn(options,value))throw new InputError(label+'无效');return value;}
export function whatsappNumber(value=''){
 const raw=text(value,'WhatsApp号码',50,false);if(!raw)return '';
 const normalized=raw.replace(/[\s()+-]/g,'');
 if(!/^[1-9]\d{6,14}$/.test(normalized))throw new InputError('WhatsApp号码须含国家区号，共7–15位数字');return normalized;
}
export function dateInput(value,label='时间'){
 if(typeof value!=='string'||!value.trim())throw new InputError(label+'不能为空');
 // Forms submit explicit UTC ISO values or a China-time datetime-local.
 const raw=value.trim(),d=new Date(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(raw)?raw+':00+08:00':raw);
 if(!Number.isFinite(d.getTime())||d.getUTCFullYear()<2000||d.getUTCFullYear()>2100)throw new InputError(label+'格式无效');return d.toISOString();
}
export function contactLink(phone,message=''){const n=whatsappNumber(phone);return n?'https://wa.me/'+n+(message?'?text='+encodeURIComponent(message):''):'';}
