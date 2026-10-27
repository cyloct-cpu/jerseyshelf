import {db,now,putSetting,transaction} from './db.mjs';
import {waConfig,waCredentials} from './whatsapp-config.mjs';
import {permitted,waOrder,orderWaPermitted} from './whatsapp.mjs';
import {sendWaTemplate} from './whatsapp-provider.mjs';
import {reconcileWaReceipt} from './whatsapp-receipts.mjs';
function recoverStale(){db.prepare("UPDATE whatsapp_messages SET status='unknown',last_error='提交超时或服务重启，发送结果需核实，不自动重发',updated_at=? WHERE status='sending' AND updated_at<?").run(now(),new Date(Date.now()-60000).toISOString());}
let busy=false,timer;
export async function processWaQueue({send=sendWaTemplate}={}){if(busy)return;recoverStale();const c=waConfig();if(c.mode!=='cloud'||!c.live)return;busy=true;try{const message=transaction(()=>{const row=db.prepare("SELECT * FROM whatsapp_messages WHERE status='queued' AND next_attempt<=? ORDER BY created_at LIMIT 1").get(Date.now());if(!row)return null;return db.prepare("UPDATE whatsapp_messages SET status='sending',attempts=attempts+1,updated_at=? WHERE id=? AND status='queued'").run(now(),row.id).changes?row:null;});if(!message)return;
 let payload;try{payload=JSON.parse(message.payload);const order=waOrder(message.order_id);if(order.order_kind!=='external'||order.fulfillment_status==='cancelled'||!orderWaPermitted(order,message.phone))throw new Error();if(!c.checkedAt||Date.now()-Date.parse(c.checkedAt)>86400000||payload.revision!==c.revision)throw new Error();const current=c.templates[message.kind];if(JSON.stringify(current)!==JSON.stringify(payload.template))throw new Error();}catch{db.prepare("UPDATE whatsapp_messages SET status='cancelled',last_error='订单、许可或模板状态已变化，请重新核对',updated_at=? WHERE id=?").run(now(),message.id);return;}
 try{const id=await send(c,waCredentials(),payload);transaction(()=>{db.prepare("UPDATE whatsapp_messages SET status='accepted',platform_id=?,last_error='',updated_at=? WHERE id=?").run(id,now(),message.id);reconcileWaReceipt(id);});const latest=waConfig();putSetting('whatsapp',{...latest,lastSentAt:now()});}
 catch(err){const retry=err.kind==='rate'&&message.attempts<2;db.prepare('UPDATE whatsapp_messages SET status=?,last_error=?,next_attempt=?,updated_at=? WHERE id=?').run(retry?'queued':err.kind==='unknown'?'unknown':'failed',err.kind==='rate'?'接口限流':err.kind==='unknown'?'发送结果不确定，请人工核实，未自动重发':'发送失败，请检查账号和模板',retry?Date.now()+60000:0,now(),message.id);}
 }finally{busy=false;}}
export function startWaWorker(){if(timer)return;recoverStale();if(process.env.WHATSAPP_AUTO_UPDATE==='false')return;timer=setInterval(()=>processWaQueue().catch(()=>{}),3000);timer.unref();}
