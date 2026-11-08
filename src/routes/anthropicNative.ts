// Local patch: native /v1/messages handler for plain chat and client-side tools.
//
// Compared with the original paths in anthropic.ts:
//  - History is sent as one SDK user message made of per-message content blocks
//    (not one flattened string), so Anthropic's prompt cache matches the previous
//    request's prefix and only the new turn is billed at full price.
//  - Images / PDFs (in user messages and inside tool_result) are passed as real blocks.
//  - The upstream Anthropic event stream is relayed as-is (real streaming, thinking
//    deltas + signatures included); non-streaming responses are accumulated from it.
//  - `thinking` / `output_config.effort` / `max_tokens` from the client are honoured.
//  - The SDK runs isolated: no built-in tools, no settings, no persistence (see sdkBridge).
import type { Request, Response } from "express";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { trackedQuery } from "../services/sdkBridge.js";
import { cancelTask } from "../services/taskTracker.js";
import { classifyUpstreamError } from "../services/errorClassifier.js";
import { buildToolBridge } from "../services/toolBridge.js";
import type { ClientTool } from "../types/toolBridge.js";

type Block = { type?: string; [k: string]: unknown };
interface Msg {
  role: string;
  content: string | Block[];
}
export interface NativeBody {
  model: string;
  messages: Msg[];
  system?: string | Block[];
  stream?: boolean;
  max_tokens?: number;
  thinking?: unknown;
  output_config?: unknown;
  tool_choice?: { type?: string };
}
export interface NativeParams {
  messageId: string;
  requestedModel: string;
  resolvedModel: string;
  stream: boolean;
  body: NativeBody;
  clientTools: ClientTool[];
  sdkCwd: string;
}

const LABEL: Record<string, string> = { user: "User", assistant: "Assistant", system: "System" };
// Keep only the most recent N images/documents from history (older ones become a placeholder).
const MAX_MEDIA = parseInt(process.env.MAX_HISTORY_IMAGES || "8", 10);

// Stable across requests so it stays inside the cached prefix.
const TRANSCRIPT_NOTE =
  "The conversation so far is given to you as a transcript whose turns are labelled " +
  "[User], [Assistant] and [System]. Reply as the assistant to the latest turn. Do not prefix " +
  "your reply with a label. Lines like [called tool ...] and [tool result ...] record earlier tool " +
  "calls; to call a tool yourself, use the tool-use mechanism, never write such lines as text.";

// ---------------- prompt construction ----------------

function isMedia(b: Block): boolean {
  return (b.type === "image" || b.type === "document") && !!b.source && typeof b.source === "object";
}

function cleanMedia(b: Block): Block {
  const out: Block = { type: b.type, source: b.source };
  if (b.type === "document") {
    if (b.title) out.title = b.title;
    if (b.context) out.context = b.context;
  }
  return out; // drops client cache_control etc. (the CLI places its own breakpoints)
}

function countMedia(messages: Msg[]): number {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (isMedia(b)) n++;
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        for (const c of b.content as Block[]) if (isMedia(c)) n++;
      }
    }
  }
  return n;
}

export function buildPromptBlocks(messages: Msg[]): Block[] {
  // Single plain user message: send it untouched (best quality for simple chat).
  if (messages.length === 1 && messages[0].role === "user") {
    const c = messages[0].content;
    if (typeof c === "string") return [{ type: "text", text: c }];
  }

  let skipMedia = Math.max(0, countMedia(messages) - MAX_MEDIA);
  const blocks: Block[] = [];

  for (const m of messages) {
    let buf = `[${LABEL[m.role] ?? m.role}]: `;
    const flush = () => {
      if (buf.trim()) blocks.push({ type: "text", text: buf });
      buf = "";
    };
    const media = (b: Block) => {
      if (skipMedia > 0) {
        skipMedia--;
        buf += `[${b.type} omitted: older attachment]\n`;
        return;
      }
      flush();
      blocks.push(cleanMedia(b));
    };

    if (typeof m.content === "string") {
      buf += m.content;
    } else {
      for (const b of m.content) {
        switch (b.type) {
          case "text":
            buf += `${b.text as string}\n`;
            break;
          case "tool_use":
            buf += `[called tool "${b.name as string}" (id=${b.id as string}) with input: ${JSON.stringify(b.input ?? {})}]\n`;
            break;
          case "tool_result": {
            buf += `[${b.is_error ? "tool error" : "tool result"} (id=${b.tool_use_id as string})]: `;
            if (typeof b.content === "string") buf += `${b.content}\n`;
            else if (Array.isArray(b.content)) {
              for (const c of b.content as Block[]) {
                if (c.type === "text") buf += `${c.text as string}\n`;
                else if (isMedia(c)) media(c);
              }
            } else buf += "\n";
            break;
          }
          case "image":
          case "document":
            if (isMedia(b)) media(b);
            break;
          // thinking / redacted_thinking from earlier turns are dropped
        }
      }
    }
    flush();
  }
  return blocks;
}

function systemText(system: NativeBody["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system || undefined;
  const t = system.filter((b) => b.type === "text").map((b) => b.text as string).join("\n\n");
  return t || undefined;
}

function previewOf(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (typeof c === "string") return c.slice(0, 200);
    const t = c.find((b) => b.type === "text");
    if (t) return String(t.text).slice(0, 200);
    if (c.some((b) => b.type === "tool_result")) return "(tool_result turn)";
  }
  return "(no text)";
}

type SdkThinking =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budgetTokens: number; display?: "summarized" | "omitted" }
  | { type: "disabled" };

// Models that only support a fixed thinking budget (no adaptive thinking).
const BUDGET_ONLY = /haiku-4-5|-4-5-|sonnet-4-0|opus-4-0|opus-4-1|3-7/;

// Client asks for thinking -> adaptive (summarized, so the client can show it); the CLI
// ignores fixed budgets on 4.6+/5.x models. No thinking requested -> disabled (the CLI
// still forces adaptive on 5.x models, where the model decides whether to think).
function mapThinking(t: unknown, model: string, maxTokens?: number): SdkThinking {
  if (!t || typeof t !== "object") return { type: "disabled" };
  const o = t as { type?: string; budget_tokens?: number };
  if (o.type !== "adaptive" && o.type !== "enabled") return { type: "disabled" };
  if (!BUDGET_ONLY.test(model)) return { type: "adaptive", display: "summarized" };
  let budget = typeof o.budget_tokens === "number" ? o.budget_tokens : 8000;
  if (maxTokens && budget >= maxTokens) budget = maxTokens - 1;
  return budget >= 1024 ? { type: "enabled", budgetTokens: budget, display: "summarized" } : { type: "disabled" };
}

function mapEffort(oc: unknown): string | undefined {
  const e = oc && typeof oc === "object" ? (oc as { effort?: unknown }).effort : undefined;
  return typeof e === "string" && ["low", "medium", "high", "xhigh", "max"].includes(e) ? e : undefined;
}

// ---------------- response accumulation ----------------

interface Acc {
  blocks: Block[];
  partialJson: Record<number, string>;
  stopReason: string | null;
  stopSequence: string | null;
  usage: Record<string, unknown>;
}

function accumulate(acc: Acc, ev: Block): void {
  switch (ev.type) {
    case "message_start": {
      const u = (ev.message as { usage?: Record<string, unknown> })?.usage;
      if (u) Object.assign(acc.usage, u);
      break;
    }
    case "content_block_start":
      acc.blocks[ev.index as number] = { ...(ev.content_block as Block) };
      if ((ev.content_block as Block).type === "tool_use") acc.partialJson[ev.index as number] = "";
      break;
    case "content_block_delta": {
      const b = acc.blocks[ev.index as number];
      const d = ev.delta as Block;
      if (!b) break;
      if (d.type === "text_delta") b.text = ((b.text as string) ?? "") + (d.text as string);
      else if (d.type === "thinking_delta") b.thinking = ((b.thinking as string) ?? "") + (d.thinking as string);
      else if (d.type === "signature_delta") b.signature = d.signature;
      else if (d.type === "input_json_delta") acc.partialJson[ev.index as number] += d.partial_json as string;
      break;
    }
    case "content_block_stop": {
      const i = ev.index as number;
      if (acc.partialJson[i] !== undefined) {
        try {
          acc.blocks[i].input = acc.partialJson[i] ? JSON.parse(acc.partialJson[i]) : {};
        } catch {
          acc.blocks[i].input = {};
        }
      }
      break;
    }
    case "message_delta": {
      const d = ev.delta as { stop_reason?: string; stop_sequence?: string | null };
      if (d?.stop_reason) acc.stopReason = d.stop_reason;
      if (d?.stop_sequence !== undefined) acc.stopSequence = d.stop_sequence;
      const u = ev.usage as Record<string, unknown> | undefined;
      if (u) for (const [k, v] of Object.entries(u)) if (v !== null && v !== undefined) acc.usage[k] = v;
      break;
    }
  }
}

function sse(res: Response, ev: Block): void {
  res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

function errorPayload(err: unknown): Block {
  const c = classifyUpstreamError(err);
  return { type: "error", error: { type: c.status >= 500 ? "api_error" : c.type, message: c.message } };
}

// ---------------- handler ----------------

export async function handleNative(req: Request, res: Response, p: NativeParams): Promise<void> {
  const { body } = p;
  const tools = body.tool_choice?.type === "none" ? [] : p.clientTools;

  let bridge: ReturnType<typeof buildToolBridge> | null = null;
  try {
    bridge = tools.length > 0 ? buildToolBridge(tools) : null;
  } catch (err) {
    res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: (err as Error).message } });
    return;
  }
  const nameMap = bridge?.mcpToClient ?? new Map<string, string>();

  const content = buildPromptBlocks(body.messages);
  const sysParts = [TRANSCRIPT_NOTE];
  if (req.keySystemPrompt) sysParts.push(req.keySystemPrompt);
  const cs = systemText(body.system);
  if (cs) sysParts.push(cs);

  const extraEnv: Record<string, string> = {};
  if (typeof body.max_tokens === "number" && body.max_tokens > 0) {
    extraEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(body.max_tokens);
  }

  async function* input(): AsyncGenerator<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      session_id: "",
    } as unknown as SDKUserMessage;
  }

  const { generator } = trackedQuery({
    completionId: p.messageId,
    prompt: input(),
    promptPreview: previewOf(body.messages),
    requestedModel: p.requestedModel,
    resolvedModel: p.resolvedModel,
    isStreaming: p.stream,
    apiKeyId: req.apiKeyId ?? null,
    apiKeyName: req.apiKeyName ?? null,
    includePartialMessages: true,
    mcpServers: bridge?.mcpServers,
    allowedTools: bridge?.allowedTools,
    builtInTools: [],
    systemPrompt: sysParts.join("\n\n"),
    maxTurns: 1,
    cwd: p.sdkCwd,
    thinking: mapThinking(body.thinking, p.resolvedModel, body.max_tokens),
    effort: mapEffort(body.output_config),
    extraEnv,
  });

  const acc: Acc = { blocks: [], partialJson: {}, stopReason: null, stopSequence: null, usage: {} };
  let started = false; // stream: message_start relayed
  let finished = false; // first upstream message_stop seen
  let responded = false;
  let clientGone = false;
  res.on("close", () => {
    if (!responded) {
      clientGone = true;
      cancelTask(p.messageId);
    }
  });

  const finishNonStream = () => {
    responded = true;
    res.json({
      id: p.messageId,
      type: "message",
      role: "assistant",
      model: p.resolvedModel,
      content: acc.blocks.filter(Boolean),
      stop_reason: acc.stopReason ?? "end_turn",
      stop_sequence: acc.stopSequence,
      usage: acc.usage,
    });
  };

  try {
    for await (const m of generator) {
      if (clientGone) break;
      if (finished) continue; // drain the rest so the request log completes
      if (m.type !== "stream_event" || m.parent_tool_use_id) continue;

      const ev = { ...(m.event as Block) };
      if (ev.type === "message_start") {
        ev.message = { ...(ev.message as Block), id: p.messageId, model: p.resolvedModel };
      } else if (ev.type === "content_block_start" && (ev.content_block as Block)?.type === "tool_use") {
        const cb = { ...(ev.content_block as Block) };
        cb.name = nameMap.get(cb.name as string) ?? cb.name;
        ev.content_block = cb;
      }
      accumulate(acc, ev);

      if (p.stream) {
        if (!started) {
          if (ev.type !== "message_start") continue;
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.flushHeaders();
          started = true;
        }
        sse(res, ev);
      }

      if (ev.type === "message_stop") {
        finished = true;
        if (p.stream) {
          responded = true;
          res.end();
        } else {
          finishNonStream();
        }
      }
    }
  } catch (err) {
    // After message_stop the SDK typically throws error_max_turns (it tried to continue
    // past our intercepted tool call). That is the normal path, not a failure.
    if (!finished && !clientGone) {
      console.error("[native] upstream error:", (err as Error)?.message);
      responded = true;
      if (started) {
        sse(res, errorPayload(err));
        res.end();
      } else if (!res.headersSent) {
        const c = classifyUpstreamError(err);
        if (c.retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(c.retryAfterSeconds));
        res.status(c.status).json(errorPayload(err));
      }
      return;
    }
  }

  if (!finished && !clientGone && !responded) {
    responded = true;
    const err = new Error("Upstream ended without a complete message");
    if (started) {
      sse(res, errorPayload(err));
      res.end();
    } else {
      res.status(502).json({ type: "error", error: { type: "api_error", message: err.message } });
    }
  }
}
