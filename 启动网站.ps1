[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 3001,
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'
$taskNode = 'C:\Users\Administrator\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
if (-not (Test-Path -LiteralPath $taskNode)) {
    $taskNode = (Get-Command node -ErrorAction Stop).Source
}
Set-Location -LiteralPath $PSScriptRoot
$siteUrl = "http://127.0.0.1:$Port"
try {
    $siteHealth = Invoke-RestMethod -Uri "$siteUrl/health" -TimeoutSec 2
    if ($siteHealth.ok -eq $true) {
        Write-Host "网站已运行：$siteUrl/"
        Write-Host "管理后台：$siteUrl/admin"
        return
    }
} catch {
    # Start only after the health check confirms the requested port is not serving the site.
}

$env:PORT = [string]$Port
$env:HOST = '127.0.0.1'
if ($Foreground) {
    & $taskNode 'apps/api/server.mjs'
    exit $LASTEXITCODE
}

$siteStorage = Join-Path $PSScriptRoot 'storage'
New-Item -ItemType Directory -Path $siteStorage -Force | Out-Null
$siteOutLog = Join-Path $siteStorage 'server.log'
$siteErrorLog = Join-Path $siteStorage 'server-error.log'
$siteProcess = Start-Process -FilePath $taskNode -ArgumentList 'apps/api/server.mjs' -WorkingDirectory $PSScriptRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput $siteOutLog -RedirectStandardError $siteErrorLog
Set-Content -LiteralPath (Join-Path $siteStorage 'site-server.pid') -Value $siteProcess.Id -Encoding ascii

for ($attempt = 0; $attempt -lt 40; $attempt++) {
    Start-Sleep -Milliseconds 250
    if ($siteProcess.HasExited) {
        throw "网站启动失败，请查看 $siteErrorLog"
    }
    try {
        $siteHealth = Invoke-RestMethod -Uri "$siteUrl/health" -TimeoutSec 2
        if ($siteHealth.ok -eq $true) {
            Write-Host "网站已在后台启动：$siteUrl/"
            Write-Host "管理后台：$siteUrl/admin"
            Write-Host "日志：$siteOutLog"
            return
        }
    } catch {
        # Give the new server a moment to initialize its database and listener.
    }
}
throw "网站尚未响应，请查看 $siteOutLog 和 $siteErrorLog"
