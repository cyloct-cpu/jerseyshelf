import {execFile} from 'node:child_process';
export class WaError extends Error{constructor(message,kind='failed'){super(message);this.kind=kind;}}
async function request(url,options,fetcher=fetch){
 if(url.protocol!=='https:'||url.hostname!=='graph.facebook.com')throw new WaError('WhatsApp官方接口地址无效');
 let response;
 try{
  if(process.platform==='win32'&&fetcher===fetch){
   const script="$u=New-Object System.Text.UTF8Encoding($false);[Console]::InputEncoding=$u;[Console]::OutputEncoding=$u;$r=([Console]::In.ReadToEnd()|ConvertFrom-Json);$h=@{Authorization=[string]$r.auth};$p=@{Uri=[string]$r.url;Method=[string]$r.method;Headers=$h;MaximumRedirection=0;UseBasicParsing=$true;TimeoutSec=15;ErrorAction='Stop'};if($r.body){$p.ContentType='application/json';$p.Body=[System.Text.Encoding]::UTF8.GetBytes([string]$r.body)};try{$x=Invoke-WebRequest @p;@{status=[int]$x.StatusCode;body=[string]$x.Content}|ConvertTo-Json -Compress}catch{if(!$_.Exception.Response){exit 1};@{status=[int]$_.Exception.Response.StatusCode;body=[string]$_.ErrorDetails.Message}|ConvertTo-Json -Compress}";
   response=await new Promise((resolve,reject)=>{const child=execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:20000,maxBuffer:1024*1024},(err,out)=>{if(err)return reject(err);try{resolve(JSON.parse(out.replace(/^\uFEFF/,'')));}catch{reject(new Error());}});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({url:url.href,method:options.method||'GET',auth:options.headers.Authorization,body:options.body||''}));});
  }else{const r=await fetcher(url,{...options,redirect:'error',signal:AbortSignal.timeout(15000)});response={status:r.status,body:await r.text()};}
 }catch{throw new WaError(options.method==='POST'?'发送结果不确定，请核实后处理，系统不会自动重发':'无法连接官方接口',options.method==='POST'?'unknown':'failed');}
 if(response.status===429)throw new WaError('官方接口限流，稍后重试','rate');
 if(response.status>=500)throw new WaError('官方接口暂时异常，发送结果需核实',options.method==='POST'?'unknown':'failed');
 if(response.status<200||response.status>=300)throw new WaError('官方接口拒绝请求，请检查账号权限、收件人和模板（HTTP '+response.status+'）');
 try{if(response.body.length>512*1024)throw new Error();return JSON.parse(response.body);}catch{throw new WaError('官方接口响应无效，发送结果需核实',options.method==='POST'?'unknown':'failed');}
}
export async function inspectWaAccount(c,credentials,fetcher){
 const headers={Authorization:'Bearer '+credentials.token};
 const phone=await request(new URL(`https://graph.facebook.com/${c.version}/${c.phoneId}?fields=id,display_phone_number,verified_name`),{headers},fetcher);
 if(String(phone.id)!==c.phoneId||String(phone.display_phone_number||'').replace(/\D/g,'')!==c.phone)throw new WaError('Phone Number ID与店铺号码不一致');
 const numbers=await request(new URL(`https://graph.facebook.com/${c.version}/${c.wabaId}/phone_numbers?fields=id&limit=100`),{headers},fetcher);
 if(!Array.isArray(numbers.data)||!numbers.data.some(n=>String(n.id)===c.phoneId))throw new WaError('此号码不属于所填WABA，或未在前100个号码中找到');
 const data=await request(new URL(`https://graph.facebook.com/${c.version}/${c.wabaId}/message_templates?fields=name,language,status,components&limit=100`),{headers},fetcher);
 if(!Array.isArray(data.data))throw new WaError('未能读取此WABA的模板');return data.data.filter(t=>t.status==='APPROVED').map(t=>({name:t.name,language:t.language,components:t.components}));
}
export async function sendWaTemplate(c,credentials,payload,fetcher){
 const body={messaging_product:'whatsapp',recipient_type:'individual',to:payload.phone,type:'template',template:{name:payload.template.name,language:{code:payload.template.language},...(payload.parameters.length?{components:[{type:'body',parameters:payload.parameters.map(text=>({type:'text',text}))}]}:{})}};
 const result=await request(new URL(`https://graph.facebook.com/${c.version}/${c.phoneId}/messages`),{method:'POST',headers:{Authorization:'Bearer '+credentials.token,'Content-Type':'application/json'},body:JSON.stringify(body)},fetcher);
 const id=result.messages?.[0]?.id;if(typeof id!=='string'||!id||id.length>300)throw new WaError('官方响应未包含消息ID，请先核实发送结果','unknown');return id;
}
