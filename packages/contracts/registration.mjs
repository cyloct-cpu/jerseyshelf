import {email,text,InputError} from './validation.mjs';
import {whatsappNumber} from './customers.mjs';
export const registrationWaVersion='registration-service-v1';
export const marketingVersion='email-marketing-v1';
export const registrationWaNotice='我同意球世界通过此WhatsApp号码，就我的购买咨询、账户及相关服务与我联系。我可以随时撤回同意。';
export const permissionNames={unknown:'授权未知',granted:'已授权',declined:'未授权',revoked:'已撤回'};
export function registrationFields(input,{password=true}={}){
 const out={},errors={};
 const parse=(key,fn)=>{try{out[key]=fn();}catch(err){if(!(err instanceof InputError))throw err;errors[key]=err.message;}};
 parse('first_name',()=>text(input.first_name??input.name,'名',100));
 parse('last_name',()=>text(input.last_name||'','姓',100,false));
 if(!errors.first_name&&!errors.last_name){out.name=[out.first_name,out.last_name].filter(Boolean).join(' ');if(out.name.length>100)errors.first_name='姓名合计不能超过100个字符';}
 if(password){parse('email',()=>email(input.email));parse('password',()=>{const v=text(input.password,'密码',200);if(v.length<12)throw new InputError('密码至少 12 位');return v;});}
 parse('whatsapp_phone',()=>{const number=text(input.whatsapp_phone||'','WhatsApp号码',50,false),code=text(input.whatsapp_country_code||'','国家区号',6,false);if(!number)return '';if(number.startsWith('+'))return whatsappNumber(number);if(!code)throw new InputError('请填写国家区号，或使用+开头的完整号码');if(!/^\+?[1-9]\d{0,3}$/.test(code))throw new InputError('请选择或填写有效国家区号');return whatsappNumber(code+number.replace(/^0+/,''));});
 out.whatsapp_consent=input.whatsapp_consent==='1';out.email_marketing=input.email_marketing==='1';
 if(out.whatsapp_consent&&!out.whatsapp_phone&&!errors.whatsapp_phone)errors.whatsapp_phone='请填写含国家区号的WhatsApp号码后再授权联系';
 if(Object.keys(errors).length){const err=new InputError('请检查标记的注册信息');err.fields=errors;throw err;}return out;
}
