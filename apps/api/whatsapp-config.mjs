import {createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {db,putSetting,audit} from './db.mjs';
import {config} from './config.mjs';
import {InputError,text} from '../../packages/contracts/validation.mjs';
import {whatsappNumber} from '../../packages/contracts/customers.mjs';
export const waKinds={confirmation:'订单确认',payment:'付款沟通',shipping:'发货通知',review:'收货回访',service:'售后沟通'};
export const waStatuses={queued:'排队中',sending:'提交中',accepted:'平台已接受',sent:'已发送',delivered:'已送达',read:'已读',received:'客户消息',failed:'失败',unknown:'待核实',cancelled:'已取消'};
export function waConfig(){const r=db.prepare("SELECT value FROM settings WHERE key='whatsapp'").get();return {mode:'off',phone:'',name:'',version:'',phoneId:'',wabaId:'',live:false,autoConfirmation:false,autoShipping:false,templates:{},...(r?JSON.parse(r.value):{})};}
const keyFile=path.join(path.dirname(config.dbPath),'whatsapp-credentials.key');
function key(create=false){if(create&&!existsSync(keyFile)){try{writeFileSync(keyFile,randomBytes(32),{flag:'wx',mode:0o600});}catch(err){if(err.code!=='EEXIST')throw err;}}const value=readFileSync(keyFile);if(value.length!==32)throw new InputError('WhatsApp加密文件损坏',503);return value;}
function seal(data){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key(true),iv),body=Buffer.concat([c.update(JSON.stringify(data),'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]).toString('base64');}
export function waCredentials(){const c=waConfig();if(!c.secret)return {};try{const data=Buffer.from(c.secret,'base64'),d=createDecipheriv('aes-256-gcm',key(),data.subarray(0,12));d.setAuthTag(data.subarray(12,28));return JSON.parse(Buffer.concat([d.update(data.subarray(28)),d.final()]).toString('utf8'));}catch{throw new InputError('WhatsApp凭据无法读取，请重新填写',503);}}
export function waPublicConfig(){const {secret,approved,...c}=waConfig();let credentials={},credentialError='';try{credentials=waCredentials();}catch{credentialError='凭据无法解密，请恢复成套加密文件或重新填写';}return {...c,configured:Boolean(secret),approved:approved||[],hasAccountCheck:Boolean(c.checkedAt),credentialFields:Object.keys(credentials).filter(k=>Boolean(credentials[k])),credentialError};}
export function saveWaConfig(input,actor){
 const old=waConfig(),mode=text(input.mode,'模式',10);if(!['off','link','cloud'].includes(mode))throw new InputError('模式无效');
 const phone=whatsappNumber(input.phone||''),name=text(input.name||'','店铺名称',100,false),version=text(input.version||'','Graph API版本',12,false),phoneId=text(input.phone_id||'','Phone Number ID',40,false),wabaId=text(input.waba_id||'','WABA ID',40,false);
 if(version&&!/^v\d{1,3}\.\d{1,2}$/.test(version)||phoneId&&!/^\d{5,40}$/.test(phoneId)||wabaId&&!/^\d{5,40}$/.test(wabaId))throw new InputError('API版本或账号ID格式无效');
 let secret=old.secret||'',previousCredentials={};try{previousCredentials=waCredentials();}catch{if(mode==='cloud'&&![input.token,input.appSecret,input.verifyToken].every(Boolean))throw new InputError('原凭据无法读取，请重新填写三项凭据');}const credentials={...previousCredentials};
 if(input.clear_secret==='1'){if(mode==='cloud')throw new InputError('删除凭据前请退出官方API模式');secret='';for(const k of Object.keys(credentials))delete credentials[k];}
 for(const [field,label] of [['token','Access Token'],['appSecret','App Secret'],['verifyToken','Webhook Verify Token']]){const value=text(input[field]||'',label,4096,false);if(value){if(input.clear_secret==='1')throw new InputError('不能同时删除并填写凭据');if(!/^[\x21-\x7e]{8,4096}$/.test(value))throw new InputError(label+'格式无效');credentials[field]=value;}}
 if(Object.values(credentials).some(Boolean))secret=seal(credentials);
 const live=mode==='cloud'&&input.live==='1';
 if(mode!=='off'&&!phone)throw new InputError('请填写本店WhatsApp号码，包含国家区号');
 if(mode==='cloud'&&(!version||!phoneId||!wabaId||!credentials.token||!credentials.appSecret||!credentials.verifyToken))throw new InputError('官方API模式需要API版本、两个账号ID及三项凭据');
 if(live&&input.fees_confirmed!=='1')throw new InputError('启用实际发送前请确认模板和可能的消息费用');
 const templates={};
 for(const kind of Object.keys(waKinds)){const template=text(input['template_'+kind]||'','模板名',100,false),language=text(input['language_'+kind]||'en_US','模板语言',20),vars=text(input['vars_'+kind]||'','模板参数',200,false).split(',').map(v=>v.trim()).filter(Boolean);if(template&&!/^[a-z0-9_]+$/.test(template)||! /^[a-z]{2,3}(?:_[A-Za-z]{2,4})?$/.test(language)||vars.length>10||vars.some(v=>!['order_id','name','items','total','tracking'].includes(v)))throw new InputError('模板名、语言或参数无效');templates[kind]={name:template,language,vars};}
 const fingerprint=JSON.stringify([version,phoneId,wabaId,phone,templates,credentials.token,credentials.appSecret]);
 const previous=JSON.stringify([old.version,old.phoneId,old.wabaId,old.phone,old.templates,previousCredentials.token,previousCredentials.appSecret]);
 const changed=fingerprint!==previous;
 const defaultLocale=input.default_locale==='zh-CN'?'zh-CN':'en',linkTemplate=text(input.link_template||'','点击联系消息模板',1200,false);if([...linkTemplate.matchAll(/\{([^{}]+)\}/g)].some(m=>!['name','order_id','items','total','tracking'].includes(m[1])))throw new InputError('点击联系模板含不支持的变量');
 putSetting('whatsapp',{mode,phone,name,version,phoneId,wabaId,secret,live,templates,defaultLocale,linkTemplate,revision:changed?randomBytes(16).toString('hex'):old.revision||'',autoConfirmation:input.auto_confirmation==='1',autoShipping:input.auto_shipping==='1',checkedAt:changed?'':old.checkedAt||'',approved:changed?[]:old.approved||[],webhookVerifiedAt:credentials.verifyToken!==previousCredentials.verifyToken?'':old.webhookVerifiedAt||'',lastSentAt:old.lastSentAt||''});audit(actor,'whatsapp.config',mode);
}
