"""Regression check for third-party clients (WorkBuddy-like): an agent loop with its own
system prompt and tool names, executing the tools locally, over streaming /v1/messages.

    python scripts/e2e-third-party.py <base_url> <api_key> [model]

Prints prompt-cache usage per request. Expect the second request on to write only a few
hundred to a few thousand tokens (session continuity by fingerprint), not the whole
context again.
"""
import json
import os
import socket
import subprocess
import sys
import tempfile
import urllib.request

BASE, KEY = sys.argv[1].rstrip("/"), sys.argv[2]
MODEL = sys.argv[3] if len(sys.argv) > 3 else "claude-sonnet-5-5"
WORK = tempfile.mkdtemp()
with open(os.path.join(WORK, "notes.txt"), "w", encoding="utf-8") as f:
    f.write("project codename: pelican\nbudget: 4817\n")

SYSTEM = ("You are DeskPal, a desktop work assistant made by Example Corp. Use the provided tools "
          "to inspect the user's files and machine. Be brief.")
TOOLS = [
    {"name": "read_file", "description": "Read a text file from the user's workspace.",
     "input_schema": {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}},
    {"name": "run_command", "description": "Run a shell command on the user's machine and return its output.",
     "input_schema": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]}},
]


def call(messages):
    body = {"model": MODEL, "max_tokens": 2000, "stream": True, "system": SYSTEM, "tools": TOOLS, "messages": messages}
    req = urllib.request.Request(f"{BASE}/v1/messages", data=json.dumps(body).encode(),
                                 headers={"x-api-key": KEY, "content-type": "application/json",
                                          "user-agent": "DeskPal/1.0"})
    blocks, usage, partial = {}, {}, {}
    with urllib.request.urlopen(req, timeout=300) as r:
        for raw in r:
            line = raw.decode("utf-8").strip()
            if not line.startswith("data:"):
                continue
            ev = json.loads(line[5:])
            t = ev.get("type")
            if t == "message_start":
                usage = ev["message"].get("usage", {})
            elif t == "content_block_start":
                blocks[ev["index"]] = dict(ev["content_block"])
            elif t == "content_block_delta":
                d = ev["delta"]
                b = blocks[ev["index"]]
                if d.get("type") == "text_delta":
                    b["text"] = b.get("text", "") + d["text"]
                elif d.get("type") == "input_json_delta":
                    partial[ev["index"]] = partial.get(ev["index"], "") + d["partial_json"]
                elif d.get("type") == "thinking_delta":
                    b["thinking"] = b.get("thinking", "") + d.get("thinking", "")
                elif d.get("type") == "signature_delta":
                    b["signature"] = d.get("signature")
            elif t == "error":
                raise RuntimeError(ev)
    for i, js in partial.items():
        blocks[i]["input"] = json.loads(js) if js else {}
    return [blocks[i] for i in sorted(blocks)], usage


def run_tool(name, inp):
    if name == "read_file":
        try:
            with open(os.path.join(WORK, os.path.basename(inp.get("path", ""))), encoding="utf-8") as f:
                return f.read()
        except OSError as e:
            return f"error: {e}"
    if name == "run_command":
        cmd = inp.get("command", "")
        if cmd.strip() == "hostname":
            return socket.gethostname()
        return subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=30).stdout[:2000]
    return "unknown tool"


def turn(messages, label):
    for step in range(8):
        content, usage = call(messages)
        tools = [b for b in content if b["type"] == "tool_use"]
        print(f"{label}.{step}  cache write {usage.get('cache_creation_input_tokens')}  "
              f"read {usage.get('cache_read_input_tokens')}  tools {[t['name'] for t in tools]}")
        messages.append({"role": "assistant", "content": content})
        if not tools:
            return "".join(b.get("text", "") for b in content if b["type"] == "text")
        messages.append({"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": t["id"], "content": run_tool(t["name"], t.get("input", {}))}
            for t in tools]})
    return "(no final answer)"


msgs = [{"role": "user", "content": "Read notes.txt and run the command hostname, then tell me the codename, the budget plus one, and the hostname."}]
print("answer 1:", turn(msgs, "q1")[:200])
after_q1 = list(msgs)
msgs.append({"role": "user", "content": "Now multiply that budget by two using run_command with python -c, and tell me the result."})
print("answer 2:", turn(msgs, "q2")[:200])
# Rewind: drop question 2 and ask something else from the state after answer 1.
rewound = after_q1 + [{"role": "user", "content": "Instead: what is the codename written in capital letters? Answer with just the word."}]
print("answer 3 (after rewind):", turn(rewound, "q3")[:200])
print("expected: pelican, 4818,", socket.gethostname(), "; then 9634; then PELICAN (q3 should resume, not rebuild)")
