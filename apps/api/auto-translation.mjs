import { createHash } from 'node:crypto';
import { db, settings, putSetting, now, transaction } from './db.mjs';
import { validLocale } from '../../packages/contracts/locales.mjs';
import { InputError } from '../../packages/contracts/validation.mjs';
import { providerAdapters, providerSupports, translationChunks, TranslationError } from './translation-provider.mjs';
import { initializeTranslationProviders, providerConfigurations, publicProviderStatuses, providerCredentials, setProviderState, nextProviderPeriod } from './translation-providers.mjs';
export { saveTranslationProvider } from './translation-providers.mjs';

const publicTexts = new Set(), builtinEnglish = new Set();
let busy = false, timer, scanTimer;
const hash = text => createHash('sha256').update(text).digest('hex');
const dateKey = () => new Date().toISOString().slice(0, 10);
const automatic = () => process.env.TRANSLATION_AUTO_UPDATE !== 'false';
export function translationConfig() {
  const row = db.prepare("SELECT value FROM settings WHERE key='translation_config'").get();
  return {enabled:true,dailyLimit:200000,...(row ? JSON.parse(row.value) : {})};
}
export function registerPublicTexts(texts, {builtin = false} = {}) {
  for (const value of texts) {
    if (typeof value !== 'string' || !value.trim()) continue;
    publicTexts.add(value.trim());
    if (builtin) builtinEnglish.add(value.trim());
  }
}
function addCustomization(config, list) {
  if (!config || typeof config !== 'object') return;
  if (config.printing?.enabled) list.push(config.printing.label, config.printing.placeholder);
  if (config.patches?.enabled) list.push(config.patches.label, ...(config.patches.options || []).filter(p => p.enabled).map(p => p.name));
}
export function scanPublicTranslationSources() {
  const list = [], all = settings(), home = all.home || {}, site = all.site || {};
  list.push(site.name, site.announcement);
  for (const group of [home.slides,home.sections,home.extraImages]) for (const item of group || []) list.push(item.title, item.description);
  for (const row of db.prepare('SELECT title,description,customization,customization_mode FROM products WHERE active=1').iterate()) {
    list.push(row.title, row.description);
    if (row.customization_mode === 'custom') { try { addCustomization(JSON.parse(row.customization), list); } catch {} }
  }
  for (const row of db.prepare('SELECT name FROM collections WHERE deleted_at IS NULL').iterate()) list.push(row.name);
  for (const row of db.prepare('SELECT title,body FROM pages WHERE published=1').iterate()) list.push(row.title, row.body);
  for (const template of Object.values(all.product_customization_templates || {})) addCustomization(template, list);
  // Rebuild the allowlist so unpublished/deleted/old source text cannot start new external requests.
  publicTexts.clear(); registerPublicTexts([...builtinEnglish, ...staticTexts, ...list]);
  return list.filter(t => typeof t === 'string' && t.trim());
}
const staticTexts = new Set();
export function registerTranslationUI(texts, builtin = false) {
  for (const text of texts) if (typeof text === 'string' && text.trim()) staticTexts.add(text.trim());
  registerPublicTexts(texts, {builtin});
}
function sourceLocale(text) { return /\p{Script=Han}/u.test(text) ? 'zh-CN' : 'en'; }
function canTranslate(text, locale) {
  if (locale === 'en' && /^\d{4}-\d{2}赛季$/.test(text)) return false;
  return validLocale(locale) && locale !== 'ha-Arab' && locale !== sourceLocale(text) && /\p{L}/u.test(text);
}
function queueChunk(text, locale) {
  const source = sourceLocale(text), key = hash(text);
  db.prepare(`INSERT OR IGNORE INTO translation_jobs(source_hash,source_text,source_locale,target_locale,created_at,updated_at) VALUES(?,?,?,?,?,?)`).run(key,text,source,locale,now(),now());
  db.prepare("UPDATE translation_jobs SET status='pending',next_attempt=0 WHERE source_hash=? AND source_locale=? AND target_locale=? AND status='obsolete'").run(key,source,locale);
  return db.prepare('SELECT * FROM translation_jobs WHERE source_hash=? AND source_locale=? AND target_locale=?').get(key,source,locale);
}

// Only registered PUBLIC merchant text may create a job. Request queries, customer
// input, addresses, order snapshots and printingName never enter this allowlist.
export function automaticTranslation(value, locale, {queue = true} = {}) {
  const text = String(value || '').trim();
  if (!text || !publicTexts.has(text) || !canTranslate(text, locale)) return null;
  const cfg = translationConfig(), chunks = translationChunks(text);
  const rows = chunks.map(chunk => {
    if (sourceLocale(chunk) === locale) return {status:'ready',translated_text:chunk};
    const found = db.prepare('SELECT * FROM translation_jobs WHERE source_hash=? AND source_locale=? AND target_locale=?').get(hash(chunk),sourceLocale(chunk),locale);
    return found?.status !== 'obsolete' ? (found || (queue && cfg.enabled ? queueChunk(chunk,locale) : null)) : (queue && cfg.enabled ? queueChunk(chunk,locale) : null);
  });
  return rows.every(row => row?.status === 'ready') ? rows.map(row => row.translated_text).join(' ') : null;
}
export function enqueuePublicTranslations(locale = 'en') {
  if (!validLocale(locale) || locale === 'zh-CN' || locale === 'ha-Arab') throw new InputError('此语言暂不可批量自动翻译');
  scanPublicTranslationSources();
  const before = db.prepare('SELECT COUNT(*) n FROM translation_jobs').get().n;
  transaction(() => {
    for (const text of publicTexts) {
      if (locale === 'en' && builtinEnglish.has(text)) continue;
      automaticTranslation(text,locale);
    }
  });
  return db.prepare('SELECT COUNT(*) n FROM translation_jobs').get().n - before;
}
function allowedChunk(text) {
  if (publicTexts.has(text)) return true;
  for (const full of publicTexts) if (full.includes(text) && translationChunks(full).includes(text)) return true;
  return false;
}
function state() {
  const row = db.prepare("SELECT value FROM settings WHERE key='translation_state'").get();
  return row ? JSON.parse(row.value) : {};
}
export function translationStatus() {
  const usage = db.prepare('SELECT * FROM translation_usage WHERE day=?').get(dateKey()) || {characters:0,requests:0};
  return {...translationConfig(),...state(),usage,busy,automatic:automatic(),providers:publicProviderStatuses(),counts:db.prepare('SELECT status,COUNT(*) count FROM translation_jobs GROUP BY status').all(),locales:db.prepare("SELECT target_locale,COUNT(*) total,SUM(status='ready') ready FROM translation_jobs GROUP BY target_locale ORDER BY target_locale").all(),builtinCount:builtinEnglish.size,recent:db.prepare('SELECT id,source_text,source_locale,target_locale,provider,translated_text,status,attempts,last_error,updated_at FROM translation_jobs ORDER BY updated_at DESC,id DESC LIMIT 30').all(),attempts:db.prepare('SELECT provider,result,message,created_at FROM translation_attempts ORDER BY id DESC LIMIT 15').all()};
}
export function saveTranslationConfig(input) {
  const limit = Number(input.dailyLimit);
  if (!Number.isInteger(limit) || limit < 100 || limit > 10000000) throw new InputError('每日总请求上限为 100–10000000 字符');
  putSetting('translation_config',{enabled:input.enabled === '1',dailyLimit:limit,version:2});
}
export function retryTranslations() {
  // A retry never clears a provider quota cooldown or the daily accounting.
  return db.prepare("UPDATE translation_jobs SET status='pending',attempts=0,next_attempt=0,last_error='',updated_at=? WHERE status='failed'").run(now()).changes;
}
export function queueTranslationConnectionTest(provider = '') {
  if (!translationConfig().enabled) throw new InputError('请先启用自动翻译');
  if (provider && !providerConfigurations().some(p=>p.id===provider&&p.configured&&p.enabled)) throw new InputError('请先配置并启用要测试的接口');
  const job=queueChunk('首页','en');
  if (job.status==='running') throw new InputError('连接测试正在处理，请稍后查看状态');
  db.prepare("UPDATE translation_jobs SET status='pending',requested_provider=?,blocked_providers='{}',attempts=0,next_attempt=0 WHERE id=?").run(provider,job.id);
  return 'pending';
}
function updateQueueState(value) {
  if (JSON.stringify(state())!==JSON.stringify(value)) putSetting('translation_state',value);
}
function recordAttempt(job,provider,result,message='') {
  db.prepare('INSERT INTO translation_attempts(job_id,provider,result,message,created_at) VALUES(?,?,?,?,?)').run(job.id,provider,result,message,now());
}
function reserveRequest(job,p,characters,current,first) {
  return transaction(()=>{
    const day=new Date(current).toISOString().slice(0,10),cfg=translationConfig();
    db.prepare('INSERT OR IGNORE INTO translation_usage(day) VALUES(?)').run(day);
    const used=db.prepare('SELECT characters FROM translation_usage WHERE day=?').get(day).characters;
    if(used+characters>cfg.dailyLimit)return 'global';
    const fresh=providerConfigurations(current).find(row=>row.id===p.id);
    if(!fresh?.enabled||!fresh.configured||fresh.usage.total+characters>fresh.limit)return 'provider';
    db.prepare('UPDATE translation_usage SET characters=characters+?,requests=requests+1 WHERE day=?').run(characters,day);
    db.prepare('INSERT INTO translation_provider_usage(provider,period,characters,requests) VALUES(?,?,?,1) ON CONFLICT(provider,period) DO UPDATE SET characters=characters+excluded.characters,requests=requests+1').run(p.id,p.periodKey,characters);
    db.prepare("UPDATE translation_jobs SET status='running',attempts=attempts+?,updated_at=? WHERE id=?").run(first?1:0,now(),job.id);
    return 'reserved';
  });
}
export async function processTranslationQueue({translate,adapters=providerAdapters,force=false,maxJobs=1,clock=Date.now}={}) {
  if(busy||!translationConfig().enabled||!force&&!automatic())return;
  busy=true;
  try {
    for(let index=0;index<Math.min(maxJobs,100);index++) {
      const current=clock(),job=db.prepare("SELECT * FROM translation_jobs WHERE status='pending' AND next_attempt<=? ORDER BY CASE WHEN target_locale='en' THEN 0 ELSE 1 END,id LIMIT 1").get(current);
      if(!job)break;
      if(!allowedChunk(job.source_text)){db.prepare("UPDATE translation_jobs SET status='obsolete',updated_at=? WHERE id=?").run(now(),job.id);continue;}
      const characters=Array.from(job.source_text).length,blocked=JSON.parse(job.blocked_providers||'{}');
      const providers=providerConfigurations(current).filter(p=>!job.requested_provider||p.id===job.requested_provider);
      const enabled=providers.filter(p=>p.enabled&&p.configured);
      let completed=false,first=true,budget=false,lastError='',temporary=false;
      const waits=[];
      for(const p of enabled) {
        if(blocked[p.id]?.reason==='unsupported')continue;
        if(blocked[p.id]?.until>current){waits.push(blocked[p.id].until);continue;}
        if(!providerSupports(p.id,job.source_locale,job.target_locale)){blocked[p.id]={reason:'unsupported'};recordAttempt(job,p.id,'unsupported','此接口暂不支持该语言对');continue;}
        if(p.state.reason==='auth'){lastError=p.name+'需要检查后台密钥或免费档权限';continue;}
        if(p.state.resume_at>current){waits.push(p.state.resume_at);lastError=p.name+'：'+p.state.last_error;continue;}
        if(p.usage.total+characters>p.limit){waits.push(nextProviderPeriod(p,current));lastError=p.name+'已达到本站为其设置的免费用量上限';continue;}
        let credentials;
        try {credentials=p.id==='mymemory'?{}:providerCredentials(p.id);if(!credentials)throw new Error();}
        catch {lastError=p.name+'密钥无法读取，请在后台重新填写';setProviderState(p.id,{reason:'auth',message:lastError});recordAttempt(job,p.id,'auth',lastError);continue;}
        const reservation=reserveRequest(job,p,characters,current,first);
        if(reservation==='global') {budget=true;lastError='达到本站每日总请求上限，次日自动继续';waits.push(Date.parse(new Date(current).toISOString().slice(0,10)+'T00:00:00Z')+86400000);break;}
        if(reservation==='provider')continue;
        first=false;
        try {
          const handler=translate||adapters[p.id];
          if(!handler)throw new TranslationError('接口适配器不可用','invalid');
          const result=await handler(job.source_text,job.source_locale,job.target_locale,credentials,p);
          if(typeof result!=='string'||!result.trim())throw new TranslationError('翻译接口没有返回有效译文','invalid',300000);
          db.prepare("UPDATE translation_jobs SET status='ready',provider=?,translated_text=?,last_error='',next_attempt=0,blocked_providers=?,requested_provider='',updated_at=? WHERE id=?").run(p.id,result,JSON.stringify(blocked),now(),job.id);
          setProviderState(p.id,{lastSuccess:now()});recordAttempt(job,p.id,'success');
          updateQueueState({lastSuccess:now(),lastError:'',resumeAt:0,activeProvider:p.id});completed=true;break;
        } catch(error) {
          const code=error instanceof TranslationError?error.code:'network',delay=Math.max(5000,Math.min(86400000,error.retryMs||60000));
          lastError=error instanceof TranslationError?error.message:'翻译接口连接失败，已尝试下一个服务';recordAttempt(job,p.id,code,lastError);
          if(code==='unsupported')blocked[p.id]={reason:'unsupported'};
          else if(code==='invalid'){blocked[p.id]={reason:'invalid',until:current+delay};waits.push(current+delay);temporary=true;}
          else {setProviderState(p.id,{reason:code,message:lastError,resumeAt:code==='auth'?0:current+delay});if(code!=='auth')waits.push(current+delay);if(['network','rate'].includes(code))temporary=true;}
          // Quota, invalid credentials and per-language failures all fall through
          // to the next DIFFERENT service in the configured order.
        }
      }
      if(completed)continue;
      const allUnsupported=enabled.length>0&&enabled.every(p=>blocked[p.id]?.reason==='unsupported');
      const status=allUnsupported?'unsupported':temporary&&job.attempts>=3?'failed':'pending';
      const next=waits.length?Math.min(...waits):current+60000;
      const message=allUnsupported?'已配置的接口均不支持此语言对':lastError||'没有可用的已配置免费接口，请在后台配置并启用';
      db.prepare('UPDATE translation_jobs SET status=?,last_error=?,next_attempt=?,blocked_providers=?,updated_at=? WHERE id=?').run(status,message,next,JSON.stringify(blocked),now(),job.id);
      updateQueueState({lastError:message,resumeAt:next,reason:budget?'budget':'providers',activeProvider:''});
      // Other languages/jobs may still use a service that skipped this job.
      if(budget)break;
    }
  } finally {busy=false;}
}
export function startTranslationWorker() {
  if (timer) return;
  initializeTranslationProviders();
  scanPublicTranslationSources();
  db.prepare("UPDATE translation_jobs SET status='pending' WHERE status='running'").run();
  enqueuePublicTranslations('en');
  timer = setInterval(() => { processTranslationQueue().catch(() => {}); },1500); timer.unref();
  scanTimer = setInterval(() => { scanPublicTranslationSources(); enqueuePublicTranslations('en'); },60000); scanTimer.unref();
}
