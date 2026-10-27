import {db,now,transaction,audit,settings,putSetting} from './db.mjs';
import {text,int,InputError} from '../../packages/contracts/validation.mjs';
import {dateInput} from '../../packages/contracts/customers.mjs';
import {parseCurrencyAmount,currencyMap} from '../../packages/contracts/currencies.mjs';
import {hash} from './security.mjs';
export const serviceKinds={refund:'仅退款',return_refund:'退货退款',exchange:'换货',reship:'补发',cash_refund:'代收多收退款'};
export const serviceStates={review:'待审核',waiting_return:'待寄回',returning:'退货运输中',inspecting:'待验收',refund_pending:'待退款',replacement_pending:'待换货/补发',completed:'已完成',rejected:'已拒绝'};
export const followStates={new:'待首次联系',waiting:'待客户回复',missing:'资料待补',confirmed:'已确认',cancelled:'已取消'};
export function serviceRules(){return {followHours:24,returnDays:0,customPolicy:'manual',shippingPolicy:'manual',...settings().service_rules};}
function order(id){const o=db.prepare('SELECT * FROM orders WHERE id=?').get(text(String(id),'订单号',100));if(!o||o.order_kind!=='external')throw new InputError('正式订单不存在',404);return o;}
function syncCrm(id){const s=db.prepare('SELECT * FROM service_cases WHERE id=?').get(id);if(s?.customer_case_id)db.prepare('UPDATE customer_cases SET status=?,resolution=?,updated_at=? WHERE id=?').run(['completed','rejected'].includes(s.status)?'resolved':'processing','商品售后 #'+s.id+'：'+(serviceStates[s.status]||s.status),now(),s.customer_case_id);}
function money(v,c,zero=false){if(!currencyMap.has(c))throw new InputError('币种无效');let n;try{n=parseCurrencyAmount(v,{minor:currencyMap.get(c).minor});}catch{throw new InputError('金额格式无效');}if(!zero&&!n)throw new InputError('金额须大于0');return n;}
function at(v){const t=dateInput(v||now());if(Date.parse(t)>Date.now()+300000)throw new InputError('实际发生时间不能在未来');return t;}
function event(o,actor,kind,body,id=null,key=null,t=now()){db.prepare('INSERT INTO service_events(case_id,order_id,kind,body,actor_id,occurred_at,created_at,request_key) VALUES(?,?,?,?,?,?,?,?)').run(id,o.id,kind,body,actor,t,now(),key);audit(actor,'service.'+kind,id||o.id);}
export function initializeFollowups(){const rules=serviceRules();db.prepare("INSERT OR IGNORE INTO order_followups(order_id,next_at,updated_at) SELECT id,datetime(created_at,?),? FROM orders WHERE order_kind='external' AND fulfillment_status='pending'").run('+'+rules.followHours+' hours',now());}
export function saveServiceRules(input,actor){const followHours=int(input.follow_hours,'跟进小时数',1,720),returnDays=int(input.return_days,'退货天数',0,365);if(!['manual','exclude'].includes(input.custom_policy)||!['manual','exclude'].includes(input.shipping_policy))throw new InputError('审核规则无效');putSetting('service_rules',{followHours,returnDays,customPolicy:input.custom_policy,shippingPolicy:input.shipping_policy});audit(actor,'service.rules','rules');}
export function saveFollowup(input,actor){return transaction(()=>{
 const o=order(input.order_id);if(o.fulfillment_status!=='pending')throw new InputError('仅未发货订单可修改确认跟进');
 const stage=text(input.stage,'跟进状态',30);if(!['new','waiting','missing','confirmed'].includes(stage))throw new InputError('跟进状态无效');
 if(stage==='confirmed'&&o.payment_method==='cod'&&!o.cod_confirmed_at)throw new InputError('请先在发货资料卡核实地址与代收金额');
 const next=dateInput(input.next_at,'下次跟进'),result=text(input.result,'联系结果',1000),owner=text(input.owner||'','负责人',100,false);
 db.prepare('INSERT INTO order_followups VALUES(?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET owner=excluded.owner,stage=excluded.stage,result=excluded.result,next_at=excluded.next_at,updated_at=excluded.updated_at').run(o.id,owner,stage,result,next,now());event(o,actor,'followup',JSON.stringify({stage,result,owner,next}));return o.id;
});}
export function refundableLines(o){
 const items=db.prepare('SELECT * FROM order_items WHERE order_id=? ORDER BY id').all(o.id),total=items.reduce((n,i)=>n+i.unit_price*i.quantity,0),discount=o.discount||0;
 const allocations=items.map(i=>Math.floor(discount*(i.unit_price*i.quantity)/Math.max(1,total)));let extra=discount-allocations.reduce((a,b)=>a+b,0);for(let n=0;n<allocations.length&&extra;n++,extra--)allocations[n]++;
 const currency=o.payment_method==='cod'?o.cod_currency:o.currency,payable=o.payment_method==='cod'?o.cod_amount:o.total;
 const weights=[...items.map((i,n)=>i.unit_price*i.quantity-allocations[n]),o.shipping],shares=weights.map(w=>Math.floor(w*payable/Math.max(1,o.total)));let remainder=payable-shares.reduce((n,x)=>n+x,0);for(let n=0;n<shares.length&&remainder>0;n++,remainder--)shares[n]++;
 return items.map((i,n)=>{const net=i.unit_price*i.quantity-allocations[n],limit=shares[n];return {...i,net,discount:allocations[n],ceiling:limit,shipping_ceiling:shares.at(-1),currency};});
}
export function createService(input,actor){return transaction(()=>{
 const o=order(input.order_id);if(o.fulfillment_status!=='shipped')throw new InputError('仅已发货订单可创建商品售后');
 const key=text(input.request_key,'请求标识',100),prior=db.prepare('SELECT id,order_id FROM service_cases WHERE request_key=?').get(key);if(prior){if(prior.order_id!==o.id)throw new InputError('请求标识冲突',409);return prior.id;}
 const kind=text(input.kind,'售后类型',30);if(!Object.hasOwn(serviceKinds,kind)||kind==='cash_refund')throw new InputError('商品售后类型无效，代收多收退款请从差额单创建');
 if(!o.delivered_at&&!db.prepare("SELECT id FROM shipments WHERE order_id=? AND status='delivered'").get(o.id))throw new InputError('签收前拒收退回请使用包裹管理');
 const rules=serviceRules();if(rules.returnDays&&o.delivered_at&&Date.now()-Date.parse(o.delivered_at)>rules.returnDays*86400000)throw new InputError('超过当前申请期限，请核实规则后处理');
 const lines=refundableLines(o),selected=[];
 for(const i of lines){const q=int(input['qty_'+i.id]||0,'售后数量',0,i.quantity);if(!q)continue;const used=db.prepare("SELECT COALESCE(SUM(si.quantity),0) n FROM service_items si JOIN service_cases sc ON sc.id=si.case_id WHERE si.order_item_id=? AND sc.status!='rejected'").get(i.id).n;
  const signed=o.delivered_at?i.quantity:db.prepare("SELECT COALESCE(SUM(si.quantity),0) n FROM shipment_items si JOIN shipments p ON p.id=si.shipment_id WHERE si.order_item_id=? AND p.status='delivered'").get(i.id).n;if(used+q>signed)throw new InputError('售后数量超过此商品已签收数量');
  if(used+q>i.quantity)throw new InputError('累计售后数量超过购买数量');const customization=JSON.parse(i.customization||'{}');
  const excluded=rules.customPolicy==='exclude'?(customization.extraPrice||0)*i.quantity:0,limit=Math.max(0,i.ceiling-Math.floor(excluded*(o.payment_method==='cod'?o.cod_amount:o.total)/Math.max(1,o.total)));
  selected.push({...i,q,refund:Math.floor(limit*(used+q)/i.quantity)-Math.floor(limit*used/i.quantity)});
 }
 if(!selected.length)throw new InputError('请选择售后商品及数量');
 const currency=selected[0].currency,goods=selected.reduce((n,i)=>n+i.refund,0),shipping=rules.shippingPolicy==='exclude'?0:selected[0].shipping_ceiling;
 const id=Number(db.prepare('INSERT INTO service_cases(order_id,kind,reason,evidence,owner,currency,goods_ceiling,shipping_ceiling,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(o.id,kind,text(input.reason,'售后原因',1000),text(input.evidence||'','图片媒体路径/证据说明',2000,false),text(input.owner||'','负责人',100,false),currency,goods,shipping,key,now(),now()).lastInsertRowid);
 for(const i of selected)db.prepare('INSERT INTO service_items(case_id,order_item_id,quantity,ceiling,price_snapshot) VALUES(?,?,?,?,?)').run(id,i.id,i.q,i.refund,JSON.stringify({title:i.title,variant:i.variant_label,unit_price:i.unit_price,discount:i.discount,net:i.net,order_currency:o.currency,refund_currency:currency,customization:i.customization}));
 if(o.customer_id){const crm=Number(db.prepare('INSERT INTO customer_cases(customer_id,order_id,category,subject,owner,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(o.customer_id,o.id,kind,'商品售后 #'+id+'：'+text(input.reason,'原因',1000).slice(0,150),text(input.owner||'','负责人',100,false),new Date(Date.now()+rules.followHours*3600000).toISOString(),now(),now()).lastInsertRowid);db.prepare('UPDATE service_cases SET customer_case_id=? WHERE id=?').run(crm,id);}
 event(o,actor,'create',JSON.stringify({kind,goods,shipping,currency}),id);return id;
});}
export function serviceCase(id){const s=db.prepare('SELECT * FROM service_cases WHERE id=?').get(int(id,'售后单',1));if(!s)throw new InputError('售后单不存在',404);return {...s,items:db.prepare('SELECT si.*,oi.title,oi.variant_label,oi.variant_id FROM service_items si JOIN order_items oi ON oi.id=si.order_item_id WHERE case_id=?').all(s.id)};}
export function updateService(input,actor){return transaction(()=>{
 const s=serviceCase(input.case_id),o=order(s.order_id),action=text(input.action,'售后操作',30),note=text(input.note,'核实说明',2000),time=at(input.occurred_at);
 if(action==='approve'||action==='reject'){
  if(s.status!=='review')throw new InputError('售后单已审核');
  let value=0,shippingValue=0;if(action==='approve'&&['refund','return_refund','cash_refund'].includes(s.kind)){value=money(input.amount,s.currency,true);shippingValue=money(input.shipping_amount||'0',s.currency,true);const usedShipping=db.prepare("SELECT COALESCE(SUM(approved_shipping),0) n FROM service_cases WHERE order_id=? AND id<>? AND status!='rejected'").get(o.id,s.id).n;if(shippingValue>value||(s.kind!=='cash_refund'&&shippingValue+usedShipping>s.shipping_ceiling)||(s.kind==='cash_refund'&&shippingValue)||value-shippingValue>s.goods_ceiling)throw new InputError('商品退款或累计可退运费超过上限');if(value>s.goods_ceiling+s.shipping_ceiling)throw new InputError('审核退款超过商品与运费上限');}
  const status=action==='reject'?'rejected':['refund','cash_refund'].includes(s.kind)?'refund_pending':s.kind==='reship'?'replacement_pending':'waiting_return';
  db.prepare('UPDATE service_cases SET status=?,approved_amount=?,approved_shipping=?,approval_note=?,updated_at=? WHERE id=?').run(status,value,shippingValue,note,now(),s.id);
 }else if(action==='return_tracking'){
  if(!['waiting_return','returning'].includes(s.status))throw new InputError('售后单当前不能登记退货运单');
  db.prepare("UPDATE service_cases SET status='returning',return_tracking=?,updated_at=? WHERE id=?").run(text(input.tracking,'退货运单',150),now(),s.id);
 }else if(action==='inspect'){
  if(!['waiting_return','returning','inspecting'].includes(s.status))throw new InputError('当前不能验收');
  const key=text(input.request_key,'验收请求标识',100),prior=db.prepare('SELECT case_id FROM service_events WHERE request_key=?').get(key);if(prior){if(prior.case_id!==s.id)throw new InputError('请求标识冲突',409);return s.id;}
  if(input.confirmed!=='1')throw new InputError('请核实实际收到商品及验收数量');let received=0;const updates=[];
  for(const i of s.items){const qty=int(input['received_'+i.id]||0,'本次实收数量',0,i.quantity-i.received),stock=int(input['stock_'+i.id]||0,'本次可售数量',0,qty);received+=qty;updates.push({item_id:i.id,received:qty,restocked:stock});
   const warehouse=db.prepare('SELECT COALESCE(SUM(si.quantity),0) n FROM shipment_items si JOIN shipments p ON p.id=si.shipment_id WHERE si.order_item_id=? AND p.restocked_at<>?').get(i.order_item_id,'').n;
   const other=db.prepare('SELECT COALESCE(SUM(restocked),0) n FROM service_items WHERE order_item_id=?').get(i.order_item_id).n;
   const purchased=db.prepare('SELECT quantity FROM order_items WHERE id=?').get(i.order_item_id).quantity;if(stock+other+warehouse>purchased)throw new InputError('累计恢复库存超过购买数量');
   db.prepare('UPDATE service_items SET received=received+?,restocked=restocked+? WHERE id=?').run(qty,stock,i.id);if(stock)db.prepare('UPDATE variants SET stock=stock+? WHERE id=?').run(stock,i.variant_id);
  }
  if(!received)throw new InputError('请填写本次收到数量');const refreshed=serviceCase(s.id),complete=refreshed.items.every(i=>i.received===i.quantity);
  db.prepare('UPDATE service_cases SET status=?,updated_at=? WHERE id=?').run(complete?(s.kind==='exchange'?'replacement_pending':'refund_pending'):'inspecting',now(),s.id);syncCrm(s.id);event(o,actor,'inspect',JSON.stringify({note,rows:updates}),s.id,key,time);return s.id;
 }else if(action==='finish_inspection'){
  if(s.status!=='inspecting'||input.confirmed!=='1'||!s.items.some(i=>i.received))throw new InputError('请先登记实际收到数量，并核实数量不足的处理结果');
  let value=s.approved_amount;
  if(s.kind==='return_refund'){value=money(input.amount,s.currency,true);const limit=s.items.reduce((n,i)=>n+Math.floor(i.ceiling*i.received/i.quantity),0)+s.approved_shipping;if(value>s.approved_amount||value>limit)throw new InputError('数量不足时退款不能超过已批准金额及实际收到商品上限');}
  db.prepare('UPDATE service_cases SET status=?,approved_amount=?,updated_at=? WHERE id=?').run(s.kind==='exchange'?'replacement_pending':'refund_pending',value,now(),s.id);
 }else if(action==='replacement'){
  if(s.status!=='replacement_pending'||input.confirmed!=='1')throw new InputError('请核实待换货/补发及实际发出');const tracking=text(input.tracking,'换货/补发运单',150);
  for(const i of s.items){const quantity=s.kind==='exchange'?i.received:i.quantity;if(!quantity)continue;const target=int(input['variant_'+i.id]||i.variant_id,'换货/补发规格',1),v=db.prepare('SELECT * FROM variants WHERE id=? AND product_id=(SELECT product_id FROM variants WHERE id=?)').get(target,i.variant_id);if(!v||!v.active)throw new InputError('请选择同一商品的有效换货规格');const changed=db.prepare('UPDATE variants SET stock=stock-? WHERE id=? AND stock>=? AND active=1').run(quantity,target,quantity);if(changed.changes!==1)throw new InputError('换货或补发库存不足');db.prepare('UPDATE service_items SET replaced=?,replacement_variant_id=? WHERE id=?').run(quantity,target,i.id);}
  db.prepare("UPDATE service_cases SET status='completed',replacement_tracking=?,updated_at=? WHERE id=?").run(tracking,now(),s.id);
 }else if(action==='complete_zero'){
  if(s.status!=='refund_pending'||s.approved_amount!==0)throw new InputError('只有审核为零退款的已验收售后可关闭');db.prepare("UPDATE service_cases SET status='completed',updated_at=? WHERE id=?").run(now(),s.id);
 }else throw new InputError('不支持的售后操作');
 syncCrm(s.id);event(o,actor,action,JSON.stringify({note,amount:input.amount||'',shipping_amount:input.shipping_amount||'',tracking:input.tracking||''}),s.id,null,time);return s.id;
});}
export function refundSummary(id){return db.prepare('SELECT COALESCE(SUM(amount),0) total,COALESCE(SUM(CASE WHEN carrier_offset=1 THEN amount ELSE 0 END),0) offset FROM service_refunds WHERE order_id=?').get(id);}
export function recordServiceRefund(input,actor){return transaction(()=>{
 const s=serviceCase(input.case_id),o=order(s.order_id),currency=s.currency,value=money(input.amount,currency),key=text(input.request_key,'请求标识',100),reference=text(input.reference,'退款参考号',150);
 const prior=db.prepare('SELECT * FROM service_refunds WHERE request_key=?').get(key);if(prior){if(prior.case_id!==s.id||prior.amount!==value||prior.reference!==reference)throw new InputError('退款请求标识冲突',409);return s.id;}
 if(s.status!=='refund_pending'||input.confirmed!=='1')throw new InputError('请先审核/验收并核实实际退款完成');
 const casePaid=db.prepare('SELECT COALESCE(SUM(amount),0) n FROM service_refunds WHERE case_id=?').get(s.id).n;if(value+casePaid>s.approved_amount)throw new InputError('累计退款超过审核金额');
 const cash=o.payment_method==='cod'?db.prepare('SELECT COALESCE(SUM(collected_amount),0) n FROM shipments WHERE order_id=?').get(o.id).n:db.prepare("SELECT COALESCE(SUM(CASE kind WHEN 'receipt' THEN amount ELSE -amount END),0) n FROM order_receipts WHERE order_id=?").get(o.id).n;
 const total=refundSummary(o.id);if(value+total.total>cash)throw new InputError('退款超过已核实收到的客户货款');
 const source=text(input.source,'退款方',20);if(!['merchant','carrier'].includes(source))throw new InputError('退款方无效');const offset=source==='carrier'&&input.carrier_offset==='1'?1:0;
 if(offset){if(o.payment_method!=='cod')throw new InputError('非货到付款不能从物流回款中扣除');const gross=db.prepare('SELECT COALESCE(SUM(gross),0) n FROM cod_remittances WHERE order_id=?').get(o.id).n;if(value+total.offset>cash-gross)throw new InputError('退款扣除超过物流商尚未结算货款');}
 if(db.prepare('SELECT id FROM service_refunds WHERE order_id=? AND reference=?').get(o.id,reference))throw new InputError('退款参考号已登记',409);
 const transferCurrency=text(input.transfer_currency||currency,'实际退款币种',3),transfer=money(input.transfer_amount||input.amount,transferCurrency),evidence=text(input.evidence,'退款凭证与换算依据',2000),time=at(input.occurred_at);
 if(transferCurrency===currency&&transfer!==value)throw new InputError('同币种退款金额须一致');
 db.prepare('INSERT INTO service_refunds(case_id,order_id,amount,currency,source,carrier_offset,transfer_amount,transfer_currency,method,recipient,reference,occurred_at,actor_id,evidence,request_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(s.id,o.id,value,currency,source,offset,transfer,transferCurrency,text(input.method,'退款方式',100),text(input.recipient,'退款对象',100),reference,time,actor,evidence,key,now());
 db.prepare('UPDATE orders SET payment_status=? WHERE id=?').run(value+total.total===cash?'refunded':'part_refunded',o.id);if(value+casePaid===s.approved_amount)db.prepare("UPDATE service_cases SET status='completed',updated_at=? WHERE id=?").run(now(),s.id);
 syncCrm(s.id);event(o,actor,'refund',JSON.stringify({value,currency,source,offset,reference,transfer,transferCurrency,evidence}),s.id,null,time);return s.id;
});}
export function reconciliation(input,actor){return transaction(()=>{
 const o=order(input.order_id);if(o.payment_method!=='cod')throw new InputError('仅货到付款订单可核对物流差额');
 if(input.id){const prior=db.prepare('SELECT * FROM reconciliation_cases WHERE id=? AND order_id=?').get(int(input.id,'差额单',1),o.id);if(!prior||prior.status!=='open')throw new InputError('差额单不存在或已处理');const result=text(input.result,'处理结果',2000);db.prepare("UPDATE reconciliation_cases SET status='resolved',result=?,updated_at=? WHERE id=?").run(result,now(),prior.id);event(o,actor,'difference_resolved',result);return o.id;}
 const kind=text(input.kind,'差额类型',30);if(!['collection','remittance','fee','currency'].includes(kind))throw new InputError('差额类型无效');
 db.prepare('INSERT INTO reconciliation_cases(order_id,kind,expected,actual,currency,owner,evidence,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').run(o.id,kind,money(input.expected,o.cod_currency,true),money(input.actual,o.cod_currency,true),o.cod_currency,text(input.owner||'','负责人',100,false),text(input.evidence,'差额依据',2000),now(),now());event(o,actor,'difference',kind);return o.id;
});}
export function recordActualCollection(input,actor){return transaction(()=>{
 const o=order(input.order_id),s=db.prepare('SELECT * FROM shipments WHERE id=? AND order_id=?').get(int(input.shipment_id,'包裹',1),o.id);
 if(o.payment_method!=='cod'||!s||s.status!=='delivered'||(s.collected_at&&input.correction!=='1'))throw new InputError('包裹不可登记实际代收');const value=money(input.amount,o.cod_currency,true),reason=text(input.evidence,'代收核实依据',2000),time=at(input.occurred_at);
 if(input.confirmed!=='1')throw new InputError('请核实物流商实际代收金额');
 const settled=db.prepare('SELECT COALESCE(SUM(gross),0) n FROM cod_remittances WHERE order_id=?').get(o.id).n,refunded=refundSummary(o.id),others=db.prepare('SELECT COALESCE(SUM(collected_amount),0) n FROM shipments WHERE order_id=? AND id<>?').get(o.id,s.id).n;if(value+others<settled+refunded.offset||value+others<refunded.total)throw new InputError('更正后代收金额不足以覆盖已回款或已退款，请先核实相关账目');
 db.prepare('UPDATE shipments SET collected_amount=?,collected_at=?,updated_at=? WHERE id=?').run(value,time,now(),s.id);
 if(value!==s.cod_amount)db.prepare("INSERT INTO reconciliation_cases(order_id,kind,expected,actual,currency,evidence,created_at,updated_at) VALUES(?,'collection',?,?,?,?,?,?)").run(o.id,s.cod_amount,value,o.cod_currency,reason,now(),now());
 event(o,actor,'actual_collection',JSON.stringify({shipment:s.id,expected:s.cod_amount,before:s.collected_amount,actual:value,reason}));return o.id;
});}
export function createDifferenceRefund(input,actor){return transaction(()=>{
 const d=db.prepare("SELECT * FROM reconciliation_cases WHERE id=? AND status='open' AND kind='collection'").get(int(input.id,'差额单',1));if(!d)throw new InputError('待处理代收差额不存在');const o=order(d.order_id),key=text(input.request_key,'请求标识',100),prior=db.prepare('SELECT id,order_id FROM service_cases WHERE request_key=?').get(key);if(prior){if(prior.order_id!==o.id)throw new InputError('请求标识冲突',409);return prior.id;}
 const received=db.prepare('SELECT COALESCE(SUM(collected_amount),0) n FROM shipments WHERE order_id=?').get(o.id).n,reserved=db.prepare("SELECT COALESCE(SUM(goods_ceiling),0) n FROM service_cases WHERE order_id=? AND kind='cash_refund' AND status!='rejected'").get(o.id).n,excess=received-o.cod_amount-reserved;if(excess<=0)throw new InputError('此订单没有尚未申请退款的核实多收金额');
 const stamp=now(),reason='代收差额 #'+d.id+'：核实多收款退款';const id=Number(db.prepare("INSERT INTO service_cases(order_id,kind,reason,evidence,owner,currency,goods_ceiling,shipping_ceiling,request_key,created_at,updated_at) VALUES(?,'cash_refund',?,?,?,?,?,0,?,?,?)").run(o.id,reason,d.evidence,d.owner,o.cod_currency,excess,key,stamp,stamp).lastInsertRowid);event(o,actor,'excess_refund_application',JSON.stringify({difference:d.id,excess,currency:o.cod_currency}),id);return id;
});}
export function serviceStats(){initializeFollowups();return {follow:db.prepare("SELECT COUNT(*) n FROM order_followups f JOIN orders o ON o.id=f.order_id WHERE o.fulfillment_status='pending' AND o.cod_confirmed_at='' AND f.stage NOT IN('confirmed','cancelled') AND julianday(f.next_at)<=julianday('now')").get().n,review:db.prepare("SELECT COUNT(*) n FROM service_cases WHERE status='review'").get().n,returns:db.prepare("SELECT COUNT(*) n FROM service_cases WHERE status IN('waiting_return','returning','inspecting')").get().n,refunds:db.prepare("SELECT COUNT(*) n FROM service_cases WHERE status='refund_pending'").get().n,replacements:db.prepare("SELECT COUNT(*) n FROM service_cases WHERE status='replacement_pending'").get().n,differences:db.prepare("SELECT COUNT(*) n FROM reconciliation_cases WHERE status='open'").get().n};}
export function saveServiceAttachment(input,actor){
 const s=serviceCase(input.case_id),raw=text(input.data,'图片编码',5*1024*1024);if(!/^[A-Za-z0-9+/]+={0,2}$/.test(raw))throw new InputError('图片编码无效');const bytes=Buffer.from(raw,'base64');if(!bytes.length||bytes.length>3*1024*1024)throw new InputError('图片最多3MB');
 let type;if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))type='image/png';else if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)type='image/jpeg';else if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')type='image/webp';else if(/^GIF8[79]a$/.test(bytes.subarray(0,6).toString()))type='image/gif';else throw new InputError('仅支持PNG、JPG、WebP、GIF图片');
 const digest=hash(bytes),prior=db.prepare('SELECT id FROM service_attachments WHERE case_id=? AND digest=?').get(s.id,digest);if(prior)return prior.id;if(db.prepare('SELECT COUNT(*) n FROM service_attachments WHERE case_id=?').get(s.id).n>=10)throw new InputError('每个售后单最多10张图片');
 const id=Number(db.prepare('INSERT INTO service_attachments(case_id,name,content_type,digest,content,actor_id,created_at) VALUES(?,?,?,?,?,?,?)').run(s.id,text(input.name,'图片名称',200),type,digest,bytes,actor,now()).lastInsertRowid);audit(actor,'service.attachment',s.id);return id;
}
