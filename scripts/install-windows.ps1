# One-shot install for Windows: deps, build, secrets, boot-time scheduled task, firewall, first API key.
# Run from an elevated PowerShell (needed for the scheduled task and firewall rule):
#   powershell -ExecutionPolicy Bypass -File scripts\install-windows.ps1 [-Role anthropic|openai] [-Port N] [-KeyName home-pc]
# Safe to re-run: existing secrets / keys are kept, the task and firewall rule are replaced.
#
# Two roles, chosen with -Role (install one or both — both share this folder's DB and key):
#   anthropic (default): Anthropic /v1/messages with client-side tools. Default port 3457,
#                        task "mehdi-claude-proxy". This is the original proxy.
#   openai:              also serves the OpenAI layer (/v1/chat/completions, /v1/responses)
#                        for Cursor / Cline / Cherry / Codex etc. Default port 3458, task
#                        "mehdi-claude-proxy-openai". Separate process, so it never disturbs
#                        the Anthropic one. Run this script twice (once per role) for both.
param(
    [ValidateSet("anthropic", "openai")][string]$Role = "anthropic",
    [int]$Port = 0,
    [string]$TaskName = "",
    [string]$KeyName = "home-pc",
    [switch]$NoFirewall
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

# Role-specific defaults (only when the caller did not override them).
if ($Port -eq 0) { $Port = if ($Role -eq "openai") { 3458 } else { 3457 } }
if ($TaskName -eq "") { $TaskName = if ($Role -eq "openai") { "mehdi-claude-proxy-openai" } else { "mehdi-claude-proxy" } }

function Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Check-Exit($what) { if ($LASTEXITCODE -ne 0) { throw "$what failed (exit $LASTEXITCODE)" } }

Step "Checking prerequisites"
foreach ($c in "node", "npm", "claude") {
    if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { throw "'$c' not found in PATH. Install it first (see SKILL.md)." }
}
Write-Host "  node $(node -v), npm $(npm -v), $(claude --version)"
if (-not (Test-Path "$env:USERPROFILE\.claude\.credentials.json")) {
    Write-Warning "No Claude login found for $env:USERNAME. Run 'claude' once and log in with the Max account, then re-run this script."
}

Step "Stopping any running instance (it locks the better-sqlite3 .node file)"
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $TaskName }
$old = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($old) {
    $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$($old.OwningProcess)").ParentProcessId
    Stop-Process -Id $old.OwningProcess -Force -ErrorAction SilentlyContinue
    # also stop the restart loop (powershell running start-public.ps1) so it can't relaunch node mid-install
    if ($parent) { Stop-Process -Id $parent -Force -ErrorAction SilentlyContinue }
    Start-Sleep 2
}

Step "Installing dependencies"
npm install --no-fund --no-audit; Check-Exit "npm install"
# npm 11+ blocks install scripts until approved; better-sqlite3 needs its native build.
npm install-scripts approve better-sqlite3 2>$null | Out-Null
npm rebuild better-sqlite3; Check-Exit "better-sqlite3 rebuild"
node -e "new (require('better-sqlite3'))(':memory:')"; Check-Exit "better-sqlite3 load test"

Step "Building"
npm run build; Check-Exit "build"

Step "Secrets"
if (-not (Test-Path "$root\.admin-secret")) {
    $b = New-Object byte[] 32; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
    Set-Content "$root\.admin-secret" -Value (($b | ForEach-Object { $_.ToString("x2") }) -join "") -Encoding ascii -NoNewline
    Write-Host "  generated .admin-secret"
} else { Write-Host "  keeping existing .admin-secret" }

Step "Scheduled task '$TaskName' (runs at boot as $env:USERNAME, no login needed)"
$script = "$root\scripts\start-public.ps1"
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$script`" -Port $Port -Role $Role" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtStartup; $trigger.Delay = "PT40S"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew
$desc = if ($Role -eq "openai") { "claude-code-proxy on :$Port (OpenAI layer: /v1/chat/completions, /v1/responses + Anthropic /v1/messages, client-side tools)" } else { "claude-code-proxy on :$Port (Anthropic /v1/messages, client-side tools)" }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description $desc -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

if (-not $NoFirewall) {
    Step "Windows Firewall: allow inbound TCP $Port"
    Get-NetFirewallRule -DisplayName "$TaskName $Port" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule -DisplayName "$TaskName $Port" -Direction Inbound -Protocol TCP -LocalPort $Port -Action Allow | Out-Null
}

Step "Waiting for the server"
$ok = $false
foreach ($i in 1..30) {
    try { Invoke-RestMethod "http://127.0.0.1:$Port/health" -TimeoutSec 10 | Out-Null; $ok = $true; break } catch { Start-Sleep 2 }
}
if (-not $ok) { $logName = if ($Role -eq "openai") { "proxy-openai.log" } else { "proxy.log" }; throw "Server did not come up on :$Port. Check $root\$logName" }

Step "API key for clients"
if (-not (Test-Path "$root\.home-key")) {
    $secret = (Get-Content "$root\.admin-secret" -Raw).Trim()
    $r = Invoke-RestMethod -Method Post "http://127.0.0.1:$Port/api/admin/keys" -Headers @{ Authorization = "Bearer $secret" } -ContentType "application/json" -Body (@{ name = $KeyName } | ConvertTo-Json)
    Set-Content "$root\.home-key" -Value $r.key -Encoding ascii -NoNewline
    Write-Host "  created key '$KeyName' ($($r.key_prefix)...) -> .home-key"
} else { Write-Host "  keeping existing .home-key" }

Write-Host "`nDone ($Role role). Proxy: http://0.0.0.0:$Port   key: $root\.home-key" -ForegroundColor Green
if ($Role -eq "openai") {
    Write-Host "  OpenAI endpoints: POST /v1/chat/completions, POST /v1/responses (Codex). Anthropic /v1/messages also served."
} else {
    Write-Host "  Anthropic endpoint: POST /v1/messages. (For OpenAI clients, install the 'openai' role: -Role openai.)"
}
Write-Host "Remember to open TCP $Port in the cloud security group, then configure clients (see SKILL.md)."
