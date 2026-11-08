#!/usr/bin/env bash
# Regression check: a real Claude Code client runs two prompts in one session through
# the proxy, then prints per-request prompt-cache usage and the result file.
#
#   scripts/e2e-two-prompts.sh <base_url> <api_key> [model] [--restart "<command>"]
#
# Expect: tools ran on THIS machine (result.txt here, hostname of this machine), and from
# the second request on, cache writes in the hundreds to low thousands while reads grow.
# With --restart, the command runs between the two prompts (e.g. restarting the proxy);
# the second prompt should then still continue the same session (no full rewrite).
# Needs: claude on PATH, python. Never run it in a shell whose ANTHROPIC_BASE_URL is the
# proxy's own address if that shell also starts the proxy.
set -euo pipefail
BASE="${1:?base url}"; KEY="${2:?api key}"; MODEL="${3:-claude-sonnet-5-5}"
RESTART=""
if [ "${4:-}" = "--restart" ]; then RESTART="${5:?restart command}"; fi

DIR="$(mktemp -d)"
cd "$DIR"
printf 'secret-number: 4817\n' > input.txt
printf 'def add(a, b):\n    return a + b\n\ndef mul(a, b):\n    return a * b\n' > calc.py

P1="Read input.txt and calc.py, use Bash to run 'hostname', fix nothing, then write result.txt containing the secret number plus 1, the hostname, and the names of the functions in calc.py. Reply 'done'."
P2="Add a function sub(a, b) to calc.py, then use Bash to run python -c to print add(2,3), mul(2,3) and sub(5,2) from calc.py, and append that output to result.txt. Reply 'done'."

run() { ANTHROPIC_BASE_URL="$BASE" ANTHROPIC_AUTH_TOKEN="$KEY" timeout 600 claude -p "$@" < /dev/null 2>/dev/null; }

report() {
  python - "$1" "$2" <<'PY'
import json, sys
seen = set()
for line in open(sys.argv[1], encoding="utf-8"):
    o = json.loads(line)
    if o.get("type") == "assistant":
        m = o["message"]
        if m["id"] in seen:
            continue
        seen.add(m["id"]); u = m.get("usage", {})
        kinds = [b.get("name") or b["type"] for b in m["content"]]
        print(f'{sys.argv[2]}  cache write {u.get("cache_creation_input_tokens")}  read {u.get("cache_read_input_tokens")}  {kinds}')
    if o.get("type") == "result":
        print(f'{sys.argv[2]}  result: {str(o.get("result"))[:80]}')
PY
}

run --model "$MODEL" --output-format stream-json --verbose --permission-mode bypassPermissions "$P1" > q1.jsonl
report q1.jsonl q1
if [ -n "$RESTART" ]; then echo "== restart: $RESTART"; bash -c "$RESTART"; fi
run --continue --model "$MODEL" --output-format stream-json --verbose --permission-mode bypassPermissions "$P2" > q2.jsonl
report q2.jsonl q2
echo "== result.txt (expect 4818, $(hostname), add, mul, then 5 6 3):"
cat result.txt 2>/dev/null || echo "(missing)"
echo "== dir: $DIR"
