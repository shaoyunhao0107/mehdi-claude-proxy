// OpenAI protocol layer — Responses (/v1/responses) response adapter.
//
// Intercepts the Anthropic output the hardened core writes to `res` (one JSON message, or
// an Anthropic SSE stream) and re-emits it as an OpenAI Responses response: a `response`
// object for non-stream, or the Responses SSE event sequence (response.created,
// output_item.added, output_text.delta / function_call_arguments.delta, output_item.done,
// response.completed) for streaming. Named SSE events and sequence_number are what Codex
// reads. The core is untouched.
import type { Response } from "express";
import type { ResponsesToolAliases } from "./responsesTools.js";

type Json = Record<string, unknown>;

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export interface ResponsesAdapterOptions {
  responseId: string; // resp_...
  model: string;
  stream: boolean;
  created: number;
  aliases: ResponsesToolAliases;
  reasoningRequested: boolean;
}

function toStatus(stop: string | null | undefined): "completed" | "incomplete" {
  return stop === "max_tokens" ? "incomplete" : "completed";
}

function mapUsage(u: AnthropicUsage | undefined): Json {
  const input = (u?.input_tokens ?? 0) + (u?.cache_read_input_tokens ?? 0) + (u?.cache_creation_input_tokens ?? 0);
  const output = u?.output_tokens ?? 0;
  return {
    input_tokens: input,
    output_tokens: output,
    total_tokens: input + output,
    input_tokens_details: { cached_tokens: u?.cache_read_input_tokens ?? 0 },
  };
}

interface BlockState {
  kind: "text" | "tool";
  itemId: string;
  outputIndex: number;
  text: string;
  args: string;
  callId?: string;
  claudeName?: string;
}

export class OpenAIResponsesResAdapter {
  readonly headersSent = false;
  private realHeadersSent = false;
  private errorStatus = 200;
  private usage: AnthropicUsage | undefined;
  private finish: string | null = null;
  private seq = 0;
  private outputIndex = 0;
  private createdEmitted = false;
  private blocks = new Map<number, BlockState>();
  private output: Json[] = []; // closed items, for response.completed
  private sseBuffer = "";
  private closed = false;

  constructor(
    private readonly real: Response,
    private readonly opt: ResponsesAdapterOptions,
  ) {}

  // --- surface handleNative uses ---------------------------------------------------------

  setHeader(name: string, value: string): this {
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
  json(body: Json): this {
    if (body && body.type === "error") this.sendError(this.errorStatus === 200 ? 500 : this.errorStatus, body.error as Json);
    else this.sendNonStream(body);
    return this;
  }
  write(chunk: string): boolean {
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
    this.real.end();
    return this;
  }
  on(event: string, cb: (...a: unknown[]) => void): this {
    this.real.on(event, cb);
    return this;
  }

  // --- emit ------------------------------------------------------------------------------

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

  private emit(event: string, data: Json): void {
    this.real.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data, sequence_number: this.seq++ })}\n\n`);
  }

  private envelope(status: string, extra: Json = {}): Json {
    return { id: this.opt.responseId, object: "response", created_at: this.opt.created, model: this.opt.model, status, ...extra };
  }

  private toolItem(st: BlockState, status: "in_progress" | "completed"): Json {
    const alias = st.claudeName ? this.opt.aliases.get(st.claudeName) : undefined;
    const ns = alias?.namespace ? { namespace: alias.namespace } : {};
    const id = `fc_${st.callId}`;
    if (alias?.kind === "custom") {
      let input = st.args;
      try {
        const parsed = JSON.parse(st.args || "{}") as { input?: unknown };
        if (parsed && typeof parsed.input === "string") input = parsed.input;
        else if (st.args === "" || st.args === "{}") input = "";
      } catch {
        /* keep raw */
      }
      return { type: "custom_tool_call", id, call_id: st.callId, name: alias.name, ...ns, input, status };
    }
    return { type: "function_call", id, call_id: st.callId, name: alias?.name ?? st.claudeName, ...ns, arguments: st.args || "{}", status };
  }

  private handleFrame(frame: string): void {
    const dataLine = frame.split("\n").find((l) => l.startsWith("data:"));
    if (!dataLine) return;
    let ev: Json;
    try {
      ev = JSON.parse(dataLine.slice(5).trim());
    } catch {
      return;
    }
    switch (ev.type as string) {
      case "message_start": {
        const u = (ev.message as { usage?: AnthropicUsage } | undefined)?.usage;
        if (u) this.usage = { ...this.usage, ...u };
        if (!this.createdEmitted) {
          this.createdEmitted = true;
          this.emit("response.created", { response: this.envelope("in_progress", { output: [] }) });
          this.emit("response.in_progress", { response: this.envelope("in_progress", { output: [] }) });
          if (this.opt.reasoningRequested) {
            const oi = this.outputIndex++;
            const item: Json = { type: "reasoning", id: `rs_${this.opt.responseId}`, summary: [], encrypted_content: null, status: "completed" };
            this.emit("response.output_item.added", { output_index: oi, item: { ...item, status: "in_progress" } });
            this.emit("response.output_item.done", { output_index: oi, item });
            this.output.push(item);
          }
        }
        break;
      }
      case "content_block_start": {
        const idx = ev.index as number;
        const block = ev.content_block as { type?: string; id?: string; name?: string } | undefined;
        const oi = this.outputIndex++;
        if (block?.type === "text") {
          const itemId = `msg_${this.opt.responseId}_${oi}`;
          this.blocks.set(idx, { kind: "text", itemId, outputIndex: oi, text: "", args: "" });
          this.emit("response.output_item.added", {
            output_index: oi,
            item: { type: "message", id: itemId, status: "in_progress", role: "assistant", content: [] },
          });
          this.emit("response.content_part.added", {
            item_id: itemId, output_index: oi, content_index: 0, part: { type: "output_text", text: "", annotations: [] },
          });
        } else if (block?.type === "tool_use") {
          const st: BlockState = { kind: "tool", itemId: `fc_${block.id}`, outputIndex: oi, text: "", args: "", callId: block.id, claudeName: block.name };
          this.blocks.set(idx, st);
          this.emit("response.output_item.added", { output_index: oi, item: this.toolItem(st, "in_progress") });
        }
        break;
      }
      case "content_block_delta": {
        const st = this.blocks.get(ev.index as number);
        if (!st) break;
        const delta = ev.delta as { type?: string; text?: string; partial_json?: string } | undefined;
        if (delta?.type === "text_delta" && delta.text) {
          st.text += delta.text;
          this.emit("response.output_text.delta", { item_id: st.itemId, output_index: st.outputIndex, content_index: 0, delta: delta.text });
        } else if (delta?.type === "input_json_delta" && delta.partial_json !== undefined) {
          st.args += delta.partial_json;
          this.emit("response.function_call_arguments.delta", { item_id: st.itemId, output_index: st.outputIndex, delta: delta.partial_json });
        }
        break;
      }
      case "content_block_stop": {
        const st = this.blocks.get(ev.index as number);
        if (!st) break;
        if (st.kind === "text") {
          this.emit("response.output_text.done", { item_id: st.itemId, output_index: st.outputIndex, content_index: 0, text: st.text });
          this.emit("response.content_part.done", {
            item_id: st.itemId, output_index: st.outputIndex, content_index: 0, part: { type: "output_text", text: st.text, annotations: [] },
          });
          const item: Json = { type: "message", id: st.itemId, status: "completed", role: "assistant", content: [{ type: "output_text", text: st.text, annotations: [] }] };
          this.emit("response.output_item.done", { output_index: st.outputIndex, item });
          this.output.push(item);
        } else {
          const item = this.toolItem(st, "completed");
          const alias = st.claudeName ? this.opt.aliases.get(st.claudeName) : undefined;
          if (alias?.kind !== "custom") {
            this.emit("response.function_call_arguments.done", { item_id: st.itemId, output_index: st.outputIndex, arguments: st.args || "{}" });
          }
          this.emit("response.output_item.done", { output_index: st.outputIndex, item });
          this.output.push(item);
        }
        break;
      }
      case "message_delta": {
        const d = ev.delta as { stop_reason?: string } | undefined;
        if (d?.stop_reason) this.finish = d.stop_reason;
        const u = ev.usage as AnthropicUsage | undefined;
        if (u) this.usage = { ...this.usage, ...u };
        break;
      }
      case "message_stop": {
        const status = toStatus(this.finish);
        const extra: Json = { output: this.output, usage: mapUsage(this.usage), parallel_tool_calls: true, tool_choice: "auto", tools: [] };
        if (status === "incomplete") extra.incomplete_details = { reason: "max_output_tokens" };
        this.emit(status === "incomplete" ? "response.incomplete" : "response.completed", { response: this.envelope(status, extra) });
        break;
      }
      case "error": {
        this.emit("response.failed", { response: this.envelope("failed", { error: toResponsesError(ev.error as Json | undefined) }) });
        break;
      }
      default:
        break;
    }
  }

  private sendNonStream(msg: Json): void {
    const content = (msg.content as Json[]) ?? [];
    const output: Json[] = [];
    const textParts: Json[] = [];
    if (this.opt.reasoningRequested) {
      output.push({ type: "reasoning", id: `rs_${this.opt.responseId}`, summary: [], encrypted_content: null, status: "completed" });
    }
    for (const b of content) {
      if (b.type === "text" && typeof b.text === "string") textParts.push({ type: "output_text", text: b.text, annotations: [] });
      else if (b.type === "tool_use") {
        const st: BlockState = { kind: "tool", itemId: `fc_${b.id}`, outputIndex: 0, text: "", args: JSON.stringify(b.input ?? {}), callId: b.id as string, claudeName: b.name as string };
        output.push(this.toolItem(st, "completed"));
      }
    }
    if (textParts.length) {
      output.splice(this.opt.reasoningRequested ? 1 : 0, 0, { type: "message", id: `msg_${this.opt.responseId}`, status: "completed", role: "assistant", content: textParts });
    }
    const status = toStatus(msg.stop_reason as string | undefined);
    const body: Json = this.envelope(status, {
      output,
      usage: mapUsage(msg.usage as AnthropicUsage | undefined),
      parallel_tool_calls: true,
      tool_choice: "auto",
      tools: [],
      ...(status === "incomplete" ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
    });
    this.realHeadersSent = true;
    this.real.json(body);
  }

  private sendError(status: number, err: Json | undefined): void {
    if (this.realHeadersSent) {
      this.emit("response.failed", { response: this.envelope("failed", { error: toResponsesError(err) }) });
      this.real.end();
      this.closed = true; // a later end() must not write to the ended response
      return;
    }
    this.realHeadersSent = true;
    this.real.status(status).json({ error: toResponsesError(err) });
  }
}

function toResponsesError(err: Json | undefined): Json {
  return { type: (err?.type as string) ?? "server_error", message: (err?.message as string) ?? "Internal server error" };
}
