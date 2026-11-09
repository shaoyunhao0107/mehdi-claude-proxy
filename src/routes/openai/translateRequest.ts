// OpenAI protocol layer — request translation (OpenAI chat/completions -> Anthropic).
//
// Produces the Anthropic `NativeBody` + `clientTools` that the hardened core
// (anthropicNative.ts handleNative) consumes. System messages are collected into the
// Anthropic `system` field; because that text is not a Claude Code prompt, the core
// treats this as a third-party client and uses the official preset with the client's
// prompt moved into a reminder — the safe fingerprint path, for free.
import type { ClientTool } from "../../types/toolBridge.js";
import type { NativeBody } from "../anthropicNative.js";

type Json = Record<string, unknown>;

export interface OpenAIChatBody {
  model?: string;
  messages?: Json[];
  tools?: Json[];
  tool_choice?: unknown;
  stream?: boolean;
  max_tokens?: number;
  max_completion_tokens?: number;
  temperature?: number;
  reasoning_effort?: string;
  stream_options?: { include_usage?: boolean };
}

export interface TranslatedChat {
  body: NativeBody;
  clientTools: ClientTool[];
  includeUsage: boolean;
}

// OpenAI content can be a string or an array of parts ({type:"text"|"image_url", ...}).
function partsToAnthropic(content: unknown): string | Json[] {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const blocks: Json[] = [];
  for (const part of content as Json[]) {
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({ type: "text", text: part.text });
    } else if (part.type === "image_url") {
      const url = ((part.image_url as Json)?.url as string) ?? "";
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (m) {
        blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
      } else if (url) {
        blocks.push({ type: "image", source: { type: "url", url } });
      }
    }
  }
  // A single text block collapses to a plain string (smaller, same meaning).
  if (blocks.length === 1 && blocks[0].type === "text") return blocks[0].text as string;
  return blocks;
}

function toolChoice(choice: unknown): NativeBody["tool_choice"] {
  if (choice === "none") return { type: "none" };
  if (choice === "required") return { type: "any" };
  if (choice === "auto") return { type: "auto" };
  if (choice && typeof choice === "object") {
    const fn = (choice as Json).function as Json | undefined;
    if (fn?.name) return { type: "tool", name: fn.name } as NativeBody["tool_choice"];
  }
  return undefined;
}

export function translateChatRequest(raw: OpenAIChatBody): TranslatedChat {
  const systemTexts: string[] = [];
  const messages: NativeBody["messages"] = [];

  for (const msg of raw.messages ?? []) {
    const role = msg.role as string;
    if (role === "system" || role === "developer") {
      const c = msg.content;
      systemTexts.push(typeof c === "string" ? c : JSON.stringify(c));
      continue;
    }
    if (role === "assistant") {
      const toolCalls = msg.tool_calls as Json[] | undefined;
      if (toolCalls && toolCalls.length) {
        const blocks: Json[] = [];
        if (typeof msg.content === "string" && msg.content) blocks.push({ type: "text", text: msg.content });
        for (const tc of toolCalls) {
          const fn = (tc.function as Json) ?? {};
          let input: Json = {};
          try {
            input = JSON.parse((fn.arguments as string) || "{}");
          } catch {
            input = {};
          }
          blocks.push({ type: "tool_use", id: tc.id, name: fn.name, input });
        }
        messages.push({ role: "assistant", content: blocks });
      } else {
        messages.push({ role: "assistant", content: partsToAnthropic(msg.content) });
      }
      continue;
    }
    if (role === "tool") {
      const block: Json = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id as string,
        content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content ?? ""),
      };
      const last = messages[messages.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content) && (last.content[0] as Json)?.type === "tool_result") {
        (last.content as Json[]).push(block);
      } else {
        messages.push({ role: "user", content: [block] });
      }
      continue;
    }
    // user (and anything else) → user turn
    messages.push({ role: "user", content: partsToAnthropic(msg.content) });
  }

  const clientTools: ClientTool[] = (raw.tools ?? [])
    .filter((t) => (t as Json).type === "function" && (t as Json).function)
    .map((t) => {
      const fn = (t as Json).function as Json;
      return {
        name: fn.name as string,
        description: fn.description as string | undefined,
        input_schema: (fn.parameters as Json) ?? { type: "object", properties: {} },
      };
    });

  const body: NativeBody = {
    model: raw.model ?? "",
    messages,
    stream: raw.stream === true,
    max_tokens: raw.max_completion_tokens ?? raw.max_tokens,
  };
  if (systemTexts.length) body.system = systemTexts.join("\n\n");
  const tc = toolChoice(raw.tool_choice);
  if (tc) body.tool_choice = tc;

  return {
    body,
    clientTools,
    includeUsage: raw.stream !== true || raw.stream_options?.include_usage === true,
  };
}
