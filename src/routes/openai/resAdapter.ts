// OpenAI protocol layer — response interceptor.
//
// The Anthropic core (anthropicNative.ts `handleNative`) writes an Anthropic Messages
// response straight to an Express `res`: either one `res.json(message)` or a stream of
// SSE events (message_start, content_block_*, message_delta, message_stop). This adapter
// is a stand-in `res` that captures that output and re-emits it to the real client in
// OpenAI shape — /v1/chat/completions (object "chat.completion" / "chat.completion.chunk")
// — so the whole hardened core (session continuity, fingerprint alignment, official tool
// definitions) is reused untouched. Nothing in anthropicNative.ts changes.
import type { Response } from "express";

type Json = Record<string, unknown>;

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface OpenAIAdapterOptions {
  id: string; // chatcmpl-...
  model: string; // the model name echoed back to the client (requested model)
  stream: boolean;
  created: number; // unix seconds
  /** Include a usage object (OpenAI `stream_options.include_usage` / always on non-stream). */
  includeUsage: boolean;
  /** Map Anthropic thinking deltas onto `reasoning_content` deltas (default: drop them). */
  emitReasoning: boolean;
}

function stopToFinish(stop: string | null | undefined): "stop" | "tool_calls" | "length" {
  if (stop === "tool_use") return "tool_calls";
  if (stop === "max_tokens") return "length";
  return "stop"; // end_turn, stop_sequence, null
}

function usageBlock(u: AnthropicUsage | undefined): Json | undefined {
  if (!u) return undefined;
  const prompt = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
  const completion = u.output_tokens ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    // Surface cache detail the way OpenAI does for prompt caching, so cost is visible.
    prompt_tokens_details: { cached_tokens: u.cache_read_input_tokens ?? 0 },
  };
}

/**
 * An Express-`Response`-shaped object that handleNative writes Anthropic output to, and
 * which translates that output to OpenAI chat-completions on the real `res`.
 *
 * Only the members handleNative touches are implemented: setHeader, flushHeaders,
 * headersSent, status, json, write, end, on. Everything else is inert.
 */
export class OpenAIChatResAdapter {
  readonly headersSent = false; // handleNative only reads this to avoid double error bodies
  private realHeadersSent = false;
  private sentRole = false;
  private finish: "stop" | "tool_calls" | "length" | null = null;
  private usage: AnthropicUsage | undefined;
  // Anthropic content-block index -> OpenAI tool_calls index (text/thinking blocks are skipped).
  private toolIndexByBlock = new Map<number, number>();
  private nextToolIndex = 0;
  private sseBuffer = "";
  private closed = false;

  constructor(
    private readonly real: Response,
    private readonly opt: OpenAIAdapterOptions,
  ) {}

  // --- surface handleNative uses ---------------------------------------------------------

  setHeader(name: string, value: string): this {
    // Swallow Anthropic SSE headers; we set our own in `begin()`. Pass through Retry-After.
    if (/^retry-after$/i.test(name)) this.real.setHeader(name, value);
    return this;
  }

  flushHeaders(): void {
    this.begin();
  }

  status(code: number): this {
    this.errorStatus = code;
    return this;
  }

  private errorStatus = 200;

  json(body: Json): this {
    // Two cases: an error body ({type:"error", error:{...}}) or a full Anthropic message.
    if (body && body.type === "error") {
      this.sendError(this.errorStatus === 200 ? 500 : this.errorStatus, body.error as Json);
      return this;
    }
    this.sendNonStreamMessage(body);
    return this;
  }

  write(chunk: string): boolean {
    // Streaming path: handleNative writes Anthropic SSE frames "event: X\ndata: {...}\n\n".
    if (this.closed) return false;
    this.begin();
    this.sseBuffer += chunk;
    let i: number;
    while ((i = this.sseBuffer.indexOf("\n\n")) !== -1) {
      const frame = this.sseBuffer.slice(0, i);
      this.sseBuffer = this.sseBuffer.slice(i + 2);
      this.handleFrame(frame);
    }
    return true;
  }

  end(): this {
    if (this.closed) return this;
    this.closed = true;
    if (this.opt.stream) {
      if (this.realHeadersSent) this.real.write("data: [DONE]\n\n");
      this.real.end();
    } else if (!this.realHeadersSent) {
      // handleNative ended the stream without a complete message (rare): close politely.
      this.real.end();
    }
    return this;
  }

  on(event: string, cb: (...a: unknown[]) => void): this {
    // handleNative registers res.on("close", ...) to detect client disconnects.
    this.real.on(event, cb);
    return this;
  }

  // --- translation -----------------------------------------------------------------------

  private begin(): void {
    if (this.realHeadersSent) return;
    this.realHeadersSent = true;
    if (this.opt.stream) {
      this.real.setHeader("Content-Type", "text/event-stream");
      this.real.setHeader("Cache-Control", "no-cache");
      this.real.setHeader("Connection", "keep-alive");
      this.real.flushHeaders?.();
    }
  }

  private chunk(delta: Json, finish: string | null = null, usage?: Json): void {
    const choice: Json = { index: 0, delta, finish_reason: finish };
    const frame: Json = {
      id: this.opt.id,
      object: "chat.completion.chunk",
      created: this.opt.created,
      model: this.opt.model,
      choices: [choice],
    };
    if (usage) frame.usage = usage;
    this.real.write(`data: ${JSON.stringify(frame)}\n\n`);
  }

  private handleFrame(frame: string): void {
    // frame is "event: <type>\ndata: <json>" (possibly just "data: ...").
    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) return;
    let ev: Json;
    try {
      ev = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return;
    }
    const type = ev.type as string;
    switch (type) {
      case "message_start": {
        const msg = ev.message as { usage?: AnthropicUsage } | undefined;
        if (msg?.usage) this.usage = { ...this.usage, ...msg.usage };
        if (!this.sentRole) {
          this.sentRole = true;
          this.chunk({ role: "assistant", content: "" });
        }
        break;
      }
      case "content_block_start": {
        const idx = ev.index as number;
        const block = ev.content_block as { type?: string; id?: string; name?: string } | undefined;
        if (block?.type === "tool_use") {
          const ti = this.nextToolIndex++;
          this.toolIndexByBlock.set(idx, ti);
          this.chunk({
            tool_calls: [{ index: ti, id: block.id, type: "function", function: { name: block.name, arguments: "" } }],
          });
        }
        break;
      }
      case "content_block_delta": {
        const idx = ev.index as number;
        const delta = ev.delta as { type?: string; text?: string; partial_json?: string; thinking?: string } | undefined;
        if (!delta) break;
        if (delta.type === "text_delta" && delta.text) {
          this.chunk({ content: delta.text });
        } else if (delta.type === "input_json_delta" && delta.partial_json !== undefined) {
          const ti = this.toolIndexByBlock.get(idx);
          if (ti !== undefined) {
            this.chunk({ tool_calls: [{ index: ti, function: { arguments: delta.partial_json } }] });
          }
        } else if (delta.type === "thinking_delta" && this.opt.emitReasoning && delta.thinking) {
          this.chunk({ reasoning_content: delta.thinking });
        }
        break;
      }
      case "message_delta": {
        const d = ev.delta as { stop_reason?: string } | undefined;
        if (d?.stop_reason) this.finish = stopToFinish(d.stop_reason);
        const u = ev.usage as AnthropicUsage | undefined;
        if (u) this.usage = { ...this.usage, ...u };
        break;
      }
      case "message_stop": {
        this.chunk({}, this.finish ?? "stop");
        // As OpenAI sends it with stream_options.include_usage: one last chunk that
        // carries the usage and no choices.
        const usage = this.opt.includeUsage ? usageBlock(this.usage) : undefined;
        if (usage) {
          this.real.write(`data: ${JSON.stringify({
            id: this.opt.id, object: "chat.completion.chunk", created: this.opt.created, model: this.opt.model,
            choices: [], usage,
          })}\n\n`);
        }
        break;
      }
      case "error": {
        // An error mid-stream: forward an OpenAI-style error frame, then DONE via end().
        const err = ev.error as Json | undefined;
        this.real.write(`data: ${JSON.stringify({ error: toOpenAIError(err) })}\n\n`);
        break;
      }
      default:
        break; // ping, content_block_stop: nothing to emit
    }
  }

  private sendNonStreamMessage(msg: Json): void {
    const content = (msg.content as Array<Json>) ?? [];
    const texts: string[] = [];
    const toolCalls: Json[] = [];
    for (const b of content) {
      if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
      else if (b.type === "tool_use") {
        toolCalls.push({
          id: b.id,
          type: "function",
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      }
    }
    const message: Json = { role: "assistant", content: texts.length ? texts.join("") : null };
    if (toolCalls.length) message.tool_calls = toolCalls;
    const body: Json = {
      id: this.opt.id,
      object: "chat.completion",
      created: this.opt.created,
      model: this.opt.model,
      choices: [{ index: 0, message, finish_reason: stopToFinish(msg.stop_reason as string | undefined) }],
    };
    const usage = usageBlock(msg.usage as AnthropicUsage | undefined);
    if (usage) body.usage = usage;
    this.realHeadersSent = true;
    this.real.json(body);
  }

  private sendError(status: number, err: Json | undefined): void {
    if (this.realHeadersSent) {
      // Already streaming: emit an error frame instead of an HTTP status.
      this.real.write(`data: ${JSON.stringify({ error: toOpenAIError(err) })}\n\n`);
      if (this.opt.stream) this.real.write("data: [DONE]\n\n");
      this.real.end();
      this.closed = true; // a later end() must not write to the ended response
      return;
    }
    this.realHeadersSent = true;
    this.real.status(status).json({ error: toOpenAIError(err) });
  }
}

function toOpenAIError(err: Json | undefined): Json {
  const type = (err?.type as string) ?? "server_error";
  const message = (err?.message as string) ?? "Internal server error";
  // OpenAI error shape; map Anthropic error types onto familiar OpenAI ones.
  const map: Record<string, string> = {
    invalid_request_error: "invalid_request_error",
    authentication_error: "invalid_request_error",
    rate_limit_error: "rate_limit_exceeded",
    billing_error: "insufficient_quota",
    not_found_error: "invalid_request_error",
    overloaded_error: "server_error",
    api_error: "server_error",
  };
  return { message, type: map[type] ?? "server_error", code: type };
}
