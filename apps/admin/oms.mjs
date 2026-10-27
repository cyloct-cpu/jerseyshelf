import { escape as e } from '../api/security.mjs';
import { csrf } from '../storefront/views.mjs';
import { omsConfig, omsOverview, omsQueueRows, omsQueueStatus } from '../api/oms.mjs';
import { tracking17Config } from '../api/tracking17.mjs';

export function omsPanel(ctx) {
  const cfg = omsConfig(), overview = omsOverview(), queue = omsQueueRows(), stats = Object.fromEntries(omsQueueStatus().map(r => [r.status, r.n]));
  const t17 = tracking17Config();
  return `${cfg.insecureHttp ? '<div class="notice error">当前服务地址为 HTTP，客户代码与密码将以明文传输，建议要求服务商提供 HTTPS 地址。</div>' : ''}
<section class="panel stack"><h2>OMS 履约对接</h2>
<p>开启后，货到付款资料确认、在线支付成功的新订单自动推送到代发系统；队列自动重试，运单号回填后轨迹每 30 分钟同步一次。金额、发货资料以订单快照为准。</p>
<form method="post" action="/admin/oms/save" class="stack">${csrf(ctx.session)}
<label class="inline"><input type="checkbox" name="enabled" value="1" ${cfg.enabled ? 'checked' : ''}>开启 OMS 对接</label>
<label>服务地址<input name="base_url" value="${e(cfg.baseUrl)}" maxlength="200" placeholder="https://oms.example.com:7772"></label>
<label>客户代码<input name="customer_code" value="${e(cfg.customerCode)}" maxlength="100"></label>
<label>客户密码<input name="customer_pwd" type="password" autocomplete="new-password" maxlength="200" placeholder="${cfg.hasCustomerPwd ? '已配置，留空保持不变' : '输入客户密码'}"></label>
<label class="inline"><input type="checkbox" name="clear_pwd" value="1">删除已保存密码</label>
<div class="two-cols">
<label>发货仓库 ID<input name="default_og_id" type="number" min="1" value="${cfg.defaultOgId}"></label>
<label>默认渠道代码<input name="default_service_code" value="${e(cfg.defaultServiceCode)}" maxlength="100" placeholder="如日本佐川渠道 service_code"></label>
<label>单件重量（kg）<input name="default_weight_kg" type="number" step="0.01" min="0.01" value="${cfg.defaultWeightKg}"></label>
<label>签收后未回款提醒（天）<input name="cod_remind_days" type="number" min="1" max="365" value="${cfg.codRemindDays}"></label>
</div>
<div class="actions"><button class="button">保存 OMS 配置</button><button name="test_channels" value="1" formaction="/admin/oms/action">保存并拉取渠道/仓库</button></div>
</form></section>
<section class="panel stack"><h2>17TRACK 轨迹补拉</h2>
<p>为 OMS 未覆盖或手工录入的运单自动拉取轨迹，30 分钟去重；未配置 Key 时仅使用 OMS 轨迹。</p>
<form method="post" action="/admin/tracking17/save" class="stack">${csrf(ctx.session)}
<label>API Key<input name="api_key" type="password" autocomplete="new-password" maxlength="128" placeholder="${t17.hasApiKey ? '已配置，留空保持不变' : '在 17track.net 开发者中心获取'}"></label>
<label class="inline"><input type="checkbox" name="clear_key" value="1">删除已保存 Key</label>
<div class="actions"><button class="button">保存 17TRACK 配置</button></div>
</form></section>
<section class="panel"><h2>队列状态</h2>
<p>待处理 ${stats.pending || 0} · 已完成 ${stats.done || 0} · 已失败 ${stats.failed || 0}。失败任务按 30 秒至 4 小时梯度自动重试 5 次，之后需人工处理。</p>
<form method="post" action="/admin/oms/action" class="actions">${csrf(ctx.session)}
<input name="order_id" placeholder="订单号 BW-…" maxlength="80" required>
<button name="action" value="push" class="button">推送 OMS</button>
<button name="action" value="track">补拉运单号</button>
<button name="action" value="cancel">作废 OMS 订单</button>
<button name="action" value="sync">立即同步全部轨迹</button>
</form>
${queue.length ? `<table><thead><tr><th>#</th><th>订单</th><th>操作</th><th>状态</th><th>尝试</th><th>最近错误</th></tr></thead><tbody>${queue.map(r => `<tr><td>${r.id}</td><td>${e(r.order_id)}</td><td>${{ create: '下单', track: '取号', cancel: '作废', block: '拦截', label: '面单' }[r.op] || r.op}</td><td>${{ pending: '待处理', done: '完成', failed: '失败' }[r.status] || r.status}</td><td>${r.attempts}</td><td>${e(r.last_error).slice(0, 80)}</td></tr>`).join('')}</tbody></table>` : '<p>暂无队列记录。</p>'}
</section>
<section class="panel"><h2>OMS 订单与面单</h2>
${overview.orders.length ? `<table><thead><tr><th>订单</th><th>OMS 单号</th><th>运单号</th><th>状态</th><th>更新时间</th></tr></thead><tbody>${overview.orders.map(r => `<tr><td><a href="/admin/orders/${e(r.order_id)}">${e(r.order_id)}</a></td><td>${e(r.oms_order_number)}</td><td>${e(r.tracking_number)}</td><td>${e(r.status)}</td><td>${e(r.updated_at)}</td></tr>`).join('')}</tbody></table>` : '<p>暂无 OMS 订单。</p>'}
${overview.labels.length ? `<h3>面单（服务端仅保留 20 天，已下载留档）</h3><table><thead><tr><th>订单</th><th>运单号</th><th>链接</th><th>获取时间</th></tr></thead><tbody>${overview.labels.map(r => `<tr><td>${e(r.order_id)}</td><td>${e(r.tracking_number)}</td><td><a href="${e(r.url)}" target="_blank" rel="noopener noreferrer">下载</a></td><td>${e(r.fetched_at)}</td></tr>`).join('')}</tbody></table>` : ''}
</section>`;
}
