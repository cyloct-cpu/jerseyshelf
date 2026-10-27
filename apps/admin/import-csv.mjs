import { escape as e } from '../api/security.mjs';
import { csrf } from '../storefront/views.mjs';
import { listBatches } from '../api/import-batch.mjs';

// 批量导入：对齐 KITVAULT 的三步体验（上传清单与图片 → 校验预览 → 确认入库），保持零依赖（CSV/JSON，xlsx 需第三方库不支持）。
export function csvImportForm(ctx) {
  const batches = listBatches();
  return `<section class="panel stack"><h2>第 1 步 · 上传清单与图片</h2>
<p>上传清单文件（CSV / JSON）与图片文件夹 → 校验预览 → 确认入库。图片按目录名（= 清单里规格 SKU 或商品 slug）自动配对：子目录内 <code translate="no">1.jpg 2.jpg …</code> 按数字顺序作主图集，<code translate="no">51.jpg 52.jpg …</code> 作为补充图排在后面；散图文件名 = 编号；图片未覆盖时用清单「图片」列。入库即同步到另一商店；媒体按内容哈希去重。</p>
<div class="actions"><a class="button secondary" href="/admin/import/template.csv">下载 CSV 模板（Excel 另存为 CSV(UTF-8)）</a></div>
<form method="post" action="/admin/import/upload" enctype="multipart/form-data" data-upload class="stack">${csrf(ctx.session)}
<label>① 清单文件（products.csv / products.json）<input type="file" name="manifest" accept=".csv,.json,text/csv,application/json" required></label>
<label>批次名称（留空自动按日期命名）<input name="label" maxlength="100" placeholder="例如：2026-27-first"></label>
<fieldset><legend>② 图片来源（三选一，可选）</legend>
<label class="inline"><input type="radio" name="image_source" value="folder" checked>图片文件夹（选择整个文件夹，子目录名 = 编号，推荐）</label>
<label class="inline"><input type="radio" name="image_source" value="files">散图 / 多选文件（文件名 = 编号）</label>
<input type="file" name="images" id="import-images" multiple accept="image/png,image/jpeg,image/webp,image/gif">
<p id="import-image-hint" class="error-text" style="color:#777">选择文件夹时将保留子目录结构；最多 2000 张、单张不超过 8 MB。</p>
</fieldset>
<label class="inline"><input type="checkbox" name="overwrite" value="1">允许覆盖现有商品</label>
<label class="inline"><input type="checkbox" name="draft" value="1" checked>导入后默认草稿（新建商品下架，需在商品管理手动上架）</label>
<label>批次说明（选填）<input name="note" maxlength="100" placeholder="仅用于备注"></label>
<div class="actions"><button class="button">上传并校验（进入第 2 步预览）</button></div>
</form></section>
<section class="panel"><h2>批次工作区（可回滚）</h2>
${batches.length ? `<table><thead><tr><th>批次</th><th>名称</th><th>清单规模</th><th>图片</th><th>模式</th><th>状态</th><th>结果</th><th>操作</th></tr></thead><tbody>${batches.map(b => {
  const report = (() => { try { return JSON.parse(b.report || '{}'); } catch { return {}; } })();
  let actions = '';
  if (b.status === 'preview') actions = `<form method="post" action="/admin/import/commit" class="inline-form">${csrf(ctx.session)}<input type="hidden" name="batch_id" value="${e(b.batch_id)}"><button class="button">确认入库</button></form>`;
  else if (b.status === 'imported') actions = `<form method="post" action="/admin/import/rollback" class="inline-form">${csrf(ctx.session)}<input type="hidden" name="batch_id" value="${e(b.batch_id)}"><button class="danger">回滚</button></form>`;
  return `<tr><td>${e(b.batch_id)}</td><td>${e(b.label)}</td><td>${b.total} 件</td><td>${b.images || 0} 张</td><td>${b.draft ? '草稿' : '直接上架'}${b.overwrite ? ' · 覆盖' : ''}</td><td>${{ preview: '待入库', imported: '已导入', failed: '失败', rolled_back: '已回滚' }[b.status] || b.status}</td><td>${b.status === 'imported' ? `新建 ${report.newProducts ?? b.created_products} / 更新 ${report.updatedProducts ?? b.updated_products}${report.drafted ? ' · 草稿 ' + report.drafted : ''}` : b.status === 'rolled_back' ? `还原 ${report.restored ?? 0} / 移除 ${report.removed ?? 0}` : '—'}</td><td>${actions}</td></tr>`;
}).join('')}</tbody></table>` : '<p>暂无批次。</p>'}
</section>`;
}
export function importErrorPanel(ctx, message) {
  return `<section class="panel"><h2>上传校验未通过</h2><div class="notice error">${e(message)}</div><p>清单未入库，可修正后重新上传。</p><a class="button" href="/admin/import">← 返回第 1 步</a></section>`;
}
// 粘贴式 CSV 导入（旧入口）的结果页仍在使用。
export function csvImportPanel(ctx, result) {
  return `${result.dryRun
    ? `<section class="panel"><h2>预检结果（未写入）</h2><p>新建 ${result.newProducts}，更新 ${result.updatedProducts}，跳过 ${result.skippedProducts}。确认无误后请返回重新提交并选择「执行导入」。</p></section>`
    : `<section class="panel"><h2>导入完成</h2><p>批次 #${result.batchId}：新建 ${result.newProducts} 件，更新 ${result.updatedProducts} 件，跳过 ${result.skippedProducts} 件。</p><div class="actions"><a class="button" href="/admin/products">查看商品管理</a></div></section>`}
<a href="/admin/import">← 返回批量导入</a>${csvImportForm(ctx)}`;
}
export function importPreviewPanel(ctx, result, fields) {
  const { batchId, report, imageCounts, imagesStored } = result;
  const warnings = result.warnings || [];
  const perProduct = Object.entries(imageCounts).slice(0, 50);
  return `<section class="panel stack"><h2>第 2 步 · 校验预览（未入库）</h2>
<p>批次 <strong>${e(batchId)}</strong> · 共 ${report.newProducts + report.updatedProducts + report.skippedProducts} 件商品；上传图片 ${imagesStored} 张已入库媒体库（哈希去重）。</p>
${warnings.length ? `<div class="notice error">${warnings.map(w=>e(w)).join('<br>')}</div>` : ''}
<div class="metrics"><article><span>新建</span><strong>${report.newProducts}</strong></article><article><span>更新</span><strong>${report.updatedProducts}</strong></article><article><span>跳过</span><strong>${report.skippedProducts}</strong></article></div>
${perProduct.length ? `<details><summary>逐件配图情况（前 50 件）</summary><table><thead><tr><th>商品</th><th>配图数</th></tr></thead><tbody>${perProduct.map(([slug, count]) => `<tr><td>${e(slug)}</td><td>${count} 张</td></tr>`).join('')}</tbody></table></details>` : '<p>本次未上传图片，将使用清单「图片」列。</p>'}
<div class="actions">
<form method="post" action="/admin/import/commit" class="inline-form">${csrf(ctx.session)}<input type="hidden" name="batch_id" value="${e(batchId)}"><button class="button">第 3 步 · 确认入库${fields.draft === '1' ? '（新建商品为草稿）' : ''}</button></form>
<a class="button secondary" href="/admin/import">放弃，返回第 1 步</a>
</div>
<p>入库后可在下方批次工作区回滚。</p>
</section>${csvImportForm(ctx)}`;
}
export function importDonePanel(ctx, outcome, batchId) {
  return `<section class="panel stack"><h2>第 3 步 · 入库完成</h2>
<p>批次 <strong>${e(batchId)}</strong>：新建 ${outcome.report.newProducts} 件${outcome.report.drafted ? `（其中 ${outcome.report.drafted} 件为草稿，需在<a href="/admin/products">商品管理</a>手动上架）` : ''}、更新 ${outcome.report.updatedProducts} 件、跳过 ${outcome.report.skippedProducts} 件。</p>
<div class="actions"><a class="button" href="/admin/products">查看商品管理</a><a class="button secondary" href="/admin/import">返回导入</a></div>
<p>如导入有误，可在批次工作区对该批次回滚；回滚同样会同步到另一商店。</p>
</section>`;
}
