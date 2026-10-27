import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createHmac, timingSafeEqual, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { db, putSetting, audit, transaction, now } from './db.mjs';
import { config } from './config.mjs';
import { InputError, text } from '../../packages/contracts/validation.mjs';
import { currencyMap } from '../../packages/contracts/currencies.mjs';
import { event } from './customers.mjs';
import { random } from './security.mjs';
import { omsConfig, enqueueOms } from './oms.mjs';
import { enqueueEmail, orderPaidEmail } from './mailer.mjs';

// ---------- 密钥封存（与 fx-provider 同模式：AES-256-GCM + 独立密钥文件） ----------
const keyFile = path.join(path.dirname(config.dbPath), 'payment-credentials.key');
function secretKey(create = false) {
  if (!existsSync(keyFile)) { if (!create) throw new Error('支付密钥文件缺失'); writeFileSync(keyFile, randomBytes(32), { mode: 0o600 }); }
  return readFileSync(keyFile);
}
function seal(value) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secretKey(true), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function unseal(value) {
  try {
    const data = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', secretKey(), data.subarray(0, 12));
    decipher.setAuthTag(data.subarray(12, 28));
    return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString('utf8');
  } catch { throw new InputError('支付密钥无法读取，请在后台重新配置', 503); }
}

// ---------- 配置 ----------
// settings 键 payment：{enabled, stripe:{mode,secret,webhookSecret,publicKey}, paypal:{mode,clientId,clientSecret,webhookId}}
// 其中 secret/webhookSecret/clientSecret 为封存串；页面录入的明文只出现一次，不回显。
export function paymentConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key='payment'").get();
  const stored = row ? JSON.parse(row.value) : {};
  const stripe = stored.stripe || {}, paypal = stored.paypal || {};
  return {
    enabled: stored.enabled === true,
    stripe: { mode: stripe.mode === 'test' ? 'test' : 'live', publicKey: stripe.publicKey || '', hasSecret: !!stripe.secret, hasWebhookSecret: !!stripe.webhookSecret },
    paypal: { mode: paypal.mode === 'sandbox' ? 'sandbox' : 'live', clientId: paypal.clientId || '', hasClientSecret: !!paypal.clientSecret, hasWebhookId: !!paypal.webhookId }
  };
}
function secrets() {
  const row = db.prepare("SELECT value FROM settings WHERE key='payment'").get();
  const stored = row ? JSON.parse(row.value) : {};
  return {
    stripeSecret: stored.stripe?.secret ? unseal(stored.stripe.secret) : '',
    stripeWebhookSecret: stored.stripe?.webhookSecret ? unseal(stored.stripe.webhookSecret) : '',
    paypalClientSecret: stored.paypal?.clientSecret ? unseal(stored.paypal.clientSecret) : '',
    paypalWebhookId: stored.paypal?.webhookId ? unseal(stored.paypal.webhookId) : '',
    paypalMode: stored.paypal?.mode === 'sandbox' ? 'sandbox' : 'live',
    stripeMode: stored.stripe?.mode === 'test' ? 'test' : 'live'
  };
}
const apiKey = v => /^[A-Za-z0-9_-]{16,300}$/.test(v);
export function savePaymentConfig(input, actor) {
  const stored0 = (() => { const row = db.prepare("SELECT value FROM settings WHERE key='payment'").get(); return row ? JSON.parse(row.value) : {}; })();
  const stripe = { ...(stored0.stripe || {}) }, paypal = { ...(stored0.paypal || {}) };
  if (input.stripe_mode) stripe.mode = input.stripe_mode === 'test' ? 'test' : 'live';
  if (input.paypal_mode) paypal.mode = input.paypal_mode === 'sandbox' ? 'sandbox' : 'live';
  if (typeof input.stripe_public_key === 'string' && input.stripe_public_key.trim()) stripe.publicKey = text(input.stripe_public_key, 'Stripe 公钥', 200).trim();
  if (typeof input.stripe_secret_key === 'string' && input.stripe_secret_key.trim()) {
    const key = input.stripe_secret_key.trim();
    if (!apiKey(key)) throw new InputError('Stripe 密钥格式无效');
    stripe.secret = seal(key);
  }
  if (typeof input.stripe_webhook_secret === 'string' && input.stripe_webhook_secret.trim()) {
    const key = input.stripe_webhook_secret.trim();
    if (!apiKey(key)) throw new InputError('Stripe Webhook 签名密钥格式无效');
    stripe.webhookSecret = seal(key);
  }
  if (typeof input.paypal_client_id === 'string' && input.paypal_client_id.trim()) paypal.clientId = text(input.paypal_client_id, 'PayPal Client ID', 200).trim();
  if (typeof input.paypal_client_secret === 'string' && input.paypal_client_secret.trim()) {
    const key = input.paypal_client_secret.trim();
    if (!apiKey(key)) throw new InputError('PayPal Client Secret 格式无效');
    paypal.clientSecret = seal(key);
  }
  if (typeof input.paypal_webhook_id === 'string' && input.paypal_webhook_id.trim()) {
    paypal.webhookId = seal(text(input.paypal_webhook_id, 'PayPal Webhook ID', 200).trim());
  }
  for (const [flag, field] of [['clear_stripe_secret', 'secret'], ['clear_stripe_webhook', 'webhookSecret'], ['clear_paypal_secret', 'clientSecret'], ['clear_paypal_webhook', 'webhookId']]) {
    if (input[flag] === '1') {
      if (flag.startsWith('clear_stripe')) delete stripe[field]; else delete paypal[field];
    }
  }
  const value = { enabled: input.enabled === '1', stripe, paypal };
  putSetting('payment', value);
  audit(actor, 'payment.config', input.enabled === '1' ? 'enabled' : 'disabled');
  return paymentConfig();
}

// ---------- Stripe ----------
const STRIPE_API = 'https://api.stripe.com';
export function stripeSignaturePayload(timestamp, body) { return timestamp + '.' + body; }
export function verifyStripeSignature(body, sigHeader, secret) {
  // 未配置密钥时直接拒绝（不做“跳过验签”的降级）。
  if (!secret) throw new InputError('Stripe Webhook 未配置签名密钥，拒绝处理', 400);
  const parts = String(sigHeader || '').split(',').map(p => p.split('=').map(s => s.trim()));
  const timestamp = parts.find(p => p[0] === 't')?.[1];
  const signatures = parts.filter(p => p[0] === 'v1').map(p => p[1]).filter(Boolean);
  if (!timestamp || !signatures.length) throw new InputError('Stripe 签名头无效', 400);
  if (!/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) throw new InputError('Stripe 签名时间戳超出容差', 400);
  const expected = createHmac('sha256', secret).update(stripeSignaturePayload(timestamp, body)).digest('hex');
  const match = signatures.some(s => {
    const a = Buffer.from(s, 'utf8'), b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  });
  if (!match) throw new InputError('Stripe 签名不匹配', 400);
}
async function stripeRequest(endpoint, secretKey, params, method = 'POST', fetcher = fetch) {
  const headers = { Authorization: 'Bearer ' + secretKey };
  let body;
  if (method === 'POST') { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(params); }
  const response = await fetcher(STRIPE_API + endpoint, { method, headers, body, signal: AbortSignal.timeout(15000), redirect: 'error' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new InputError('Stripe 接口错误：' + (data.error?.message || response.status), 502);
  return data;
}
export async function createStripeCheckoutSession(order, baseUrl, fetcher = fetch) {
  const s = secrets();
  if (!s.stripeSecret) throw new InputError('Stripe 尚未配置密钥', 503);
  const minor = currencyMap.get(order.currency)?.minor ?? 2;
  const psId = 'PS-' + random(12).toUpperCase();
  const data = await stripeRequest('/v1/checkout/sessions', s.stripeSecret, {
    mode: 'payment',
    success_url: baseUrl + '/checkout/return?ps=' + psId,
    cancel_url: baseUrl + '/orders/' + order.id,
    client_reference_id: order.id,
    'metadata[order_id]': order.id,
    'metadata[payment_session]': psId,
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': order.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(order.total),
    'line_items[0][price_data][product_data][name]': 'Order ' + order.id
  }, 'POST', fetcher);
  db.prepare('INSERT INTO payment_sessions(id,order_id,provider,provider_ref,amount,currency,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(psId, order.id, 'stripe', data.id, order.total, order.currency, 'pending', now(), now());
  return { id: psId, redirect: data.url };
}
export async function retrieveStripeSession(psId, fetcher = fetch) {
  const s = secrets();
  if (!s.stripeSecret) throw new InputError('Stripe 尚未配置密钥', 503);
  const row = db.prepare("SELECT * FROM payment_sessions WHERE id=? AND provider='stripe'").get(psId);
  if (!row) throw new InputError('支付会话不存在', 404);
  const data = await stripeRequest('/v1/checkout/sessions/' + row.provider_ref, s.stripeSecret, {}, 'GET', fetcher);
  if (data.payment_status === 'paid') settlePaymentSession(psId, data.payment_intent || row.provider_ref);
  else if (data.status === 'expired') updateSessionStatus(psId, 'failed');
  return row;
}

// ---------- PayPal ----------
const paypalBase = mode => mode === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com';
let paypalToken = { value: '', expires: 0 };
async function paypalAuth(s, fetcher = fetch) {
  if (paypalToken.value && Date.now() < paypalToken.expires - 60000) return paypalToken.value;
  const basic = Buffer.from(s.paypalClientIdValue + ':' + s.paypalClientSecret).toString('base64');
  const response = await fetcher(paypalBase(s.paypalMode) + '/v1/oauth2/token', {
    method: 'POST', headers: { Authorization: 'Basic ' + basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials', signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new InputError('PayPal 授权失败：' + (data.error_description || response.status), 502);
  paypalToken = { value: data.access_token, expires: Date.now() + data.expires_in * 1000 };
  return data.access_token;
}
export async function createPaypalOrder(order, baseUrl, fetcher = fetch) {
  const s = secrets();
  if (!s.paypalClientSecret) throw new InputError('PayPal 尚未配置密钥', 503);
  const minor = currencyMap.get(order.currency)?.minor ?? 2;
  const psId = 'PS-' + random(12).toUpperCase();
  const token = await paypalAuth({ ...s, paypalClientIdValue: (paymentConfigRaw().paypal || {}).clientId || '' }, fetcher);
  const response = await fetcher(paypalBase(s.paypalMode) + '/v2/checkout/orders', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      intent: 'CAPTURE',
      purchase_units: [{ reference_id: order.id, custom_id: psId + ':' + order.id, amount: { currency_code: order.currency, value: (order.total / 10 ** minor).toFixed(minor) } }],
      application_context: { return_url: baseUrl + '/checkout/return?ps=' + psId, cancel_url: baseUrl + '/orders/' + order.id, user_action: 'PAY_NOW' }
    }), signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new InputError('PayPal 接口错误：' + (data.message || response.status), 502);
  const approve = data.links?.find(l => l.rel === 'approve')?.href;
  if (!approve) throw new InputError('PayPal 未返回支付链接', 502);
  db.prepare('INSERT INTO payment_sessions(id,order_id,provider,provider_ref,amount,currency,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(psId, order.id, 'paypal', data.id, order.total, order.currency, 'pending', now(), now());
  return { id: psId, redirect: approve };
}
export async function capturePaypalOrder(psId, fetcher = fetch) {
  const s = secrets();
  if (!s.paypalClientSecret) throw new InputError('PayPal 尚未配置密钥', 503);
  const row = db.prepare("SELECT * FROM payment_sessions WHERE id=? AND provider='paypal'").get(psId);
  if (!row) throw new InputError('支付会话不存在', 404);
  if (row.status === 'paid') return row;
  const token = await paypalAuth({ ...s, paypalClientIdValue: (paymentConfigRaw().paypal || {}).clientId || '' }, fetcher);
  const response = await fetcher(paypalBase(s.paypalMode) + '/v2/checkout/orders/' + row.provider_ref + '/capture', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: '{}', signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 422 && data.details?.some(d => d.issue === 'ORDER_ALREADY_CAPTURED')) { settlePaymentSession(psId, row.provider_ref); return row; }
  if (!response.ok) throw new InputError('PayPal 扣款确认失败：' + (data.message || response.status), 502);
  const captured = data.purchase_units?.[0]?.payments?.captures?.[0];
  if (data.status === 'COMPLETED' && captured?.status === 'COMPLETED') settlePaymentSession(psId, captured.id);
  return row;
}
export async function verifyPaypalWebhook(eventBody, headers, fetcher = fetch) {
  const s = secrets();
  if (!s.paypalClientSecret || !s.paypalWebhookId) throw new InputError('PayPal Webhook 未配置密钥，拒绝处理', 400);
  const token = await paypalAuth({ ...s, paypalClientIdValue: (paymentConfigRaw().paypal || {}).clientId || '' }, fetcher);
  const response = await fetcher(paypalBase(s.paypalMode) + '/v1/notifications/verify-webhook-signature', {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      auth_algo: headers['paypal-auth-algo'], cert_url: headers['paypal-cert-url'], transmission_id: headers['paypal-transmission-id'],
      transmission_sig: headers['paypal-transmission-sig'], transmission_time: headers['paypal-transmission-time'],
      webhook_id: s.paypalWebhookId, webhook_event: JSON.parse(eventBody)
    }), signal: AbortSignal.timeout(15000), redirect: 'error'
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.verification_status !== 'SUCCESS') throw new InputError('PayPal Webhook 验签失败', 400);
}
function paymentConfigRaw() {
  const row = db.prepare("SELECT value FROM settings WHERE key='payment'").get();
  return row ? JSON.parse(row.value) : {};
}

// ---------- 收款落地（幂等，以 request_key 去重） ----------
function updateSessionStatus(psId, status) {
  db.prepare('UPDATE payment_sessions SET status=?,updated_at=? WHERE id=?').run(status, now(), psId);
}
export function markOrderPaidViaProvider(orderId, provider, providerReference) {
  return transaction(() => {
    const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
    if (!o) throw new InputError('订单不存在', 404);
    if (o.payment_status === 'paid') return o.id;
    if (o.payment_method !== 'online') throw new InputError('仅在线支付订单可自动确认收款', 409);
    if (o.payment_status !== 'unpaid') throw new InputError('订单付款状态不允许自动确认：' + o.payment_status, 409);
    const key = 'auto:' + provider + ':' + providerReference;
    if (!db.prepare('SELECT id FROM order_receipts WHERE request_key=?').get(key)) {
      const actor = (db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get() || {}).id;
      db.prepare('INSERT INTO order_receipts(order_id,kind,amount,currency,method,reference,occurred_at,actor_id,request_key,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(o.id, 'receipt', o.total, o.currency, provider === 'stripe' ? 'Stripe 在线支付' : 'PayPal 在线支付', providerReference.slice(0, 150), now(), actor, key, now());
      db.prepare("UPDATE orders SET payment_status='paid',payment_provider=?,payment_reference=?,paid_at=CASE WHEN paid_at='' THEN ? ELSE paid_at END WHERE id=?").run(provider, providerReference.slice(0, 150), now(), o.id);
      if (o.customer_id) {
        event(o.customer_id, 'payment', '在线支付自动确认 ' + o.currency + ' ' + (o.total / 100).toFixed(2), actor, o.id);
        db.prepare("UPDATE customer_tasks SET status='done',result='在线支付已自动确认到账',updated_at=? WHERE order_id=? AND kind='payment' AND status='pending'").run(now(), o.id);
      }
      audit(actor, 'payment.auto_paid', o.id + ':' + provider);
      if (omsConfig().enabled) { try { enqueueOms(o.id, 'create', actor); } catch { /* 推送失败不影响收款确认 */ } }
      { try { enqueueEmail({ dedupeKey: 'order-paid:' + o.id, orderId: o.id, customerId: o.customer_id, ...orderPaidEmail(o) }); } catch { /* 邮件失败不影响收款确认 */ } }
    }
    return o.id;
  });
}
export function settlePaymentSession(psId, providerReference) {
  const ps = db.prepare('SELECT * FROM payment_sessions WHERE id=?').get(psId);
  if (!ps) throw new InputError('支付会话不存在', 404);
  if (ps.status === 'paid') return ps.order_id;
  const orderId = markOrderPaidViaProvider(ps.order_id, ps.provider, providerReference);
  updateSessionStatus(psId, 'paid');
  return orderId;
}
export function handleStripeEvent(raw) {
  const payload = JSON.parse(raw);
  if (payload.type === 'checkout.session.completed' || payload.type === 'checkout.session.async_payment_succeeded') {
    const session = payload.data?.object || {};
    const orderId = session.metadata?.order_id || session.client_reference_id;
    const psId = session.metadata?.payment_session || (orderId ? db.prepare("SELECT id FROM payment_sessions WHERE order_id=? AND provider='stripe' AND status='pending' ORDER BY created_at DESC").get(orderId)?.id : null);
    if (orderId && (session.payment_status === 'paid' || session.status === 'complete')) {
      if (psId) settlePaymentSession(psId, session.payment_intent || session.id);
      else markOrderPaidViaProvider(orderId, 'stripe', session.payment_intent || session.id);
    }
  } else if (payload.type === 'checkout.session.expired') {
    const psId = payload.data?.object?.metadata?.payment_session;
    if (psId) updateSessionStatus(psId, 'failed');
  }
}
export function handlePaypalEvent(payload) {
  const resource = payload.resource || {};
  const psId = String(resource.custom_id || '').split(':')[0]
    || (resource.supplementary_data?.related_ids?.order_id ? db.prepare("SELECT id FROM payment_sessions WHERE provider_ref=? AND provider='paypal'").get(resource.supplementary_data.related_ids.order_id)?.id : null)
    || (resource.id ? db.prepare("SELECT id FROM payment_sessions WHERE provider_ref=? AND provider='paypal'").get(resource.id)?.id : null);
  if (payload.event_type === 'PAYMENT.CAPTURE.COMPLETED' || payload.event_type === 'CHECKOUT.ORDER.COMPLETED') {
    const reference = resource.id || resource.supplementary_data?.related_ids?.order_id || '';
    if (psId) settlePaymentSession(psId, reference);
    else {
      const orderId = String(resource.custom_id || '').split(':')[1] || resource.supplementary_data?.related_ids?.order_id || '';
      if (orderId) markOrderPaidViaProvider(orderId, 'paypal', reference);
    }
  } else if (psId && (payload.event_type === 'CHECKOUT.ORDER.VOIDED' || payload.event_type === 'PAYMENT.CAPTURE.DECLINED')) updateSessionStatus(psId, 'failed');
}
export function orderPaymentSessions(orderId) {
  return db.prepare('SELECT * FROM payment_sessions WHERE order_id=? ORDER BY created_at DESC').all(orderId);
}
export function getPaymentSession(psId) { return db.prepare('SELECT * FROM payment_sessions WHERE id=?').get(psId); }
export function stripeWebhookSecret() { return secrets().stripeWebhookSecret; }

// ---------- 对外：创建支付入口 ----------
export async function startOrderPayment(orderId, provider, baseUrl) {
  const o = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!o) throw new InputError('订单不存在', 404);
  if (o.payment_method !== 'online') throw new InputError('此订单不支持在线支付', 400);
  if (o.payment_status === 'paid') throw new InputError('订单已支付', 409);
  if (o.fulfillment_status === 'cancelled') throw new InputError('订单已取消', 409);
  const cfg = paymentConfig();
  if (!cfg.enabled) throw new InputError('在线支付未开启', 503);
  if (provider === 'stripe' && !cfg.stripe.hasSecret) throw new InputError('Stripe 未配置密钥', 503);
  if (provider === 'paypal' && !(cfg.paypal.clientId && cfg.paypal.hasClientSecret)) throw new InputError('PayPal 未配置密钥', 503);
  const pending = db.prepare("SELECT * FROM payment_sessions WHERE order_id=? AND provider=? AND status='pending' ORDER BY created_at DESC").get(orderId, provider);
  if (pending && Date.now() - Date.parse(pending.created_at) < 3600000 && provider === 'paypal') return pending.id;
  return provider === 'stripe' ? (await createStripeCheckoutSession(o, baseUrl)).id : (await createPaypalOrder(o, baseUrl)).id;
}
export async function paymentRedirect(psId) {
  const ps = db.prepare('SELECT * FROM payment_sessions WHERE id=?').get(psId);
  if (!ps) throw new InputError('支付会话不存在', 404);
  if (ps.provider === 'stripe') {
    const s = secrets();
    const data = await stripeRequest('/v1/checkout/sessions/' + ps.provider_ref, s.stripeSecret, {}, 'GET');
    return data.url;
  }
  const s = secrets();
  const token = await paypalAuth({ ...s, paypalClientIdValue: (paymentConfigRaw().paypal || {}).clientId || '' });
  const response = await fetch(paypalBase(s.paypalMode) + '/v2/checkout/orders/' + ps.provider_ref, { headers: { Authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  const data = await response.json();
  const approve = data.links?.find(l => l.rel === 'approve')?.href;
  if (!approve) throw new InputError('支付链接已失效，请重新发起支付', 410);
  return approve;
}

// ---------- 连接测试 ----------
export async function testPaymentConnection(target) {
  const s = secrets();
  if (target === 'stripe') {
    if (!s.stripeSecret) throw new InputError('Stripe 未配置密钥');
    await stripeRequest('/v1/checkout/sessions?limit=1', s.stripeSecret, {}, 'GET');
    return 'Stripe 连接成功，密钥有效';
  }
  if (target === 'paypal') {
    if (!s.paypalClientSecret) throw new InputError('PayPal 未配置密钥');
    await paypalAuth({ ...s, paypalClientIdValue: (paymentConfigRaw().paypal || {}).clientId || '' });
    return 'PayPal 连接成功，密钥有效';
  }
  throw new InputError('未知测试目标');
}
