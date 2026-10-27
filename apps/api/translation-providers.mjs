import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.mjs';
import { db, putSetting, transaction } from './db.mjs';
import { InputError } from '../../packages/contracts/validation.mjs';

export const translationProviders = [
  {id:'google-free',name:'Google 免费端点',period:'month',priority:5,limit:450000,max:500000,docs:''},
  {id:'azure',name:'微软 Azure F0',period:'month',priority:10,limit:1900000,max:2000000,docs:'https://azure.microsoft.com/en-us/pricing/details/translator/'},
  {id:'baidu',name:'百度通用翻译',period:'month',priority:20,limit:45000,max:50000,docs:'https://fanyi-api.baidu.com/doc/13'},
  {id:'deepl',name:'DeepL API Free',period:'month',priority:30,limit:450000,max:500000,docs:'https://www.deepl.com/en/your-account/keys'},
  {id:'lingva',name:'Lingva',period:'month',priority:35,limit:190000,max:200000,docs:'https://lingva.ml'},
  {id:'mymemory',name:'MyMemory',period:'day',priority:40,limit:4500,max:4500,docs:'https://mymemory.translated.net/doc/spec.php'}
];
const plans = {standard:50000,advanced:1000000,enterprise:2000000};
const keyFile = path.join(path.dirname(config.dbPath),'translation-credentials.key');
function key(create = false) {
  if (create && !existsSync(keyFile)) { try { writeFileSync(keyFile,randomBytes(32),{mode:0o600,flag:'wx'}); } catch (error) { if (error.code !== 'EEXIST') throw error; } }
  const value = readFileSync(keyFile); if (value.length !== 32) throw new Error('Invalid translation key file'); return value;
}
function seal(value) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm',key(true),iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value),'utf8'),cipher.final()]);
  return Buffer.concat([iv,cipher.getAuthTag(),data]).toString('base64');
}
export function providerCredentials(provider) {
  const stored = storedProviders()[provider];
  if (!stored?.secret) return null;
  try {
    const data = Buffer.from(stored.secret,'base64'), decipher = createDecipheriv('aes-256-gcm',key(),data.subarray(0,12));
    decipher.setAuthTag(data.subarray(12,28));
    return JSON.parse(Buffer.concat([decipher.update(data.subarray(28)),decipher.final()]).toString('utf8'));
  } catch { throw new InputError('翻译密钥无法解密，请在后台重新填写该接口的密钥',503); }
}
function storedProviders() {
  const row = db.prepare("SELECT value FROM settings WHERE key='translation_providers'").get();
  return row ? JSON.parse(row.value) : {};
}
export function providerPeriod(definition, time = Date.now()) {
  const iso = new Date(time).toISOString();
  return definition.period === 'day' ? iso.slice(0,10) : iso.slice(0,7);
}
export function nextProviderPeriod(definition, time = Date.now()) {
  const date = new Date(time);
  return definition.period === 'day' ? Date.UTC(date.getUTCFullYear(),date.getUTCMonth(),date.getUTCDate()+1) : Date.UTC(date.getUTCFullYear(),date.getUTCMonth()+1,1);
}
export function providerState(provider) {
  return db.prepare('SELECT * FROM translation_provider_state WHERE provider=?').get(provider)||{reason:'',last_error:'',resume_at:0,last_success:''};
}
export function setProviderState(provider, {reason = '',message = '',resumeAt = 0,lastSuccess} = {}) {
  const old = providerState(provider);
  db.prepare(`INSERT INTO translation_provider_state(provider,reason,last_error,resume_at,last_success) VALUES(?,?,?,?,?) ON CONFLICT(provider) DO UPDATE SET reason=excluded.reason,last_error=excluded.last_error,resume_at=excluded.resume_at,last_success=excluded.last_success`).run(provider,reason,message,resumeAt,lastSuccess??old.last_success);
}
export function providerConfigurations(time = Date.now()) {
  const stored = storedProviders();
  return translationProviders.map(def => {
    const saved = stored[def.id]||{},state = providerState(def.id), periodKey = providerPeriod(def,time);
    const usage = db.prepare('SELECT characters,requests FROM translation_provider_usage WHERE provider=? AND period=?').get(def.id,periodKey)||{characters:0,requests:0};
    const offset = saved.offsetPeriod === periodKey ? saved.externalUsage||0 : 0;
    return {...def,enabled:def.id==='mymemory'?saved.enabled!==false:saved.enabled===true,configured:def.id==='mymemory'||def.id==='google-free'||def.id==='lingva'||Boolean(saved.secret),priority:saved.priority??def.priority,limit:saved.limit??def.limit,plan:saved.plan||'standard',region:saved.region||'',state,usage:{...usage,external:offset,total:usage.characters+offset},periodKey};
  }).sort((a,b)=>a.priority-b.priority||a.id.localeCompare(b.id));
}
export function publicProviderStatuses(time = Date.now()) {
  return providerConfigurations(time).map(p => {
    const status = !p.configured ? '未配置密钥' : !p.enabled ? '已关闭' : p.state.reason === 'auth' ? '需要检查密钥' : p.usage.total >= p.limit ? '达到本站上限' : p.state.resume_at>time ? (p.state.reason === 'quota'?'额度等待':'等待重试') : !['mymemory','google-free','lingva'].includes(p.id)&&!p.state.last_success?'已配置，待验证':'可用';
    return {id:p.id,name:p.name,enabled:p.enabled,configured:p.configured,priority:p.priority,limit:p.limit,period:p.period,periodKey:p.periodKey,plan:p.plan,region:p.region,usage:p.usage,status,lastError:p.state.last_error,resumeAt:p.usage.total>=p.limit?nextProviderPeriod(p,time):p.state.resume_at,lastSuccess:p.state.last_success,docs:p.docs};
  });
}
export function initializeTranslationProviders() {
  if (db.prepare("SELECT key FROM settings WHERE key='translation_providers'").get()) return;
  transaction(() => {
    const cfg = db.prepare("SELECT value FROM settings WHERE key='translation_config'").get();
    const previous = cfg ? JSON.parse(cfg.value) : {};
    const legacy = db.prepare("SELECT value FROM settings WHERE key='translation_state'").get();
    const state = legacy ? JSON.parse(legacy.value) : {};
    putSetting('translation_providers',{mymemory:{enabled:true,priority:40,limit:previous.dailyLimit||4500}});
    putSetting('translation_config',{enabled:previous.enabled!==false,dailyLimit:200000,version:2});
    if (state.resumeAt>Date.now()) setProviderState('mymemory',{reason:/额度|上限/.test(state.lastError)?'quota':'network',message:state.lastError,resumeAt:state.resumeAt});
    // The old single-provider cooldown must not prevent a newly configured provider.
    putSetting('translation_state',{});
    db.prepare("UPDATE translation_jobs SET next_attempt=0 WHERE status='pending'").run();
  });
}
function secretInput(value, label) {
  const text = String(value||'').trim();
  if (text && !/^[\x21-\x7e]{8,512}$/.test(text)) throw new InputError(label+'格式无效');
  return text;
}
export function saveTranslationProvider(input) {
  const definition = translationProviders.find(p=>p.id===input.provider);
  if (!definition) throw new InputError('翻译接口不存在');
  const all = storedProviders(), old = all[definition.id]||{}, enabled = input.enabled==='1';
  const priority = Number(input.priority), limit = Number(input.limit), plan = input.plan||old.plan||'standard';
  const max = definition.id==='baidu' ? plans[plan] : definition.max;
  if (!max || !Number.isInteger(priority)||priority<1||priority>99||!Number.isInteger(limit)||limit<1||limit>max) throw new InputError('接力顺序或字符上限无效，上限不能高于所选免费档额度');
  const typed = secretInput(input.api_key,'API密钥'), appId = String(input.app_id||'').trim();
  if (typed && input.clear_key==='1') throw new InputError('填写密钥与删除密钥不能同时选择');
  const keyless = ['mymemory','google-free','lingva'];
  let secret = input.clear_key==='1'?'':old.secret||'';
  if (!keyless.includes(definition.id)) {
    if (typed) {
      if (definition.id==='baidu'&&!/^\d{8,30}$/.test(appId)) throw new InputError('请同时填写有效的百度AppID');
      if (definition.id==='deepl'&&!typed.endsWith(':fx')) throw new InputError('这里只接受以 :fx 结尾的 DeepL API Free 密钥');
      secret = seal({key:typed,...(definition.id==='baidu'?{appId}:{})});
    } else if (appId) throw new InputError('更新百度AppID时请同时填写对应密钥');
    if (enabled && !secret) throw new InputError('启用此接口前请先填写密钥');
    if (enabled && input.free_plan_confirmed!=='1') throw new InputError('请确认已开通对应免费档，并将上限设置在当前可用免费额度内');
  }
  const region = String(input.region??old.region??'').trim();
  if (region && !/^[a-z0-9-]{2,50}$/.test(region)) throw new InputError('Azure资源区域格式无效');
  const periodKey = providerPeriod(definition), externalUsage = input.external_usage===''||input.external_usage===undefined ? old.offsetPeriod===periodKey?old.externalUsage||0:0 : Number(input.external_usage);
  if (!Number.isSafeInteger(externalUsage)||externalUsage<0||externalUsage>max) throw new InputError('本期其他渠道用量无效');
  const changed = Boolean(typed||input.clear_key==='1'||region!==old.region);
  transaction(() => {
    all[definition.id]={enabled,priority,limit,plan,region,secret,externalUsage,offsetPeriod:periodKey};
    putSetting('translation_providers',all);
    const state = providerState(definition.id);
    // Saving/reordering never clears a known quota cooldown or usage accounting.
    if (changed && state.reason==='auth') setProviderState(definition.id);
    db.prepare("UPDATE translation_jobs SET status='pending',attempts=0,next_attempt=0 WHERE status IN ('pending','failed','unsupported')").run();
    putSetting('translation_state',{});
  });
  return definition.id;
}
