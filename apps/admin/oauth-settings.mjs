import { escape as e } from '../api/security.mjs';
import { csrf } from '../storefront/views.mjs';
import { oauthConfig } from '../api/oauth.mjs';

export function oauthSettings(ctx) {
  const cfg = oauthConfig();
  return `<section class="panel stack"><h2>Google 登录</h2>
<p>在 Google Cloud Console 创建 OAuth 客户端（Web 应用），授权回调地址填 <code translate="no">${e(process.env.PUBLIC_BASE_URL || 'https://你的域名')}/account/google/callback</code>。配置后前台登录页出现「使用 Google 继续」；已注册同邮箱顾客自动绑定，新邮箱自动建档。</p>
<form method="post" action="/admin/oauth/save" class="stack">${csrf(ctx.session)}
<label>Client ID<input name="google_client_id" value="${e(cfg.google.clientId)}" maxlength="200" placeholder="xxxx.apps.googleusercontent.com"></label>
<label>Client Secret<input name="google_client_secret" type="password" autocomplete="new-password" maxlength="300" placeholder="${cfg.google.hasClientSecret ? '已配置，留空保持不变' : '输入 Client Secret'}"></label>
<label class="inline"><input type="checkbox" name="clear_secret" value="1">删除已保存 Secret</label>
<div class="actions"><button class="button">保存 Google 登录配置</button></div>
</form></section>`;
}
