import {refundSummary} from './aftersales.mjs';
import {db,transaction,now,audit} from './db.mjs';
import {text,int,InputError} from '../../packages/contracts/validation.mjs';
import {parseCurrencyAmount,currencyMap} from '../../packages/contracts/currencies.mjs';
import {dateInput} from '../../packages/contracts/customers.mjs';
import {checkoutCountries,needsPostal,needsRegion} from '../../packages/contracts/checkout.mjs';
import {ensureShipment,carriers,shipmentStatuses} from './shipments.mjs';
import {omsConfig,enqueueOms} from './oms.mjs';
import {enqueueEmail,shippedEmail} from './mailer.mjs';

function codOrder(id){const o=db.prepare('SELECT * FROM orders WHERE id=?').get(text(id,'订单号',100));if(!o||o.payment_method!=='cod'||o.order_kind!=='external')throw new InputError('货到付款订单不存在',404);return o;}
function amount(value,currency,zero=false){if(!currencyMap.has(currency))throw new InputError('币种无效');let n;try{n=parseCurrencyAmount(value,{minor:currencyMap.get(currency).minor});}catch{throw new InputError('金额或小数位无效');}if(!zero&&!n)throw new InputError('金额必须大于0');return n;}
function happened(input){const at=dateInput(input,'核实时间');if(Date.parse(at)>Date.now()+300000)throw new InputError('时间不能在未来');return at;}
function log(o,actor,kind,body,shipment=null,at=now()){db.prepare('INSERT INTO cod_events(order_id,shipment_id,kind,body,actor_id,occurred_at,created_at) VALUES(?,?,?,?,?,?,?)').run(o.id,shipment,kind,body,actor,at,now());audit(actor,'cod.'+kind,o.id);}
export function shippingAddress(o){const address=o.shipping_address||o.address||'{}';return typeof address==='string'?JSON.parse(address):address;}
export function codSummary(o){
 const s=db.prepare("SELECT COALESCE(SUM(collected_amount),0) collected,COUNT(*) packages,COALESCE(SUM(CASE WHEN status='delivered' THEN 1 ELSE 0 END),0) delivered,COALESCE(SUM(CASE WHEN status IN('exception','refused','returning') OR (status='returned' AND restocked_at='') THEN 1 ELSE 0 END),0) exceptions,COALESCE(SUM(CASE WHEN status='returned' AND restocked_at<>'' THEN 1 ELSE 0 END),0) restocked,COALESCE(SUM(CASE WHEN status='delivered' AND cod_amount>collected_amount THEN 1 ELSE 0 END),0) collection_pending FROM shipments WHERE order_id=?").get(o.id);
 const r=db.prepare('SELECT COALESCE(SUM(gross),0) gross,COALESCE(SUM(fee),0) fee,COALESCE(SUM(net),0) net FROM cod_remittances WHERE order_id=?').get(o.id);
 let label=o.fulfillment_status==='cancelled'?'已取消':s.exceptions?'异常待处理':!o.cod_confirmed_at?'货到付款 · 待确认':o.fulfillment_status==='pending'?'可安排发货':s.delivered===s.packages&&s.packages?'已签收 · 代收待核实':s.delivered?'部分签收 · 待跟进':'待签收 · 待代收';
 if(s.restocked===s.packages&&s.packages)label='已退回入库';
 if(s.collected>r.gross)label='已代收 · 待回款';
 else if(r.gross>0)label=r.gross===o.cod_amount?'已回款':'部分回款';
 if(s.exceptions&&r.gross>0)label+=' · 物流异常';
 const refunds=refundSummary(o.id);if(refunds.total)label+=' · 已登记退款';return {...s,...r,label,refunded:refunds.total,refundOffset:refunds.offset,outstanding:s.collected-r.gross-refunds.offset};
}
export function confirmCod(input,actor){return transaction(()=>{
 const o=codOrder(input.order_id);if(o.fulfillment_status!=='pending')throw new InputError('仅待发货订单可确认或更正发货资料');
 if(input.confirmed!=='1')throw new InputError('请核实地址、电话和代收金额');
 const address={country:text(input.country,'国家',2),region:text(input.region||'','省/州',100,false),city:text(input.city,'城市',150),line:text(input.address,'详细地址',500),line2:text(input.address2===undefined?shippingAddress(o).line2||'':input.address2,'大楼、公寓等',200,false),postal:text(input.postal||'','邮编',30,false),phone:text(input.phone,'联系电话',50)};
 if(!checkoutCountries.includes(address.country))throw new InputError('国家无效');
 if(needsPostal(address.country)&&!address.postal)throw new InputError('此国家需要邮编');
 if(needsRegion(address.country)&&!address.region)throw new InputError('此国家需要填写省/州');
 if(!/^[+0-9 ()-]{6,50}$/.test(address.phone))throw new InputError('联系电话格式无效');
 const name=text(input.recipient,'收件人',100),currency=text(input.cod_currency,'代收币种',3),value=amount(input.cod_amount,currency),note=text(input.cod_note||'','代收说明',1000,false);
 if((currency!==o.currency||value!==o.total)&&!note)throw new InputError('代收金额或币种与订单不同，请填写换算或差额说明');
 const snapshot={...address,recipient:name};db.prepare('UPDATE orders SET cod_amount=?,cod_currency=?,cod_note=?,shipping_address=?,cod_confirmed_at=? WHERE id=?').run(value,currency,note,JSON.stringify(snapshot),now(),o.id);
 db.prepare("UPDATE order_followups SET stage='confirmed',updated_at=? WHERE order_id=?").run(now(),o.id);
 if(omsConfig().enabled)enqueueOms(o.id,'create',actor);
 log(o,actor,'confirm',JSON.stringify({before:{address:shippingAddress(o),amount:o.cod_amount,currency:o.cod_currency},after:{address:snapshot,amount:value,currency,note}}));return o.id;
});}
export function dispatchCod(id,number,actor){return transaction(()=>{
 const o=codOrder(id);if(!o.cod_confirmed_at||o.fulfillment_status!=='pending')throw new InputError('请先核实货到付款资料，且订单须待发货');
 const tracking=text(number,'运单号',150);if(!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{2,149}$/.test(tracking))throw new InputError('运单号格式无效');
 db.prepare("UPDATE orders SET fulfillment_status='shipped',tracking=? WHERE id=?").run(tracking,o.id);ensureShipment(o.id,tracking);
 db.prepare('UPDATE shipments SET cod_amount=? WHERE order_id=?').run(o.cod_amount,o.id);
 try{enqueueEmail({dedupeKey:'shipped:'+o.id+':'+tracking,orderId:o.id,customerId:o.customer_id,...shippedEmail(o,tracking)});}catch{}
 log(o,actor,'dispatch',tracking);return o.id;
});}
export function codAction(input,actor){return transaction(()=>{
 const o=codOrder(input.order_id),action=text(input.action,'操作',40);
 if(action==='dispatch')return dispatchCod(o.id,input.tracking,actor);
 if(action==='cancel'){
  if(o.fulfillment_status!=='pending')throw new InputError('已发货订单请登记拒收或退回');
  for(const i of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(o.id))db.prepare('UPDATE variants SET stock=stock+? WHERE id=?').run(i.quantity,i.variant_id);
  db.prepare("UPDATE orders SET fulfillment_status='cancelled' WHERE id=?").run(o.id);db.prepare("UPDATE customer_tasks SET status='cancelled',result='货到付款订单取消',updated_at=? WHERE order_id=? AND status='pending'").run(now(),o.id);db.prepare("UPDATE order_followups SET stage='cancelled',updated_at=? WHERE order_id=?").run(now(),o.id);log(o,actor,'cancel','未发货取消并恢复库存');return o.id;
 }
 if(o.fulfillment_status!=='shipped')throw new InputError('订单尚未发货');
 const s=db.prepare('SELECT * FROM shipments WHERE id=? AND order_id=?').get(int(input.shipment_id,'包裹',1),o.id);if(!s)throw new InputError('包裹不属于此订单',404);
 const at=happened(input.occurred_at);if(s.shipped_at&&Date.parse(at)<Date.parse(s.shipped_at)-300000)throw new InputError('核实时间不能早于发货时间');
 const evidence=text(input.evidence,'核实依据',1000);
 if(action==='collect'){
  if(s.status!=='delivered'||s.collected_at)throw new InputError('仅已签收且未登记代收的包裹可确认代收');
  const n=amount(input.amount,o.cod_currency);if(n!==s.cod_amount)throw new InputError('代收金额须等于此包裹核定代收金额；差异请先联系物流商核实');
  db.prepare('UPDATE shipments SET collected_amount=?,collected_at=?,updated_at=? WHERE id=?').run(n,at,now(),s.id);
 }else if(action==='restock'){
  if(s.status!=='returned'||s.restocked_at||input.confirmed!=='1')throw new InputError('仅已退回、未入库且已验收的包裹可恢复库存');
  const items=db.prepare('SELECT si.order_item_id,si.quantity,oi.variant_id FROM shipment_items si JOIN order_items oi ON oi.id=si.order_item_id WHERE shipment_id=?').all(s.id);if(!items.length)throw new InputError('包裹尚未分配商品，不能恢复库存');
  for(const i of items){const bought=db.prepare('SELECT quantity FROM order_items WHERE id=?').get(i.order_item_id).quantity,restored=db.prepare('SELECT COALESCE(SUM(restocked),0) n FROM service_items WHERE order_item_id=?').get(i.order_item_id).n,warehouse=db.prepare("SELECT COALESCE(SUM(si.quantity),0) n FROM shipment_items si JOIN shipments p ON p.id=si.shipment_id WHERE si.order_item_id=? AND p.restocked_at<>''").get(i.order_item_id).n;if(restored+warehouse+i.quantity>bought)throw new InputError('累计恢复库存超过购买数量');}
  for(const i of items)db.prepare('UPDATE variants SET stock=stock+? WHERE id=?').run(i.quantity,i.variant_id);
  db.prepare('UPDATE shipments SET restocked_at=?,updated_at=? WHERE id=?').run(at,now(),s.id);
 }else{
  const transitions={info_received:['in_transit','exception','refused','returning','delivered'],in_transit:['out_for_delivery','delivered','exception','refused','returning'],out_for_delivery:['delivered','exception','refused','returning'],available_for_pickup:['delivered','exception','refused','returning'],unknown:['in_transit','out_for_delivery','delivered','exception','refused','returning'],exception:['in_transit','out_for_delivery','delivered','refused','returning','returned'],refused:['returning','returned'],returning:['returned']};
  if(!transitions[s.status]?.includes(action))throw new InputError('包裹状态转换无效或已登记');
  db.prepare('UPDATE shipments SET status=?,updated_at=? WHERE id=?').run(action,now(),s.id);
  db.prepare('INSERT INTO shipment_events(shipment_id,status,description,occurred_at,created_at) VALUES(?,?,?,?,?)').run(s.id,action,(shipmentStatuses[action]||action)+'（商家人工核实）',at,now());
 }
 log(o,actor,action,evidence,s.id,at);
 const summary=codSummary(o),completeItems=!db.prepare('SELECT oi.id FROM order_items oi WHERE oi.order_id=? AND oi.quantity<>(SELECT COALESCE(SUM(si.quantity),0) FROM shipment_items si WHERE si.order_item_id=oi.id) LIMIT 1').get(o.id);if(summary.delivered===summary.packages&&summary.packages&&completeItems)db.prepare("UPDATE orders SET delivered_at=CASE WHEN delivered_at='' THEN ? ELSE delivered_at END WHERE id=?").run(at,o.id);
 return o.id;
});}
export function remitCod(input,actor){return transaction(()=>{
 const o=codOrder(input.order_id),currency=text(input.currency,'币种',3);if(currency!==o.cod_currency)throw new InputError('回款币种须与核定代收币种一致');
 if(input.confirmed!=='1')throw new InputError('请人工核实到账');
 const gross=amount(input.gross,currency),fee=amount(input.fee||'0',currency,true);if(fee>gross)throw new InputError('扣费不能超过本次结算金额');
 const at=happened(input.occurred_at),reference=text(input.reference,'回款参考号',150),key=text(input.request_key,'请求标识',100);
 const prior=db.prepare('SELECT * FROM cod_remittances WHERE request_key=?').get(key);if(prior){if(prior.order_id!==o.id||prior.gross!==gross||prior.fee!==fee||prior.reference!==reference)throw new InputError('请求标识冲突',409);return o.id;}
 const balance=codSummary(o);if(gross>balance.outstanding)throw new InputError('结算金额不能超过已核实代收但未回款的金额');
 if(db.prepare('SELECT id FROM cod_remittances WHERE order_id=? AND reference=?').get(o.id,reference))throw new InputError('此回款参考号已登记',409);
 db.prepare('INSERT INTO cod_remittances(order_id,gross,fee,net,currency,reference,occurred_at,actor_id,request_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(o.id,gross,fee,gross-fee,currency,reference,at,actor,key,now());
 const transferCurrency=input.transfer_currency||currency,transfer=amount(input.transfer_net||((gross-fee)/10**currencyMap.get(currency).minor).toFixed(currencyMap.get(currency).minor),transferCurrency,true),transferNote=text(input.transfer_note||'','转款换算依据',2000,false);if(transferCurrency!==currency&&!transferNote)throw new InputError('跨币种私下转款请填写换算与到账依据');if(transferCurrency===currency&&transfer!==gross-fee)throw new InputError('同币种实收与结算减扣费不一致');db.prepare('UPDATE cod_remittances SET transfer_currency=?,transfer_net=?,transfer_note=? WHERE order_id=? AND request_key=?').run(transferCurrency,transfer,transferNote,o.id,key);
 const after=codSummary(o);db.prepare("UPDATE orders SET payment_status=?,paid_at=CASE WHEN ?='paid' AND paid_at='' THEN ? ELSE paid_at END WHERE id=?").run(after.refunded?(after.refunded===after.collected?'refunded':'part_refunded'):after.gross===o.cod_amount?'paid':'partial',after.gross===o.cod_amount?'paid':'partial',at,o.id);
 log(o,actor,'remittance',JSON.stringify({gross,fee,net:gross-fee,currency,reference}),null,at);return o.id;
});}
export function codQueue(o){const s=codSummary(o);if(o.fulfillment_status==='cancelled')return 'cancelled';if(s.exceptions)return 'exception';if(s.outstanding>0)return 'remittance';if(s.collection_pending)return 'collection';if(o.fulfillment_status==='pending')return o.cod_confirmed_at?'dispatch':'confirm';if(s.delivered+s.restocked<s.packages)return 'delivery';return 'done';}
export function codStats(){const totals={confirm:0,dispatch:0,delivery:0,collection:0,remittance:0,exception:0,stale:0};for(const o of db.prepare("SELECT * FROM orders WHERE payment_method='cod' AND fulfillment_status!='cancelled'").all()){const key=codQueue(o);if(key in totals)totals[key]++;if(db.prepare("SELECT id FROM shipments WHERE order_id=? AND status NOT IN('delivered','returned') AND updated_at<? LIMIT 1").get(o.id,new Date(Date.now()-3*86400000).toISOString()))totals.stale++;}return totals;}

export function csvCell(v){let s=String(v??'');if(/^[\s]*[=+\-@]/.test(s))s="'"+s;return '"'+s.replaceAll('"','""')+'"';}
export function exportShipping(ids,actor){
 if(!Array.isArray(ids))ids=[ids];if(!ids.length||ids.length>500)throw new InputError('请选择1至500个订单');
 const rows=[['order_id','recipient','phone','email','country','region','city','address','postal','items','cod_amount','cod_currency','cod_note']];
 for(const id of new Set(ids)){const o=codOrder(id);if(!o.cod_confirmed_at||o.fulfillment_status!=='pending')throw new InputError('仅已确认、待发货的货到付款订单可导出');const a=shippingAddress(o);rows.push([o.id,a.recipient||o.customer_name,a.phone,o.email,a.country,a.region||'',a.city,[a.line,a.line2].filter(Boolean).join(', '),a.postal,db.prepare('SELECT title,variant_label,quantity FROM order_items WHERE order_id=?').all(o.id).map(i=>`${i.title} / ${i.variant_label} × ${i.quantity}`).join('; '), (o.cod_amount/10**currencyMap.get(o.cod_currency).minor).toFixed(currencyMap.get(o.cod_currency).minor),o.cod_currency,o.cod_note]);}
 audit(actor,'cod.export',rows.length-1);return '\ufeff'+rows.map(r=>r.map(csvCell).join(',')).join('\r\n');
}
export function parseCsv(raw){
 if(typeof raw!=='string'||raw.length>1000000)throw new InputError('CSV最多1MB');raw=raw.replace(/^\ufeff/,'');const rows=[];let row=[],cell='',quoted=false;
 for(let i=0;i<raw.length;i++){const c=raw[i];if(c==='"'){if(quoted&&raw[i+1]==='"'){cell+='"';i++;}else if(!quoted&&cell!=='')throw new InputError('CSV引号格式错误');else quoted=!quoted;}else if(c===','&&!quoted){row.push(cell);cell='';}else if((c==='\n'||c==='\r')&&!quoted){if(c==='\r'&&raw[i+1]==='\n')i++;row.push(cell);if(row.some(Boolean))rows.push(row);row=[];cell='';}else cell+=c;}
 if(quoted)throw new InputError('CSV引号未闭合');row.push(cell);if(row.some(Boolean))rows.push(row);return rows;
}
export function importTracking(input,actor){
 const rows=parseCsv(input.csv);const head=rows.shift()||[];if(head.join(',')!=='order_id,tracking_number,carrier,carrier_name')throw new InputError('请使用模板列：order_id,tracking_number,carrier,carrier_name');if(!rows.length||rows.length>500)throw new InputError('每次导入1至500行');
 return rows.map((r,i)=>{try{return transaction(()=>{if(r.length!==4)throw new InputError('列数不正确');const [id,number,carrier,name]=r.map(x=>x.trim());if(!Object.hasOwn(carriers,carrier)||carrier==='other'&&!name)throw new InputError('物流公司代码无效或其他公司缺少名称');const o=codOrder(id);if(o.fulfillment_status==='shipped'&&db.prepare('SELECT id FROM shipments WHERE order_id=? AND tracking_number=? AND carrier=?').get(id,number,carrier))return {row:i+2,id,status:'跳过',message:'相同运单已回填'};dispatchCod(id,number,actor);db.prepare('UPDATE shipments SET carrier=?,carrier_name=? WHERE order_id=? AND tracking_number=?').run(carrier,text(name,'公司名称',80,false),id,number);return {row:i+2,id,status:'成功',message:number};});}catch(err){if(!(err instanceof InputError))throw err;return {row:i+2,id:r[0]||'',status:'失败',message:err.message};}});
}
