// OpenAI protocol layer: request translation and the Anthropic->OpenAI response adapter.
// Pure translation, no API calls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { translateChatRequest } from "../src/routes/openai/translateRequest.js";
import { OpenAIChatResAdapter } from "../src/routes/openai/resAdapter.js";

// --- request translation -----------------------------------------------------------------

test("system messages become the Anthropic system field; user/assistant map over", () => {
  const { body } = translateChatRequest({
    model: "m",
    messages: [
      { role: "system", content: "You are terse." },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "user", content: "bye" },
    ],
  });
  assert.equal(body.system, "You are terse.");
  assert.equal(body.messages.length, 3);
  assert.deepEqual(body.messages[0], { role: "user", content: "hi" });
  assert.deepEqual(body.messages[1], { role: "assistant", content: "hello" });
});

test("tools, tool_choice and max_completion_tokens translate", () => {
  const { body, clientTools } = translateChatRequest({
    model: "m",
    max_completion_tokens: 256,
    tool_choice: "required",
    messages: [{ role: "user", content: "x" }],
    tools: [{ type: "function", function: { name: "get_weather", description: "w", parameters: { type: "object", properties: { city: { type: "string" } } } } }],
  });
  assert.equal(body.max_tokens, 256);
  assert.deepEqual(body.tool_choice, { type: "any" });
  assert.equal(clientTools.length, 1);
  assert.equal(clientTools[0].name, "get_weather");
});

test("an assistant tool_call followed by a tool result becomes Anthropic tool_use / tool_result", () => {
  const { body } = translateChatRequest({
    model: "m",
    messages: [
      { role: "user", content: "weather?" },
      { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"Paris"}' } }] },
      { role: "tool", tool_call_id: "call_1", content: "18C" },
    ],
  });
  const asst = body.messages[1];
  assert.equal(asst.role, "assistant");
  assert.equal((asst.content as Array<Record<string, unknown>>)[0].type, "tool_use");
  assert.equal((asst.content as Array<Record<string, unknown>>)[0].id, "call_1");
  const toolMsg = body.messages[2];
  assert.equal(toolMsg.role, "user");
  assert.equal((toolMsg.content as Array<Record<string, unknown>>)[0].type, "tool_result");
  assert.equal((toolMsg.content as Array<Record<string, unknown>>)[0].tool_use_id, "call_1");
});

test("a data: image_url part becomes an Anthropic base64 image block", () => {
  const { body } = translateChatRequest({
    model: "m",
    messages: [{ role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } }] }],
  });
  const parts = body.messages[0].content as Array<Record<string, unknown>>;
  assert.equal(parts[1].type, "image");
  assert.deepEqual(parts[1].source, { type: "base64", media_type: "image/png", data: "AAAA" });
});

// --- response adapter: fake Express res that collects output ------------------------------

function fakeRes() {
  const state: { headers: Record<string, string>; chunks: string[]; json?: unknown; status: number; ended: boolean } = {
    headers: {}, chunks: [], status: 200, ended: false,
  };
  const res = {
    setHeader(k: string, v: string) { state.headers[k] = v; return res; },
    flushHeaders() {},
    status(c: number) { state.status = c; return res; },
    json(b: unknown) { state.json = b; state.ended = true; return res; },
    write(s: string) { state.chunks.push(s); return true; },
    end() { state.ended = true; return res; },
    on() { return res; },
  };
  return { res, state };
}

function frames(evs: Array<[string, Record<string, unknown>]>): string[] {
  return evs.map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

test("non-stream: an Anthropic message becomes one chat.completion with tool_calls", () => {
  const { res, state } = fakeRes();
  const a = new OpenAIChatResAdapter(res as never, { id: "chatcmpl-x", model: "m", stream: false, created: 1, includeUsage: true, emitReasoning: false });
  a.json({
    type: "message", role: "assistant",
    content: [{ type: "text", text: "sure" }, { type: "tool_use", id: "t1", name: "get_weather", input: { city: "Paris" } }],
    stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5 },
  });
  const b = state.json as { object: string; choices: Array<{ message: Record<string, unknown>; finish_reason: string }>; usage: Record<string, number> };
  assert.equal(b.object, "chat.completion");
  assert.equal(b.choices[0].finish_reason, "tool_calls");
  assert.equal(b.choices[0].message.content, "sure");
  const tc = (b.choices[0].message.tool_calls as Array<Record<string, unknown>>)[0];
  assert.equal((tc.function as Record<string, string>).name, "get_weather");
  assert.equal((tc.function as Record<string, string>).arguments, '{"city":"Paris"}');
  assert.equal(b.usage.prompt_tokens, 15); // input + cache_read
  assert.equal(b.usage.total_tokens, 18);
});

test("stream: Anthropic SSE becomes OpenAI chunks, tool args assemble, ends with DONE", () => {
  const { res, state } = fakeRes();
  const a = new OpenAIChatResAdapter(res as never, { id: "chatcmpl-y", model: "m", stream: true, created: 1, includeUsage: true, emitReasoning: false });
  a.flushHeaders();
  for (const f of frames([
    ["message_start", { message: { usage: { input_tokens: 4 } } }],
    ["content_block_start", { index: 0, content_block: { type: "text" } }],
    ["content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hi " } }],
    ["content_block_start", { index: 1, content_block: { type: "tool_use", id: "t1", name: "f" } }],
    ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: '{"a":' } }],
    ["content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "1}" } }],
    ["message_delta", { delta: { stop_reason: "tool_use" }, usage: { output_tokens: 7 } }],
    ["message_stop", {}],
  ])) a.write(f);
  a.end();

  assert.equal(state.headers["Content-Type"], "text/event-stream");
  assert.ok(state.chunks.includes("data: [DONE]\n\n"));
  const parsed = state.chunks.filter((c) => c.startsWith("data: {")).map((c) => JSON.parse(c.slice(6)));
  let text = "", args = "", finish: string | null = null, name = "";
  for (const o of parsed) {
    const d = o.choices[0].delta;
    if (d.content) text += d.content;
    for (const tc of d.tool_calls ?? []) { if (tc.function?.name) name = tc.function.name; if (tc.function?.arguments) args += tc.function.arguments; }
    if (o.choices[0].finish_reason) finish = o.choices[0].finish_reason;
  }
  assert.equal(text, "Hi ");
  assert.equal(name, "f");
  assert.equal(args, '{"a":1}');
  assert.equal(finish, "tool_calls");
});

test("an Anthropic error body becomes an OpenAI error with a mapped type", () => {
  const { res, state } = fakeRes();
  const a = new OpenAIChatResAdapter(res as never, { id: "chatcmpl-e", model: "m", stream: false, created: 1, includeUsage: false, emitReasoning: false });
  a.status(429).json({ type: "error", error: { type: "rate_limit_error", message: "slow down" } });
  assert.equal(state.status, 429);
  const b = state.json as { error: { type: string; message: string; code: string } };
  assert.equal(b.error.type, "rate_limit_exceeded");
  assert.equal(b.error.code, "rate_limit_error");
  assert.equal(b.error.message, "slow down");
});
