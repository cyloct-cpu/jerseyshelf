import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv, createVerify, createPublicKey } from 'node:crypto';
import path from 'node:path';
import { db, putSetting, audit, now, transaction } from './db.mjs';
import { config } from './config.mjs';
import { InputError, email as validEmail, text } from '../../packages/contracts/validation.mjs';
import { passwordHash, random } from './security.mjs';
import { linkRegisteredCustomer } from './customers.mjs';

// ---------- 配置（settings 键 oauth：{google:{clientId,clientSecret(sealed)}}） ----------
const keyFile = path.join(path.dirname(config.dbPath), 'oauth-credentials.key');
function secretKey(create = false) {
  if (!existsSync(keyFile)) { if (!create) throw new Error('OAuth 密钥文件缺失'); writeFileSync(keyFile, randomBytes(32), { mode: 0o600 }); }
  return readFileSync(keyFile);
}
function seal(value) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', secretKey(true), iv);
  const data = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]).toString('base64');
}
function unseal(value) {
  try {
    const raw = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', secretKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  } catch { throw new InputError('OAuth 密钥无法读取，请在后台重新配置', 503); }
}
export function oauthConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key='oauth'").get();
  const s = row ? JSON.parse(row.value) : {};
  return { google: { clientId: s.google?.clientId || '', hasClientSecret: !!s.google?.clientSecret } };
}
export function googleEnabled() { const c = oauthConfig().google; return !!(c.clientId && c.hasClientSecret); }
export function saveOauthConfig(input, actor) {
  const row = db.prepare("SELECT value FROM settings WHERE key='oauth'").get();
  const s = row ? JSON.parse(row.value) : {}; s.google = { ...(s.google || {}) };
  if (typeof input.google_client_id === 'string' && input.google_client_id.trim()) s.google.clientId = text(input.google_client_id, 'Google Client ID', 200).trim();
  if (input.clear_secret === '1') delete s.google.clientSecret;
  else if (typeof input.google_client_secret === 'string' && input.google_client_secret.trim()) {
    const secret = input.google_client_secret.trim();
    if (secret.length < 16) throw new InputError('Google Client Secret 格式无效');
    s.google.clientSecret = seal(secret);
  }
  putSetting('oauth', s);
  audit(actor, 'oauth.config', s.google.clientId ? 'configured' : 'cleared');
  return oauthConfig();
}

// ---------- 端点（可用环境变量覆盖，便于本地联调与测试） ----------
const AUTH_BASE = () => process.env.GOOGLE_OAUTH_BASE || 'https://accounts.google.com';
const API_BASE = () => process.env.GOOGLE_API_BASE || 'https://www.googleapis.com';

// ---------- 授权发起 ----------
export function googleAuthUrl(baseUrl, state, nonce) {
  const c = oauthConfig().google;
  if (!googleEnabled()) throw new InputError('Google 登录未配置', 503);
  const url = new URL(AUTH_BASE() + '/o/oauth2/v2/auth');
  url.searchParams.set('client_id', c.clientId);
  url.searchParams.set('redirect_uri', baseUrl + '/account/google/callback');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('prompt', 'select_account');
  return url.href;
}

// ---------- code 换 token ----------
export async function exchangeGoogleCode(code, baseUrl, fetcher = fetch) {
  const row = db.prepare("SELECT value FROM settings WHERE key='oauth'").get();
  const s = row ? JSON.parse(row.value) : {};
  const secret = s.google?.clientSecret ? unseal(s.google.clientSecret) : '';
  if (!s.google?.clientId || !secret) throw new InputError('Google 登录未配置', 503);
  let response;
  const tokenUrl = (process.env.GOOGLE_TOKEN_BASE || 'https://oauth2.googleapis.com') + '/token';
  try {
    response = await fetcher(tokenUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: s.google.clientId, client_secret: secret, redirect_uri: baseUrl + '/account/google/callback', grant_type: 'authorization_code' }),
      signal: AbortSignal.timeout(15000), redirect: 'error'
    });
  } catch (err) {
    throw new InputError('Google 授权服务连接失败：' + (err?.name === 'TimeoutError' ? '请求超时' : '网络错误'), 502);
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new InputError('Google 授权失败：' + (payload.error_description || response.status), 502);
  if (!payload.id_token) throw new InputError('Google 未返回身份令牌', 502);
  return payload.id_token;
}

// ---------- id_token 严格验签（JWKS + RS256，含 iss/aud/exp/nonce） ----------
let jwksCache = { keys: null, at: 0 };
export function decodeJwtSegments(idToken) {
  const parts = String(idToken || '').split('.');
  if (parts.length !== 3) throw new InputError('身份令牌格式无效', 400);
  const decode = seg => {
    const normalized = seg.replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(normalized + '='.repeat((4 - normalized.length % 4) % 4), 'base64').toString('utf8'));
  };
  return { header: decode(parts[0]), payload: decode(parts[1]), signature: parts[2], signingInput: parts[0] + '.' + parts[1] };
}
export async function googleJwks(fetcher = fetch) {
  if (jwksCache.keys && Date.now() - jwksCache.at < 24 * 3600 * 1000) return jwksCache.keys;
  const response = await fetcher(API_BASE() + '/oauth2/v3/certs', { signal: AbortSignal.timeout(15000), redirect: 'error' });
  if (!response.ok) throw new InputError('Google 证书服务不可用', 502);
  const payload = await response.json();
  jwksCache = { keys: payload.keys || [], at: Date.now() };
  return jwksCache.keys;
}
export function verifyGoogleIdToken(idToken, { clientId, nonce, keys, nowMs = Date.now() }) {
  const { header, payload, signature, signingInput } = decodeJwtSegments(idToken);
  if (header.alg !== 'RS256') throw new InputError('身份令牌算法不支持', 400);
  const jwk = (keys || []).find(k => k.kid === header.kid && k.kty === 'RSA' && k.use === 'sig');
  if (!jwk) throw new InputError('身份令牌签名密钥未找到', 400);
  const publicKey = createPublicKey({ key: { kty: jwk.kty, n: jwk.n, e: jwk.e }, format: 'jwk' });
  const ok = createVerify('RSA-SHA256').update(signingInput).verify(publicKey, Buffer.from(signature.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  if (!ok) throw new InputError('身份令牌签名无效', 400);
  const iss = String(payload.iss || '').replace(/\/$/, '');
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') throw new InputError('身份令牌签发方无效', 400);
  if (payload.aud !== clientId) throw new InputError('身份令牌受众不匹配', 400);
  if (!Number.isFinite(payload.exp) || payload.exp * 1000 < nowMs) throw new InputError('身份令牌已过期', 400);
  if (nonce && payload.nonce !== nonce) throw new InputError('身份令牌 nonce 不匹配', 400);
  if (!payload.email || payload.email_verified !== true) throw new InputError('Google 账号邮箱未验证', 400);
  return { sub: String(payload.sub), email: String(payload.email), name: String(payload.name || payload.email) };
}

// ---------- 登录 / 绑定 / 自动建档 ----------
export function googleLoginOrRegister(claims) {
  return transaction(() => {
    const address = validEmail(claims.email);
    const bound = db.prepare("SELECT * FROM users WHERE oauth_provider='google' AND oauth_sub=?").get(claims.sub);
    if (bound) return bound.id;
    const existing = db.prepare('SELECT * FROM users WHERE email=?').get(address);
    if (existing) {
      db.prepare("UPDATE users SET oauth_provider='google',oauth_sub=? WHERE id=?").run(claims.sub, existing.id);
      return existing.id;
    }
    const id = Number(db.prepare("INSERT INTO users(email,password,name,role,created_at,oauth_provider,oauth_sub) VALUES(?,?,?,'customer',?,'google',?)").run(address, passwordHash(random(24)), text(claims.name, '姓名', 100, false) || address, now(), claims.sub).lastInsertRowid);
    linkRegisteredCustomer(id);
    audit(null, 'oauth.register', address);
    return id;
  });
}
