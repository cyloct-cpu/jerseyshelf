import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {request as httpRequest} from 'node:http';
import {existsSync,readFileSync,appendFileSync,mkdirSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {db,putSetting,audit} from './db.mjs';
import {config,root} from './config.mjs';
import {InputError,int,cents} from '../../packages/contracts/validation.mjs';
import {parseCurrencyAmount,convertMinor} from '../../packages/contracts/currencies.mjs';
import {random,limited} from './security.mjs';
import {visionFallbackSearch} from './image-search-fallback.mjs';

const state=path.resolve(root,process.env.IMAGE_SEARCH_STATE||'storage/image-search');
const python=process.env.IMAGE_SEARCH_PYTHON||'python3';
const socketPath=process.env.IMAGE_SEARCH_SOCKET||'';
const script=path.join(root,'scripts/image-search/engine.py');
const queries=new Map();
let worker=null,starting=null,pending=null,rebuild=null,lastError='',statusCache=null,statusAt=0;
export function imageSearchConfig(){const row=db.prepare("SELECT value FROM settings WHERE key='image_search'").get();return {enabled:false,minScore:0.90,...(row?JSON.parse(row.value):{})};}
export function imageSearchEnabled(){return imageSearchConfig().enabled;}
export function imageSearchStatus(){
 if(Date.now()-statusAt>10000){statusAt=Date.now();try{const info=JSON.parse(readFileSync(path.join(state,'index.json'),'utf8'));statusCache={images:info.records.length,products:new Set(info.records.flatMap(r=>r.products)).size,failed:info.failures.length,createdAt:info.createdAt,partial:info.partial,generation:info.generation,coverageMode:info.coverageMode||'all',modelVersion:info.version};}catch{statusCache=null;}}
 let progress={};try{progress=JSON.parse(readFileSync(path.join(state,'build-status.json'),'utf8'));}catch{}
 const externalBuilding=progress.running&&Date.now()/1000-progress.updatedAt<900;
 return {...imageSearchConfig(),ready:!!statusCache,...statusCache,building:!!rebuild||!!externalBuilding||existsSync(path.join(state,'rebuild-request.json')),progress:externalBuilding?{done:progress.done,total:progress.total}:null,lastError:lastError||(progress.error?'图库索引更新失败，请查看任务日志':'')};
}
function environment(){return {...process.env,DATABASE_PATH:config.dbPath,MEDIA_PATH:config.mediaDir,IMAGE_SEARCH_STATE:state,IMAGE_SEARCH_THREADS:'1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1',PYTHONUNBUFFERED:'1'};}
function log(chunk){mkdirSync(state,{recursive:true});appendFileSync(path.join(state,'service.log'),chunk);}
function stop(){const child=worker;worker=null;child?.kill();}
async function ready(){
 if(worker)return;
 if(starting)return starting;
 starting=new Promise((resolve,reject)=>{
  const child=spawn(python,[script,'serve'],{cwd:root,env:environment(),stdio:['pipe','pipe','pipe'],windowsHide:true});
  let settled=false;
  const timer=setTimeout(()=>{fail(new InputError('以图搜款启动超时，请稍后重试',503));child.kill();},30000);
  function fail(err){lastError=err.message;if(!settled){settled=true;clearTimeout(timer);reject(err);}}
  child.on('error',()=>fail(new InputError('以图搜款运行环境尚未就绪',503)));
  child.stderr.on('data',log);
  createInterface({input:child.stdout}).on('line',line=>{
   let data;try{data=JSON.parse(line);}catch{return;}
   if(data.ready){if(settled)return;settled=true;clearTimeout(timer);worker=child;lastError='';resolve();return;}
   if(pending&&pending.child===child&&data.id===pending.id){const task=pending;pending=null;clearTimeout(task.timer);data.error?task.reject(new InputError('图片无法识别，请使用清晰的 JPG、PNG 或 WebP 图片',400)):task.resolve(data);}
  });
  child.on('exit',()=>{if(worker===child)worker=null;fail(new InputError('以图搜款暂不可用，请稍后重试',503));if(pending?.child===child){const task=pending;pending=null;clearTimeout(task.timer);task.reject(new InputError('以图搜款暂不可用，请稍后重试',503));}});
 });
 try{await starting;}finally{starting=null;}
}
function searchSocket(bytes){return new Promise((resolve,reject)=>{
 const body=JSON.stringify({image:bytes.toString('base64')});
 const req=httpRequest({socketPath,path:'/search',method:'POST',headers:{'Content-Type':'application/json','Content-Length':Buffer.byteLength(body)}},res=>{
  const chunks=[];let size=0;
  res.on('error',()=>reject(new InputError('以图搜款暂不可用，请稍后重试',503)));
  res.on('aborted',()=>reject(new InputError('以图搜款暂不可用，请稍后重试',503)));
  res.on('data',chunk=>{size+=chunk.length;if(size>1024*1024){req.destroy(new Error('response too large'));return;}chunks.push(chunk);});
  res.on('end',()=>{try{const value=JSON.parse(Buffer.concat(chunks));if(res.statusCode===400){reject(new InputError('图片无法识别，请使用清晰的 JPG、PNG 或 WebP 图片',400));return;}if(res.statusCode!==200||!Array.isArray(value.candidates))throw new Error();resolve(value);}catch{reject(new InputError('以图搜款暂不可用，请稍后重试',503));}});
 });
 req.setTimeout(15000,()=>req.destroy(new Error('timeout')));
 req.on('error',()=>reject(new InputError('以图搜款暂不可用，请稍后重试',503)));
 req.end(body);
});}
let occupied=false;
export async function submitImageSearch(bytes,owner,ip,{preview=false}={}){
 if(!imageSearchEnabled()&&!preview)throw new InputError('以图搜款暂未开放，请使用文字搜索',503);
 if(!Buffer.isBuffer(bytes)||!bytes.length||bytes.length>8*1024*1024)throw new InputError('图片不能超过 8 MB',413);
 if(limited('image-session:'+owner,10,60000)||limited('image-ip:'+ip,20,60000))throw new InputError('搜款过于频繁，请稍后重试',429);
 const status=imageSearchStatus();if(!status.ready||(status.partial&&!preview))throw new InputError('图库索引尚未就绪，请使用文字搜索',503);
 if(occupied)throw new InputError('搜款服务繁忙，请稍后重试',429);
 occupied=true;
 try{
  let data;
  if(socketPath)data=await searchSocket(bytes);
  else {await ready();data=await new Promise((resolve,reject)=>{const id=random(12),child=worker;const timer=setTimeout(()=>{pending=null;stop();reject(new InputError('搜款超时，请稍后重试',504));},15000);pending={id,child,timer,resolve,reject};child.stdin.write(JSON.stringify({id,image:bytes.toString('base64')})+'\n',err=>{if(err&&pending?.id===id){pending=null;clearTimeout(timer);stop();reject(new InputError('以图搜款暂不可用',503));}});});}
  for(const [id,q] of queries)if(q.expires<Date.now())queries.delete(id);
  if(queries.size>=200)queries.delete(queries.keys().next().value);
  // 低于阈值：尝试视觉大模型属性兜底（未配置或失败时静默保持无结果）。
  let fallback=null;
  const threshold=imageSearchConfig().minScore;
  if(!data.candidates.some(c=>c.score>=threshold)){
    try{fallback=await visionFallbackSearch(bytes,'image/jpeg');}catch{}
  }
  const id=random(24);queries.set(id,{owner,expires:Date.now()+30*60000,candidates:data.candidates,preview,fallback});
  clearTimeout(idleTimer);idleTimer=setTimeout(()=>{if(!occupied)stop();},10*60000);idleTimer.unref();
  return {id,ms:data.ms};
 }finally{occupied=false;}
}
export function imageSearchResults(id,owner,params,fx){
 const q=queries.get(id);
 if(!q||q.owner!==owner||q.expires<Date.now())throw new InputError('图片搜索已过期，请重新上传图片',410);
 if(!imageSearchEnabled()&&!q.preview)throw new InputError('以图搜款暂未开放',503);
 const threshold=imageSearchConfig().minScore;
 const candidates=q.candidates.filter(c=>Number.isSafeInteger(c.id)&&c.score>=threshold);
 let rows=[];
 if(candidates.length){const found=db.prepare(`SELECT * FROM products WHERE active=1 AND id IN (${candidates.map(()=>'?').join(',')})`).all(...candidates.map(c=>c.id));const byId=new Map(found.map(p=>[p.id,p]));
  for(const c of candidates){const p=byId.get(c.id);if(!p)continue;const images=JSON.parse(p.images);if(!images.includes(c.path))continue;rows.push({...p,images});}
 }else if(q.fallback?.products?.length){
  // 兜底候选：按视觉模型给的搜索词从文字索引取回，并明确标注为相似推荐。
  const ids=q.fallback.products.map(p=>p.id);
  const found=db.prepare(`SELECT * FROM products WHERE active=1 AND id IN (${ids.map(()=>'?').join(',')})`).all(...ids);
  const order=new Map(ids.map((id,i)=>[id,i]));
  rows=found.sort((a,b)=>order.get(a.id)-order.get(b.id)).map(p=>({...p,images:JSON.parse(p.images)}));
 }
 const collection=params.collection||'';
 if(collection){const ids=new Set(db.prepare('SELECT pc.product_id FROM product_collections pc JOIN collections c ON c.id=pc.collection_id WHERE c.slug=? AND c.deleted_at IS NULL').all(collection).map(r=>r.product_id));rows=rows.filter(p=>ids.has(p.id));}
 for(const [key,op] of [['min',1],['max',-1]])if(params[key]){let value;try{value=fx?parseCurrencyAmount(params[key],fx):cents(params[key]);}catch{throw new InputError('价格筛选格式错误');}rows=rows.filter(p=>op*(fx?convertMinor(p.price,fx):p.price)>=op*value);}
 if(params.sort==='price_asc')rows.sort((a,b)=>a.price-b.price||a.id-b.id);
 if(params.sort==='price_desc')rows.sort((a,b)=>b.price-a.price||a.id-b.id);
 const page=int(params.page||1,'页码',1,10000),count=rows.length;
 return {products:rows.slice((page-1)*24,page*24),count,page,pages:Math.ceil(count/24),imageQuery:id,preview:q.preview,fallbackQuery:q.fallback?.query||''};
}
export function saveImageSearchConfig(input,actor){
 const enabled=input.enabled==='1',minScore=Number(input.min_score);
 if(!Number.isFinite(minScore)||minScore<0.5||minScore>0.99)throw new InputError('匹配阈值应为 0.50 至 0.99');
 if(enabled){const s=imageSearchStatus();if(!s.ready||s.partial)throw new InputError('完整图库索引就绪后才能开放');
  const acceptedFile=path.join(state,'acceptance.json'),releaseFile=path.join(state,'release-approval.json');
  const acceptance=existsSync(acceptedFile)?JSON.parse(readFileSync(acceptedFile,'utf8')):null;
  const release=existsSync(releaseFile)?JSON.parse(readFileSync(releaseFile,'utf8')):null;
  const accepted=acceptance?.accepted===true&&acceptance.generation===s.generation;
  const approved=release?.ownerApproved===true&&release.mode==='similar_styles'&&(release.generation===s.generation||(release.catalogUpdatesApproved===true&&release.modelVersion===s.modelVersion));
  if(!accepted&&!approved)throw new InputError('请先完成验收，或保存站点负责人明确授权的相似款发布记录');
 }
 putSetting('image_search',{enabled,minScore});audit(actor,'image-search.config','settings');
 if(!enabled){stop();queries.clear();}
}
export function rebuildImageSearch(actor,{automatic=false}={}){
 if(imageSearchStatus().building)throw new InputError('图库索引正在更新',409);
 mkdirSync(state,{recursive:true});
 if(socketPath){try{writeFileSync(path.join(state,'rebuild-request.json'),JSON.stringify({actor,requestedAt:Date.now()}),{flag:'wx',mode:0o600});}catch(err){if(err.code==='EEXIST')throw new InputError('图库索引更新已排队',409);throw err;}audit(actor,'image-search.rebuild','queued');return;}
 const child=spawn(python,[script,'build',...(automatic?[]:['--force'])],{cwd:root,env:environment(),stdio:['ignore','pipe','pipe'],windowsHide:true});rebuild=child;lastError='';
 child.stdout.on('data',log);child.stderr.on('data',log);
 child.on('error',()=>{lastError='图片索引环境不可用';rebuild=null;});
 child.on('exit',code=>{if(rebuild===child)rebuild=null;statusAt=0;if(code!==0)lastError='索引更新失败，请检查图库日志';else lastError='';});
 audit(actor,'image-search.rebuild','index');
}
let syncTimer;
let idleTimer;
export function startImageSearchSync(){
 if(process.env.IMAGE_SEARCH_AUTO_UPDATE!=='true')return;
 const sync=()=>{if(rebuild||occupied||!imageSearchEnabled())return;rebuildImageSearch(null,{automatic:true});};
 syncTimer=setInterval(sync,5*60000);syncTimer.unref();
}
process.on('exit',()=>{stop();rebuild?.kill();});
