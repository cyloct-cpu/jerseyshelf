import { db, putSetting, audit } from './db.mjs';
import { InputError, text } from '../../packages/contracts/validation.mjs';
import { sealTo, unsealFrom } from './secrets.mjs';
import { catalog } from './catalog.mjs';
import { usdFx } from './currencies.mjs';

// 视觉大模型兜底：CLIP 相似分低于阈值时，把原图交给 OpenAI 兼容的视觉模型，
// 提取「球队/赛季/类型」属性转成搜索词，走站内文字索引出候选。全程失败则维持无结果。
const SETTING = 'image_search_fallback';
const KEY_NAME = 'image-search-fallback-credentials';
export function fallbackConfig() {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTING);
  const s = row ? JSON.parse(row.value) : {};
  return { enabled: s.enabled === true, baseUrl: s.baseUrl || '', model: s.model || '', hasApiKey: !!s.apiKey };
}
export function saveFallbackConfig(input, actor) {
  const row = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTING);
  const s = row ? JSON.parse(row.value) : {};
  if (typeof input.fallback_base_url === 'string' && input.fallback_base_url.trim()) {
    const url = text(input.fallback_base_url, '接口地址', 300).trim().replace(/\/+$/, '');
    if (!/^https:\/\/[A-Za-z0-9.-]+(:\d+)?(\/[A-Za-z0-9._/-]*)?$/.test(url)) throw new InputError('接口地址须为 https:// 开头的有效地址');
    s.baseUrl = url;
  }
  if (typeof input.fallback_model === 'string' && input.fallback_model.trim()) s.model = text(input.fallback_model, '模型名称', 200).trim();
  if (input.clear_key === '1') delete s.apiKey;
  else if (typeof input.fallback_api_key === 'string' && input.fallback_api_key.trim()) {
    const key = input.fallback_api_key.trim();
    if (key.length < 16) throw new InputError('API Key 格式无效');
    s.apiKey = sealTo(KEY_NAME, key);
  }
  s.enabled = input.fallback_enabled === '1';
  if (s.enabled && (!s.baseUrl || !s.model || !s.apiKey)) throw new InputError('开启兜底前需填写接口地址、模型名称与 API Key');
  putSetting(SETTING, s);
  audit(actor, 'image-search.fallback_config', s.enabled ? 'enabled' : 'disabled');
  return fallbackConfig();
}
const PROMPT = 'You help identify football/soccer jerseys from a photo. Reply with ONE short English search query naming ONLY the likely team and season (max 6 words), e.g. "Bayern Munich 2026/27". Do not include words like jersey or kit. If unsure, still give your best guess. Reply with the query text only, no quotes.';

async function callVisionModel(bytes, contentType, fetcher) {
  const s = (() => { const row = db.prepare('SELECT value FROM settings WHERE key=?').get(SETTING); return JSON.parse(row.value); })();
  const key = unsealFrom(KEY_NAME, s.apiKey, '兜底模型密钥无法读取，请在后台重新配置');
  const response = await fetcher(s.baseUrl + '/chat/completions', {
    method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: s.model, max_tokens: 60, temperature: 0,
      messages: [{ role: 'user', content: [
        { type: 'text', text: PROMPT },
        { type: 'image_url', image_url: { url: `data:${contentType || 'image/jpeg'};base64,${bytes.toString('base64')}` } }
      ] }]
    }),
    signal: AbortSignal.timeout(20000), redirect: 'error'
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new InputError('兜底模型接口错误：' + (payload.error?.message || response.status), 502);
  const query = String(payload.choices?.[0]?.message?.content || '').trim().replace(/^["'`]+|["'`]+$/g, '').slice(0, 80);
  if (!query) throw new InputError('兜底模型未返回有效描述', 502);
  return query;
}
// 返回文字搜索候选（产品卡片数组）。供 submitImageSearch 在低于阈值时调用。
export async function visionFallbackSearch(bytes, contentType, fetcher = fetch) {
  const cfg = fallbackConfig();
  if (!cfg.enabled) return null;
  const query = await callVisionModel(bytes, contentType, fetcher);
  const result = catalog({ q: query }, false, usdFx);
  return { query, products: result.products.map(p => ({ id: p.id, title: p.title, slug: p.slug })) };
}
export async function testFallbackConnection(fetcher = fetch) {
  const cfg = fallbackConfig();
  if (!cfg.baseUrl || !cfg.model) throw new InputError('请先填写接口地址与模型名称');
  const s = JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(SETTING).value);
  const key = s.apiKey ? unsealFrom(KEY_NAME, s.apiKey) : '';
  if (!key) throw new InputError('尚未配置 API Key');
  const response = await fetcher(cfg.baseUrl + '/models', { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new InputError('接口连接失败：HTTP ' + response.status, 502);
  return '接口连接成功';
}
