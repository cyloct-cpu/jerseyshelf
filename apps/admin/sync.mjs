import { escape as e } from '../api/security.mjs';
import { csrf } from '../storefront/views.mjs';
import { syncStatus } from '../api/catalog-sync.mjs';

export function syncAdmin(ctx) {
  const s = syncStatus();
  return `<section class="panel stack"><h2>商品同步发布</h2>
<p>本店为商品主库。另一商店（JERSEYDOCK）持下面生成的令牌，通过 <code translate="no">/api/sync/catalog?cursor=已同步游标&amp;token=令牌</code> 增量拉取；首次用 <code translate="no">full=1</code> 全量快照。商品/分类的每次保存、上下架、删除恢复都会进入变更队列；媒体按内容哈希共享，同机共享 media 目录时不占额外硬盘，跨机由对方按需拉取。</p>
<form method="post" action="/admin/sync/save" class="stack">${csrf(ctx.session)}
<label>本店公开地址（供对方拼接媒体与接口 URL）<input name="public_base" value="${e(s.publicBase)}" maxlength="200" placeholder="https://jerseyshelf.com"></label>
<div class="actions"><button class="button">保存配置</button></div>
</form>
<form method="post" action="/admin/sync/reset" class="stack">${csrf(ctx.session)}
<p>令牌：${s.hasToken ? '已生成（不回显）' : '尚未生成'}</p>
<button class="danger">${s.hasToken ? '重置令牌（旧令牌立即失效）' : '生成同步令牌'}</button>
</form></section>
<section class="panel"><h2>发布状态</h2>
<p>商品总数 ${s.products} · 变更队列累计 ${s.latest} 条（消费方同步到最新游标后可视为已发布）。</p>
<p>接口地址：<code translate="no">${e(s.publicBase || 'https://你的域名')}/api/sync/catalog?cursor=0&amp;token=…</code>（全量：<code translate="no">&amp;full=1</code>）</p>
</section>`;
}
