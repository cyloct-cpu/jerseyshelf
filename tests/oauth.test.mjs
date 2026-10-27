import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {generateKeyPairSync,createSign} from 'node:crypto';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnTestServer} from './helpers/server.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-oauth-'+process.pid);
let mockServerPort=0;
let child,base,db,mock,mockBase,log='';
const CLIENT_ID='test-client-id.apps.googleusercontent.com';
// RSA 密钥与 JWT 构造（真实 RS256 签名，走完整验签路径）。
const {publicKey,privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
const jwk={...publicKey.export({format:'jwk'}),kid:'testkid',use:'sig',alg:'RS256'};
const b64=o=>Buffer.from(JSON.stringify(o)).toString('base64url');
function idToken({code,nonce,aud=CLIENT_ID,iss='https://accounts.google.com',exp=Math.floor(Date.now()/1000)+600,email='google-user@example.com',sub='google-sub-001',corrupt=false}){
  const header=b64({alg:'RS256',kid:'testkid',typ:'JWT'});
  const payload=b64({iss,aud,exp,nonce,email,email_verified:true,sub,name:'Google User'});
  const signer=createSign('RSA-SHA256');signer.update(header+'.'+payload);
  let signature=signer.sign(privateKey,'base64url');
  if(corrupt)signature=signature.slice(0,-2)+(signature.slice(-2)==='aa'?'bb':'aa');
  return header+'.'+payload+'.'+signature;
}
class Client{cookies=new Map();csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body,location:r.headers.get('location')};}post(url,data={}){const form=new URLSearchParams({csrf:this.csrf});for(const [k,v] of Object.entries(data))for(const x of Array.isArray(v)?v:[v])form.append(k,x);return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});}}
const admin=new Client(),visitor=new Client();
const ok=r=>assert.equal(r.status,303,r.body+'\n'+log);
let tokens={};
before(async()=>{
  mkdirSync(dir,{recursive:true});
  mock=createServer((req,res)=>{
    if(req.url==='/oauth2/v3/certs'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({keys:[jwk]}));return;}
    if(req.url==='/token'){
      let body='';req.on('data',d=>body+=d);req.on('end',()=>{
        const code=new URLSearchParams(body).get('code')||'';
        const token=tokens[code];
        if(!token){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'invalid_grant'}));return;}
        res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({id_token:token,access_token:'at',token_type:'Bearer'}));
      });return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise(r=>mock.listen(0,'127.0.0.1',r));
  mockBase='http://127.0.0.1:'+mock.address().port;
  ({child,base}=await spawnTestServer({root,dir,extraEnv:{ADMIN_EMAIL:'oauth-admin@example.com',ADMIN_PASSWORD:'oauth-password-123456',OMS_AUTO_UPDATE:'false',EMAIL_AUTO_UPDATE:'false',GOOGLE_OAUTH_BASE:mockBase,GOOGLE_TOKEN_BASE:mockBase,GOOGLE_API_BASE:mockBase}}));
  db=new DatabaseSync(path.join(dir,'store.sqlite'));db.exec('PRAGMA busy_timeout=5000');
  await admin.get('/account');
  ok(await admin.post('/account/login',{email:'oauth-admin@example.com',password:'oauth-password-123456'}));
  await admin.get('/admin');
});
after(async()=>{
  mock?.close();
  db?.close();
  try{(await import('../apps/api/db.mjs')).db.close();}catch{}
  if(child&&child.exitCode===null){child.kill();await new Promise(r=>{child.once('exit',r);setTimeout(r,3000).unref();});}
  assert.ok(path.relative(path.join(root,'tests'),dir).startsWith('.tmp-oauth-'));rmSync(dir,{recursive:true,force:true});
});

test('login page hides Google entry until configured; start refuses without config',async()=>{
  const page=await visitor.get('/account');
  assert.equal(page.status,200);assert.doesNotMatch(page.body,/使用 Google/);
  assert.equal((await visitor.get('/account/google/start')).status,503);
  // 配置密钥封存保存。
  ok(await admin.post('/admin/oauth/save',{google_client_id:CLIENT_ID,google_client_secret:'google-secret-1234567890'}));
  const stored=JSON.parse(db.prepare("SELECT value FROM settings WHERE key='oauth'").get().value);
  assert.equal(stored.google.clientId,CLIENT_ID);assert.ok(stored.google.clientSecret&&!stored.google.clientSecret.includes('google-secret'));
  const after=await visitor.get('/account');
  assert.match(after.body,/使用 Google 继续/);
});

test('full OAuth flow creates a customer, binds on re-login and rejects tampered tokens',async()=>{
  const start=await visitor.get('/account/google/start');
  ok(start);
  assert.match(start.location,new RegExp('^'+mockBase.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+'/o/oauth2/v2/auth'));
  const state=start.location.match(/[?&]state=([a-f0-9]{32})/)[1];
  const nonce=start.location.match(/[?&]nonce=([a-f0-9]{32})/)[1];
  const stateCookie=visitor.cookies.get('bw_oauth');
  assert.equal(stateCookie,state+'.'+nonce);
  // 状态不匹配被拒绝。
  assert.equal((await visitor.get('/account/google/callback?state='+'0'.repeat(32)+'&code=good')).status,400);
  tokens.good=idToken({code:'good',nonce});
  // 篡改签名的令牌被拒绝。
  tokens.tampered=idToken({code:'tampered',nonce,corrupt:true});
  const bad=await visitor.get('/account/google/callback?state='+state+'&code=tampered');
  assert.equal(bad.status,400,bad.body);
  // 受众不符与过期被拒绝。
  tokens.wrongaud=idToken({code:'wrongaud',nonce,aud:'other-client'});
  assert.equal((await visitor.get('/account/google/callback?state='+state+'&code=wrongaud')).status,400);
  tokens.expired=idToken({code:'expired',nonce,exp:Math.floor(Date.now()/1000)-10});
  assert.equal((await visitor.get('/account/google/callback?state='+state+'&code=expired')).status,400);
  // 完整成功路径：建档 + 登录。
  const done=await visitor.get('/account/google/callback?state='+state+'&code=good');
  ok(done);assert.match(done.location,/\/account/);
  const user=db.prepare("SELECT * FROM users WHERE oauth_provider='google' AND oauth_sub='google-sub-001'").get();
  assert.ok(user);assert.equal(user.email,'google-user@example.com');assert.equal(user.role,'customer');
  const account=await visitor.get('/account');
  assert.match(account.body,/Google User/);
  // 同一身份再次登录复用账号。
  const again=await visitor.get('/account/google/start');ok(again);
  const state2=again.location.match(/[?&]state=([a-f0-9]{32})/)[1];
  const nonce2=again.location.match(/[?&]nonce=([a-f0-9]{32})/)[1];
  tokens.again=idToken({code:'again',nonce:nonce2});
  ok(await visitor.get('/account/google/callback?state='+state2+'&code=again'));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM users WHERE oauth_provider='google'").get().n,1);
  // nonce 不匹配被拒绝（重放其它会话的令牌）。
  tokens.replay=idToken({code:'replay',nonce:'f'.repeat(32)});
  assert.equal((await visitor.get('/account/google/callback?state='+state2+'&code=replay')).status,400);
});

test('existing customer with same email gets bound instead of duplicated',async()=>{
  const shopper=new Client();await shopper.get('/account');
  ok(await shopper.post('/account/register',{email:'bind@example.com',name:'本地已有用户',password:'shopper-password-123456'}));
  const localId=db.prepare('SELECT id FROM users WHERE email=?').get('bind@example.com').id;
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE email=?').get('bind@example.com').n,1);
  // 模块级验证绑定路径：同邮箱的新 Google 身份绑定到既有账号而不是新建。
  process.env.DATABASE_PATH=path.join(dir,'store.sqlite');
  const oauth=await import('../apps/api/oauth.mjs');
  const id=oauth.googleLoginOrRegister({sub:'google-sub-777',email:'bind@example.com',name:'Google User'});
  assert.equal(id,localId);
  const row=db.prepare('SELECT * FROM users WHERE id=?').get(id);
  assert.equal(row.oauth_provider,'google');assert.equal(row.oauth_sub,'google-sub-777');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users WHERE email=?').get('bind@example.com').n,1);
  // 全新身份走建档分支（audit 记 null 操作者）。
  const fresh=oauth.googleLoginOrRegister({sub:'google-sub-888',email:'fresh@example.com',name:'Fresh User'});
  const freshRow=db.prepare('SELECT * FROM users WHERE id=?').get(fresh);
  assert.equal(freshRow.role,'customer');assert.equal(freshRow.oauth_sub,'google-sub-888');
});
