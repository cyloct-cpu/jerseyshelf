import {db,transaction,now,audit,putSetting,settings} from './db.mjs';
import {syncCustomerProfile,customerProfileSources} from './customer-profile.mjs';
import {InputError,text,email,int} from '../../packages/contracts/validation.mjs';
import {whatsappNames,taskNames,caseNames,choice,whatsappNumber,dateInput} from '../../packages/contracts/customers.mjs';

export const customerViews={all:'全部客户',new_registered:'新注册客户',registered:'注册未成交',registration_missing:'注册缺WhatsApp号码',registration_unconsented:'注册有号码未授权',registration_authorized:'注册已授权待联系',registration_clicked:'注册已点击聊天',unknown:'WhatsApp待核实',unconnected:'确认未联系',connected:'已联系未成交',new_orders:'新订单待联系',unpaid:'待付款',today:'今日待跟进',overdue:'逾期待办',review:'待回访',aftersale:'售后处理中',archived:'已归档',test:'测试订单客户'};
export const customerConfig=()=>({orderMode:'test',reviewDays:5,...settings().customer_management});
export function event(customerId,kind,body='',actor=null,orderId=null){db.prepare('INSERT INTO customer_events(customer_id,order_id,kind,body,actor_id,created_at) VALUES(?,?,?,?,?,?)').run(customerId,orderId,kind,body,actor,now());}
export function customer(id){const c=db.prepare('SELECT * FROM customers WHERE id=?').get(int(id,'客户编号',1));if(!c)throw new InputError('客户不存在',404);return c;}
export function addTask(customerId,{kind,title,due=now(),orderId=null,owner='',key=null},actor=null){
 customer(customerId);choice(kind,taskNames,'待办类型');
 if(orderId&&!db.prepare('SELECT id FROM orders WHERE id=? AND customer_id=?').get(orderId,customerId))throw new InputError('订单不属于此客户');
 const r=db.prepare('INSERT OR IGNORE INTO customer_tasks(customer_id,order_id,kind,title,due_at,owner,dedupe_key,created_at,updated_at,actor_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(customerId,orderId,kind,title,dateInput(due),owner,key,now(),now(),actor);return Number(r.lastInsertRowid);
}
function createProfile({name='',contact='',phone='',country='',source}){
 const r=db.prepare('INSERT INTO customers(name,email,phone,country,source,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(name,contact||null,phone,country,source,now(),now());const id=Number(r.lastInsertRowid);event(id,'created',source);return id;
}
export function linkRegisteredCustomer(userId,{backfill=false,phone}={}){return transaction(()=>{
 const u=db.prepare("SELECT * FROM users WHERE id=? AND role='customer'").get(userId);if(!u)throw new InputError('客户账户不存在');if(u.customer_id){syncCustomerProfile(u.customer_id,{registrationPhone:phone});return u.customer_id;}
 let c=db.prepare('SELECT * FROM customers WHERE email=?').get(u.email),id=c?.id;
 if(!id)id=createProfile({name:u.name,contact:u.email,source:'register'});
 // This association is CRM-only: order.user_id and account permissions are never changed.
 db.prepare('UPDATE users SET customer_id=? WHERE id=?').run(id,userId);event(id,'register',backfill?'历史注册账户关联':'客户注册');
 addTask(id,{kind:'first_contact',title:'注册客户首次跟进',key:'register:'+userId});syncCustomerProfile(id,{registrationPhone:phone});return id;
});}
export function linkSubscriber(contact){return transaction(()=>{
 const value=email(contact);let c=db.prepare('SELECT id FROM customers WHERE email=?').get(value);
 if(!c){const id=createProfile({contact:value,source:'subscribe'});event(id,'subscribe','邮箱订阅');return id;}db.prepare("UPDATE customers SET source='subscribe' WHERE id=? AND source='test_order'").run(c.id);return c.id;
});}
export function linkOrderCustomer(orderId){return transaction(()=>{
 const o=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);if(!o)throw new InputError('订单不存在',404);if(o.customer_id){syncCustomerProfile(o.customer_id);return o.customer_id;}
 const address=JSON.parse(o.address||'{}');let id;
 if(o.user_id&&db.prepare("SELECT id FROM users WHERE id=? AND role='customer'").get(o.user_id))id=linkRegisteredCustomer(o.user_id);
 else id=db.prepare('SELECT id FROM customers WHERE email=?').get(o.email)?.id;
 let phone='';try{phone=whatsappNumber(address.phone||'');}catch{}
 if(!id)id=createProfile({name:o.customer_name,contact:o.email,phone:'',country:address.country||'',source:o.order_kind==='test'?'test_order':'order'});
 db.prepare('UPDATE orders SET customer_id=? WHERE id=?').run(id,orderId);
 if(o.order_kind==='external'&&customer(id).archived_at){db.prepare('UPDATE customers SET archived_at=NULL,updated_at=? WHERE id=?').run(now(),id);event(id,'archive','新正式订单自动恢复客户档案',null,orderId);}
 syncCustomerProfile(id);
 event(id,'order',o.order_kind==='test'?'创建测试订单':'网站下单',null,orderId);
 if(o.order_kind==='external'){
  addTask(id,{kind:'first_contact',title:'网站新订单：首次联系',orderId,key:'order-contact:'+orderId});
  if(o.payment_method!=='cod')addTask(id,{kind:'payment',title:'订单付款跟进',orderId,due:new Date(Date.now()+86400000).toISOString(),key:'order-payment:'+orderId});
 }
 return id;
});}
export function initializeCustomers(){transaction(()=>{
 for(const u of db.prepare("SELECT id FROM users WHERE role='customer' AND customer_id IS NULL").all())linkRegisteredCustomer(u.id,{backfill:true});
 for(const o of db.prepare('SELECT id FROM orders WHERE customer_id IS NULL').all())linkOrderCustomer(o.id);
 for(const s of db.prepare('SELECT email FROM subscribers WHERE active=1').all())linkSubscriber(s.email);
 for(const c of db.prepare('SELECT id FROM customers').all())syncCustomerProfile(c.id);
});}
export function saveCustomer(input,actor){return transaction(()=>{
 const id=input.id?int(input.id,'客户编号',1):null,old=id?syncCustomerProfile(id):null;
 const contact=old?old.email:input.email?email(input.email):null;
 if(old&&input.email!==undefined&&(input.email?email(input.email):null)!==contact)throw new InputError('客户邮箱由注册或下单资料自动带入，不能在这里更改');
 const editable=(key,label,max)=>text(input[key]===undefined?old?.[key]||'':input[key],label,max,false);
 const name=editable('name','联系姓名',100),phone=input.phone===undefined?old?.phone||'':whatsappNumber(input.phone),mobile=editable('mobile','手机号码',50);
 if(!contact&&!phone&&!mobile)throw new InputError('至少填写邮箱或联系电话');
 const country=editable('country','国家/地区',80),locale=editable('locale','语言',50),owner=editable('owner','负责人',80),tags=editable('tags','标签',500);
 const overrides=old?JSON.parse(old.profile_overrides):{};
 for(const key of ['name','country','mobile','phone'])if(old?({name,country,mobile,phone})[key]!==old[key]:Boolean(({name,country,mobile,phone})[key]))overrides[key]=true;
 let result=id;
 if(old)db.prepare('UPDATE customers SET name=?,mobile=?,phone=?,country=?,locale=?,owner=?,tags=?,profile_overrides=?,do_not_contact=?,updated_at=? WHERE id=?').run(name,mobile,phone,country,locale,owner,tags,JSON.stringify(overrides),input.do_not_contact==='1'?1:0,now(),id);
 else{result=createProfile({name,contact,phone,country,source:'manual'});db.prepare('UPDATE customers SET mobile=?,locale=?,owner=?,tags=?,profile_overrides=?,do_not_contact=? WHERE id=?').run(mobile,locale,owner,tags,JSON.stringify(overrides),input.do_not_contact==='1'?1:0,result);}
 if(old&&old.phone!==phone)db.prepare("UPDATE customers SET whatsapp_status='unknown',whatsapp_verified_at='',whatsapp_verified_by=NULL WHERE id=?").run(id);
 if(input.do_not_contact==='1')db.prepare("UPDATE customer_tasks SET status='cancelled',result='客户要求停止普通跟进',updated_at=? WHERE customer_id=? AND status='pending' AND (kind='purchase' OR (kind='first_contact' AND order_id IS NULL))").run(now(),result);
 const values={name,mobile,phone,country,locale,owner,tags};
 const changes=old?Object.keys(values).filter(k=>values[k]!==old[k]).map(k=>k+': '+(old[k]||'未填写')+' → '+(values[k]||'未填写')).join('；'):'手动补充档案';
 event(result,'profile','资料已更新：'+changes,actor);audit(actor,'customer.save',result);return result;
});}
export function saveWhatsapp(input,actor){return transaction(()=>{
 const c=customer(input.customer_id),status=choice(input.status,whatsappNames,'WhatsApp状态'),note=text(input.note||'','核实说明',1000,false);
 if(status==='connected'&&!c.phone)throw new InputError('确认已联系前请先保存带国家区号的号码');
 if(status!=='unknown'&&!note)throw new InputError('请填写核实依据或沟通摘要');
 db.prepare('UPDATE customers SET whatsapp_status=?,whatsapp_verified_at=?,whatsapp_verified_by=?,updated_at=? WHERE id=?').run(status,status==='unknown'?'':now(),actor,now(),c.id);
 event(c.id,'whatsapp',whatsappNames[c.whatsapp_status]+' → '+whatsappNames[status]+(note?'：'+note:''),actor);audit(actor,'customer.whatsapp',c.id);return c.id;
});}
export function archiveCustomer(input,actor){return transaction(()=>{const c=customer(input.customer_id);db.prepare('UPDATE customers SET archived_at=?,updated_at=? WHERE id=?').run(input.restore==='1'?null:now(),now(),c.id);event(c.id,'archive',input.restore==='1'?'恢复客户':'归档客户',actor);audit(actor,'customer.archive',c.id);return c.id;});}
export function logContact(input,actor){return transaction(()=>{
 const c=customer(input.customer_id),channel=choice(input.channel,{email:1,whatsapp:1,phone:1,other:1},'联系渠道'),outcome=choice(input.outcome,{contacted:1,no_reply:1,failed:1,note:1},'沟通结果');
 if(input.order_id&&!db.prepare('SELECT id FROM orders WHERE id=? AND customer_id=?').get(input.order_id,c.id))throw new InputError('订单不属于此客户');
 const body=text(input.body,'沟通记录',3000);event(c.id,'contact',channel+' / '+({contacted:'已实际联系',no_reply:'已联系未回复',failed:'联系失败',note:'内部备注'}[outcome])+'：'+body,actor,input.order_id||null);
 if(input.order_id&&!db.prepare('SELECT id FROM orders WHERE id=? AND customer_id=?').get(input.order_id,c.id))throw new InputError('订单不属于此客户');
 if(outcome==='contacted')db.prepare("UPDATE customer_tasks SET status='done',result='已记录实际联系成功',actor_id=?,updated_at=? WHERE customer_id=? AND kind='first_contact' AND order_id IS NULL AND status='pending'").run(actor,now(),c.id);
 if(['contacted','no_reply'].includes(outcome))db.prepare('UPDATE customers SET last_contact_at=?,updated_at=? WHERE id=?').run(now(),now(),c.id);
 if(input.task_id){const task=db.prepare('SELECT * FROM customer_tasks WHERE id=? AND customer_id=?').get(int(input.task_id,'待办编号',1),c.id);if(!task)throw new InputError('待办不存在');if(task.kind==='first_contact'&&outcome!=='contacted')throw new InputError('首次联系待办请在实际联系成功后完成，未回复可保留待办或延期');db.prepare("UPDATE customer_tasks SET status='done',result=?,actor_id=?,updated_at=? WHERE id=?").run(body,actor,now(),task.id);}
 if(input.next_at&&c.do_not_contact&&((input.next_kind||'purchase')==='purchase'||((input.next_kind==='first_contact')&&!input.order_id)))throw new InputError('客户已要求停止普通购买跟进');
 if(input.next_at)addTask(c.id,{kind:input.next_kind||'purchase',title:taskNames[input.next_kind||'purchase'],due:input.next_at,orderId:input.order_id||null,owner:c.owner},actor);
 audit(actor,'customer.contact',c.id);return c.id;
});}
export function saveTask(input,actor){return transaction(()=>{
 const c=customer(input.customer_id),kind=choice(input.kind,taskNames,'待办类型');
 if(c.do_not_contact&&(kind==='purchase'||(kind==='first_contact'&&!input.order_id)))throw new InputError('客户已要求停止普通购买跟进');
 addTask(c.id,{kind,title:text(input.title||taskNames[kind],'待办标题',200),due:input.due_at,orderId:input.order_id||null,owner:text(input.owner||'','负责人',80,false)},actor);event(c.id,'task','新增'+taskNames[kind],actor);return c.id;
});}
export function updateTask(input,actor){return transaction(()=>{
 const c=customer(input.customer_id),t=db.prepare('SELECT * FROM customer_tasks WHERE id=? AND customer_id=?').get(int(input.task_id,'待办编号',1),c.id);if(!t)throw new InputError('待办不存在',404);
 const action=choice(input.action,{done:1,cancelled:1,reschedule:1,reopen:1},'待办操作'),result=text(input.result||'','处理结果',2000,action!=='reopen');
 if(t.kind==='first_contact'&&action==='done')throw new InputError('首次联系请通过“记录沟通”完成，确保保留实际联系结果');
 db.prepare('UPDATE customer_tasks SET status=?,due_at=?,result=?,actor_id=?,updated_at=? WHERE id=?').run(['reschedule','reopen'].includes(action)?'pending':action,action==='reschedule'?dateInput(input.due_at):t.due_at,result,actor,now(),t.id);event(c.id,'task',t.title+'：'+action+' '+result,actor,t.order_id);return c.id;
});}
export function saveCase(input,actor){return transaction(()=>{
 const c=customer(input.customer_id),orderId=text(input.order_id,'订单号',80);
 if(!db.prepare('SELECT id FROM orders WHERE id=? AND customer_id=?').get(orderId,c.id))throw new InputError('请选择此客户的订单');
 const category=choice(input.category,{size:1,printing:1,delivery:1,return:1,other:1},'售后类型'),subject=text(input.subject,'售后问题',1000),due=dateInput(input.due_at),owner=text(input.owner||'','负责人',80,false);
 const r=db.prepare('INSERT INTO customer_cases(customer_id,order_id,category,subject,due_at,owner,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(c.id,orderId,category,subject,due,owner,now(),now());
 addTask(c.id,{kind:'aftersale',title:'售后：'+subject.slice(0,150),due,orderId,owner,key:'case:'+r.lastInsertRowid},actor);event(c.id,'aftersale','新建售后：'+subject,actor,orderId);audit(actor,'customer.case_create',r.lastInsertRowid);return c.id;
});}
export function updateCase(input,actor){return transaction(()=>{
 const c=customer(input.customer_id),row=db.prepare('SELECT * FROM customer_cases WHERE id=? AND customer_id=?').get(int(input.case_id,'售后编号',1),c.id);if(!row)throw new InputError('售后事项不存在',404);
 const status=choice(input.status,caseNames,'售后状态'),body=text(input.body,'处理记录',2000),due=input.due_at?dateInput(input.due_at):row.due_at;
 db.prepare('UPDATE customer_cases SET status=?,resolution=?,due_at=?,updated_at=? WHERE id=?').run(status,body,due,now(),row.id);
 db.prepare('UPDATE customer_tasks SET status=?,due_at=?,result=?,updated_at=? WHERE dedupe_key=?').run(['resolved','closed'].includes(status)?'done':'pending',due,body,now(),'case:'+row.id);
 event(c.id,'aftersale',caseNames[status]+'：'+body,actor,row.order_id);audit(actor,'customer.case_update',row.id);return c.id;
});}
export function saveCustomerConfig(input,actor){const mode=choice(input.order_mode,{test:1,external:1,cod:1,online:1},'订单模式'),days=int(input.review_days,'收货后回访天数',1,90);putSetting('customer_management',{orderMode:mode,reviewDays:days});audit(actor,'customer.config',mode);}

const summarySQL=`SELECT c.*,
 (SELECT whatsapp_phone FROM users WHERE role='customer' AND customer_id=c.id ORDER BY id LIMIT 1) registered_whatsapp_phone,
 (SELECT whatsapp_clicked_at FROM users WHERE role='customer' AND customer_id=c.id ORDER BY id LIMIT 1) registration_clicked_at,
 (SELECT COALESCE((SELECT p.state FROM account_contact_permissions p WHERE p.user_id=u.id AND p.channel='whatsapp' AND p.scope='registration_service' AND p.address=u.whatsapp_phone),'unknown') FROM users u WHERE u.role='customer' AND u.customer_id=c.id ORDER BY u.id LIMIT 1) registration_wa_state,
 (SELECT MIN(created_at) FROM users WHERE role='customer' AND customer_id=c.id) registered_at,
 (SELECT name FROM users WHERE role='customer' AND customer_id=c.id ORDER BY id LIMIT 1) nickname,
 (SELECT id FROM orders WHERE customer_id=c.id ORDER BY CASE order_kind WHEN 'external' THEN 0 ELSE 1 END,created_at DESC,rowid DESC LIMIT 1) latest_order_id,
 (SELECT COUNT(*) FROM orders WHERE customer_id=c.id AND order_kind='external') order_count,
 (SELECT COUNT(*) FROM orders WHERE customer_id=c.id AND order_kind='test') test_count,
 (SELECT COUNT(*) FROM orders WHERE customer_id=c.id AND order_kind='external' AND payment_status='paid') paid_count,
 (SELECT COUNT(*) FROM orders WHERE customer_id=c.id AND order_kind='external' AND paid_at!='') deal_count,
 (SELECT COUNT(*) FROM orders WHERE customer_id=c.id AND order_kind='external' AND payment_status IN('unpaid','partial') AND fulfillment_status!='cancelled') unpaid_count,
 (SELECT COUNT(*) FROM orders WHERE customer_id=c.id AND order_kind='external' AND payment_status IN('refunded','part_refunded')) refund_count,
 (SELECT SUM(base_total) FROM orders WHERE customer_id=c.id AND order_kind='external' AND payment_status='paid') paid_base,
 (SELECT MAX(created_at) FROM orders WHERE customer_id=c.id AND order_kind='external') last_order_at,
 (SELECT MIN(t.due_at) FROM customer_tasks t LEFT JOIN orders o ON o.id=t.order_id WHERE t.customer_id=c.id AND t.status='pending' AND (o.id IS NULL OR o.order_kind='external') AND (c.do_not_contact=0 OR (t.kind!='purchase' AND (t.kind!='first_contact' OR t.order_id IS NOT NULL))) ) next_due,
 (SELECT COUNT(*) FROM customer_tasks t JOIN orders o ON o.id=t.order_id WHERE t.customer_id=c.id AND t.kind='first_contact' AND t.status='pending' AND o.order_kind='external' AND o.fulfillment_status!='cancelled') new_orders,
 (SELECT COUNT(*) FROM customer_tasks t LEFT JOIN orders o ON o.id=t.order_id WHERE t.customer_id=c.id AND t.kind='review' AND t.status='pending' AND (o.id IS NULL OR o.order_kind='external')) review_count,
 (SELECT COUNT(*) FROM customer_cases k JOIN orders o ON o.id=k.order_id WHERE k.customer_id=c.id AND k.status NOT IN('resolved','closed') AND o.order_kind='external') case_count
 FROM customers c`;
function viewCondition(view){return ({new_registered:"registered_at IS NOT NULL AND registered_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-7 days')",registration_missing:"registered_at IS NOT NULL AND COALESCE(registered_whatsapp_phone,'')=''",registration_unconsented:"registered_at IS NOT NULL AND COALESCE(registered_whatsapp_phone,'')!='' AND COALESCE(registration_wa_state,'unknown')!='granted'",registration_authorized:"registration_wa_state='granted' AND (phone!=registered_whatsapp_phone OR whatsapp_status!='connected') AND NOT EXISTS(SELECT 1 FROM whatsapp_messages wm WHERE wm.customer_id=s.id AND wm.phone=s.registered_whatsapp_phone AND wm.direction='in')",registration_clicked:"COALESCE(registration_clicked_at,'')!=''",registered:"registered_at IS NOT NULL AND deal_count=0",unknown:"whatsapp_status='unknown'",unconnected:"whatsapp_status='not_contacted'",connected:"whatsapp_status='connected' AND deal_count=0",new_orders:'new_orders>0',unpaid:'unpaid_count>0',review:'review_count>0',aftersale:'case_count>0',test:'test_count>0',today:"next_due < strftime('%Y-%m-%dT16:00:00.000Z','now','+8 hours')",overdue:"next_due < strftime('%Y-%m-%dT%H:%M:%fZ','now')"})[view]||'1=1';}
function filters(q={}){
 const view=Object.hasOwn(customerViews,q.view)?q.view:'all',parts=[view==='archived'?'archived_at IS NOT NULL':'archived_at IS NULL',view==='test'?'1=1':"(source!='test_order' OR registered_at IS NOT NULL OR order_count>0 OR source='subscribe')",viewCondition(view)],args=[];
 if(q.q){const term='%'+text(q.q,'搜索',120).replace(/[!%_]/g,m=>'!'+m)+'%';parts.push("(name LIKE ? ESCAPE '!' OR nickname LIKE ? ESCAPE '!' OR email LIKE ? ESCAPE '!' OR phone LIKE ? ESCAPE '!' OR tags LIKE ? ESCAPE '!' OR EXISTS(SELECT 1 FROM orders oo WHERE oo.customer_id=s.id AND oo.id LIKE ? ESCAPE '!'))");args.push(term,term,term,term,term,term);}
 if(q.whatsapp){choice(q.whatsapp,whatsappNames,'联系状态');parts.push('whatsapp_status=?');args.push(q.whatsapp);}
 if(q.missing_phone==='1')parts.push("phone=''");
 if(q.country){parts.push("country LIKE ? ESCAPE '!'");args.push('%'+text(q.country,'国家',80).replace(/[!%_]/g,m=>'!'+m)+'%');}
 if(q.deal==='yes')parts.push('deal_count>0');else if(q.deal==='no')parts.push('deal_count=0');
 if(q.from){parts.push('COALESCE(registered_at,created_at)>=?');args.push(dateInput(q.from+'T00:00'));}if(q.to){parts.push('COALESCE(registered_at,created_at)<?');args.push(new Date(Date.parse(dateInput(q.to+'T00:00'))+86400000).toISOString());}
 return {view,where:parts.join(' AND '),args};
}
export function listCustomers(query={},exporting=false){const f=filters(query),page=int(query.page||1,'页码',1,100000),count=db.prepare(`SELECT COUNT(*) n FROM (${summarySQL}) s WHERE ${f.where}`).get(...f.args).n;
 const rows=db.prepare(`SELECT * FROM (${summarySQL}) s WHERE ${f.where} ORDER BY CASE WHEN new_orders>0 THEN 0 WHEN next_due IS NOT NULL THEN 1 ELSE 2 END,next_due,created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...f.args,exporting?10000:25,exporting?0:(page-1)*25);return {rows,count,page,pages:Math.max(1,Math.ceil(count/25)),view:f.view};}
export function customerStats(){const rows=db.prepare(`SELECT * FROM (${summarySQL}) s WHERE archived_at IS NULL AND (source!='test_order' OR registered_at IS NOT NULL OR order_count>0)`).all(),stats={};for(const view of Object.keys(customerViews))stats[view]=db.prepare(`SELECT COUNT(*) n FROM (${summarySQL}) s WHERE ${filters({view}).where}`).get().n;return {...stats,total:rows.length,missing:rows.filter(c=>!c.phone).length};}
export function customerDetail(id){const c=syncCustomerProfile(id);return {customer:{...db.prepare(`SELECT * FROM (${summarySQL}) s WHERE id=?`).get(c.id),sources:customerProfileSources(c.id)},orders:db.prepare('SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC').all(c.id),tasks:db.prepare('SELECT * FROM customer_tasks WHERE customer_id=? ORDER BY CASE status WHEN \'pending\' THEN 0 ELSE 1 END,due_at,id DESC').all(c.id),events:db.prepare('SELECT e.*,u.name actor_name FROM customer_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.customer_id=? ORDER BY e.id DESC LIMIT 150').all(c.id),cases:db.prepare('SELECT * FROM customer_cases WHERE customer_id=? ORDER BY id DESC').all(c.id),subscribed:!!(c.email&&db.prepare('SELECT email FROM subscribers WHERE email=? AND active=1').get(c.email))};}
