import { createHash, randomBytes } from 'node:crypto';
import { translationJsonRequest } from './translation-http.mjs';
import { TranslationError } from './translation-errors.mjs';
export { TranslationError } from './translation-errors.mjs';

// MyMemory's q parameter is limited in UTF-8 bytes, not JavaScript characters.
// Prefer sentence/word boundaries and never split a surrogate pair.
export function translationChunks(value, limit = 480) {
  const chars = Array.from(String(value).trim()), chunks = [];
  while (chars.length) {
    let bytes = 0, end = 0, boundary = 0;
    for (; end < chars.length; end++) {
      const length = Buffer.byteLength(chars[end]);
      if (bytes + length > limit) break;
      bytes += length;
      if (/[\s。！？.!?；;]/u.test(chars[end])) boundary = end + 1;
    }
    if (!end) throw new TranslationError('翻译分段长度无效', 'invalid');
    const take = end < chars.length && boundary > end / 2 ? boundary : end;
    const chunk = chars.splice(0, take).join('').trim();
    if (chunk) chunks.push(chunk);
  }
  return chunks;
}

function decodeEntities(text) {
  return text.replace(/&#(x[0-9a-f]+|\d+);/gi, (all, code) => {
    const point = code[0].toLowerCase() === 'x' ? parseInt(code.slice(1), 16) : Number(code);
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : all;
  }).replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name) => ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' '}[name]));
}

export function parseTranslation(payload, { source, target }) {
  const status = Number(payload?.responseStatus), detail = String(payload?.responseDetails || '');
  const rawText = payload?.responseData?.translatedText;
  const translated = typeof rawText==='string' ? decodeEntities(rawText).trim() : '';
  if (status === 429 || payload?.quotaFinished === true || /USED ALL AVAILABLE|FREE TRANSLATIONS FOR TODAY/i.test(detail + translated)) {
    const wait = (detail + translated).match(/(\d+) HOURS?\s+(\d+) MINUTES?\s+(\d+) SECONDS?/i);
    const retry = wait ? (Number(wait[1]) * 3600 + Number(wait[2]) * 60 + Number(wait[3]) + 60) * 1000 : 3600000;
    throw new TranslationError('免费接口额度已用完，等待恢复后自动继续', 'quota', Math.max(60000, Math.min(86400000, retry)));
  }
  if (/INVALID LANGUAGE PAIR|NOT SUPPORTED|IS NOT SUPPORTED/i.test(detail + translated) || payload?.mtLangSupported === false && status !== 200) {
    throw new TranslationError('接口暂不支持此语言对，可使用商品的人工译文', 'unsupported', 86400000);
  }
  if (status !== 200 || !translated || translated.length > 20000 || /MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID LANGUAGE/i.test(translated)) {
    throw new TranslationError('免费接口没有返回有效译文，请稍后重试', 'invalid', 300000);
  }
  if (target === 'en' && /\p{Script=Han}/u.test(source) && /\p{Script=Han}/u.test(translated)) {
    throw new TranslationError('英文译文仍含中文，已保留原文并等待重试', 'invalid', 300000);
  }
  return translated;
}

export function validatedTranslation(value, source, target) {
  if (typeof value !== 'string' || !value.trim() || value.length > 20000) throw new TranslationError('翻译接口没有返回有效译文','invalid',300000);
  const translated = decodeEntities(value).trim();
  if (target === 'en' && /\p{Script=Han}/u.test(source) && /\p{Script=Han}/u.test(translated)) throw new TranslationError('英文译文仍含中文，已尝试下一个服务','invalid',300000);
  return translated;
}

export async function myMemoryTranslate(source, sourceLocale, targetLocale, fetcher = fetch) {
  if (!source || Buffer.byteLength(source) > 500) throw new TranslationError('单次翻译必须为 1–500 字节','invalid');
  const url = new URL('https://api.mymemory.translated.net/get');
  url.search = new URLSearchParams({q:source,langpair:sourceLocale+'|'+targetLocale,mt:'1'}).toString();
  const {status,payload,retryMs} = await translationJsonRequest(url,{headers:{Accept:'application/json'}},fetcher);
  if (status >= 500) throw new TranslationError('MyMemory暂时不可用','network',retryMs);
  return parseTranslation({...payload,responseStatus:payload.responseStatus||status},{source,target:targetLocale});
}

function httpFailure(status, retryMs, name) {
  if ([401,403].includes(status)) throw new TranslationError(name+'密钥或账号权限无效，请检查后台配置','auth');
  if (status === 429) throw new TranslationError(name+'请求过于频繁，稍后自动恢复','rate',retryMs);
  if (status >= 500 || status === 408) throw new TranslationError(name+'暂时不可用，已尝试下一个服务','network',retryMs);
  if (status < 200 || status >= 300) throw new TranslationError(name+'没有返回有效译文','invalid',300000);
}
const azureLocale = locale => ({'zh-CN':'zh-Hans','zh-TW':'zh-Hant','no':'nb','hmn':'mww','tl':'fil'}[locale]||locale);
export async function azureTranslate(source, from, to, credentials, options = {}, fetcher = fetch) {
  const url = new URL('https://api.cognitive.microsofttranslator.com/translate');
  url.search = new URLSearchParams({'api-version':'3.0',from:azureLocale(from),to:azureLocale(to),textType:'plain'}).toString();
  const headers = {'Content-Type':'application/json; charset=UTF-8','Ocp-Apim-Subscription-Key':credentials.key};
  if (options.region) headers['Ocp-Apim-Subscription-Region'] = options.region;
  const {status,payload,retryMs} = await translationJsonRequest(url,{method:'POST',headers,body:JSON.stringify([{Text:source}])},fetcher);
  const code = Number(payload?.error?.code);
  if (code === 403001) throw new TranslationError('微软F0免费额度已用完，已尝试下一个服务','quota',86400000);
  if ([400003,400004,400006,400018,400019,400023,400035,400036].includes(code)) throw new TranslationError('微软暂不支持此语言对','unsupported',86400000);
  httpFailure(status,retryMs,'微软');
  return validatedTranslation(payload?.[0]?.translations?.find(row => row.to?.toLowerCase() === azureLocale(to).toLowerCase())?.text,source,to);
}
const baiduLocales = {en:'en','zh-CN':'zh','zh-TW':'cht',ja:'jp',ko:'kor',fr:'fra',es:'spa',ar:'ara',bg:'bul',et:'est',da:'dan',fi:'fin',ro:'rom',sl:'slo',sv:'swe',vi:'vie',de:'de',ru:'ru',pt:'pt',it:'it',nl:'nl',pl:'pl',cs:'cs',hu:'hu',th:'th',el:'el'};
export function providerSupports(provider, from, to) {
  if (to === 'ha-Arab') return false;
  if (provider === 'baidu') return Boolean(baiduLocales[from] && baiduLocales[to]);
  return true; // Other adapters use the official response to determine support.
}
const GOOGLE_FREE_HOST = (process.env.GOOGLE_FREE_BASE||'https://translate.googleapis.com').replace(/^https:\/\//,'');
const LINGVA_HOST = (process.env.LINGVA_BASE||'https://lingva.ml').replace(/^https:\/\//,'');
export async function baiduTranslate(source, from, to, credentials, options = {}, fetcher = fetch) {
  if (!providerSupports('baidu',from,to)) throw new TranslationError('百度通用翻译免费版本暂不支持此语言对','unsupported',86400000);
  const salt = randomBytes(16).toString('hex');
  const sign = createHash('md5').update(credentials.appId+source+salt+credentials.key).digest('hex');
  const body = new URLSearchParams({q:source,from:baiduLocales[from],to:baiduLocales[to],appid:credentials.appId,salt,sign}).toString();
  const {status,payload,retryMs} = await translationJsonRequest(new URL('https://fanyi-api.baidu.com/api/trans/vip/translate'),{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'},body},fetcher);
  const code = String(payload?.error_code || '');
  if (code === '54004') throw new TranslationError('百度免费额度或账户可用量不足，已尝试下一个服务','quota',86400000);
  if (['52003','54001','58000','58002','90107'].includes(code)) throw new TranslationError('百度AppID、密钥或服务权限无效，请检查后台配置','auth');
  if (['54003','54005'].includes(code)) throw new TranslationError('百度请求过于频繁，稍后自动恢复','rate',retryMs);
  if (['52001','52002'].includes(code)) throw new TranslationError('百度暂时不可用，已尝试下一个服务','network',retryMs);
  if (code === '58001') throw new TranslationError('百度暂不支持此语言对','unsupported',86400000);
  if (code) throw new TranslationError('百度暂未返回有效译文','invalid',300000);
  httpFailure(status,retryMs,'百度');
  return validatedTranslation(Array.isArray(payload.trans_result)?payload.trans_result.map(row=>row.dst).join('\n'):null,source,to);
}
const deeplLocale = locale => ({'zh-CN':'ZH-HANS','zh-TW':'ZH-HANT',en:'EN-US',pt:'PT-PT','no':'NB'}[locale]||locale.toUpperCase());
export async function deeplTranslate(source, from, to, credentials, options = {}, fetcher = fetch) {
  // The paid api.deepl.com host is deliberately never selected.
  const body = {text:[source],source_lang:from.startsWith('zh-')?'ZH':from.toUpperCase(),target_lang:deeplLocale(to)};
  const {status,payload,retryMs} = await translationJsonRequest(new URL('https://api-free.deepl.com/v2/translate'),{method:'POST',headers:{Authorization:'DeepL-Auth-Key '+credentials.key,'Content-Type':'application/json'},body:JSON.stringify(body)},fetcher);
  if (status === 456) throw new TranslationError('DeepL免费额度已用完，已尝试下一个服务','quota',86400000);
  if (status === 400) throw new TranslationError('DeepL暂不支持此语言对或请求','unsupported',86400000);
  httpFailure(status,retryMs,'DeepL');
  return validatedTranslation(payload?.translations?.[0]?.text,source,to);
}
// 免费无密钥端点：Google gtx 与 Lingva。非官方接口，仅作为接力链最前的高吞吐选择，
// 失败/封锁时按临时错误退避并自动落到密钥型提供方；限流降级不会影响配额核算。
const freeLocales = value => ({'zh-CN':'zh-CN','zh-TW':'zh-TW'}[value]||value);
export async function googleFreeTranslate(source, from, to, credentials, options = {}, fetcher = fetch) {
  const url = new URL((process.env.GOOGLE_FREE_BASE||'https://translate.googleapis.com')+'/translate_a/single');
  url.search = new URLSearchParams({client:'gtx',sl:freeLocales(from),tl:freeLocales(to),dt:'t',q:source}).toString();
  const {status,payload,retryMs} = await translationJsonRequest(url,{headers:{Accept:'application/json'}},fetcher);
  httpFailure(status,retryMs,'Google免费端点');
  const segments = Array.isArray(payload?.[0]) ? payload[0].map(part=>part?.[0]).filter(Boolean) : [];
  return validatedTranslation(segments.join(''),source,to);
}
export async function lingvaTranslate(source, from, to, credentials, options = {}, fetcher = fetch) {
  const url = new URL((process.env.LINGVA_BASE||'https://lingva.ml')+'/api/v1/'+freeLocales(from)+'/'+freeLocales(to)+'/'+encodeURIComponent(source));
  const {status,payload,retryMs} = await translationJsonRequest(url,{headers:{Accept:'application/json'}},fetcher);
  httpFailure(status,retryMs,'Lingva');
  return validatedTranslation(payload?.translation,source,to);
}
export const providerAdapters = {mymemory:(source,from,to,credentials,options,fetcher)=>myMemoryTranslate(source,from,to,fetcher),azure:azureTranslate,baidu:baiduTranslate,deepl:deeplTranslate,'google-free':googleFreeTranslate,lingva:lingvaTranslate};
