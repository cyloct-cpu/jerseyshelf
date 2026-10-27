import {serviceRules} from './aftersales.mjs';
import {dispatchCod,codAction} from './cod.mjs';
import { db, now, settings, transaction, audit } from './db.mjs';
import { random, hash } from './security.mjs';
import { text, int, InputError } from '../../packages/contracts/validation.mjs';
import { resolveProductCustomization } from './customization.mjs';
import { settleQuote } from './currencies.mjs';
import { convertCart } from '../../packages/contracts/currencies.mjs';
import { quantityDiscount } from '../../packages/contracts/promotions.mjs';
import { checkoutFields } from '../../packages/contracts/checkout.mjs';
import {linkOrderCustomer,customerConfig} from './customers.mjs';
import {updateExternalOrder} from './customer-payments.mjs';
import {captureWaOrder} from './whatsapp.mjs';
import {rememberShippingAddress} from './shipping-address.mjs';

export function createDirectPurchase(session,input){
  const [line]=addCartLine([],input),id=random(24);
  db.prepare('INSERT INTO direct_purchases(id,session_hash,line,expires,created_at) VALUES(?,?,?,?,?)').run(id,session.token_hash,JSON.stringify(line),Date.now()+30*60000,now());
  return id;
}
export function directPurchase(session,id){
  if(typeof id!=='string'||!/^[a-f0-9]{48}$/.test(id))throw new InputError('购买记录不存在',404);
  const purchase=db.prepare('SELECT * FROM direct_purchases WHERE id=? AND session_hash=?').get(id,session.token_hash);
  if(!purchase)throw new InputError('购买记录不存在',404);
  if(!purchase.order_id&&purchase.expires<Date.now())throw new InputError('购买记录已过期，请返回商品页重新选择');
  return {...purchase,line:JSON.parse(purchase.line)};
}
export function checkoutSelection(session,id){
  const purchase=id!==undefined?directPurchase(session,id):null;
  return {purchase,source:purchase?'purchase:'+purchase.id:'cart',cart:cartSummary(purchase?[purchase.line]:JSON.parse(session.cart))};
}
export function cartLineKey(line){return String(line.variantId)+':'+hash(JSON.stringify([line.customization?.printingName||'',(line.customization?.patches||[]).map(p=>p.id).sort()])).slice(0,20);}
export function addCartLine(cart,input){
  const variantId=int(input.variantId,'规格',1),quantity=int(input.quantity,'数量',1,99);
  const product=db.prepare('SELECT p.id,p.customization,p.customization_mode,p.customization_template FROM products p JOIN variants v ON v.product_id=p.id WHERE v.id=?').get(variantId);
  if(!product)throw new InputError('商品规格不存在');
  const line={variantId,quantity,customization:resolveProductCustomization(product,input)},key=cartLineKey(line),existing=cart.find(i=>cartLineKey(i)===key);
  if(existing){existing.quantity=int(existing.quantity+quantity,'数量',1,99);existing.customization=line.customization;}else cart.push(line);
  const summary=cartSummary(cart);if(summary.items.some(i=>!i.available))throw new InputError('商品已下架、定制选项已更改或库存不足');
  return cart;
}
export function changeCartLine(cart,input){
  let target;
  if(input.lineKey!==undefined)target=cart.find(i=>cartLineKey(i)===input.lineKey);
  else{const id=int(input.variantId,'规格',1),matches=cart.filter(i=>i.variantId===id);if(matches.length>1)throw new InputError('请指定要更新的定制商品');target=matches[0];}
  if(!target)throw new InputError('购物车条目不存在');
  const quantity=input.remove==='1'?0:int(input.quantity,'数量',0,99),key=cartLineKey(target);
  if(!quantity)return cart.filter(i=>cartLineKey(i)!==key);
  target.quantity=quantity;return cart;
}
export function cartSummary(cart) {
  if(!Array.isArray(cart)||cart.length>100)throw new InputError('购物车格式错误');
  const items=cart.map(line=>{
    const variantId=int(line.variantId,'规格',1); const quantity=int(line.quantity,'数量',1,99);
    const v=db.prepare('SELECT v.*,p.title,p.slug,p.images,p.customization product_customization,p.customization_mode,p.customization_template,p.active product_active FROM variants v JOIN products p ON p.id=v.product_id WHERE v.id=?').get(variantId);
    if(!v)throw new InputError('商品规格已不存在');
    let customization,selectionError='';
    try{customization=resolveProductCustomization({id:v.product_id,customization:v.product_customization,customization_mode:v.customization_mode,customization_template:v.customization_template},{printingName:line.customization?.printingName||'',patchIds:(line.customization?.patches||[]).map(p=>p.id)});}catch(err){if(!(err instanceof InputError))throw err;customization=line.customization;selectionError='定制选项已更改，请移除后重新选择';}
    const price=v.price+(customization?.extraPrice||0);
    return {...v,price,basePrice:v.price,variantId,quantity,customization,lineKey:cartLineKey(line),selectionError,images:JSON.parse(v.images),available:!!(v.active&&v.product_active&&!selectionError&&v.stock>=quantity),lineTotal:price*quantity};
  });
  const totals=new Map();for(const i of items)totals.set(i.variantId,(totals.get(i.variantId)||0)+i.quantity);
  for(const i of items)if(i.stock<totals.get(i.variantId))i.available=false;
  const subtotal=items.reduce((sum,i)=>sum+i.lineTotal,0); const quantity=items.reduce((sum,i)=>sum+i.quantity,0);
  const {site,quantity_promotion}=settings();
  const shipping=quantity===0||quantity>=site.freeShippingQty?0:site.shipping;
  const {discount,promotion}=quantityDiscount(quantity,subtotal,quantity_promotion);
  return {items,subtotal,discount,promotion,shipping,total:subtotal-discount+shipping,quantity};
}
export function createOrder(input, session, user,selectedCurrency='USD') {
  const key=hash(session.token_hash+(typeof input.purchase==='string'?'purchase:'+input.purchase+':':'')+text(input.checkoutKey,'订单请求标识',100));
  return transaction(()=>{
    const purchase=input.purchase!==undefined?directPurchase(session,input.purchase):null;
    // Completion is tied to the purchase, not a key regenerated by page refresh.
    if(purchase?.order_id)return purchase.order_id;
    const existing=db.prepare('SELECT id FROM orders WHERE idempotency_key=?').get(key);
    if(existing)return existing.id;
    const mode=customerConfig().orderMode,fields=checkoutFields(input,{cod:mode==='cod'}),contact=fields.email,name=fields.name;
    const address={country:fields.country,region:fields.region,city:fields.city,line:fields.address,line2:fields.address2,postal:fields.postal,phone:fields.phone};
    const cart=cartSummary(purchase?[purchase.line]:JSON.parse(session.cart));
    if(!cart.items.length)throw new InputError('购物车为空');
    if(cart.items.some(i=>!i.available))throw new InputError('部分商品已下架或库存不足，请更新购物车');
    const fx=settleQuote(input,session,cart,selectedCurrency,purchase?'purchase:'+purchase.id:'cart'),settled=convertCart(cart,fx);
    const id='BW-'+Date.now().toString(36).toUpperCase()+'-'+random(4).toUpperCase();
    db.prepare('INSERT INTO orders(id,user_id,email,customer_name,address,subtotal,shipping,total,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(id,user?.id||null,contact,name,JSON.stringify(address),settled.subtotal,settled.shipping,settled.total,key,now());
    db.prepare('UPDATE orders SET currency=?,fx_rate=?,fx_date=?,fx_source=?,base_subtotal=?,base_shipping=?,base_total=? WHERE id=?').run(fx.currency,fx.rate,fx.date,fx.source,cart.subtotal,cart.shipping,cart.total,id);
    db.prepare('UPDATE orders SET discount=?,base_discount=?,discount_snapshot=? WHERE id=?').run(settled.discount,cart.discount,JSON.stringify(cart.promotion||{}),id);
    db.prepare('UPDATE orders SET note=? WHERE id=?').run(fields.note,id);
    for(const [index,i] of settled.items.entries()){
      const r=db.prepare('UPDATE variants SET stock=stock-? WHERE id=? AND stock>=? AND active=1').run(i.quantity,i.id,i.quantity);
      if(r.changes!==1)throw new InputError('库存不足');
      db.prepare('INSERT INTO order_items(order_id,variant_id,title,variant_label,sku,unit_price,quantity,customization,base_unit_price) VALUES(?,?,?,?,?,?,?,?,?)').run(id,i.id,i.title,i.label,i.sku,i.price,i.quantity,JSON.stringify(i.customization||{}),cart.items[index].price);
    }
    db.prepare('INSERT INTO guest_order_access(order_id,session_hash,expires) VALUES(?,?,?)').run(id,session.token_hash,Date.now()+7*24*60*60*1000);
    if(purchase)db.prepare('UPDATE direct_purchases SET order_id=? WHERE id=?').run(id,purchase.id);
    else db.prepare('UPDATE sessions SET cart=? WHERE token_hash=?').run('[]',session.token_hash);
    db.prepare('UPDATE orders SET order_kind=? WHERE id=?').run(mode==='test'?'test':'external',id);
    if(mode==='cod')db.prepare("UPDATE orders SET payment_method='cod',cod_amount=?,cod_currency=? WHERE id=?").run(settled.total,fx.currency,id);
    if(mode==='online')db.prepare("UPDATE orders SET payment_method='online' WHERE id=?").run(id);
    linkOrderCustomer(id);
    if(mode!=='test')db.prepare('INSERT OR IGNORE INTO order_followups(order_id,next_at,updated_at) VALUES(?,?,?)').run(id,new Date(Date.now()+serviceRules().followHours*3600000).toISOString(),now());
    captureWaOrder(id,fields.whatsapp_phone,fields.whatsapp_consent,fields.whatsapp_locale);
    rememberShippingAddress(user,fields);
    return id;
  });
}
export function getOrder(id) {
  const order=db.prepare('SELECT * FROM orders WHERE id=?').get(id);
  if(!order)return null;
  return {...order,address:JSON.parse(order.address),items:db.prepare('SELECT * FROM order_items WHERE order_id=?').all(id)};
}
export function canReadOrder(order, user, session) {
  return !!(user?.role==='admin'||(user && order.user_id===user.id)||db.prepare('SELECT order_id FROM guest_order_access WHERE order_id=? AND session_hash=? AND expires>?').get(order.id,session.token_hash,Date.now()));
}
export function updateOrder(id, action, tracking, user, deliveredAt='') {
  const existing=db.prepare('SELECT order_kind,payment_method FROM orders WHERE id=?').get(id);
  if(existing?.payment_method==='cod'){if(action==='ship')return dispatchCod(id,tracking,user);if(action==='cancel')return codAction({order_id:id,action},user);throw new InputError('货到付款请在包裹签收与代收区操作');}
  if(existing?.order_kind==='external')return updateExternalOrder(id,action,tracking,user,deliveredAt);
  return transaction(()=>{
    const o=getOrder(id); if(!o)throw new InputError('订单不存在',404);
    if(action==='test-pay'){
      if(o.payment_status!=='unpaid'||o.fulfillment_status!=='pending')throw new InputError('此订单不能模拟付款');
      db.prepare("UPDATE orders SET payment_status='test_paid' WHERE id=?").run(id);
    }else if(action==='ship'){
      if(o.payment_status!=='test_paid'||o.fulfillment_status!=='pending')throw new InputError('仅已模拟付款且待发货的订单可以发货');
      db.prepare("UPDATE orders SET fulfillment_status='shipped',tracking=? WHERE id=?").run(text(tracking,'物流单号',150),id);
    }else if(action==='cancel'){
      if(o.fulfillment_status!=='pending'||o.payment_status!=='unpaid')throw new InputError('仅未付款且待处理订单可以取消');
      for(const i of o.items)db.prepare('UPDATE variants SET stock=stock+? WHERE id=?').run(i.quantity,i.variant_id);
      db.prepare("UPDATE orders SET fulfillment_status='cancelled' WHERE id=?").run(id);
    }else if(action==='test-refund'){
      if(o.payment_status!=='test_paid'||o.fulfillment_status!=='pending')throw new InputError('仅尚未发货的模拟付款订单可以模拟退款');
      for(const i of o.items)db.prepare('UPDATE variants SET stock=stock+? WHERE id=?').run(i.quantity,i.variant_id);
      db.prepare("UPDATE orders SET payment_status='test_refunded',fulfillment_status='cancelled' WHERE id=?").run(id);
    }else throw new InputError('不支持的订单操作');
    audit(user,'order.'+action,id);
  });
}
