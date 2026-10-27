import { escape as e } from '../api/security.mjs';
import { csrf } from '../storefront/views.mjs';
import { emailConfig, emailQueue, emailStats } from '../api/mailer.mjs';

export function emailPanel(ctx) {
  const cfg = emailConfig(), stats = emailStats(), queue = emailQueue();
  return `<section class="panel stack"><h2>邮件通知</h2>
<p>通过 Resend 发送订单付款确认、发货通知和退款确认，按订单语言出中英文模板；未开启或未配置时队列静默挂起，不影响订单流程。</p>
<form method="post" action="/admin/email/save" class="stack">${csrf(ctx.session)}
<label class="inline"><input type="checkbox" name="enabled" value="1" ${cfg.enabled ? 'checked' : ''}>开启邮件通知</label>
<label>发件地址<input name="from" value="${e(cfg.from)}" maxlength="200" placeholder="JerseyShelf <noreply@yourdomain.com>"></label>
<label>Resend API Key<input name="api_key" type="password" autocomplete="new-password" maxlength="200" placeholder="${cfg.hasApiKey ? '已配置，留空保持不变' : 're_...（resend.com/api-keys）'}"></label>
<label class="inline"><input type="checkbox" name="clear_key" value="1">删除已保存 Key</label>
<div class="actions"><button class="button">保存邮件配置</button></div>
</form>
<form method="post" action="/admin/email/test" class="actions">${csrf(ctx.session)}
<input name="to" type="email" placeholder="收件邮箱" required maxlength="200">
<button>发送测试邮件</button>
</form></section>
<section class="panel"><h2>发送记录</h2>
<p>待发 ${stats.pending || 0} · 已发送 ${stats.sent || 0} · 失败 ${stats.failed || 0}。失败按 1 分钟 / 10 分钟 / 1 小时重试三次。</p>
${queue.length ? `<table><thead><tr><th>#</th><th>订单</th><th>收件</th><th>类型 / 主题</th><th>状态</th><th>最近错误</th></tr></thead><tbody>${queue.map(r => `<tr><td>${r.id}</td><td>${e(r.order_id)}</td><td>${e(r.to_email)}</td><td>${{ order_paid: '付款确认', shipped: '发货通知', refund: '退款确认', custom: '自定义' }[r.kind]}<br><small>${e(r.subject)}</small></td><td>${{ pending: '待发', sent: '已发送', failed: '失败', skipped: '跳过' }[r.status] || r.status}</td><td>${e(r.last_error).slice(0, 60)}</td></tr>`).join('')}</tbody></table>` : '<p>暂无发送记录。</p>'}
</section>`;
}
