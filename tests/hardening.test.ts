// Local improvements: one middleware pass per request, loopback-only without keys,
// the second barrier for built-in tools, and OpenAI-layer translation details.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "net";
import { app } from "../src/app.js";
import { createApiKey, updateApiKey } from "../src/services/apiKeyService.js";
import { db } from "../src/db/connection.js";
import { buildSdkOptions } from "../src/services/sdkBridge.js";
import { translateChatRequest } from "../src/routes/openai/translateRequest.js";
import { OpenAIChatResAdapter } from "../src/routes/openai/resAdapter.js";
import { apiKeyAuth } from "../src/middleware/apiKeyAuth.js";
import { concurrencyLimit, concurrencyStatus } from "../src/middleware/concurrency.js";

async function withServer<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  try {
    return await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

function fakeAuthCall(remoteAddress: string, headers: Record<string, string> = {}) {
  const out: { status?: number; body?: unknown; passed: boolean } = { passed: false };
  const req = { headers, path: "/models", socket: { remoteAddress } };
  const res = {
    status(code: number) { out.status = code; return this; },
    json(body: unknown) { out.body = body; return this; },
  };
  apiKeyAuth(req as never, res as never, () => { out.passed = true; });
  return out;
}

test("without any key, only this machine gets in", () => {
  db.prepare("DELETE FROM api_keys").run();
  assert.equal(fakeAuthCall("127.0.0.1").passed, true);
  assert.equal(fakeAuthCall("::ffff:127.0.0.1").passed, true);
  const remote = fakeAuthCall("203.0.113.9");
  assert.equal(remote.passed, false);
  assert.equal(remote.status, 401);
});

test("a request counts once against its key's requests per minute", async () => {
  db.prepare("DELETE FROM api_keys").run();
  const key = createApiKey("rpm");
  updateApiKey(key.id, { rate_limit_rpm: 3 });
  await withServer(async (base) => {
    // /v1/embeddings is the last router: it used to pass the limiter once per router before it.
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await fetch(`${base}/v1/embeddings`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key.key}` },
        body: JSON.stringify({}),
      });
      statuses.push(r.status);
    }
    assert.deepEqual(statuses.map((s) => s === 429), [false, false, false, true]);
  });
});

test("a wrong key is refused before anything else runs", async () => {
  await withServer(async (base) => {
    const r = await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer sk-wrong" } });
    assert.equal(r.status, 401);
  });
});

test("the concurrency cap covers /responses", () => {
  const before = concurrencyStatus().running;
  const listeners: Array<() => void> = [];
  const res = { once: (_e: string, cb: () => void) => { listeners.push(cb); } };
  let passed = false;
  concurrencyLimit({ method: "POST", path: "/responses" } as never, res as never, () => { passed = true; });
  assert.equal(passed, true);
  assert.equal(concurrencyStatus().running, before + 1);
  for (const cb of listeners) cb(); // the response closed: the slot is released
  assert.equal(concurrencyStatus().running, before);
});

test("client-run built-ins get no permission rules and no permission mode", () => {
  // A rule on a file tool runs before the PreToolUse hook and would hide the call from the
  // client. The CLI's default permission mode is what refuses a call the hook missed.
  const hooks = { PreToolUse: [{ hooks: [async () => ({})] }] };
  const options = buildSdkOptions({ resolvedModel: "m", builtInTools: ["Bash", "Read", "Write"], extraOptions: { hooks } });
  assert.equal(options.disallowedTools, undefined);
  assert.equal(options.permissionMode, undefined);
  assert.equal(options.allowDangerouslySkipPermissions, undefined);
  assert.deepEqual(options.tools, ["Bash", "Read", "Write"]);
  assert.deepEqual(buildSdkOptions({ resolvedModel: "m", disallowedTools: ["WebSearch"], extraOptions: { hooks } }).disallowedTools, ["WebSearch"]);
});

test("content arrays give their text to system, assistant and tool turns", () => {
  const t = translateChatRequest({
    model: "m",
    messages: [
      { role: "system", content: [{ type: "text", text: "be brief" }] },
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "calling" }], tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "c1", content: [{ type: "text", text: "line 1" }, { type: "text", text: "line 2" }] },
    ],
  });
  assert.equal(t.body.system, "be brief");
  assert.deepEqual(t.body.messages[1].content, [
    { type: "text", text: "calling" },
    { type: "tool_use", id: "c1", name: "f", input: {} },
  ]);
  assert.deepEqual(t.body.messages[2].content, [{ type: "tool_result", tool_use_id: "c1", content: "line 1\nline 2" }]);
});

test("reasoning_effort turns thinking on at that effort; none and minimal leave it off", () => {
  const high = translateChatRequest({ model: "m", messages: [{ role: "user", content: "x" }], reasoning_effort: "high" });
  assert.deepEqual(high.body.thinking, { type: "adaptive" });
  assert.deepEqual(high.body.output_config, { effort: "high" });
  for (const effort of ["none", "minimal", undefined]) {
    const off = translateChatRequest({ model: "m", messages: [{ role: "user", content: "x" }], reasoning_effort: effort });
    assert.equal(off.body.thinking, undefined);
    assert.equal(off.body.output_config, undefined);
  }
});

test("after a mid-stream error the adapter writes nothing more", () => {
  const writes: string[] = [];
  let ended = 0;
  const real = {
    setHeader() {}, flushHeaders() {},
    write(chunk: string) { if (ended) throw new Error("write after end"); writes.push(chunk); return true; },
    end() { ended++; },
    status() { return this; }, json() { return this; }, on() { return this; },
  };
  const a = new OpenAIChatResAdapter(real as never, { id: "c", model: "m", stream: true, created: 1, includeUsage: false, emitReasoning: false });
  a.flushHeaders();
  a.status(529).json({ type: "error", error: { type: "overloaded_error", message: "busy" } });
  a.write("event: ping\ndata: {\"type\":\"ping\"}\n\n");
  a.end();
  assert.equal(ended, 1);
  assert.ok(writes.some((w) => w.includes('"code":"overloaded_error"')));
  assert.equal(writes[writes.length - 1], "data: [DONE]\n\n");
});

test("the thinking filter drops thinking blocks and renumbers the rest", async () => {
  const { thinkingFilter } = await import("../src/routes/anthropicNative.js");
  const f = thinkingFilter();
  const events = [
    { type: "message_start", message: {} },
    { type: "content_block_start", index: 0, content_block: { type: "thinking" } },
    { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hm" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "s" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "hi" } },
    { type: "content_block_stop", index: 1 },
    { type: "content_block_start", index: 2, content_block: { type: "redacted_thinking" } },
    { type: "content_block_stop", index: 2 },
    { type: "content_block_start", index: 3, content_block: { type: "tool_use", id: "t", name: "f" } },
    { type: "content_block_stop", index: 3 },
    { type: "message_delta", delta: { stop_reason: "tool_use" } },
    { type: "message_stop" },
  ];
  const out = events.map((e) => f(e)).filter(Boolean) as Array<{ type: string; index?: number }>;
  assert.deepEqual(out.map((e) => [e.type, e.index]), [
    ["message_start", undefined],
    ["content_block_start", 0], ["content_block_delta", 0], ["content_block_stop", 0],
    ["content_block_start", 1], ["content_block_stop", 1],
    ["message_delta", undefined], ["message_stop", undefined],
  ]);
  // A stream without thinking passes through untouched.
  const g = thinkingFilter();
  const plain = { type: "content_block_start", index: 0, content_block: { type: "text" } };
  assert.equal(g(plain), plain);
});
