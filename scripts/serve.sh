#!/usr/bin/env bash
# Runs this proxy as a service reachable from other machines, protected by an
# API key, and prints the addresses and the key to use.
#
#   scripts/serve.sh install [--port 3457]   set up, start, print addresses and key
#   scripts/serve.sh info                    print addresses and key again
#   scripts/serve.sh restart | stop | uninstall | logs
#
# It listens on every interface, so every network this machine is on can reach
# it: the local network always, the internet when this machine has a public
# address and the port is open in its firewall / security group. The API answers
# 401 without the key. One instance serves /v1/messages, /v1/chat/completions
# and /v1/responses.
#
# Needs: Node 22+ and the Claude Code CLI logged in for the user that runs this
# (claude auth status). A fresh clone is built on the first install.
#
# On Windows use scripts/install-windows.ps1 instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CONFIG_DIR="${PROXY_CONFIG_DIR:-$HOME/.config/claude-code-proxy}"
KEY_FILE="$CONFIG_DIR/api-key"
PORT_FILE="$CONFIG_DIR/serve-port"
START_SCRIPT="$CONFIG_DIR/serve-start.sh"
DATA_DIR="$CONFIG_DIR/data"
ADMIN_FILE="$CONFIG_DIR/admin-secret"
LABEL="com.claude-code-proxy"
UNIT="claude-code-proxy"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
case "$(uname -s)" in Darwin) OS=mac ;; Linux) OS=linux ;; *) echo "unsupported system: $(uname -s)" >&2; exit 1 ;; esac
LOG_FILE="$([ "$OS" = mac ] && echo "$HOME/Library/Logs/claude-code-proxy.log" || echo "$CONFIG_DIR/claude-code-proxy.log")"

say() { printf '%s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
port() { cat "$PORT_FILE" 2>/dev/null || echo 3457; }

# systemd: a user unit for an ordinary user, a system unit for root.
if [ "$OS" = linux ]; then
  if [ "$(id -u)" = 0 ]; then SYSTEMCTL=(systemctl); UNIT_FILE="/etc/systemd/system/$UNIT.service"
  else SYSTEMCTL=(systemctl --user); UNIT_FILE="$HOME/.config/systemd/user/$UNIT.service"; fi
fi

lan_addresses() {
  if [ "$OS" = mac ]; then ifconfig 2>/dev/null | awk '/^[a-z]/{iface=$1} /inet /{print iface, $2}' | grep -Ev '^(lo|utun|bridge|awdl|llw)' | awk '{print $2}' | grep -v '^127\.'
  elif command -v ip >/dev/null 2>&1; then ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | grep -Ev '^(172\.17\.|169\.254\.)' || true
  else hostname -I 2>/dev/null | tr ' ' '\n' | grep -E '^[0-9]+\.' || true; fi
}

# The address the internet sees this machine as. Not routed through a proxy:
# a proxy's exit address is not this machine's.
public_address() {
  local url ip
  for url in https://api.ipify.org https://ifconfig.me/ip https://icanhazip.com; do
    ip="$(curl -4 -fsS -m 6 --noproxy '*' "$url" 2>/dev/null | tr -d '[:space:]' || true)"
    if [[ "$ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then echo "$ip"; return 0; fi
  done
  return 1
}

answers() { [ "$(curl -s -m "${2:-5}" --noproxy '*' -o /dev/null -w '%{http_code}' "http://$1:$(port)/health" 2>/dev/null)" = 200 ]; }

# A fresh clone has no build.
ensure_built() {
  [ -f "$ROOT/dist/server.js" ] && return 0
  say "No build yet: installing dependencies and building (a few minutes the first time)..."
  mkdir -p "$CONFIG_DIR"
  (cd "$ROOT" && npm install --no-audit --no-fund && npm run build) >"$CONFIG_DIR/build.log" 2>&1 \
    || die "the build failed: see $CONFIG_DIR/build.log"
  [ -f "$ROOT/dist/server.js" ] || die "the build produced no dist/server.js"
}

write_start_script() {
  local node claude_dir
  node="$(command -v node)" || die "node not found (Node 22+ is needed)"
  [ "$("$node" -p 'Number(process.versions.node.split(".")[0])')" -ge 22 ] || die "Node 22+ is needed, found $("$node" -v)"
  ensure_built
  command -v claude >/dev/null 2>&1 || die "the Claude Code CLI ('claude') is not on PATH"
  claude auth status 2>/dev/null | grep -q '"loggedIn": *true' || die "the Claude Code CLI is not logged in: run 'claude' and log in first"
  claude_dir="$(dirname "$(command -v claude)")"
  mkdir -p "$CONFIG_DIR" "$DATA_DIR/sdk-cwd"
  if [ ! -s "$ADMIN_FILE" ]; then
    (umask 077; openssl rand -hex 24 > "$ADMIN_FILE")
  fi
  chmod 600 "$ADMIN_FILE"
  echo "$1" > "$PORT_FILE"
  cat > "$START_SCRIPT" <<EOF
#!/usr/bin/env bash
# Written by scripts/serve.sh. The admin secret is read from its file, not kept here.
export PATH="$claude_dir:$(dirname "$node"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PORT="$1"
export DATABASE_PATH="$DATA_DIR/proxy.db"
export SESSION_DIR="$DATA_DIR/sessions"
export AUDIT_DIR="$DATA_DIR/audit"
export SDK_CWD="$DATA_DIR/sdk-cwd"
export ADMIN_API_SECRET="\$(cat "$ADMIN_FILE")"
cd "$ROOT" || exit 1
exec "$node" "$ROOT/dist/server.js"
EOF
  chmod 700 "$START_SCRIPT"
}

service_stop() {
  if [ "$OS" = mac ]; then launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  else "${SYSTEMCTL[@]}" stop "$UNIT" 2>/dev/null || true; fi
}

service_start() {
  if [ "$OS" = mac ]; then
    mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG_FILE")"
    cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$START_SCRIPT</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>StandardOutPath</key><string>$LOG_FILE</string>
  <key>StandardErrorPath</key><string>$LOG_FILE</string>
</dict></plist>
EOF
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    # bootout returns before the old instance is gone, and bootstrap fails while it is still there.
    local i
    for i in $(seq 1 40); do launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break; sleep 0.5; done
    launchctl bootstrap "gui/$(id -u)" "$PLIST"
  else
    command -v systemctl >/dev/null 2>&1 || die "systemd not found: start it yourself with $START_SCRIPT"
    mkdir -p "$(dirname "$UNIT_FILE")"
    cat > "$UNIT_FILE" <<EOF
[Unit]
Description=Claude Code proxy
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$START_SCRIPT
WorkingDirectory=$ROOT
Restart=always
RestartSec=5
StandardOutput=append:$LOG_FILE
StandardError=append:$LOG_FILE

[Install]
WantedBy=$([ "$(id -u)" = 0 ] && echo multi-user.target || echo default.target)
EOF
    "${SYSTEMCTL[@]}" daemon-reload
    "${SYSTEMCTL[@]}" enable --now "$UNIT" >/dev/null
    "${SYSTEMCTL[@]}" restart "$UNIT"
    # A user service stops at logout unless lingering is on.
    if [ "$(id -u)" != 0 ] && command -v loginctl >/dev/null 2>&1; then
      loginctl enable-linger "$(id -un)" 2>/dev/null || say "note: run 'sudo loginctl enable-linger $(id -un)' so the service keeps running after you log out"
    fi
  fi
}

wait_up() {
  local i
  for i in $(seq 1 60); do answers 127.0.0.1 2 && return 0; sleep 0.5; done
  return 1
}

# The first client key, made through the admin API once the server is up. With
# no key at all the proxy serves this machine only.
ensure_key() {
  [ -s "$KEY_FILE" ] && return 0
  local body key
  body="$(curl -s -m 10 --noproxy '*' -X POST "http://127.0.0.1:$(port)/api/admin/keys" \
    -H "authorization: Bearer $(cat "$ADMIN_FILE")" -H 'content-type: application/json' -d '{"name":"clients"}')"
  key="$(printf '%s' "$body" | grep -o '"key":"[^"]*"' | cut -d'"' -f4)"
  [ -n "$key" ] || die "could not create an API key: $body"
  (umask 077; printf '%s' "$key" > "$KEY_FILE")
}

info() {
  [ -s "$KEY_FILE" ] || die "not installed yet: run '$0 install'"
  local p key ip public models
  p="$(port)"; key="$(cat "$KEY_FILE")"
  if answers 127.0.0.1 3; then say "The proxy is running on port $p."
  else say "The proxy is NOT answering on port $p. Log: $LOG_FILE"; fi
  say ""
  say "API key"
  say "  $key"
  say ""
  say "Addresses"
  say "  this machine    http://127.0.0.1:$p"
  while read -r ip; do
    [ -n "$ip" ] || continue
    if answers "$ip" 3; then say "  local network   http://$ip:$p"
    else say "  local network   http://$ip:$p   (did not answer from here)"; fi
  done < <(lan_addresses)
  if public="$(public_address)"; then
    if lan_addresses | grep -qx "$public"; then
      say "  internet        http://$public:$p   (this machine holds the public address)"
    elif answers "$public" 5; then
      say "  internet        http://$public:$p   (answers from here; confirm from another network)"
    else
      say "  internet        http://$public:$p   (did not answer from here)"
      say "                  That address is how the internet sees this machine. If it is a router's,"
      say "                  a proxy's or a VPN's, nothing reaches this machine through it. On a server"
      say "                  with its own public address, open TCP $p in the firewall / security group."
    fi
  else
    say "  internet        could not find a public address (no internet access from here?)"
  fi
  say ""
  say "Base URL for clients"
  say "  OpenAI format      <address>/v1      (chat/completions, responses, models)"
  say "  Anthropic format   <address>         (v1/messages)"
  models="$(curl -s -m 8 --noproxy '*' -H "authorization: Bearer $key" "http://127.0.0.1:$p/v1/models" 2>/dev/null | grep -o '"id":"[^"]*"' | cut -d'"' -f4 | tr '\n' ' ' || true)"
  [ -n "$models" ] && { say ""; say "Models"; say "  $models"; }
  say ""
  say "Try it"
  say "  curl http://127.0.0.1:$p/v1/chat/completions -H 'content-type: application/json' \\"
  say "    -H 'authorization: Bearer $key' \\"
  say "    -d '{\"model\":\"claude-haiku-5-5\",\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}'"
  say ""
  say "Requests are plain HTTP: on a network you do not trust, put HTTPS in front before sharing the key."
}

command="${1:-info}"; shift || true
case "$command" in
  install)
    p="$(port)"
    while [ $# -gt 0 ]; do case "$1" in --port) p="$2"; shift 2 ;; *) die "unknown option $1" ;; esac; done
    [[ "$p" =~ ^[0-9]+$ ]] || die "the port must be a number"
    write_start_script "$p"
    service_start
    wait_up || { say "The service did not answer within 30 s. Last lines of $LOG_FILE:"; tail -n 20 "$LOG_FILE" 2>/dev/null || true; exit 1; }
    ensure_key
    info ;;
  info) info ;;
  restart)
    [ -x "$START_SCRIPT" ] || die "not installed yet: run '$0 install'"
    service_start; wait_up || die "the service did not answer; see $LOG_FILE"; say "restarted" ;;
  stop) service_stop; say "stopped" ;;
  uninstall)
    service_stop
    if [ "$OS" = mac ]; then rm -f "$PLIST"; else "${SYSTEMCTL[@]}" disable "$UNIT" 2>/dev/null || true; rm -f "$UNIT_FILE"; "${SYSTEMCTL[@]}" daemon-reload 2>/dev/null || true; fi
    rm -f "$START_SCRIPT" "$PORT_FILE"
    say "removed the service. The API key ($KEY_FILE) and the data ($DATA_DIR) were kept." ;;
  logs) tail -n "${1:-60}" "$LOG_FILE" ;;
  *) die "unknown command '$command' (install, info, restart, stop, uninstall, logs)" ;;
esac
