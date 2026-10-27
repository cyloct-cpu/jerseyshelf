import { execFile } from 'node:child_process';
import { TranslationError } from './translation-errors.mjs';

async function windowsJsonRequest(url, options) {
  // Credentials travel only over stdin, never in a shell command or process args.
  const script = "$translationUtf8=New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding=$translationUtf8; [Console]::OutputEncoding=$translationUtf8; $request=([Console]::In.ReadToEnd() | ConvertFrom-Json); $headers=@{}; $request.headers.psobject.Properties | ForEach-Object { $headers[$_.Name]=[string]$_.Value }; $params=@{Uri=[string]$request.url;Method=[string]$request.method;Headers=$headers;TimeoutSec=15;MaximumRedirection=0;UseBasicParsing=$true;ErrorAction='Stop'}; if($headers.ContainsKey('Content-Type')) { $params.ContentType=$headers['Content-Type']; $headers.Remove('Content-Type') }; if($null -ne $request.body) { $params.Body=[System.Text.Encoding]::UTF8.GetBytes([string]$request.body) }; try { $r=Invoke-WebRequest @params; @{status=[int]$r.StatusCode;body=[string]$r.Content;retryAfter=[string]$r.Headers['Retry-After']} | ConvertTo-Json -Compress } catch { if(!$_.Exception.Response) { exit 1 }; $r=$_.Exception.Response; $content=$_.ErrorDetails.Message; if(!$content) { $reader=New-Object System.IO.StreamReader($r.GetResponseStream()); $content=$reader.ReadToEnd() }; @{status=[int]$r.StatusCode;body=[string]$content;retryAfter=[string]$r.Headers['Retry-After']} | ConvertTo-Json -Compress }";
  const raw = await new Promise((resolve, reject) => {
    const child = execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:20000,maxBuffer:512*1024},(error,stdout) => error ? reject(error) : resolve(stdout));
    child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify({url:url.href,method:options.method||'GET',headers:options.headers||{},body:options.body??null}));
  });
  return JSON.parse(raw.replace(/^\uFEFF/,''));
}

let windowsPreferred=false;
export async function translationJsonRequest(url, options = {}, fetcher = fetch) {
  // Fixed HTTPS host allowlist (official + vetted free endpoints). No configurable proxy URL.
  const allowedHosts = ['api.mymemory.translated.net','api.cognitive.microsofttranslator.com','fanyi-api.baidu.com','api-free.deepl.com',(process.env.GOOGLE_FREE_BASE||'https://translate.googleapis.com').replace(/^https:\/\//,''),(process.env.LINGVA_BASE||'https://lingva.ml').replace(/^https:\/\//,'')];
  if (url.protocol !== 'https:' || !allowedHosts.includes(url.hostname)) throw new TranslationError('翻译接口地址无效','invalid');
  let result;
  if(windowsPreferred&&fetcher===fetch&&process.platform==='win32') {
    try {result=await windowsJsonRequest(url,options);}catch {throw new TranslationError('无法连接翻译接口，已尝试下一个服务','network');}
  } else {
    try {
      const response=await fetcher(url,{...options,signal:AbortSignal.timeout(12000),redirect:'error'});
      const body=await response.text();result={status:response.status,body,retryAfter:response.headers?.get('retry-after')||''};
    } catch {
      if(fetcher!==fetch||process.platform!=='win32')throw new TranslationError('无法连接翻译接口，已尝试下一个服务','network');
      try {result=await windowsJsonRequest(url,options);windowsPreferred=true;}catch {throw new TranslationError('无法连接翻译接口，已尝试下一个服务','network');}
    }
  }
  let payload = {};
  if (String(result.body).length > 256*1024) throw new TranslationError('翻译接口返回内容过大','invalid');
  try { payload = JSON.parse(result.body); } catch { if (result.status >= 200 && result.status < 300) throw new TranslationError('翻译接口未返回有效JSON','invalid'); }
  const wait = /^\d+$/.test(result.retryAfter) ? Number(result.retryAfter)*1000 : Date.parse(result.retryAfter)-Date.now();
  return {status:Number(result.status),payload,retryMs:Number.isFinite(wait)&&wait>0 ? Math.max(5000,Math.min(wait,86400000)) : 60000};
}
