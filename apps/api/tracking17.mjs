import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';
import { db, putSetting, audit, now } from './db.mjs';
import { config } from './config.mjs';
import { InputError, text } from '../../packages/contracts/validation.mjs';

// 17TRACK API v2.2：对未签收包裹做轨迹补拉，写入 shipments / shipment_events。
// settings 键 tracking17：{apiKey(sealed)}
const keyFile = path.join(path.dirname(config.dbPath), 'tracking17-credentials.key');
function secretKey(create = false) {
  if (!existsSync(keyFile)) { if (!create) throw new Error('17TRACK 密钥文件缺失'); writeFileSync(keyFile, randomBytes(32), { mode: 0o600 }); }
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
  } catch { throw new InputError('17TRACK 密钥无法读取，请在后台重新配置', 503); }
}
export function tracking17Config() {
  const row = db.prepare("SELECT value FROM settings WHERE key='tracking17'").get();
  const s = row ? JSON.parse(row.value) : {};
  return { hasApiKey: !!s.apiKey };
}
export function saveTracking17Config(input, actor) {
  const row = db.prepare("SELECT value FROM settings WHERE key='tracking17'").get();
  const s = row ? JSON.parse(row.value) : {};
  if (input.clear_key === '1') delete s.apiKey;
  else if (typeof input.api_key === 'string' && input.api_key.trim()) {
    const key = input.api_key.trim();
    if (!/^[A-Za-z0-9_-]{16,128}$/.test(key)) throw new InputError('17TRACK API Key 格式无效');
    s.apiKey = seal(key);
  }
  putSetting('tracking17', s);
  audit(actor, 'tracking17.config', s.apiKey ? 'configured' : 'cleared');
  return tracking17Config();
}
function apiKey() {
  const row = db.prepare("SELECT value FROM settings WHERE key='tracking17'").get();
  const s = row ? JSON.parse(row.value) : {};
  return s.apiKey ? unseal(s.apiKey) : (process.env.TRACK17_API_KEY || '');
}

// 17TRACK 状态 → 本站包裹状态
export function track17ToShipmentStatus(status, subStatus) {
  const s = String(status || ''), sub = String(subStatus || '');
  if (s === 'Delivered') return 'delivered';
  if (s === 'Undelivered') return 'refused';
  if (s === 'Returning') return 'returning';
  if (s === 'Exception' || s === 'Expired') return 'exception';
  if (s === 'Available for Pickup') return 'available_for_pickup';
  if (s === 'In Transit') return /Out for Delivery|In Delivery/.test(sub) ? 'out_for_delivery' : 'in_transit';
  if (s === 'InfoReceived') return 'info_received';
  return 'unknown';
}
async function fetchTrack17(numbers, fetcher = fetch) {
  const key = apiKey();
  if (!key) throw new InputError('尚未配置 17TRACK API Key', 503);
  const response = await fetcher('https://api.17track.net/track/v2.2/gettrackinfo', {
    method: 'POST', headers: { '17track-api-token': key, 'Content-Type': 'application/json' },
    body: JSON.stringify(numbers.map(n => ({ number: n }))), signal: AbortSignal.timeout(20000), redirect: 'error'
  });
  const payload = await response.json().catch(() => { throw new InputError('17TRACK 返回格式错误', 502); });
  if (payload.code !== 0) throw new InputError('17TRACK 接口错误：' + (payload.message || payload.code), 502);
  return payload.data?.accept || [];
}

// 拉取所有未签收且超过 30 分钟未同步的包裹轨迹。
export async function syncTracking17(force = false, fetcher = fetch) {
  const fresh = force ? 0 : Date.now() - 30 * 60 * 1000;
  const rows = db.prepare("SELECT * FROM shipments WHERE tracking_number<>'' AND status NOT IN('delivered','returned') AND (last_synced_at='' OR last_synced_at IS NULL OR strftime('%s','now')-strftime('%s',last_synced_at)>=1800 OR last_synced_at<?) ORDER BY id LIMIT 100").all('').map(r => ({ ...r, stale: !r.last_synced_at || Date.parse(r.last_synced_at) < fresh })).filter(r => r.stale);
  if (!rows.length) return { synced: 0 };
  const result = await fetchTrack17(rows.map(r => r.tracking_number), fetcher);
  let synced = 0;
  for (const item of result) {
    const shipment = rows.find(r => r.tracking_number === item.number);
    if (!shipment) continue;
    const track = item.track_info?._?.latest_status ?? item.track_info ?? {};
    const status = track17ToShipmentStatus(track.status, track.sub_status);
    const events = (item.track_info?._?.event || item.track_info?.event || []).map(ev => ({ time: ev.time_iso, content: ev.description || ev.zh_description, location: ev.location, status }));
    if (events.length) {
      for (const ev of events) {
        const id = '17t:' + String(ev.time || '') + ':' + String(ev.content || '').slice(0, 60);
        const occurred = ev.time ? new Date(ev.time).toISOString() : now();
        db.prepare('INSERT OR IGNORE INTO shipment_events(shipment_id,provider_event_id,status,description,location,occurred_at,created_at) VALUES(?,?,?,?,?,?,?)')
          .run(shipment.id, id, ev.status || 'unknown', String(ev.content || ''), String(ev.location || ''), occurred, now());
      }
    }
    if (status !== 'unknown') db.prepare('UPDATE shipments SET status=?,last_synced_at=?,updated_at=? WHERE id=?').run(status, now(), now(), shipment.id);
    else db.prepare('UPDATE shipments SET last_synced_at=?,updated_at=? WHERE id=?').run(now(), now(), shipment.id);
    if (status === 'delivered') {
      db.prepare('UPDATE shipments SET status=\'delivered\' WHERE id=?').run(shipment.id);
      db.prepare("UPDATE orders SET delivered_at=CASE WHEN delivered_at='' THEN ? ELSE delivered_at END WHERE id=?").run(now(), shipment.order_id);
    }
    synced++;
  }
  return { synced };
}
