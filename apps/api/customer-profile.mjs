import {db,now,transaction,audit} from './db.mjs';
import {InputError,int} from '../../packages/contracts/validation.mjs';
import {whatsappNumber} from '../../packages/contracts/customers.mjs';

export function customerProfileSources(customerId){
 const c=db.prepare('SELECT * FROM customers WHERE id=?').get(int(customerId,'客户编号',1));
 if(!c)throw new InputError('客户不存在',404);
 const account=db.prepare("SELECT id,name,email,created_at,whatsapp_phone,whatsapp_updated_at FROM users WHERE customer_id=? AND role='customer' ORDER BY id LIMIT 1").get(c.id);
 // Real orders take precedence over test orders. The latest stored address is a
 // contact source only; it never changes historical orders or access rights.
 const order=db.prepare("SELECT id,customer_name,email,address,whatsapp_phone,created_at FROM orders WHERE customer_id=? ORDER BY CASE order_kind WHEN 'external' THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 1").get(c.id);
 const address=order?JSON.parse(order.address||'{}'):{};
 const mobile=String(address.phone||c.registration_phone||'');
 const explicitPhone=Boolean(account?.whatsapp_updated_at&&(!order||account.whatsapp_updated_at>=order.created_at));
 let phone=explicitPhone?account.whatsapp_phone:order?.whatsapp_phone||c.registration_phone||'';
 // A domestic shipping telephone must not be guessed to be a WhatsApp number.
 if(!explicitPhone&&!phone&&/^\s*\+/.test(mobile)){try{phone=whatsappNumber(mobile);}catch{}}
 return {nickname:account?.name||'',email:account?.email||c.email||'',registered_at:account?.created_at||'',order_id:order?.id||'',
  name:order?.customer_name||account?.name||'',country:String(address.country||''),mobile,phone,phone_explicit:explicitPhone};
}
export function syncCustomerProfile(customerId,{registrationPhone}={}){return transaction(()=>{
 let c=db.prepare('SELECT * FROM customers WHERE id=?').get(int(customerId,'客户编号',1));if(!c)throw new InputError('客户不存在',404);
 if(registrationPhone!==undefined){const phone=whatsappNumber(registrationPhone);db.prepare('UPDATE customers SET registration_phone=? WHERE id=?').run(phone,c.id);c={...c,registration_phone:phone};}
 const source=customerProfileSources(c.id),overrides=JSON.parse(c.profile_overrides),values={};
 for(const field of ['name','country','mobile','phone'])values[field]=overrides[field]?c[field]:field==='phone'&&source.phone_explicit?source.phone:(source[field]||c[field]||'');
 const changed=Object.keys(values).filter(field=>values[field]!==c[field]);
 const snapshot=JSON.stringify(source);
 if(changed.length||snapshot!==c.auto_profile){
  db.prepare('UPDATE customers SET name=?,country=?,mobile=?,phone=?,auto_profile=?,updated_at=? WHERE id=?').run(values.name,values.country,values.mobile,values.phone,snapshot,now(),c.id);
  if(values.phone!==c.phone)db.prepare("UPDATE customers SET whatsapp_status='unknown',whatsapp_verified_at='',whatsapp_verified_by=NULL WHERE id=?").run(c.id);
  if(changed.length)db.prepare("INSERT INTO customer_events(customer_id,order_id,kind,body,created_at) VALUES(?,?,'profile_auto',?,?)").run(c.id,source.order_id||null,'自动同步注册/收货资料：'+changed.map(f=>({name:'联系姓名',country:'国家/地区',mobile:'手机号码',phone:'WhatsApp号码'})[f]).join('、'),now());
 }
 return {...c,...values,auto_profile:snapshot,sources:source};
});}
export function restoreAutomaticProfile(input,actor){return transaction(()=>{
 const id=int(input.customer_id,'客户编号',1);
 if(!db.prepare('SELECT id FROM customers WHERE id=?').get(id))throw new InputError('客户不存在',404);
 db.prepare("UPDATE customers SET profile_overrides='{}' WHERE id=?").run(id);syncCustomerProfile(id);
 db.prepare("INSERT INTO customer_events(customer_id,kind,body,actor_id,created_at) VALUES(?,'profile','恢复采用注册及最新保存的收货资料',?,?)").run(id,actor,now());audit(actor,'customer.restore_auto',id);return id;
});}
