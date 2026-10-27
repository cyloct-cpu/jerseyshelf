import { email, text, InputError } from './validation.mjs';
import {whatsappNumber} from './customers.mjs';

// ISO 3166-1 regions; labels use the runtime's Unicode locale data.
export const checkoutCountries = ('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW').split(' ');
const postalRequired = new Set('AU CA CN DE FR GB IN JP NZ SG US'.split(' '));
export const needsPostal = code => postalRequired.has(code);
// Keep checkout and merchant COD corrections on the same subdivision rules.
export const regionRequiredCountries = ['US','CA','AU','IN','BH'];
export const needsRegion = code => regionRequiredCountries.includes(code);
export function countryOptions(locale='zh-CN') {
  const names = new Intl.DisplayNames([locale,'en'], {type:'region'});
  return checkoutCountries.map(code=>({code,name:names.of(code)})).sort((a,b)=>a.name.localeCompare(b.name,locale));
}
export function checkoutFields(input,{cod=false}={}) {
  const fields={},errors={};
  function field(key,label,max,required=true,parse=null){
    try{fields[key]=parse?parse(input[key]):text(input[key]??'',label,max,required);}catch(error){if(!(error instanceof InputError))throw error;errors[key]=error.message;}
  }
  field('email','邮箱',254,true,email);
  field('name','收件人',100);
  field('country','国家/地区',2);
  if(!errors.country&&!checkoutCountries.includes(fields.country))errors.country='请选择有效的国家/地区';
  field('region','省/州',100,cod&&needsRegion(fields.country));
  field('city','城市',150);
  field('address','详细地址',500);
  field('address2','大楼、公寓等',200,false);
  field('postal','邮编',30,needsPostal(fields.country));
  field('phone','电话',50,cod);
  if(cod&&!String(input.phone||'').trim())errors.phone='请输入您的联系电话';
  if(cod&&!errors.phone&&!/^[+0-9 ()-]{6,50}$/.test(fields.phone))errors.phone='请输入有效的收货联系电话';
  field('note','订单备注',1000,false);
  field('whatsapp_phone','WhatsApp号码',50,false,v=>whatsappNumber(v||''));
  fields.whatsapp_consent=input.whatsapp_consent==='1';
  fields.save_address=input.save_address==='1';
  if(fields.whatsapp_consent&&!fields.whatsapp_phone)errors.whatsapp_phone='请填写含国家区号的WhatsApp号码后再允许订单联系';
  fields.whatsapp_locale=typeof input.whatsapp_locale==='string'?input.whatsapp_locale:'en';
  if(Object.keys(errors).length){const error=new InputError('请检查标记的收货信息');error.fields=errors;throw error;}
  return fields;
}
