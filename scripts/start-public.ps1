# Runs the proxy on 0.0.0.0:<Port> in a restart loop (API key required; admin API loopback-only).
# Uses this machine's existing `claude` login - no CLAUDE_CODE_OAUTH_TOKEN is set.
# Normally started by the scheduled task that scripts/install-windows.ps1 registers.
param([int]$Port = 3457)

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$env:PORT = "$Port"
$env:ADMIN_API_SECRET = (Get-Content "$root\.admin-secret" -Raw).Trim()
$env:DATABASE_PATH = "$root\data\proxy.db"
# Ollama is only for /v1/embeddings; a local address makes /health fail fast when it's absent.
$env:OLLAMA_URL = "http://127.0.0.1:11434"
$env:PATH = "$env:USERPROFILE\.local\bin;$env:ProgramFiles\nodejs;$env:PATH"
$node = (Get-Command node -ErrorAction Stop).Source
$log = "$root\proxy.log"

while ($true) {
    # Keep the log bounded: rotate to proxy.log.1 past 20 MB (one old copy is kept).
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 20MB) { Move-Item $log "$log.1" -Force }
    "[$(Get-Date -Format s)] starting proxy on port $Port" | Out-File $log -Append -Encoding unicode
    & $node dist/server.js *>> $log
    "[$(Get-Date -Format s)] proxy exited with code $LASTEXITCODE, restarting in 10s" | Out-File $log -Append -Encoding unicode
    Start-Sleep -Seconds 10
}
