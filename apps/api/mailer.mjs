import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';
import { db, putSetting, audit, now } from './db.mjs';
import { config } from './config.mjs';
import { InputError, email as validEmail, text } from '../../packages/contracts/validation.mjs';
import { formatMinor } from '../../packages/contracts/currencies.mjs';

// ---------- 配置（settings 键 email：{enabled,from,apiKey(sealed)}） ----------
const keyFile = path.join(path.dirname(config.dbPath), 'email-credentials.key');
function secretKey(create = false) {
  if (!existsSync(keyFile)) { if (!create) throw new Error('邮件密钥文件缺失'); writeFileSync(keyFile, randomBytes(32), { mode: 0o600 }); }
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
  } catch { throw new InputError('邮件密钥无法读取，请在后台重新配置', 503); }
}
export function emailConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key='email'").get();
  const s = row ? JSON.parse(row.value) : {};
  return { enabled: s.enabled === true, from: s.from || '', hasApiKey: !!s.apiKey };
}
function apiKey() {
  const row = db.prepare("SELECT value FROM settings WHERE key='email'").get();
  const s = row ? JSON.parse(row.value) : {};
  return s.apiKey ? unseal(s.apiKey) : (process.env.RESEND_API_KEY || '');
}
export function saveEmailConfig(input, actor) {
  const row = db.prepare("SELECT value FROM settings WHERE key='email'").get();
  const s = row ? JSON.parse(row.value) : {};
  if (typeof input.from === 'string' && input.from.trim()) s.from = text(input.from, '发件地址', 200).trim();
  if (input.clear_key === '1') delete s.apiKey;
  else if (typeof input.api_key === 'string' && input.api_key.trim()) {
    const key = input.api_key.trim();
    if (!/^[A-Za-z0-9_-]{16,200}$/.test(key)) throw new InputError('Resend API Key 格式无效');
    s.apiKey = seal(key);
  }
  s.enabled = input.enabled === '1';
  if (s.enabled && (!s.from || !s.apiKey)) throw new InputError('开启前需填写发件地址与 API Key');
  putSetting('email', s);
  audit(actor, 'email.config', s.enabled ? 'enabled' : 'disabled');
  return emailConfig();
}

// ---------- 队列 ----------
export function enqueueEmail({ dedupeKey, orderId = '', customerId = null, to, kind, locale = 'en', subject, body }) {
  if (!['order_paid', 'shipped', 'refund', 'custom'].includes(kind)) throw new InputError('未知邮件类型');
  const address = validEmail(to);
  db.prepare('INSERT OR IGNORE INTO email_messages(dedupe_key,order_id,customer_id,to_email,kind,locale,subject,body,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,\'pending\',?,?)')
    .run('email:' + dedupeKey, orderId, customerId, address, kind, locale, text(subject, '主题', 300), body, now(), now());
  return db.prepare('SELECT id FROM email_messages WHERE dedupe_key=?').get('email:' + dedupeKey).id;
}
export function emailQueue(limit = 40) {
  return db.prepare('SELECT id,order_id,to_email,kind,subject,status,attempts,last_error,platform_id,created_at,updated_at FROM email_messages ORDER BY id DESC LIMIT ?').all(limit);
}
export function emailStats() {
  return Object.fromEntries(db.prepare('SELECT status,COUNT(*) n FROM email_messages GROUP BY status').all().map(r => [r.status, r.n]));
}

// ---------- 模板（双语：订单语言 zh 开头用中文，否则英文） ----------
const siteName = () => db.prepare("SELECT value FROM settings WHERE key='site'").get() ? JSON.parse(db.prepare("SELECT value FROM settings WHERE key='site'").get().value).name : 'JerseyShelf';
function itemsRows(order, zh) {
  const items = db.prepare('SELECT * FROM order_items WHERE order_id=?').all(order.id);
  const rows = items.map(i => `<tr><td>${i.title} × ${i.variant_label}</td><td>${i.quantity}</td><td>${formatMinor(i.unit_price * i.quantity, order.currency)}</td></tr>`).join('');
  return `<table><tbody>${rows}</tbody></table><p>${zh ? '合计' : 'Total'}: <strong>${formatMinor(order.total, order.currency)}</strong></p>`;
}
function wrap(title, inner) {
  return `<!doctype html><html><body style="font:14px/1.7 Arial,sans-serif;color:#181818"><div style="max-width:560px;margin:auto;padding:24px"><h2 style="margin:0 0 16px">${title}</h2>${inner}<p style="color:#777;font-size:12px;margin-top:24px">${siteName()}</p></div></body></html>`;
}
export function orderPaidEmail(order) {
  const zh = String(order.whatsapp_locale || 'en').startsWith('zh');
  return {
    kind: 'order_paid', locale: zh ? 'zh' : 'en', to: order.email,
    subject: (zh ? '付款确认 — 订单 ' : 'Payment confirmed — order ') + order.id,
    body: wrap(zh ? '付款已确认' : 'Payment confirmed', (zh ? '<p>我们已收到您的付款，订单正在安排发货。</p><p>订单号：' : "<p>We've received your payment and your order is being prepared.</p><p>Order: ") + `<strong>${order.id}</strong></p>` + itemsRows(order, zh))
  };
}
export function shippedEmail(order, tracking) {
  const zh = String(order.whatsapp_locale || 'en').startsWith('zh');
  return {
    kind: 'shipped', locale: zh ? 'zh' : 'en', to: order.email,
    subject: (zh ? '已发货 — 订单 ' : 'Shipped — order ') + order.id,
    body: wrap(zh ? '订单已发货' : 'Your order has shipped', (zh ? '<p>您的订单已发出，物流单号：' : '<p>Your order is on its way. Tracking number: ') + `<strong>${tracking}</strong></p><p>${zh ? '订单号' : 'Order'}: ${order.id}</p>` + itemsRows(order, zh))
  };
}
export function refundEmail(order, amountText, reference) {
  const zh = String(order.whatsapp_locale || 'en').startsWith('zh');
  return {
    kind: 'refund', locale: zh ? 'zh' : 'en', to: order.email,
    subject: (zh ? '退款确认 — 订单 ' : 'Refund confirmed — order ') + order.id,
    body: wrap(zh ? '退款已确认' : 'Refund confirmed', (zh ? `<p>我们已完成退款：${amountText}${reference ? '（参考号 ' + reference + '）' : ''}。</p><p>到账时间视银行或支付渠道而定。</p>` : `<p>We've issued your refund: ${amountText}${reference ? ' (reference ' + reference + ')' : ''}.</p><p>Depending on your bank or payment provider it may take a few days to appear.</p>`))
  };
}

// ---------- 发送（Resend HTTP API） ----------
export async function sendViaResend(to, subject, html, fetcher = fetch) {
  const key = apiKey();
  if (!key) throw new InputError('尚未配置邮件 API Key', 503);
  const cfg = (() => { const row = db.prepare("SELECT value FROM settings WHERE key='email'").get(); return row ? JSON.parse(row.value) : {}; })();
  if (!cfg.from) throw new InputError('尚未配置发件地址', 503);
  let response;
  try {
    response = await fetcher('https://api.resend.com/emails', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.from, to: [to], subject, html }), signal: AbortSignal.timeout(15000), redirect: 'error'
    });
  } catch (err) {
    throw new InputError('邮件服务连接失败：' + (err?.name === 'TimeoutError' ? '请求超时' : '网络错误'), 502);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new InputError('邮件服务返回错误：' + (payload.message || response.status), 502);
  return payload.id || '';
}

// ---------- worker ----------
const RETRY_DELAYS = [60000, 600000, 3600000];
export async function drainEmail(fetcher = fetch) {
  const cfg = emailConfig();
  if (!cfg.enabled) return; // 未开启时静默挂起，不消耗尝试次数。
  for (;;) {
    const msg = db.prepare("SELECT * FROM email_messages WHERE status='pending' AND next_attempt<=? ORDER BY id LIMIT 1").get(Date.now());
    if (!msg) return;
    try {
      const platformId = await sendViaResend(msg.to_email, msg.subject, msg.body, fetcher);
      db.prepare("UPDATE email_messages SET status='sent',platform_id=?,last_error='',updated_at=? WHERE id=?").run(String(platformId), now(), msg.id);
    } catch (err) {
      const attempts = msg.attempts + 1, dead = attempts > RETRY_DELAYS.length;
      db.prepare('UPDATE email_messages SET attempts=?,next_attempt=?,status=?,last_error=?,updated_at=? WHERE id=?')
        .run(attempts, Date.now() + (RETRY_DELAYS[attempts - 1] || 0), dead ? 'failed' : 'pending', String(err.message || err).slice(0, 400), now(), msg.id);
      return;
    }
  }
}
let timer = null;
export function startEmailWorker() {
  if (timer || process.env.EMAIL_AUTO_UPDATE === 'false') return;
  timer = setInterval(() => drainEmail().catch(() => {}), 3000);
  timer.unref();
}

// ---------- 测试发送（后台按钮） ----------
export async function sendTestEmail(input, actor, fetcher = fetch) {
  const to = validEmail(input.to);
  const id = await sendViaResend(to, siteName() + ' 测试邮件', wrap('测试邮件', '<p>这是一封测试邮件，配置有效。</p><p>This is a test email; your configuration works.</p>'), fetcher);
  audit(actor, 'email.test', to);
  return id;
}
