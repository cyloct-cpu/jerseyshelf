import { createHash } from 'node:crypto';

// No Meta resources load until an affirmative, current marketing choice exists.
export const metaPixelScript = `
if (!window.__jerseyShelfMetaConsentController) {
window.__jerseyShelfMetaConsentController = true;
const consentName = 'js_meta_consent';
const signalName = 'jerseyshelf-meta-consent-v1';
const gpc = navigator.globalPrivacyControl === true;
let revoked = false;
function allowed() {
  return !gpc && document.cookie.split(';').some(c => c.trim() === consentName + '=v1.accepted');
}
function startPixel() {
if (!window.__jerseyShelfMetaPixelInitialized) {
window.__jerseyShelfMetaPixelInitialized = true;
!function(f,b,e,v,n,t,s)
{if(f.fbq)return;n=f.fbq=function(){n.callMethod?
n.callMethod.apply(n,arguments):n.queue.push(arguments)};
if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';
n.queue=[];t=b.createElement(e);t.async=!0;
t.src=v;s=b.getElementsByTagName(e)[0];
s.parentNode.insertBefore(t,s)}(window, document,'script',
'https://connect.facebook.net/en_US/fbevents.js');
fbq('init', '1697741321689628');
fbq('track', 'PageView');
}
}
function clearMetaCookies() {
  for (const name of ['_fbp', '_fbc']) {
    document.cookie = name + '=; Path=/; Max-Age=0; Secure; SameSite=Lax';
    const parts = location.hostname.split('.');
    for (let i = 0; i !== parts.length - 1; i++) {
      document.cookie = name + '=; Path=/; Max-Age=0; Secure; SameSite=Lax; Domain=.' + parts.slice(i).join('.');
    }
  }
}
function syncChoice() {
  if (allowed()) {
    if (revoked && window.fbq) fbq('consent', 'grant');
    revoked = false;
    startPixel();
  } else {
    if (window.__jerseyShelfMetaPixelInitialized && !revoked && window.fbq) fbq('consent', 'revoke');
    revoked = true;
    clearMetaCookies();
  }
  const panel = document.getElementById('meta-consent-panel');
  if (panel) panel.hidden = gpc || document.cookie.split(';').some(c => /^js_meta_consent=v1.(accepted|rejected)$/.test(c.trim()));
  const status = document.getElementById('meta-consent-status');
  if (status) status.textContent = gpc ? 'Global Privacy Control is enabled. Meta tracking is off.' : allowed() ? 'Meta advertising cookies: accepted.' : 'Meta advertising cookies: off.';
}
function saveChoice(choice) {
  document.cookie = consentName + '=v1.' + choice + '; Path=/; Max-Age=15552000; SameSite=Lax; Secure';
  try { localStorage.setItem(signalName, choice + ':' + Date.now()); } catch {}
  syncChoice();
}
syncChoice();
function bindControls() {
  document.querySelectorAll('[data-meta-consent]').forEach(button => {
    if (gpc && button.dataset.metaConsent === 'accepted') button.disabled = true;
    button.addEventListener('click', () => saveChoice(button.dataset.metaConsent));
  });
  document.querySelectorAll('[data-meta-preferences]').forEach(button => button.addEventListener('click', () => {
    const panel = document.getElementById('meta-consent-panel');
    if (panel) { panel.hidden = false; panel.querySelector('button').focus(); }
  }));
  syncChoice();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindControls, {once:true});
else bindControls();
window.addEventListener('storage', event => { if (event.key === signalName) syncChoice(); });
window.addEventListener('pageshow', syncChoice);
document.addEventListener('visibilitychange', () => { if (!document.hidden) syncChoice(); });
}
`;

export const metaPixelHead = `<link rel="stylesheet" href="/assets/meta-pixel.css"><!-- Meta Pixel Code --><script>${metaPixelScript}</script><!-- End Meta Pixel Code -->`;
// Images belong in body; hidden also preserves the layout under strict style-src.
export const metaPixelNoscript = `<noscript><img height="1" width="1" style="display:none" hidden alt="" src="https://www.facebook.com/tr?id=1697741321689628&amp;ev=PageView&amp;noscript=1"></noscript>`;

export const hasMetaConsent = cookie => String(cookie || '').split(';').some(c => c.trim() === 'js_meta_consent=v1.accepted');
export function metaPixelBody(ctx = {}) {
  const zh = String(ctx.locale || '').startsWith('zh');
  return `${ctx.metaMarketingConsent ? metaPixelNoscript : ''}<aside id="meta-consent-panel" aria-label="${zh?'广告 Cookie 选择':'Advertising cookie choices'}" translate="no"><strong>${zh?'您的广告 Cookie 选择':'Your advertising cookie choices'}</strong><p>${zh?'只有您接受后，我们才会启用 Meta Pixel，将访问网址、浏览器及设备信息和 Cookie 标识符发送给 Meta，用于广告效果衡量和相关广告。拒绝不影响购物。':'Only if you accept, we enable Meta Pixel to share visited URLs, browser/device information and cookie identifiers with Meta for advertising measurement and relevant ads. Rejecting does not affect shopping.'}</p><p><a href="/pages/privacy-statement">${zh?'隐私及 Cookie 告知':'Privacy and cookie notice'}</a> · <a href="https://www.facebook.com/privacy/policy/" rel="noopener noreferrer" target="_blank">Meta Privacy Policy</a></p><p id="meta-consent-status" aria-live="polite"></p><div class="meta-consent-actions"><button type="button" data-meta-consent="rejected">${zh?'拒绝广告 Cookie':'Reject advertising cookies'}</button><button type="button" data-meta-consent="accepted">${zh?'接受广告 Cookie':'Accept advertising cookies'}</button></div></aside><button type="button" id="meta-consent-preferences" data-meta-preferences translate="no">${zh?'广告 Cookie 设置':'Ad cookie settings'}</button><noscript><p translate="no">Meta tracking is off unless you previously accepted advertising cookies. Enable JavaScript to manage your choice.</p></noscript>`;
}

export function metaPrivacyNotice(locale) {
  const zh = String(locale || '').startsWith('zh');
  return `<section class="section narrow" translate="no"><h1>${zh?'Meta 广告 Cookie 与隐私告知':'Meta advertising cookies and privacy notice'}</h1><p>${zh?'JerseyShelf 仅在您明确接受广告 Cookie 后启用 Meta Pixel（ID 1697741321689628）。未选择、拒绝或启用 Global Privacy Control 时不加载 Meta 脚本，也不发送 PageView。':'JerseyShelf enables Meta Pixel (ID 1697741321689628) only after you accept advertising cookies. No choice, rejection or Global Privacy Control means no Meta script and no PageView.'}</p><p>${zh?'用途：衡量 Facebook/Instagram 广告效果，并支持相关广告与再营销。接受后，访问网址、浏览器和设备信息、IP 地址及 Cookie 标识符可能发送给 Meta，并可能与您的 Meta 账户关联。本次仅配置 PageView，未添加姓名、邮箱、电话、购物车或订单明细等自定义事件参数。':'Purpose: measure Facebook/Instagram advertising and support relevant ads and remarketing. After acceptance, visited URLs, browser/device information, IP address and cookie identifiers may be sent to Meta and associated with your Meta account. This installation configures only PageView and adds no names, emails, phone numbers, cart or order details as custom event parameters.'}</p><p>${zh?'接收方：Meta Platforms，包括按地区适用的 Meta Platforms Ireland Limited / Meta Platforms, Inc.。Meta 按其隐私政策处理数据，可能涉及跨境处理。':'Recipient: Meta Platforms, including Meta Platforms Ireland Limited / Meta Platforms, Inc. as applicable to your region. Meta processes data under its privacy policy, potentially across borders.'} <a href="https://www.facebook.com/privacy/policy/" rel="noopener noreferrer" target="_blank">Meta Privacy Policy</a> · <a href="https://www.facebook.com/policies/cookies/" rel="noopener noreferrer" target="_blank">Meta Cookie Policy</a></p><p>${zh?'您的选择：接受与拒绝均为自愿，拒绝不影响购物。可通过每页“广告 Cookie 设置”随时改变或撤回选择。选择保存在本网站 js_meta_consent Cookie 中，最长 180 天；到期后重新询问。同一浏览器的其他打开页面会同步选择。撤回后停止此站后续 Pixel 事件并清除可访问的 _fbp / _fbc Cookie，已发送的数据不会自动删除。':'Your choice: accepting and rejecting are voluntary; rejection does not affect shopping. Use “Ad cookie settings” on any page to change or withdraw your choice. We store your choice in our js_meta_consent cookie for up to 180 days, then ask again. Other open tabs in the same browser synchronize the choice. Withdrawal stops subsequent Pixel events on this site and clears accessible _fbp / _fbc cookies; it does not automatically delete data already sent.'}</p><p>${zh?'Meta 可能使用 _fbp / _fbc 等广告 Cookie，其具体有效期及数据保存以 Meta 政策为准。js_meta_consent 及本地存储的同步信号仅用于记住和同步选择，与账户、购物车等必要 Cookie 分开。':'Meta may use advertising cookies such as _fbp / _fbc; their duration and Meta data retention are described in Meta policies. js_meta_consent and a local-storage synchronization signal only remember and synchronize your choice, separately from necessary account and cart cookies.'}</p><p>${zh?'更新日期：2026-10-23。本告知仅说明本次新增 Meta 追踪；网站其他数据处理的完整隐私声明仍需经营者补全。':'Updated 2026-10-23. This notice covers this Meta tracking installation; the operator still needs to complete a full privacy statement covering other site data processing.'}</p><button type="button" data-meta-preferences>${zh?'管理广告 Cookie':'Manage advertising cookies'}</button></section>`;
}

const scriptHash = createHash('sha256').update(metaPixelScript).digest('base64');
export function withMetaPixelCsp(policy) {
  return policy
    .replace("script-src 'self'", `script-src 'self' 'sha256-${scriptHash}' https://connect.facebook.net`)
    .replace("img-src 'self' blob:", "img-src 'self' blob: https://www.facebook.com https://www.facebook.net")
    .replace("connect-src 'self'", "connect-src 'self' https://www.facebook.com https://www.facebook.net");
}
