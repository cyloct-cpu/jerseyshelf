import {db} from './db.mjs';
import {initializeFollowups} from './aftersales.mjs';
import {codSummary} from './cod.mjs';
export const centerTabs={all:'全部订单',follow:'待确认与跟进',shipping:'发货与物流',money:'代收与回款',aftersales:'售后处理'};
export const centerFilters={all:{all:'全部订单'},follow:{all:'全部待确认',today:'今日及逾期跟进'},shipping:{all:'全部配送待办',dispatch:'待发货',delivery:'运输中/待签收',exception:'物流异常',stale:'超过3天无更新'},money:{all:'全部资金待办',collection:'签收待核实代收',remittance:'待回款',differences:'差额待处理'},aftersales:{all:'全部售后',review:'待审核',returns:'待退货验收',refunds:'待退款',replacements:'待换货/补发',completed:'已完成/拒绝'}};
export function legacyCenterView(view='all'){
 const mapping={confirm:['follow','all'],follow:['follow','today'],today:['follow','today'],dispatch:['shipping','dispatch'],delivery:['shipping','delivery'],exception:['shipping','exception'],stale:['shipping','stale'],collection:['money','collection'],remittance:['money','remittance'],differences:['money','differences'],review:['aftersales','review'],returns:['aftersales','returns'],refunds:['aftersales','refunds'],replacements:['aftersales','replacements']};return mapping[view]||['all','all'];
}
export function centerSelection(url){const legacy=legacyCenterView(url.searchParams.get('view'));let tab=url.searchParams.get('tab')||legacy[0],filter=url.searchParams.get('filter')||legacy[1];if(!Object.hasOwn(centerTabs,tab))tab='all';if(!Object.hasOwn(centerFilters[tab],filter))filter='all';return {tab,filter,q:(url.searchParams.get('q')||'').trim().toLowerCase()};}
export function centerData(){
 initializeFollowups();const dayEnd=new Date();dayEnd.setTime(Math.floor((Date.now()+8*3600000)/86400000)*86400000+86400000-8*3600000);
 const orders=db.prepare('SELECT * FROM orders ORDER BY created_at DESC').all();
 return orders.map(o=>{const follow=db.prepare('SELECT * FROM order_followups WHERE order_id=?').get(o.id),packages=db.prepare('SELECT * FROM shipments WHERE order_id=?').all(o.id),cases=db.prepare('SELECT * FROM service_cases WHERE order_id=? ORDER BY id DESC').all(o.id),differences=db.prepare("SELECT * FROM reconciliation_cases WHERE order_id=? AND status='open'").all(o.id),cod=o.payment_method==='cod',summary=cod?codSummary(o):null;
 const pending=o.order_kind==='external'&&o.fulfillment_status==='pending',confirmed=cod?!!o.cod_confirmed_at:follow?.stage==='confirmed'||o.payment_status==='paid';
 const flags={confirm:pending&&!confirmed,today:pending&&!confirmed&&follow?.stage!=='cancelled'&&Date.parse(follow?.next_at)<=dayEnd.getTime(),dispatch:pending&&(cod?confirmed:o.payment_status==='paid'),delivery:o.fulfillment_status==='shipped'&&packages.some(p=>!['delivered','returned'].includes(p.status)),exception:packages.some(p=>['exception','refused','returning'].includes(p.status)||p.status==='returned'&&!p.restocked_at),stale:packages.some(p=>!['delivered','returned'].includes(p.status)&&Date.parse(p.updated_at)<Date.now()-3*86400000),collection:cod&&packages.some(p=>p.status==='delivered'&&p.cod_amount>0&&!p.collected_at),remittance:cod&&summary.outstanding>0,differences:differences.length>0};
 return {...o,follow,packages,cases,differences,summary,flags};});
}
export function centerStats(rows=centerData()){return {confirm:rows.filter(o=>o.flags.confirm).length,today:rows.filter(o=>o.flags.today).length,dispatch:rows.filter(o=>o.flags.dispatch).length,exception:rows.filter(o=>o.flags.exception).length,remittance:rows.filter(o=>o.flags.remittance).length,aftersales:rows.reduce((n,o)=>n+o.cases.filter(c=>!['completed','rejected'].includes(c.status)).length,0)};}
export function compatibleCodStats(){const rows=centerData().filter(o=>o.payment_method==='cod');return Object.fromEntries(['confirm','dispatch','delivery','collection','remittance','exception','stale'].map(k=>[k,rows.filter(o=>o.flags[k]).length]));}
export function compatibleServiceStats(){const rows=centerData(),cases=rows.flatMap(o=>o.cases);return {follow:rows.filter(o=>o.flags.today).length,review:cases.filter(c=>c.status==='review').length,returns:cases.filter(c=>['waiting_return','returning','inspecting'].includes(c.status)).length,refunds:cases.filter(c=>c.status==='refund_pending').length,replacements:cases.filter(c=>c.status==='replacement_pending').length,differences:rows.reduce((n,o)=>n+o.differences.length,0)};}
export function selectedCenterRows(rows,{tab,filter,q}){return rows.filter(o=>{
 if(q&&![o.id,o.customer_name,o.email,o.tracking,...o.packages.map(p=>p.tracking_number)].some(v=>String(v||'').toLowerCase().includes(q)))return false;
 if(tab==='follow')return filter==='today'?o.flags.today:o.flags.confirm;
 if(tab==='shipping')return filter==='all'?o.flags.dispatch||o.flags.delivery||o.flags.exception:o.flags[filter];
 if(tab==='money')return filter==='all'?o.flags.collection||o.flags.remittance||o.flags.differences:o.flags[filter];
 return true;
});}
