# Updates the bundled Agent SDK (and with it the CLI the proxy runs: SDK 0.3.N = CLI 2.1.N),
# rebuilds, restarts the service and runs the two-prompt regression check against it.
# If the check fails, the previous SDK version is put back.
#
#   powershell -ExecutionPolicy Bypass -File scripts\update-sdk.ps1 [-Version 0.3.330] [-Port 3457] [-TestModel claude-haiku-5-5] [-SkipTest]
#
# When: the proxy log says a client is newer ("run scripts/update-sdk.ps1"), or
# GET /api/admin/status shows sdk.updateAvailable. Not automatic on purpose: a new CLI can
# change behaviour session continuity relies on, so every update is tested first.
param(
    [string]$Version = "latest",
    [int]$Port = 3457,
    [string]$TaskName = "mehdi-claude-proxy",
    [string]$TestModel = "claude-haiku-5-5",
    [switch]$SkipTest
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

function Installed { (Get-Content "node_modules\@anthropic-ai\claude-agent-sdk\package.json" -Raw | ConvertFrom-Json).version }
function Stop-Proxy {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName }
    $p = (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue).OwningProcess
    if ($p) { Stop-Process -Id $p -Force }
    Start-Sleep -Seconds 2
}
function Start-Proxy {
    Start-ScheduledTask -TaskName $TaskName
    for ($i = 0; $i -lt 45; $i++) {
        Start-Sleep -Seconds 2
        try { if ((Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/health" -TimeoutSec 5).StatusCode -eq 200) { return $true } } catch {}
    }
    return $false
}
function Install-Sdk([string]$v) {
    npm install "@anthropic-ai/claude-agent-sdk@$v" --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install $v failed" }
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
}

$old = Installed
$target = (npm view "@anthropic-ai/claude-agent-sdk@$Version" version | Select-Object -Last 1).Trim()
"installed SDK $old, target $target"
if ($target -eq $old) { "already on $target"; exit 0 }

"stopping the proxy"; Stop-Proxy
try {
    Install-Sdk $target
} catch {
    "update failed ($_), restoring $old"; Install-Sdk $old; Start-Proxy | Out-Null; exit 1
}
if (-not (Start-Proxy)) { "proxy did not come up on $target, restoring $old"; Stop-Proxy; Install-Sdk $old; Start-Proxy | Out-Null; exit 1 }
"proxy is up on SDK $(Installed)"

if ($SkipTest) { "test skipped"; exit 0 }
$key = (Get-Content "$root\.home-key" -TotalCount 1).Trim()
$bash = "$env:ProgramFiles\Git\bin\bash.exe"
"running the two-prompt regression check ($TestModel)"
$out = & $bash "scripts/e2e-two-prompts.sh" "http://127.0.0.1:$Port" $key $TestModel 2>&1 | Out-String
$out
$ok = ($out -match "q2\s+result: done") -and ($out -match "5\s*\r?\n?\s*6\s*\r?\n?\s*3|5 6 3|sub\(5,\s*2\)\s*=?\s*3")
if (-not $ok) {
    "regression check FAILED on $target, restoring $old"
    Stop-Proxy; Install-Sdk $old; Start-Proxy | Out-Null
    exit 1
}
"SDK updated $old -> $target and verified. Commit package.json / package-lock.json."
