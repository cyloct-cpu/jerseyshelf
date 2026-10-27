import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { metaPixelScript, metaPixelBody, metaPixelNoscript, hasMetaConsent } from '../apps/storefront/meta-pixel.mjs';

function browser({consent='',gpc=false}={}) {
  const cookies=new Map(consent?[['js_meta_consent',consent]]:[]),events={},buttons={};
  let loads=0;
  for(const choice of ['accepted','rejected'])buttons[choice]={dataset:{metaConsent:choice},addEventListener:(_,fn)=>buttons[choice].click=fn};
  const panel={hidden:false},status={};
  const document={readyState:'complete',hidden:false,
    get cookie(){return [...cookies].map(([k,v])=>k+'='+v).join('; ');},
    set cookie(raw){const [pair,...attributes]=raw.split(';'),at=pair.indexOf('=');if(attributes.some(a=>a.trim()==='Max-Age=0'))cookies.delete(pair.slice(0,at));else cookies.set(pair.slice(0,at),pair.slice(at+1));},
    createElement:()=>({}),getElementsByTagName:()=>[{parentNode:{insertBefore:()=>loads++}}],
    getElementById:id=>id==='meta-consent-panel'?panel:id==='meta-consent-status'?status:null,
    querySelectorAll:selector=>selector==='[data-meta-consent]'?Object.values(buttons):[],
    addEventListener:(name,fn)=>events[name]=fn};
  const context={document,navigator:{globalPrivacyControl:gpc},location:{hostname:'jerseyshelf.com'},localStorage:{setItem:()=>{}},addEventListener:(name,fn)=>events[name]=fn};
  context.window=context;
  const execute=()=>runInNewContext(metaPixelScript,context);
  execute();
  return {context,document,buttons,events,execute,cookies,panel,status,get loads(){return loads;},queue:()=>Array.from(context.fbq?.queue||[],a=>Array.from(a))};
}

test('no choice or rejection loads no Meta SDK and sends no event',()=>{
  for(const consent of ['', 'v1.rejected','v0.accepted','v1.accepted.invalid']){
    const b=browser({consent});assert.equal(b.loads,0);assert.equal(b.context.fbq,undefined);
  }
});
test('explicit acceptance starts once; repeated execution does not duplicate PageView',()=>{
  const b=browser();b.buttons.accepted.click();b.execute();b.buttons.accepted.click();
  assert.equal(b.loads,1);assert.deepEqual(b.queue(),[['init','1697741321689628'],['track','PageView']]);
  assert.equal(b.cookies.get('js_meta_consent'),'v1.accepted');assert.equal(b.panel.hidden,true);
});
test('previous acceptance starts once and withdrawal revokes and clears Meta cookies',()=>{
  const b=browser({consent:'v1.accepted'});b.cookies.set('_fbp','test');b.cookies.set('_fbc','test');
  b.buttons.rejected.click();
  assert.equal(b.cookies.has('_fbp'),false);assert.equal(b.cookies.has('_fbc'),false);
  assert.deepEqual(b.queue().at(-1),['consent','revoke']);
  b.buttons.accepted.click();assert.deepEqual(b.queue().at(-1),['consent','grant']);
  assert.equal(b.queue().filter(a=>a[1]==='PageView').length,1);
});
test('cross-tab rejection revokes immediately and GPC overrides stored acceptance',()=>{
  const b=browser({consent:'v1.accepted'});b.cookies.set('js_meta_consent','v1.rejected');
  b.events.storage({key:'jerseyshelf-meta-consent-v1'});assert.deepEqual(b.queue().at(-1),['consent','revoke']);
  const g=browser({consent:'v1.accepted',gpc:true});assert.equal(g.loads,0);assert.equal(g.context.fbq,undefined);assert.equal(g.buttons.accepted.disabled,true);
});
test('noscript image is rendered only when the server confirms marketing consent',()=>{
  assert.equal(hasMetaConsent('js_meta_consent=v1.accepted'),true);
  assert.equal(hasMetaConsent('js_meta_consent=v1.rejected'),false);
  assert.equal(hasMetaConsent('other=js_meta_consent=v1.accepted'),false);
  assert.ok(!metaPixelBody({locale:'en'}).includes(metaPixelNoscript));
  assert.equal(metaPixelBody({metaMarketingConsent:true}).split(metaPixelNoscript).length-1,1);
});
