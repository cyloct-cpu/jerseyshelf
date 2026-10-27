import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder=mkdtempSync(path.join(root,'tests/.tmp-translation-admin-'));
const port=34000+process.pid%1000,base='http://127.0.0.1:'+port;
let child,csrf='',cookie='',read;
async function request(url,options={}) {
  const response=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:cookie,...options.headers}});
  for(const value of response.headers.getSetCookie())if(value.startsWith('bw_session='))cookie=value.split(';')[0];
  const body=await response.text(),token=body.match(/name="csrf" value="([a-f0-9]+)"/);if(token)csrf=token[1];
  return {status:response.status,body};
}
const post=(url,input={},token=csrf)=>request(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({csrf:token,...input})});
before(async()=>{
  child=spawn(process.execPath,['apps/api/server.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATABASE_PATH:path.join(folder,'test.sqlite'),MEDIA_PATH:path.join(folder,'media'),ADMIN_EMAIL:'admin@local.test',ADMIN_PASSWORD:'test-password-123456',FX_AUTO_UPDATE:'false',TRANSLATION_AUTO_UPDATE:'false'},stdio:'ignore'});
  let ready=false;for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}assert.ok(ready);
  read=new DatabaseSync(path.join(folder,'test.sqlite'),{readOnly:true});
});
after(async()=>{read?.close();if(child?.exitCode===null){child.kill();await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,3000).unref();});}assert.ok(path.relative(path.join(root,'tests'),folder).startsWith('.tmp-translation-admin-'));rmSync(folder,{recursive:true,force:true});});

test('多接口后台配置鉴权、CSRF、密钥加密与状态脱敏、指定接口测试排队',async()=>{
  await request('/');assert.equal((await post('/admin/translations/provider',{provider:'azure',priority:'10',limit:'1900000'})).status,403);
  assert.equal((await post('/admin/translations/test',{provider:'azure'})).status,403);
  await request('/account');assert.equal((await post('/account/login',{email:'admin@local.test',password:'test-password-123456'})).status,303);
  const panel=await request('/admin/translations');assert.equal(panel.status,200);assert.match(panel.body,/provider-azure/);assert.match(panel.body,/provider-baidu/);assert.match(panel.body,/provider-deepl/);assert.match(panel.body,/provider-mymemory/);
  const secret='fixture-secret-never-publish-123456';
  const data={provider:'azure',priority:'10',limit:'1900000',enabled:'1',free_plan_confirmed:'1',region:'eastasia',api_key:secret};
  assert.equal((await post('/admin/translations/provider',data,'forged-csrf')).status,403);
  assert.equal((await post('/admin/translations/provider',data)).status,303);
  const saved=read.prepare("SELECT value FROM settings WHERE key='translation_providers'").get().value;assert.ok(!saved.includes(secret));assert.ok(existsSync(path.join(folder,'translation-credentials.key')));
  const page=await request('/admin/translations'),status=await request('/admin/translations/status.json');assert.ok(!page.body.includes(secret));assert.ok(!status.body.includes(secret));assert.ok(!status.body.includes('secret'));
  const metadata=JSON.parse(status.body).providers.find(p=>p.id==='azure');assert.equal(metadata.enabled,true);assert.equal(metadata.configured,true);assert.equal(metadata.status,'已配置，待验证');
  assert.equal((await post('/admin/translations/test',{provider:'azure'})).status,303);assert.equal(read.prepare("SELECT requested_provider FROM translation_jobs WHERE source_text='首页'").get().requested_provider,'azure');
  assert.equal((await post('/admin/translations/test',{provider:'deepl'})).status,400);
  assert.equal((await post('/admin/translations/provider',{...data,api_key:'',limit:'2000001'})).status,400);
  assert.equal((await post('/admin/translations/provider',{...data,api_key:'',free_plan_confirmed:''})).status,400);
  const disabled=await post('/admin/translations/provider',{provider:'azure',priority:'50',limit:'1900000'});assert.equal(disabled.status,303);
  const provider=JSON.parse((await request('/admin/translations/status.json')).body).providers.find(p=>p.id==='azure');assert.equal(provider.enabled,false);assert.equal(provider.configured,true);assert.equal(provider.priority,50);
});

test('备份包含数据库、媒体与配套翻译凭据加密文件，可成套迁移',()=>{
  const result=spawnSync(process.execPath,['scripts/ops/backup.mjs'],{cwd:root,env:{...process.env,DATABASE_PATH:path.join(folder,'test.sqlite'),MEDIA_PATH:path.join(folder,'media')},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  const output=path.resolve(result.stdout.trim()),relative=path.relative(path.join(root,'storage/backups'),output);
  assert.ok(relative&&!relative.startsWith('..')&&!path.isAbsolute(relative)&&!relative.includes(path.sep),'Backup must be a direct child of the intended backup root');
  try {
    assert.deepEqual(readFileSync(path.join(output,'translation-credentials.key')),readFileSync(path.join(folder,'translation-credentials.key')));
    assert.ok(existsSync(path.join(output,'media')));
    const snapshot=new DatabaseSync(path.join(output,'store.sqlite'),{readOnly:true});try {assert.ok(snapshot.prepare("SELECT value FROM settings WHERE key='translation_providers'").get());}finally{snapshot.close();}
  } finally {rmSync(output,{recursive:true,force:true});}
});
