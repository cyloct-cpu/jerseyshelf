[CmdletBinding()]
param([ValidateRange(1024,65535)][int]$Port=3002)
$ErrorActionPreference='Stop'
$previewRoot=Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$previewState=Join-Path $previewRoot 'storage/image-search'
$previewNode='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe'
$previewPython='C:/Users/Administrator/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
if(-not (Test-Path -LiteralPath $previewNode)){$previewNode=(Get-Command node -ErrorAction Stop).Source}
if(-not (Test-Path -LiteralPath $previewPython)){throw '请设置本机 Python 路径，并安装 scripts/image-search/requirements.txt 中的依赖。'}
if(-not (Test-Path -LiteralPath (Join-Path $previewState 'index.json'))){throw '请先按照使用说明建立试验图库索引。'}
try{if((Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2).ok){Write-Host "预览服务已运行：http://127.0.0.1:$Port/search?mode=image";return}}catch{}
$env:PORT=[string]$Port
$env:HOST='127.0.0.1'
$env:IMAGE_SEARCH_PYTHON=$previewPython
$env:IMAGE_SEARCH_AUTO_UPDATE='false'
$env:TRANSLATION_AUTO_UPDATE='false'
$env:FX_AUTO_UPDATE='false'
$previewProcess=Start-Process -FilePath $previewNode -ArgumentList 'apps/api/server.mjs' -WorkingDirectory $previewRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $previewState 'preview-server.log') -RedirectStandardError (Join-Path $previewState 'preview-server-error.log')
Set-Content -LiteralPath (Join-Path $previewState 'preview-server.pid') -Value $previewProcess.Id
for($attempt=0;$attempt -lt 40;$attempt++){
 Start-Sleep -Milliseconds 250
 if($previewProcess.HasExited){throw '预览服务启动失败，请查看 storage/image-search/preview-server-error.log'}
 try{if((Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 2).ok){Write-Host "预览：http://127.0.0.1:$Port/search?mode=image";Write-Host '使用现有本地管理员账户登录。后台维护入口：/admin/image-search';return}}catch{}
}
throw '预览服务尚未响应，请查看预览日志。'
