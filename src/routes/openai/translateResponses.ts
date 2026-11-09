// OpenAI protocol layer — Responses (/v1/responses) request translation.
//
// Codex's Responses request -> the Anthropic NativeBody the hardened core consumes, plus
// the tool alias table the response adapter needs. `instructions` and leading developer
// turns become the system field; a developer message that appears mid-conversation stays
// in the history (folding it into system would rewrite the cached prefix — see meridian's
// note). Reasoning items are dropped (phase 1).
import type { NativeBody } from "../anthropicNative.js";
import type { ClientTool } from "../../types/toolBridge.js";
import { translateResponsesTools, responsesToolAlias, type ResponsesToolAliases } from "./responsesTools.js";

type Json = Record<string, unknown>;

export interface ResponsesBody {
  model?: string;
  input?: string | Json[];
  instructions?: string;
  tools?: Json[];
  tool_choice?: unknown;
  stream?: boolean;
  max_output_tokens?: number;
  reasoning?: unknown;
  include?: string[];
}

export interface TranslatedResponses {
  body: NativeBody;
  clientTools: ClientTool[];
  aliases: ResponsesToolAliases;
  reasoningRequested: boolean;
}

function partsToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Json[])
    .map((p) => (p.type === "input_text" || p.type === "output_text" ? (p.text as string) ?? "" : ""))
    .join("");
}

function partsToBlocks(content: unknown): Json[] | null {
  if (!Array.isArray(content)) return null;
  const blocks: Json[] = [];
  let hasMedia = false;
  for (const p of content as Json[]) {
    if (p.type === "input_text" || p.type === "output_text") {
      if (p.text) blocks.push({ type: "text", text: p.text });
    } else if (p.type === "input_image") {
      const url = (p.image_url as string) ?? ((p.image_url as Json)?.url as string) ?? "";
      const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
      if (m) {
        blocks.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
        hasMedia = true;
      }
    }
  }
  return hasMedia ? blocks : null;
}

function toolOutputToContent(output: unknown): string {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) {
    return (output as Json[]).map((p) => (typeof p.text === "string" ? p.text : "")).join("");
  }
  return JSON.stringify(output ?? "");
}

export function translateResponsesRequest(raw: ResponsesBody): TranslatedResponses {
  const { clientTools, aliases } = translateResponsesTools(raw.tools);
  const items: Json[] =
    typeof raw.input === "string" ? [{ type: "message", role: "user", content: [{ type: "input_text", text: raw.input }] }] : (raw.input ?? []);

  const systemParts: string[] = [];
  if (raw.instructions) systemParts.push(raw.instructions);
  const messages: NativeBody["messages"] = [];
  let started = false;

  const pushBlock = (role: "user" | "assistant", block: Json): void => {
    const last = messages[messages.length - 1];
    if (last && last.role === role && Array.isArray(last.content)) {
      if (block.type === "tool_result") {
        const firstNonResult = (last.content as Json[]).findIndex((b) => (b as Json).type !== "tool_result");
        if (firstNonResult === -1) (last.content as Json[]).push(block);
        else (last.content as Json[]).splice(firstNonResult, 0, block);
      } else {
        (last.content as Json[]).push(block);
      }
    } else {
      messages.push({ role, content: [block] });
    }
  };

  for (const item of items) {
    const type = (item.type as string) ?? "message";
    if (type === "message") {
      const role = item.role as string;
      if (role === "developer" || role === "system") {
        const t = partsToText(item.content);
        if (!t) continue;
        if (!started) systemParts.push(t);
        else pushBlock("user", { type: "text", text: t });
        continue;
      }
      started = true;
      const r: "user" | "assistant" = role === "assistant" ? "assistant" : "user";
      const media = partsToBlocks(item.content);
      if (media) {
        for (const b of media) pushBlock(r, b);
      } else {
        const t = partsToText(item.content);
        if (t) pushBlock(r, { type: "text", text: t });
      }
    } else if (type === "function_call") {
      started = true;
      let input: Json = {};
      try {
        input = item.arguments ? JSON.parse(item.arguments as string) : {};
      } catch {
        input = {};
      }
      const name = item.namespace ? responsesToolAlias(item.namespace as string, item.name as string) : (item.name as string);
      pushBlock("assistant", { type: "tool_use", id: item.call_id, name, input });
    } else if (type === "function_call_output") {
      started = true;
      pushBlock("user", { type: "tool_result", tool_use_id: item.call_id, content: toolOutputToContent(item.output) });
    } else if (type === "custom_tool_call") {
      started = true;
      const name = responsesToolAlias(item.namespace as string | undefined, item.name as string);
      pushBlock("assistant", { type: "tool_use", id: item.call_id, name, input: { input: (item.input as string) ?? "" } });
    } else if (type === "custom_tool_call_output") {
      started = true;
      pushBlock("user", { type: "tool_result", tool_use_id: item.call_id, content: toolOutputToContent(item.output) });
    }
    // reasoning: dropped
  }

  const body: NativeBody = {
    model: raw.model ?? "",
    messages,
    stream: raw.stream === true,
    max_tokens: raw.max_output_tokens ?? 8192,
  };
  if (systemParts.length) body.system = systemParts.join("\n\n");
  if (raw.tool_choice === "none") body.tool_choice = { type: "none" };
  else if (raw.tool_choice === "required") body.tool_choice = { type: "any" };

  const reasoningRequested = !!raw.reasoning || (raw.include ?? []).some((i) => i.includes("reasoning"));
  return { body, clientTools, aliases, reasoningRequested };
}
