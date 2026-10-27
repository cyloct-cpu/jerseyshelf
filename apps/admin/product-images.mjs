import { escape as e } from '../api/security.mjs';

export function productImages(p) {
  const roles=JSON.parse(p.image_roles||'[]');
  const items=p.images.map((path,i)=>({path,role:i===0?'main':roles[i]&&roles[i]!=='main'?roles[i]:'unclassified',name:'图片 '+(i+1)}));
  const categories=[['main','主图','优先正面大图'],['side','侧面图','展示商品侧面效果'],['size','尺寸图','建议提供公制和英制单位'],['detail','内部细节图','展示材质与工艺'],['scene','参照场景图','展示实际使用场景']];
  return `<section class="panel product-image-panel" id="product-image-editor"><h2>图片</h2>
    <input type="hidden" id="product-images" name="images" value="${e(p.images.join('\n'))}">
    <input type="hidden" id="product-image-roles" name="image_roles" value="${e(JSON.stringify(items.map(i=>i.role)))}">
    <div id="image-initial-data" hidden>${e(JSON.stringify(items))}</div>
    <div class="image-upload-strip">${categories.map(([role,title,hint])=>`<button type="button" class="image-slot" data-upload-role="${role}"><span class="image-role-tag">${title}</span><span class="image-slot-body"><b>＋</b><span>${hint}</span></span></button>`).join('')}<button type="button" class="image-tool" id="upload-product-images"><b>↑</b>本地上传</button><button type="button" class="image-tool" id="choose-product-media"><b>▧</b>素材中心</button></div>
    <p class="image-rules">支持 JPG、PNG、WebP、GIF；每张不超过 3 MB。图片尺寸、宽高比例和数量不限，可重复添加。</p>
    <input type="file" id="product-image-files" accept="image/png,image/jpeg,image/webp,image/gif" multiple hidden>
    <input type="file" id="replace-product-image" accept="image/png,image/jpeg,image/webp,image/gif" hidden>
    <div class="image-toolbar"><span id="product-image-count"></span><span>第一张为主图，可拖动排序或使用前移、后移按钮。</span></div>
    <p id="product-image-status" role="status" aria-live="polite"></p><div class="product-image-grid" id="product-image-list"></div>
    <dialog id="product-media-dialog" class="image-dialog"><div class="toolbar"><h2>素材中心</h2><button type="button" data-close-dialog>关闭</button></div><input id="product-media-search" placeholder="搜索图片名称" aria-label="搜索图片名称"><p id="product-media-status" role="status"></p><div id="product-media-list" class="media-picker-grid"></div><div class="image-dialog-actions"><button type="button" id="confirm-product-media" class="button">添加选中图片</button><button type="button" data-close-dialog>取消</button></div></dialog>
    <dialog id="product-image-preview" class="image-dialog image-preview-dialog"><button type="button" data-close-dialog>关闭预览</button><img id="product-image-preview-img" alt="商品图片预览"></dialog>
  </section>`;
}
