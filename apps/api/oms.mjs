import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { db, putSetting, audit, transaction, now } from './db.mjs';
import { config } from './config.mjs';
import { InputError, text, int } from '../../packages/contracts/validation.mjs';

// ---------- 配置与密钥封存 ----------
const keyFile = path.join(path.dirname(config.dbPath), 'oms-credentials.key');
function secretKey(create = false) {
  if (!existsSync(keyFile)) { if (!create) throw new Error('OMS 密钥文件缺失'); writeFileSync(keyFile, randomBytes(32), { mode: 0o600 }); }
  return readFileSync(keyFile);
}
function seal(value) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secretKey(true), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function unseal(value) {
  try {
    const raw = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', secretKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch { throw new InputError('OMS 密钥无法读取，请在后台重新配置', 503); }
}
// settings 键 oms：{enabled,baseUrl,customerCode,customerPwd(sealed),defaultOgId,defaultServiceCode,defaultWeightKg,codRemindDays}
export function omsConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key='oms'").get();
  const s = row ? JSON.parse(row.value) : {};
  return {
    enabled: s.enabled === true,
    baseUrl: s.baseUrl || '',
    customerCode: s.customerCode || '',
    hasCustomerPwd: !!s.customerPwd,
    insecureHttp: (s.baseUrl || '').startsWith('http://'),
    defaultOgId: s.defaultOgId || 7,
    defaultServiceCode: s.defaultServiceCode || '',
    defaultWeightKg: s.defaultWeightKg || 0.3,
    codRemindDays: s.codRemindDays || 14
  };
}
function creds() {
  const row = db.prepare("SELECT value FROM settings WHERE key='oms'").get();
  const s = row ? JSON.parse(row.value) : {};
  return { baseUrl: (s.baseUrl || '').replace(/\/+$/, ''), customerCode: s.customerCode || '', customerPwd: s.customerPwd ? unseal(s.customerPwd) : '', cfg: s };
}
export function saveOmsConfig(input, actor) {
  const row = db.prepare("SELECT value FROM settings WHERE key='oms'").get();
  const s = row ? JSON.parse(row.value) : {};
  const baseUrl = text(input.base_url || '', '服务地址', 200, false).trim().replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\/[A-Za-z0-9.-]+(:\d+)?$/.test(baseUrl)) throw new InputError('服务地址格式无效（仅支持 http(s)://域名[:端口]）');
  const value = {
    enabled: input.enabled === '1',
    baseUrl,
    customerCode: text(input.customer_code || '', '客户代码', 100, false).trim(),
    customerPwd: input.clear_pwd === '1' ? undefined : (typeof input.customer_pwd === 'string' && input.customer_pwd.trim() ? seal(input.customer_pwd.trim()) : s.customerPwd),
    defaultOgId: int(input.default_og_id || 7, '发货仓库', 1, 99999),
    defaultServiceCode: text(input.default_service_code || '', '默认渠道代码', 100, false).trim(),
    defaultWeightKg: Number(input.default_weight_kg) > 0 ? Math.round(Number(input.default_weight_kg) * 100) / 100 : 0.3,
    codRemindDays: int(input.cod_remind_days || 14, '签收回款提醒', 1, 365)
  };
  if (value.enabled && (!value.baseUrl || !value.customerCode || !value.customerPwd)) throw new InputError('开启对接前需填写服务地址、客户代码与密码');
  putSetting('oms', value);
  audit(actor, 'oms.config', value.enabled ? 'enabled' : 'disabled');
  return omsConfig();
}

// ---------- OMS HTTP 客户端（统一响应 {Code,Msg,Data,Data2}：1=成功 0=失败 2=参考单号已存在按成功） ----------
async function callOms(apiPath, body, fetcher = fetch) {
  const c = creds();
  if (!omsConfig().enabled || !c.baseUrl || !c.customerCode || !c.customerPwd) throw new InputError('OMS 对接未配置或未开启', 503);
  let response;
  try {
    response = await fetcher(c.baseUrl + apiPath, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ customer_code: c.customerCode, customer_pwd: c.customerPwd, ...body }),
      signal: AbortSignal.timeout(20000), redirect: 'error', cache: 'no-store'
    });
  } catch (err) {
    throw new InputError('OMS 接口连接失败：' + (err?.name === 'TimeoutError' ? '请求超时' : '网络错误'), 502);
  }
  if (!response.ok) throw new InputError('OMS 接口 HTTP ' + response.status, 502);
  const payload = await response.json().catch(() => { throw new InputError('OMS 接口返回格式错误', 502); });
  const code = Number(payload.Code ?? 0);
  if (code === 0) throw new InputError('OMS 拒绝：' + (payload.Msg || '未知错误'), 502);
  return { code, msg: String(payload.Msg || ''), data: payload.Data ?? payload, data2: payload.Data2 };
}
export const omsGetShippingMethods = (fetcher) => callOms('/api/OMSAPI/getShippingMethod', {}, fetcher);
export const omsGetWarehouses = (fetcher) => callOms('/api/OMSAPI/GetWarehouse', {}, fetcher);
export const omsCreateDirectOrder = (payload, fetcher) => callOms('/api/OMSAPI/CreateLogisticsOrder', payload, fetcher);
export const omsGetTrackingNumber = (number, fetcher) => callOms('/api/OMSAPI/GetTrackingNumber', { number }, fetcher);
export const omsGetOrderTrack = (numbers, fetcher) => callOms('/api/OMSAPI/GetOrderTrack', { number: numbers.join(',') }, fetcher);
export const omsCancelOrder = (refNumber, fetcher) => callOms('/api/OMSAPI/CancelOrder', { order_ids: '', ref_number: refNumber, delete_type: 'ref_number' }, fetcher);

// ---------- 下单 payload（reference_no=订单号幂等） ----------
export function buildOmsOrderPayload(order, items, cfg, fetcher) {
  const ship = order.shipping_address ? JSON.parse(order.shipping_address) : JSON.parse(order.address);
  const phone = String(ship.phone || '').trim();
  if (!phone) throw new InputError('收件人电话缺失（OMS 必填），请先完善发货资料');
  const totalQty = items.reduce((s, i) => s + i.quantity, 0) || 1;
  const isCod = order.payment_method === 'cod';
  return {
    order_type: 'A',
    reference_no: order.id,
    shipping_method: cfg.defaultServiceCode,
    shipping_method_no: '',
    country_code: String(ship.country || order.country || '').slice(0, 2).toUpperCase(),
    order_weight: Math.round(cfg.defaultWeightKg * totalQty * 100) / 100,
    platform: '自建站',
    shop: 'jerseyshelf',
    order_pieces: 1,
    og_id: String(cfg.defaultOgId),
    rmk: String(order.note || '').slice(0, 200),
    COD: isCod ? Number((order.cod_amount / 100).toFixed(2)) : 0,
    label_title: 'JERSEYSHELF',
    order_source: 'jerseyshelf',
    print_phd: false,
    Consignee: {
      consignee_company: '',
      consignee_province: String(ship.region || ship.city || '').slice(0, 80),
      consignee_city: String(ship.city || '').slice(0, 80),
      consignee_district: '',
      consignee_street: String(ship.line || '').slice(0, 200),
      consignee_street2: String(ship.line2 || '').slice(0, 200),
      consignee_street3: '',
      consignee_postcode: String(ship.postal || '').slice(0, 20),
      consignee_name: String(ship.recipient || order.customer_name || '').slice(0, 60),
      consignee_telephone: phone,
      consignee_email: String(order.email || '').slice(0, 100),
      consignee_certificatetype: '', consignee_certificatecode: '', consignee_credentials_period: '', buyer_id: '', consignee_doorplate: '', consignee_taxno: ''
    },
    ItemArr: items.map(i => {
      const custom = typeof i.customization === 'string' ? JSON.parse(i.customization || '{}') : (i.customization || {});
      return {
        invoice_enname: String(i.title || 'Jersey').slice(0, 100),
        invoice_cnname: '服装',
        invoice_weight: cfg.defaultWeightKg,
        invoice_quantity: i.quantity,
        invoice_unitcharge: Number(((i.base_unit_price || i.unit_price) / 100).toFixed(2)),
        invoice_currencycode: 'USD',
        hs_code: '',
        invoice_note: [custom.printingName ? 'custom:' + custom.printingName : '', Array.isArray(custom.patches) && custom.patches.length ? 'patch:' + custom.patches.map(p => p.id ?? p).join('|') : ''].filter(Boolean).join(' '),
        invoice_url: '', sku: String(i.sku || ''), image: ''
      };
    })
  };
}

// ---------- 队列 ----------
export function enqueueOms(orderId, op, actorId = null, payload = {}) {
  if (!['create', 'track', 'cancel', 'block', 'label'].includes(op)) throw new InputError('未知队列操作');
  const dup = db.prepare("SELECT id FROM oms_queue WHERE order_id=? AND op=? AND status='pending'").get(orderId, op);
  if (dup) return dup.id;
  return Number(db.prepare("INSERT INTO oms_queue(order_id,op,payload,status,actor_id,created_at,updated_at) VALUES(?,?,?,'pending',?,?,?)").run(orderId, op, JSON.stringify(payload), actorId, now(), now()).lastInsertRowid);
}
export function omsQueueStatus() {
  return db.prepare("SELECT status,COUNT(*) n FROM oms_queue GROUP BY status").all();
}
export function omsQueueRows() {
  return db.prepare('SELECT q.*,u.name actor_name FROM oms_queue q LEFT JOIN users u ON u.id=q.actor_id ORDER BY q.id DESC LIMIT 60').all();
}

// ---------- OMS 轨迹状态 → 本站包裹状态 ----------
export function omsTrackToShipmentStatus(zhStatus) {
  const s = String(zhStatus || '');
  if (/已签收/.test(s)) return 'delivered';
  if (/拒收/.test(s)) return 'refused';
  if (/已退回|退回完成/.test(s)) return 'returned';
  if (/退件|退回|退回途中/.test(s)) return 'returning';
  if (/丢件|销毁|异常/.test(s)) return 'exception';
  if (/派送中|派送/.test(s)) return 'out_for_delivery';
  if (/待取件|自提/.test(s)) return 'available_for_pickup';
  if (/已上网|转运|到达|已出库|运输/.test(s)) return 'in_transit';
  if (/已揽收|已收件|已预报/.test(s)) return 'info_received';
  return 'unknown';
}
function applyShipmentStatus(shipmentId, status) {
  db.prepare('UPDATE shipments SET status=?,sync_status=\'ok\',last_synced_at=?,updated_at=? WHERE id=?').run(status, now(), now(), shipmentId);
}
function recordShipmentEvents(shipmentId, provider, events) {
  // 事件以 (shipment_id, provider_event_id) 幂等入库，provider_event_id 用 provider+时间+内容摘要。
  for (const ev of events || []) {
    const id = provider + ':' + String(ev.time || '') + ':' + String(ev.content || ev.description || '').slice(0, 60);
    db.prepare('INSERT OR IGNORE INTO shipment_events(shipment_id,provider_event_id,status,description,location,occurred_at,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(shipmentId, id, ev.status || 'unknown', String(ev.content || ev.description || ''), String(ev.location || ''), ev.time ? new Date(ev.time.includes('T') ? ev.time : ev.time.replace(' ', 'T') + 'Z').toISOString() : now(), now());
  }
}
function linkShipment(orderId, trackingNumber, omsOrderNumber) {
  const existing = db.prepare('SELECT * FROM shipments WHERE order_id=? AND tracking_number=?').get(orderId, trackingNumber);
  let shipmentId;
  if (existing) shipmentId = existing.id;
  else {
    const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    shipmentId = Number(db.prepare("INSERT INTO shipments(order_id,carrier,carrier_name,tracking_number,shipped_at,status,provider,provider_reference,sync_status,created_at,updated_at) VALUES(?,'other','OMS',?,?, 'info_received','oms',?,'pending',?,?)").run(orderId, trackingNumber, order && !order.tracking ? now() : (order?.shipped_at || now()), omsOrderNumber, now(), now()).lastInsertRowid);
    const items = db.prepare('SELECT id,quantity FROM order_items WHERE order_id=?').all(orderId);
    for (const item of items) db.prepare('INSERT OR IGNORE INTO shipment_items(shipment_id,order_item_id,quantity) VALUES(?,?,?)').run(shipmentId, item.id, item.quantity);
  }
  db.prepare("UPDATE shipments SET provider='oms',provider_reference=?,sync_status='ok',last_synced_at=?,updated_at=? WHERE id=?").run(omsOrderNumber, now(), now(), shipmentId);
  db.prepare("UPDATE orders SET fulfillment_status='shipped',tracking=CASE WHEN tracking='' THEN ? ELSE tracking END WHERE id=? AND fulfillment_status='pending'").run(trackingNumber, orderId);
  db.prepare('UPDATE oms_orders SET tracking_number=?,updated_at=? WHERE order_id=?').run(trackingNumber, now(), orderId);
  return shipmentId;
}

// ---------- 队列处理 ----------
const RETRY_DELAYS = [30000, 120000, 600000, 3600000, 14400000];
async function runJob(job, fetcher) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(job.order_id);
  if (!order) throw new InputError('订单不存在');
  if (job.op === 'create') {
    const cfg = omsConfig();
    const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(job.order_id);
    const payload = buildOmsOrderPayload(order, items, cfg, fetcher);
    const result = await omsCreateDirectOrder(payload, fetcher);
    const data = result.data || {};
    db.prepare("INSERT INTO oms_orders(order_id,oms_order_number,tracking_number,status,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(order_id) DO UPDATE SET oms_order_number=excluded.oms_order_number,updated_at=excluded.updated_at")
      .run(job.order_id, String(data.order_number || data.order_id || data.order_code || ''), String(data.tracking_number || ''), 'created', now(), now());
    if (data.label_url || data.label) db.prepare("INSERT INTO oms_labels(order_id,tracking_number,url,fetched_at) VALUES(?,?,?,?) ON CONFLICT(order_id,tracking_number) DO UPDATE SET url=excluded.url,fetched_at=excluded.fetched_at").run(job.order_id, String(data.tracking_number || ''), String(data.label_url || data.label), now());
    // 异步取号：跟一个 track 任务，由定时器轮询补拉运单号。
    if (!data.tracking_number) enqueueOms(job.order_id, 'track', job.actor_id);
    else linkShipment(job.order_id, String(data.tracking_number), String(data.order_number || ''));
    return;
  }
  if (job.op === 'track') {
    const rec = db.prepare('SELECT * FROM oms_orders WHERE order_id=?').get(job.order_id);
    const result = await omsGetTrackingNumber(rec?.oms_order_number || job.order_id, fetcher);
    const data = result.data || {};
    const tracking = String(data.tracking_number || data.number || data.oriNumber || '');
    if (!tracking) throw new InputError('OMS 尚未分配运单号');
    if (data.label_url || data.label) db.prepare("INSERT INTO oms_labels(order_id,tracking_number,url,fetched_at) VALUES(?,?,?,?) ON CONFLICT(order_id,tracking_number) DO UPDATE SET url=excluded.url,fetched_at=excluded.fetched_at").run(job.order_id, tracking, String(data.label_url || data.label), now());
    linkShipment(job.order_id, tracking, rec?.oms_order_number || String(data.order_number || ''));
    return;
  }
  if (job.op === 'cancel') {
    await omsCancelOrder(job.order_id, fetcher);
    db.prepare("UPDATE oms_orders SET status='cancelled',updated_at=? WHERE order_id=?").run(now(), job.order_id);
    return;
  }
  throw new InputError('未知队列操作');
}
export async function drainQueue(fetcher = fetch) {
  for (;;) {
    const job = db.prepare("SELECT * FROM oms_queue WHERE status='pending' AND next_attempt<=? ORDER BY id LIMIT 1").get(Date.now());
    if (!job) return;
    try {
      await runJob(job, fetcher);
      db.prepare("UPDATE oms_queue SET status='done',updated_at=?,last_error='' WHERE id=?").run(now(), job.id);
    } catch (err) {
      const attempts = job.attempts + 1, dead = attempts > RETRY_DELAYS.length;
      db.prepare('UPDATE oms_queue SET attempts=?,next_attempt=?,status=?,last_error=?,updated_at=? WHERE id=?')
        .run(attempts, Date.now() + (RETRY_DELAYS[attempts - 1] || RETRY_DELAYS.at(-1)), dead ? 'failed' : 'pending', String(err.message || err).slice(0, 500), now(), job.id);
      if (dead && job.op === 'create') audit(job.actor_id || 0, 'oms.push_failed', job.order_id);
      return; // 每个节拍最多处理一条失败链，避免死循环占用。
    }
  }
}
// 批量轨迹同步（OMS 渠道 + 手工运单一并刷新，写入 shipments/shipment_events）。
export async function syncOmsTracks(fetcher = fetch) {
  const rows = db.prepare("SELECT o.order_id,o.oms_order_number,o.tracking_number FROM oms_orders o WHERE o.status<>'cancelled' AND (o.tracking_number<>'' OR o.oms_order_number<>'') LIMIT 100").all();
  if (!rows.length) return { synced: 0 };
  const numbers = rows.map(r => r.tracking_number || r.oms_order_number);
  const result = await omsGetOrderTrack(numbers, fetcher);
  const items = Array.isArray(result.data) ? result.data : [result.data];
  let synced = 0;
  for (const item of items || []) {
    // 响应可能以参考单号(no)、OMS 单号(number)或运单号(oriNumber)回标识，三者任一可匹配。
    const rec = [String(item.no || ''), String(item.number || ''), String(item.oriNumber || '')]
      .map(key => key ? db.prepare('SELECT * FROM oms_orders WHERE order_id=? OR oms_order_number=? OR (tracking_number<>\'\' AND tracking_number=?)').get(key, key, key) : null)
      .find(Boolean);
    if (!rec) continue;
    const orderId = rec.order_id;
    let tracking = rec.tracking_number;
    if (!tracking && item.oriNumber) { tracking = String(item.oriNumber); linkShipment(orderId, tracking, rec.oms_order_number); }
    const shipment = tracking ? db.prepare('SELECT * FROM shipments WHERE order_id=? AND tracking_number=?').get(orderId, tracking) : null;
    if (!shipment) continue;
    const status = omsTrackToShipmentStatus(item.newTrack);
    if (status !== 'unknown') applyShipmentStatus(shipment.id, status);
    recordShipmentEvents(shipment.id, 'oms', item.events || (item.newTrack ? [{ time: item.newTrackDate, content: item.newTrack, location: item.newTrackLocation }] : []));
    if (status === 'delivered') db.prepare("UPDATE orders SET delivered_at=CASE WHEN delivered_at='' THEN ? ELSE delivered_at END WHERE id=?").run(now(), orderId);
    synced++;
  }
  return { synced };
}

// ---------- 常驻 worker：3 秒出队；每 30 分钟轨迹同步 ----------
let queueTimer = null, trackTimer = null, trackBusy = false;
export function startOmsWorker() {
  if (queueTimer || process.env.OMS_AUTO_UPDATE === 'false') return;
  queueTimer = setInterval(() => { if (!omsConfig().enabled) return; drainQueue().catch(() => {}); }, 3000);
  queueTimer.unref();
  trackTimer = setInterval(() => {
    if (!omsConfig().enabled || trackBusy) return;
    trackBusy = true;
    syncOmsTracks().catch(() => {}).finally(() => { trackBusy = false; });
  }, 30 * 60 * 1000);
  trackTimer.unref();
}

// ---------- 手动操作（后台按钮） ----------
export async function omsManualAction(input, actor, fetcher = fetch) {
  const orderId = text(input.order_id, '订单号', 80);
  const action = text(input.action, '操作', 30);
  if (!db.prepare('SELECT id FROM orders WHERE id=?').get(orderId)) throw new InputError('订单不存在', 404);
  if (action === 'push') { const id = enqueueOms(orderId, 'create', actor); await drainQueue(fetcher); return { queueId: id }; }
  if (action === 'track') { const id = enqueueOms(orderId, 'track', actor); await drainQueue(fetcher); return { queueId: id }; }
  if (action === 'cancel') { const id = enqueueOms(orderId, 'cancel', actor); await drainQueue(fetcher); return { queueId: id }; }
  if (action === 'sync') { await drainQueue(fetcher); return await syncOmsTracks(fetcher); }
  if (action === 'channels') return { channels: await omsGetShippingMethods(fetcher), warehouses: await omsGetWarehouses(fetcher) };
  throw new InputError('不支持的操作');
}
export function omsOverview() {
  return {
    config: omsConfig(),
    orders: db.prepare('SELECT o.*,ord.tracking order_tracking FROM oms_orders o LEFT JOIN orders ord ON ord.id=o.order_id ORDER BY o.updated_at DESC LIMIT 30').all(),
    labels: db.prepare('SELECT * FROM oms_labels ORDER BY fetched_at DESC LIMIT 30').all()
  };
}
