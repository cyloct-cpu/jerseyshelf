import {escape as e} from '../api/security.mjs';
import {translateText} from './translations.mjs';

export const cameraIcon='<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M8 5l1.5-2h5L16 5h4a2 2 0 0 1 2 2v12H2V7a2 2 0 0 1 2-2z"/><circle cx="12" cy="12" r="4"/></svg>';
const messages={invalid:'请选择一张 JPG、PNG 或 WebP 图片（不超过 8 MB）',large:'图片像素过大，请使用不超过 2000 万像素的图片',busy:'正在以图搜款，请稍候…',failed:'搜款暂不可用，请稍后重试',crop:'裁剪选区过小，请重新选择',ready:'图片已准备好，可裁剪后开始搜款'};
export function imageSearchPanel(ctx,{preview=false}={}){
 const t=key=>translateText(key,ctx.locale||'zh-CN');
 return `<div class="image-search-panel${ctx.url.searchParams.get('image')?' has-results':''}" id="image-search-panel" data-image-query="${e(ctx.url.searchParams.get('image')||'')}" data-preview="${preview?'1':'0'}" data-csrf="${e(ctx.session.csrf)}" ${Object.entries(messages).map(([k,v])=>`data-${k}="${e(t(v))}"`).join(' ')}>
 ${preview?'<p class="notice">管理员预览：图片搜款尚未向访客开放，试验索引不代表完整图库效果。</p>':''}
 <div class="image-dropzone" id="image-dropzone"><label for="image-search-file">${cameraIcon}<strong>上传图片，寻找对应款式</strong><span>点击选图，或将图片拖到这里</span></label><input id="image-search-file" type="file" accept="image/jpeg,image/png,image/webp"><p>支持 JPG、PNG、WebP，单张不超过 8 MB；也可粘贴图片。</p></div>
 <div id="image-editor" hidden><p>拖动框选球衣区域，或使用整张图片。尽量裁掉聊天边框和无关背景。</p><canvas id="image-crop-canvas" tabindex="0" aria-label="图片裁剪预览"></canvas><div class="image-crop-controls"><label>左边界<input type="range" min="0" max="90" value="0" id="crop-left"></label><label>上边界<input type="range" min="0" max="90" value="0" id="crop-top"></label><label>宽度<input type="range" min="10" max="100" value="100" id="crop-width"></label><label>高度<input type="range" min="10" max="100" value="100" id="crop-height"></label></div><div class="image-search-actions"><button type="button" id="image-use-all">使用整张图片</button><button type="button" id="image-search-submit" class="button">开始搜款</button><button type="button" id="image-search-cancel">取消</button></div></div>
 <div id="image-query-preview" ${ctx.url.searchParams.get('image')?'':'hidden'}><img id="image-query-thumb" alt="本次搜索图片" hidden><span>相似款式</span><a href="/search?mode=image">更换图片</a></div>
 <p id="image-search-status" role="status" aria-live="polite"></p><p class="muted">图片仅用于本次搜款，处理后不保存原图。结果为相似款候选，请核对赛季、版本和细节。</p></div><link rel="stylesheet" href="/assets/image-search.css"><script src="/assets/image-search.js" defer></script>`;
}
