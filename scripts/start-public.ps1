# Runs the proxy on 0.0.0.0:<Port> in a restart loop (API key required; admin API loopback-only).
# Uses this machine's existing `claude` login - no CLAUDE_CODE_OAUTH_TOKEN is set.
# Normally started by the scheduled task that scripts/install-windows.ps1 registers.
#
# -Role anthropic (default): /v1/messages (Anthropic protocol), the original behaviour.
# -Role openai:              also mounts the OpenAI layer (/v1/chat/completions, /v1/responses).
#   The two roles are separate processes/ports but share this folder's database and API key,
#   so one .home-key works for both. The OpenAI role keeps its own sessions/audit/log so the
#   two never collide.
param([int]$Port = 3457, [string]$Role = "anthropic")

$root = Split-Path $PSScriptRoot -Parent
Set-Location $root

$env:PORT = "$Port"
$env:ADMIN_API_SECRET = (Get-Content "$root\.admin-secret" -Raw).Trim()
$env:DATABASE_PATH = "$root\data\proxy.db"
# Ollama is only for /v1/embeddings; a local address makes /health fail fast when it's absent.
$env:OLLAMA_URL = "http://127.0.0.1:11434"
$env:PATH = "$env:USERPROFILE\.local\bin;$env:ProgramFiles\nodejs;$env:PATH"
# Working directory for the headless SDK when the client declares none (third-party /
# OpenAI clients). It MUST be a plain directory OUTSIDE any git repo: the CLI attaches the
# cwd's git status (uncommitted files, recent commit messages) to the upstream context, so
# a cwd inside this proxy's own repo would leak "proxy-openai.log", commit subjects, etc. to
# Anthropic. A neutral non-repo folder reports "Is a git repository: false" and leaks
# nothing. Claude Code clients that mirror their own cwd are unaffected.
$env:SDK_CWD = "$env:USERPROFILE\claude-workspace"
New-Item -ItemType Directory -Force $env:SDK_CWD | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
$log = "$root\proxy.log"
if ($Role -eq "openai") {
    $env:ENABLE_OPENAI_LAYER = "1"
    # Own sessions/audit so the two roles never write the same files; DB/key stay shared.
    $env:SESSION_DIR = "$root\data\sessions-openai"
    $env:AUDIT_DIR = "$root\data\audit-openai"
    $log = "$root\proxy-openai.log"
}

while ($true) {
    # Keep the log bounded: rotate to proxy.log.1 past 20 MB (one old copy is kept).
    if ((Test-Path $log) -and (Get-Item $log).Length -gt 20MB) { Move-Item $log "$log.1" -Force }
    "[$(Get-Date -Format s)] starting proxy on port $Port" | Out-File $log -Append -Encoding unicode
    & $node dist/server.js *>> $log
    "[$(Get-Date -Format s)] proxy exited with code $LASTEXITCODE, restarting in 10s" | Out-File $log -Append -Encoding unicode
    Start-Sleep -Seconds 10
}
