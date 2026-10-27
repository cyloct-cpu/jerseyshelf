import {refundSummary} from './aftersales.mjs';
import {db,transaction,now,audit} from './db.mjs';
import {InputError,text} from '../../packages/contracts/validation.mjs';
import {parseCurrencyAmount,currencyMap} from '../../packages/contracts/currencies.mjs';
import {choice,dateInput} from '../../packages/contracts/customers.mjs';
import {event,addTask,customerConfig} from './customers.mjs';
import {enqueueWaAutomatic} from './whatsapp.mjs';
import {enqueueEmail,shippedEmail,refundEmail} from './mailer.mjs';
export function receiptSummary(orderId){return db.prepare("SELECT COALESCE(SUM(CASE kind WHEN 'receipt' THEN amount ELSE -amount END),0) net,COALESCE(SUM(CASE kind WHEN 'refund' THEN amount ELSE 0 END),0) refunded,COUNT(*) count FROM order_receipts WHERE order_id=?").get(orderId);}
export function orderReceipts(orderId){return db.prepare('SELECT r.*,u.name actor_name FROM order_receipts r JOIN users u ON u.id=r.actor_id WHERE order_id=? ORDER BY r.id DESC').all(orderId);}
export function recordReceipt(input,actor){return transaction(()=>{
 const o=db.prepare('SELECT * FROM orders WHERE id=?').get(text(input.order_id,'订单号',80));if(!o)throw new InputError('订单不存在',404);
 if(o.order_kind!=='external')throw new InputError('测试订单不能登记真实收款');
 if(o.payment_method==='cod')throw new InputError('货到付款请使用物流代收与回款登记，不能记为预先收款');
 if(o.fulfillment_status==='cancelled')throw new InputError('已取消订单不能登记收款');
 const kind=choice(input.kind,{receipt:1,refund:1},'收款类型'),currency=text(input.currency,'币种',3);
 if(currency!==o.currency)throw new InputError('请按此订单结算币种记录，其他币种须先核实换算');
 let amount;try{amount=parseCurrencyAmount(input.amount,{minor:currencyMap.get(currency)?.minor??2});}catch{throw new InputError('金额格式或小数位无效');}if(!amount)throw new InputError('金额必须大于0');
 const key=text(input.request_key,'请求标识',100),method=text(input.method,'收款方式',100),reference=text(input.reference,'到账/退款参考号',150),occurred=dateInput(input.occurred_at,'到账/退款时间');
 if(Date.parse(occurred)>Date.now()+300000)throw new InputError('到账时间不能在未来');
 const prior=db.prepare('SELECT * FROM order_receipts WHERE request_key=?').get(key);
 if(prior){if(prior.order_id!==o.id||prior.amount!==amount||prior.kind!==kind)throw new InputError('请求标识已用于其他收款记录',409);return o.id;}
 if(input.confirmed!=='1')throw new InputError('请先人工核实实际到账或退款完成');
 const balance=receiptSummary(o.id);
 if(kind==='receipt'&&balance.net+amount>o.total)throw new InputError('累计净收款不能超过订单总额');
 if(kind==='refund'&&amount>balance.net-refundSummary(o.id).total)throw new InputError('退款不能超过尚未退回的实收金额');
 if(db.prepare('SELECT id FROM order_receipts WHERE order_id=? AND kind=? AND reference=?').get(o.id,kind,reference))throw new InputError('此订单已登记相同参考号，请核对是否重复',409);
 db.prepare('INSERT INTO order_receipts(order_id,kind,amount,currency,method,reference,occurred_at,actor_id,request_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(o.id,kind,amount,currency,method,reference,occurred,actor,key,now());
 const next=receiptSummary(o.id),status=refundSummary(o.id).total?(next.net-refundSummary(o.id).total===0?'refunded':'part_refunded'):next.net===o.total?'paid':next.net===0?'refunded':next.refunded?'part_refunded':'partial';
 db.prepare("UPDATE orders SET payment_status=?,paid_at=CASE WHEN ?='paid' AND paid_at='' THEN ? ELSE paid_at END WHERE id=?").run(status,status,now(),o.id);
 if(o.customer_id){event(o.customer_id,'payment',(kind==='receipt'?'核实收款':'核实退款')+' '+currency+' '+input.amount+' / '+method,actor,o.id);
  if(status==='paid')db.prepare("UPDATE customer_tasks SET status='done',result='已核实全额到账',updated_at=? WHERE order_id=? AND kind='payment' AND status='pending'").run(now(),o.id);
  else if(o.fulfillment_status==='pending'){
   addTask(o.customer_id,{kind:'payment',title:'核对订单剩余款项',orderId:o.id,key:'order-payment:'+o.id});
   db.prepare("UPDATE customer_tasks SET status='pending',result='',updated_at=? WHERE dedupe_key=?").run(now(),'order-payment:'+o.id);
  }
 }
 audit(actor,'order.'+kind,o.id);
 if(kind==='refund'){try{enqueueEmail({dedupeKey:'refund:'+key,orderId:o.id,customerId:o.customer_id,...refundEmail(o,input.amount+' '+currency,reference)});}catch{}}
 return o.id;
});}
export function updateExternalOrder(id,action,tracking,actor,deliveredAt=''){return transaction(()=>{
 const o=db.prepare('SELECT * FROM orders WHERE id=?').get(id);if(!o||o.order_kind!=='external')throw new InputError('正式外部收款订单不存在',404);
 if(o.payment_method==='cod')throw new InputError('货到付款请使用专用订单处理流程');
 if(action==='ship'){
  if(o.payment_status!=='paid'||o.fulfillment_status!=='pending')throw new InputError('仅收齐款项且待处理的订单可以发货');
  const trackingValue=text(tracking,'物流单号',150);
  try{enqueueEmail({dedupeKey:'shipped:'+id+':'+trackingValue,orderId:id,customerId:o.customer_id,...shippedEmail(o,trackingValue)});}catch{}
  db.prepare("UPDATE orders SET fulfillment_status='shipped',tracking=? WHERE id=?").run(text(tracking,'物流单号',150),id);
  addTask(o.customer_id,{kind:'delivery',title:'确认订单配送结果',orderId:id,due:new Date(Date.now()+7*86400000).toISOString(),key:'delivery:'+id},actor);
  enqueueWaAutomatic(id,'shipping');
 }else if(action==='delivered'){
  if(o.fulfillment_status!=='shipped'||o.delivered_at)throw new InputError('仅已发货且未确认收货的订单可操作');
  const at=dateInput(deliveredAt,'收货时间');if(Date.parse(at)>Date.now()+300000)throw new InputError('收货时间不能在未来');
  db.prepare('UPDATE orders SET delivered_at=? WHERE id=?').run(at,id);
  db.prepare("UPDATE customer_tasks SET status='done',result='已确认收货',updated_at=? WHERE order_id=? AND kind='delivery'").run(now(),id);
  addTask(o.customer_id,{kind:'review',title:'收货后回访',orderId:id,due:new Date(Date.parse(at)+customerConfig().reviewDays*86400000).toISOString(),key:'review:'+id},actor);
 }else if(action==='cancel'){
  if(o.fulfillment_status!=='pending'||receiptSummary(id).net!==0)throw new InputError('仅未发货且没有待退实收款的订单可取消');
  for(const item of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(id))db.prepare('UPDATE variants SET stock=stock+? WHERE id=?').run(item.quantity,item.variant_id);
  db.prepare("UPDATE orders SET fulfillment_status='cancelled' WHERE id=?").run(id);
  db.prepare("UPDATE customer_tasks SET status='cancelled',result='订单已取消',updated_at=? WHERE order_id=? AND status='pending' AND kind!='aftersale'").run(now(),id);
 }else throw new InputError('不支持的订单操作');
 event(o.customer_id,'order_update',({ship:'已发货',delivered:'已确认收货，安排回访',cancel:'已取消并恢复库存'})[action],actor,id);audit(actor,'order.external_'+action,id);
});}
