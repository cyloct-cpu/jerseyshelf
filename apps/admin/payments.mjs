import { escape as e } from '../api/security.mjs';
import { csrf } from '../storefront/views.mjs';
import { db } from '../api/db.mjs';
import { paymentConfig, orderPaymentSessions } from '../api/payments.mjs';

export function paymentsPanel(ctx) {
  const cfg = paymentConfig();
  const sessions = db.prepare('SELECT ps.*,o.email FROM payment_sessions ps JOIN orders o ON o.id=ps.order_id ORDER BY ps.created_at DESC LIMIT 50').all();
  return `<section class="panel"><h2>在线支付</h2>
<p>开启后，新订单模式可选择「正式在线支付」：顾客在订单页点击支付按钮跳转 Stripe 或 PayPal 完成付款，回调验签通过后自动确认收款。未配置签名密钥时回调一律拒绝。</p>
<form method="post" action="/admin/payments/save" class="stack">${csrf(ctx.session)}
<label class="inline"><input type="checkbox" name="enabled" value="1" ${cfg.enabled ? 'checked' : ''}>开启在线支付</label>
<fieldset><legend>Stripe（Checkout 托管页）</legend>
<label>API 模式<select name="stripe_mode"><option value="live" ${cfg.stripe.mode === 'live' ? 'selected' : ''}>正式（live）</option><option value="test" ${cfg.stripe.mode === 'test' ? 'selected' : ''}>测试（test）</option></select></label>
<label>可发布公钥<input name="stripe_public_key" value="${e(cfg.stripe.publicKey)}" maxlength="200" placeholder="pk_live_... / pk_test_..."></label>
<label>密钥（Secret Key）<input name="stripe_secret_key" type="password" autocomplete="new-password" maxlength="300" placeholder="${cfg.stripe.hasSecret ? '已配置，留空保持不变' : 'sk_live_... / sk_test_...'}"></label>
<label>Webhook 签名密钥<input name="stripe_webhook_secret" type="password" autocomplete="new-password" maxlength="300" placeholder="${cfg.stripe.hasWebhookSecret ? '已配置，留空保持不变' : 'whsec_...（回调地址 /webhooks/stripe）'}"></label>
<label class="inline"><input type="checkbox" name="clear_stripe_secret" value="1">删除已保存密钥</label>
<label class="inline"><input type="checkbox" name="clear_stripe_webhook" value="1">删除 Webhook 密钥</label>
</fieldset>
<fieldset><legend>PayPal（Orders v2）</legend>
<label>API 模式<select name="paypal_mode"><option value="live" ${cfg.paypal.mode === 'live' ? 'selected' : ''}>正式（live）</option><option value="sandbox" ${cfg.paypal.mode === 'sandbox' ? 'selected' : ''}>沙箱（sandbox）</option></select></label>
<label>Client ID<input name="paypal_client_id" value="${e(cfg.paypal.clientId)}" maxlength="200"></label>
<label>Client Secret<input name="paypal_client_secret" type="password" autocomplete="new-password" maxlength="300" placeholder="${cfg.paypal.hasClientSecret ? '已配置，留空保持不变' : '输入 Client Secret'}"></label>
<label>Webhook ID<input name="paypal_webhook_id" type="password" autocomplete="new-password" maxlength="200" placeholder="${cfg.paypal.hasWebhookId ? '已配置，留空保持不变' : '回调地址 /webhooks/paypal'}"></label>
<label class="inline"><input type="checkbox" name="clear_paypal_secret" value="1">删除 Client Secret</label>
<label class="inline"><input type="checkbox" name="clear_paypal_webhook" value="1">删除 Webhook ID</label>
</fieldset>
<div class="actions"><button class="button">保存支付配置</button><button name="test" value="stripe" formaction="/admin/payments/test">测试 Stripe 连接</button><button name="test" value="paypal" formaction="/admin/payments/test">测试 PayPal 连接</button></div>
</form></section>
<section class="panel"><h2>近期支付会话</h2>
${sessions.length ? `<table><thead><tr><th>会话</th><th>订单</th><th>渠道</th><th>金额</th><th>状态</th><th>创建时间</th></tr></thead><tbody>${sessions.map(r => `<tr><td>${e(r.id)}</td><td><a href="/admin/orders/${e(r.order_id)}">${e(r.order_id)}</a></td><td>${r.provider === 'stripe' ? 'Stripe' : 'PayPal'}</td><td>${e(r.currency)} ${(r.amount / 100).toFixed(2)}</td><td>${{ pending: '待支付', paid: '已支付', failed: '已失效', cancelled: '已取消' }[r.status] || r.status}</td><td>${e(r.created_at)}</td></tr>`).join('')}</tbody></table>` : '<p>暂无支付会话。</p>'}
</section>`;
}
