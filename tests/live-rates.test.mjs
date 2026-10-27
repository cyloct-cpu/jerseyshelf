import { test,after } from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,rmSync,readFileSync} from 'node:fs';
import path from 'node:path';
import {parseLiveRates} from '../packages/contracts/live-rates.mjs';
const root=process.cwd(),dir=path.join(root,'tests','.tmp-live-fx-'+process.pid);mkdirSync(dir,{recursive:true});
process.env.DATABASE_PATH=path.join(dir,'test.sqlite');process.env.MEDIA_PATH=path.join(dir,'media');delete process.env.FX_API_KEY;delete process.env.FX_MODE;
const {db}=await import('../apps/api/db.mjs');
const {fetchLiveSnapshot,saveFxConfig,fxStatus,fxConfig}=await import('../apps/api/fx-provider.mjs');
after(()=>{db.close();const relative=path.relative(path.join(root,'tests'),dir);assert.ok(relative.startsWith('.tmp-live-fx-')&&!relative.includes(path.sep));rmSync(dir,{recursive:true,force:true});});
test('实时接口按实际报价时间验证，不把每日或旧报价标为实时',()=>{
  const now=Date.now(),payload={success:true,source:'USD',timestamp:Math.floor(now/1000),quotes:{USDEUR:0.9,USDJPY:150}};
  const valid=parseLiveRates(payload,now);assert.equal(valid.source,'currencylayer');assert.equal(valid.rows[1].quote,'JPY');
  assert.throws(()=>parseLiveRates({...payload,timestamp:Math.floor(now/1000)-121},now),/超过2分钟/);
  assert.throws(()=>parseLiveRates({...payload,timestamp:Math.floor(now/1000)+60},now));
  assert.throws(()=>parseLiveRates({...payload,success:false},now));assert.throws(()=>parseLiveRates({...payload,source:'EUR'},now));assert.throws(()=>parseLiveRates({...payload,quotes:{USDJPY:-1}},now));
});
test('接口适配使用HTTPS，验证响应并隐藏连接异常中的密钥',async()=>{
  const key='example_secret_1234567890';let requested;
  const result=await fetchLiveSnapshot(key,async url=>{requested=url;return {ok:true,json:async()=>({success:true,source:'USD',timestamp:Math.floor(Date.now()/1000),quotes:{USDEUR:0.9}})};});
  assert.equal(requested.protocol,'https:');assert.equal(requested.hostname,'api.currencylayer.com');assert.equal(requested.searchParams.get('access_key'),key);assert.equal(result.rows[0].rate,0.9);
  await assert.rejects(()=>fetchLiveSnapshot(key,async()=>{throw new Error('unsafe '+key);}),err=>!err.message.includes(key)&&err.status===503);
});
test('密钥加密保存、留空保留、可删除；没有密钥时拒绝启用实时模式',async()=>{
  const key='example_secret_1234567890';await saveFxConfig({mode:'reference',provider:'currencylayer',api_key:key});
  const value=db.prepare("SELECT value FROM settings WHERE key='fx_config'").get().value;assert.ok(!value.includes(key));assert.equal(fxConfig().apiKey,key);assert.equal(fxStatus().keyConfigured,true);
  assert.equal(readFileSync(path.join(dir,'fx-credentials.key')).length,32);
  await saveFxConfig({mode:'reference',provider:'currencylayer',api_key:''});assert.equal(fxConfig().apiKey,key);
  await saveFxConfig({mode:'reference',provider:'currencylayer',clear_key:'1'});assert.equal(fxStatus().keyConfigured,false);
  await assert.rejects(()=>saveFxConfig({mode:'live',provider:'currencylayer'}),/尚未配置/);assert.equal(fxStatus().mode,'reference');
});
