import {db,now,transaction,audit} from './db.mjs';
import {text,int,InputError} from '../../packages/contracts/validation.mjs';
import {hash} from './security.mjs';
import {parseCurrencyAmount,currencyMap} from '../../packages/contracts/currencies.mjs';

export const carriers={other:'其他物流',yunexpress:'YunExpress',cainiao:'Cainiao',china_post:'China Post',sf:'SF Express',dhl:'DHL',ups:'UPS',fedex:'FedEx',usps:'USPS',royal_mail:'Royal Mail'};
export const shipmentStatuses={info_received:'已出单待揽收',in_transit:'运输中',out_for_delivery:'派送中',available_for_pickup:'待自提',delivered:'已签收',exception:'物流异常',refused:'客户拒收',returning:'退回途中',returned:'包裹已退回',unknown:'等待物流更新'};
export function trackingLink(s){
 const n=encodeURIComponent(s.tracking_number);
 const urls={ups:'https://www.ups.com/track?tracknum=',fedex:'https://www.fedex.com/fedextrack/?trknbr=',usps:'https://tools.usps.com/go/TrackConfirmAction?tLabels=',dhl:'https://www.dhl.com/global-en/home/tracking.html?tracking-id=',royal_mail:'https://www.royalmail.com/track-your-item#/tracking-results/'};
 return (urls[s.carrier]||'https://t.17track.net/en#nums=')+n;
}
export function shipments(orderId){return db.prepare('SELECT * FROM shipments WHERE order_id=? ORDER BY id').all(orderId).map(s=>({...s,items:db.prepare('SELECT si.*,oi.title,oi.variant_label FROM shipment_items si JOIN order_items oi ON oi.id=si.order_item_id WHERE shipment_id=?').all(s.id),events:db.prepare('SELECT * FROM shipment_events WHERE shipment_id=? ORDER BY occurred_at DESC,id DESC').all(s.id)}));}
export function canTrack(order,user,session){return !!(user?.role==='admin'||(user&&order.user_id===user.id)||db.prepare('SELECT 1 FROM guest_order_access WHERE order_id=? AND session_hash=? AND expires>?').get(order.id,session.token_hash,Date.now())||db.prepare('SELECT 1 FROM tracking_access WHERE order_id=? AND session_hash=? AND expires>?').get(order.id,session.token_hash,Date.now()));}
export function lookupTracking(input,session){
 const id=text(input.order_id,'订单号',100).toUpperCase(),contact=text(input.email,'邮箱',254).trim().toLowerCase();
 const o=db.prepare('SELECT id,email FROM orders WHERE id=?').get(id);
 if(!o||hash(o.email.trim().toLowerCase())!==hash(contact))throw new InputError('订单号或邮箱不匹配，请核对后重试',404);
 db.prepare('DELETE FROM tracking_access WHERE expires<?').run(Date.now());
 db.prepare('INSERT INTO tracking_access VALUES(?,?,?) ON CONFLICT(order_id,session_hash) DO UPDATE SET expires=excluded.expires').run(id,session.token_hash,Date.now()+30*60000);
 return id;
}
export function saveShipment(input,actor){return transaction(()=>{
 const orderId=text(input.order_id,'订单号',100),o=db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
 if(!o)throw new InputError('订单不存在',404);
 if(o.fulfillment_status!=='shipped')throw new InputError('请先在订单处理区标记发货，再管理包裹');
 const id=input.shipment_id?int(input.shipment_id,'包裹',1):null,prior=id?db.prepare('SELECT * FROM shipments WHERE id=? AND order_id=?').get(id,orderId):null;
 if(id&&!prior)throw new InputError('包裹不存在',404);
 if(o.payment_method==='cod'&&prior&&(prior.collected_at||prior.restocked_at||['delivered','returned','returning','refused'].includes(prior.status)))throw new InputError('已签收、拒收、退回或已代收包裹不能更改商品与运单，请联系物流商核实');
 let codAmount=0;
 if(o.payment_method==='cod'){
  try{codAmount=parseCurrencyAmount(input.cod_amount,{minor:currencyMap.get(o.cod_currency).minor});}catch{throw new InputError('包裹代收金额无效');}
  const allocated=db.prepare('SELECT COALESCE(SUM(cod_amount),0) n FROM shipments WHERE order_id=? AND id<>?').get(orderId,id||0).n;
  if(allocated+codAmount>o.cod_amount)throw new InputError('所有包裹代收金额不能超过订单核定代收金额');
 }
 const carrier=text(input.carrier,'物流公司',30);if(!Object.hasOwn(carriers,carrier))throw new InputError('物流公司无效');
 const name=text(input.carrier_name||'','物流公司名称',80,false);
 if(carrier==='other'&&!name)throw new InputError('请填写物流公司名称');
 const number=text(input.tracking_number,'物流单号',150);
 if(!/^[A-Za-z0-9][A-Za-z0-9 ._/-]{2,149}$/.test(number))throw new InputError('物流单号格式无效');
 const date=new Date(String(input.shipped_at)+(String(input.shipped_at).endsWith('Z')?'':'Z'));if(!Number.isFinite(date.getTime())||date.getTime()>Date.now()+300000)throw new InputError('发货时间无效或在未来');
 if(db.prepare('SELECT id FROM shipments WHERE order_id=? AND tracking_number=? AND id<>?').get(orderId,number,id||0))throw new InputError('此订单已存在相同运单');
 const items=db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId),selected=[];
 for(const item of items){const raw=input['qty_'+item.id]||'0',qty=int(raw,'包裹商品数量',0,item.quantity);if(!qty)continue;
  const used=db.prepare('SELECT COALESCE(SUM(si.quantity),0) n FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id WHERE s.order_id=? AND si.order_item_id=? AND s.id<>?').get(orderId,item.id,id||0).n;
  if(used+qty>item.quantity)throw new InputError('包裹商品数量合计超过订单数量');selected.push({id:item.id,quantity:qty});
 }
 if(!selected.length)throw new InputError('请为包裹分配至少一件商品');
 const priorItems=prior?db.prepare('SELECT order_item_id,quantity FROM shipment_items WHERE shipment_id=?').all(id):[];
 const changed=prior&&(prior.tracking_number!==number||prior.carrier!==carrier||prior.carrier_name!==name),at=now();
 let sid=id;
 if(id){db.prepare('UPDATE shipments SET carrier=?,carrier_name=?,tracking_number=?,shipped_at=?,updated_at=? WHERE id=?').run(carrier,name,number,date.toISOString(),at,id);
  if(changed){db.prepare("UPDATE shipments SET status='info_received',provider='manual',provider_reference='',sync_status='not_connected',last_synced_at='',sync_error='' WHERE id=?").run(id);db.prepare('DELETE FROM shipment_events WHERE shipment_id=?').run(id);}
 }else sid=Number(db.prepare('INSERT INTO shipments(order_id,carrier,carrier_name,tracking_number,shipped_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(orderId,carrier,name,number,date.toISOString(),at,at).lastInsertRowid);
 db.prepare('DELETE FROM shipment_items WHERE shipment_id=?').run(sid);for(const item of selected)db.prepare('INSERT INTO shipment_items VALUES(?,?,?)').run(sid,item.id,item.quantity);
 if(o.payment_method==='cod')db.prepare('UPDATE shipments SET cod_amount=? WHERE id=?').run(codAmount,sid);
 db.prepare('INSERT INTO shipment_changes(shipment_id,actor_id,before_json,after_json,created_at) VALUES(?,?,?,?,?)').run(sid,actor,JSON.stringify(prior?{...prior,items:priorItems}:{}),JSON.stringify({carrier,carrier_name:name,tracking_number:number,shipped_at:date.toISOString(),cod_amount:codAmount,items:selected}),at);
 const first=db.prepare('SELECT tracking_number FROM shipments WHERE order_id=? ORDER BY id LIMIT 1').get(orderId);db.prepare('UPDATE orders SET tracking=? WHERE id=?').run(first.tracking_number,orderId);
 audit(actor,id?'shipment.update':'shipment.create',sid);return orderId;
});}

// Legacy dispatch actions still create a package, pending carrier and item assignment.
export function ensureShipment(orderId,number){
 if(!number)return;
 const result=db.prepare("INSERT OR IGNORE INTO shipments(order_id,tracking_number,shipped_at,created_at,updated_at) VALUES(?,?,?,?,?)").run(orderId,number,now(),now(),now());
 if(result.changes){
  for(const item of db.prepare('SELECT * FROM order_items WHERE order_id=?').all(orderId)){
   const allocated=db.prepare('SELECT COALESCE(SUM(si.quantity),0) n FROM shipment_items si JOIN shipments s ON s.id=si.shipment_id WHERE s.order_id=? AND si.order_item_id=?').get(orderId,item.id).n;
   if(item.quantity>allocated)db.prepare('INSERT INTO shipment_items VALUES(?,?,?)').run(result.lastInsertRowid,item.id,item.quantity-allocated);
  }
 }
}
