import {db,transaction,now} from './db.mjs';
import {passwordHash} from './security.mjs';
import {InputError} from '../../packages/contracts/validation.mjs';
import {registrationFields} from '../../packages/contracts/registration.mjs';
import {linkRegisteredCustomer} from './customers.mjs';
import {syncCustomerProfile} from './customer-profile.mjs';
import {accountPreferences,accountPermission,writeAccountPermission} from './account-permissions.mjs';
function saveMarketing(u,granted,{initial=false}={}){if(granted)db.prepare('INSERT INTO subscribers(email,created_at,active) VALUES(?,?,1) ON CONFLICT(email) DO UPDATE SET active=1').run(u.email,now());else if(!initial)db.prepare('UPDATE subscribers SET active=0 WHERE email=?').run(u.email);}
export function registerAccount(input,locale='en'){const fields=registrationFields(input);return transaction(()=>{
 if(db.prepare('SELECT id FROM users WHERE email=?').get(fields.email)){const err=new InputError('此邮箱已注册，请登录',409);err.fields={email:err.message};throw err;}
 const id=Number(db.prepare("INSERT INTO users(email,password,name,role,created_at,first_name,last_name,whatsapp_phone,whatsapp_locale,whatsapp_updated_at,registration_profile_version) VALUES(?,?,?,'customer',?,?,?,?,?,?,1)").run(fields.email,passwordHash(fields.password),fields.name,now(),fields.first_name,fields.last_name,fields.whatsapp_phone,locale,now()).lastInsertRowid);
 const customerId=linkRegisteredCustomer(id,{phone:fields.whatsapp_phone});
 db.prepare("UPDATE customers SET locale=?,source=CASE WHEN source IN('subscribe','test_order') THEN 'register' ELSE source END,updated_at=? WHERE id=? AND locale=''").run(locale,now(),customerId);
 const u=db.prepare('SELECT * FROM users WHERE id=?').get(id);
 writeAccountPermission(u,'whatsapp','registration_service',fields.whatsapp_phone,fields.whatsapp_consent?'granted':'declined','website_registration',locale);
 writeAccountPermission(u,'email','email_marketing',u.email,fields.email_marketing?'granted':'declined','website_registration',locale);saveMarketing(u,fields.email_marketing,{initial:true});return id;
});}
export function updateAccountContact(userId,input,locale='en'){const f=registrationFields(input,{password:false});return transaction(()=>{
 const {user:old,whatsapp:previous}=accountPreferences(userId),changed=old.whatsapp_phone!==f.whatsapp_phone;
 if(changed&&old.whatsapp_phone)writeAccountPermission(old,'whatsapp','registration_service',old.whatsapp_phone,'revoked','account_number_changed',locale);
 const at=now();db.prepare("UPDATE users SET first_name=?,last_name=?,name=?,whatsapp_phone=?,whatsapp_locale=?,whatsapp_updated_at=CASE WHEN whatsapp_phone!=? THEN ? ELSE whatsapp_updated_at END,whatsapp_clicked_at=CASE WHEN whatsapp_phone!=? THEN '' ELSE whatsapp_clicked_at END,registration_profile_version=1 WHERE id=?").run(f.first_name,f.last_name,f.name,f.whatsapp_phone,locale,f.whatsapp_phone,at,f.whatsapp_phone,userId);
 const u=db.prepare('SELECT * FROM users WHERE id=?').get(userId);
 // A replacement number requires a fresh confirmation after it has been saved.
 const granted=!changed&&f.whatsapp_consent;
 writeAccountPermission(u,'whatsapp','registration_service',u.whatsapp_phone,granted?'granted':!changed&&previous?.state==='granted'||!changed&&previous?.state==='revoked'?'revoked':'declined','account_settings',locale);
 const emailOld=accountPermission(userId,'email','email_marketing',u.email);
 writeAccountPermission(u,'email','email_marketing',u.email,f.email_marketing?'granted':emailOld?.state==='granted'||emailOld?.state==='revoked'?'revoked':'declined','account_settings',locale);saveMarketing(u,f.email_marketing);
 syncCustomerProfile(u.customer_id,{registrationPhone:f.whatsapp_phone});db.prepare("INSERT INTO customer_events(customer_id,kind,body,actor_id,created_at) VALUES(?,'account_profile',?,?,?)").run(u.customer_id,changed?'客户修改注册WhatsApp号码，新号码待重新授权':'客户更新账户联系偏好',userId,at);return {changed};
});}
export function initializeRegistrationProfiles(){return transaction(()=>{
 for(const old of db.prepare("SELECT u.*,c.registration_phone,c.locale FROM users u JOIN customers c ON c.id=u.customer_id WHERE u.role='customer' AND u.registration_profile_version=0").all()){
  db.prepare("UPDATE users SET first_name=name,last_name='',whatsapp_phone=?,whatsapp_locale=?,registration_profile_version=1 WHERE id=?").run(old.registration_phone||'',old.locale||'en',old.id);
  const u=db.prepare('SELECT * FROM users WHERE id=?').get(old.id);
  writeAccountPermission(u,'whatsapp','registration_service',u.whatsapp_phone,'unknown','legacy_backfill');writeAccountPermission(u,'email','email_marketing',u.email,'unknown','legacy_backfill');
 }
});}
