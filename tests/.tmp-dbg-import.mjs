import {spawn} from 'node:child_process';
import {mkdirSync,rmSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),dir=path.join(root,'tests/.tmp-dbgimp'),base='http://127.0.0.1:31990';
class Client{cookies=new Map();csrf='';async get(url,options={}){const r=await fetch(base+url,{redirect:'manual',...options,headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; '),...options.headers}});for(const c of r.headers.getSetCookie()){const pair=c.split(';')[0],i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}const body=await r.text();this.csrf=body.match(/name="csrf" value="([a-f0-9]+)"/)?.[1]||this.csrf;return {status:r.status,body};}post(url,data={}){const form=new URLSearchParams({csrf:this.csrf});for(const [k,v] of Object.entries(data))form.append(k,v);return this.get(url,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:form});}
  async upload(url,form,files){const fd=new FormData();fd.append('csrf',this.csrf);for(const [k,v] of Object.entries(form))fd.append(k,String(v));for(const [field,file] of files)fd.append(field,new Blob([file.data],{type:file.type}),file.name);const r=await fetch(base+url,{method:'POST',redirect:'manual',headers:{Cookie:[...this.cookies].map(([k,v])=>k+'='+v).join('; ')},body:fd});const body=await r.text();return {status:r.status,body};}}
const admin=new Client();
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==','base64');
const CSV='\ufeffslug,名称,描述,价格,原价,上架,分类,图片,sku,规格,规格价格,库存\r\nbatch-kit,Batch球衣,,25.00,39.00,1,2026-27-season,,BATCH-M,M,25.00,10\r\nbatch-kit,,,,,,,,BATCH-L,L,25.00,5\r\nbatch-old,已有商品,,9.00,,,,OLD-M,M,9.00,3\r\n';
const CSV_OLD='slug,名称,价格,sku,规格,库存\r\nbatch-old,已有商品,9.00,OLD-M,M,3\r\n';
const child=spawn(process.execPath,['apps/api/server.mjs'],{cwd:root,env:{...process.env,HOST:'127.0.0.1',PORT:'31990',DATABASE_PATH:path.join(dir,'store.sqlite'),MEDIA_PATH:path.join(dir,'media'),ADMIN_EMAIL:'a@t.com',ADMIN_PASSWORD:'pass-word-123456',FX_AUTO_UPDATE:'false',TRANSLATION_AUTO_UPDATE:'false'},stdio:['ignore','pipe','pipe']});
child.stdout.on('data',()=>{});child.stderr.on('data',()=>{});
let ready=false;for(let i=0;i<150;i++){try{if((await fetch(base+'/health')).ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,50));}
await admin.get('/account');
await admin.post('/account/login',{email:'a@t.com',password:'pass-word-123456'});
await admin.get('/admin');
await admin.post('/admin/import/csv',{csv:CSV_OLD,intent:'import'});
const preview=await admin.upload('/admin/import/upload',{label:'dbg',draft:'1'},[
  ['manifest',{data:Buffer.from(CSV,'utf8'),type:'text/csv',name:'products.csv'}],
  ['images',{data:PNG,type:'image/png',name:'prod/BATCH-M/1.jpg'}]
]);
console.log('upload:',preview.status);
console.log('error:',preview.body.match(/notice error">([^<]*)/)?.[1]||'(none)');
child.kill();process.exit(0);
