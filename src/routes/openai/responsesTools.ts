// OpenAI protocol layer — Responses (/v1/responses) tool translation.
//
// Codex sends tools three ways: a flat `{type:"function", name, parameters}`, a freeform
// `{type:"custom", name, format}` (its apply_patch), and `{type:"namespace", name, tools}`
// (an MCP server with nested tools). Claude wants one flat list of function tools, so
// nested/custom tools are exposed under a deterministic alias, and an alias table maps the
// model's call back to the exact tool so the response can re-emit it in the right shape
// (function_call vs custom_tool_call, with the original namespace).
import type { ClientTool } from "../../types/toolBridge.js";

type Json = Record<string, unknown>;

export interface ResponsesToolAlias {
  name: string; // the tool's own name (without namespace)
  kind: "function" | "custom";
  namespace?: string;
}
export type ResponsesToolAliases = Map<string, ResponsesToolAlias>; // claude-visible name -> original

/** The Claude-visible name for a (namespace, name) pair. Deterministic so replays match. */
export function responsesToolAlias(namespace: string | undefined, name: string): string {
  return namespace ? `${namespace}__${name}` : name;
}

// A freeform tool has no JSON schema: Claude gets a single `input` string and the whole
// payload is passed through verbatim as the custom_tool_call input.
const FREEFORM_SCHEMA: Json = {
  type: "object",
  properties: { input: { type: "string", description: "The complete freeform payload, exactly as the tool's format requires." } },
  required: ["input"],
};

function customDescription(tool: Json): string {
  const parts: string[] = [];
  if (typeof tool.description === "string" && tool.description) parts.push(tool.description);
  const format = tool.format as Json | undefined;
  if (format && typeof format.definition === "string") {
    parts.push(`Input grammar${typeof format.syntax === "string" ? ` (${format.syntax})` : ""}:\n${format.definition}`);
  }
  return parts.join("\n\n");
}

export function translateResponsesTools(tools: Json[] | undefined): { clientTools: ClientTool[]; aliases: ResponsesToolAliases } {
  const clientTools: ClientTool[] = [];
  const aliases: ResponsesToolAliases = new Map();

  const push = (namespace: string | undefined, tool: Json): void => {
    const type = tool.type as string;
    if (type === "function") {
      const name = responsesToolAlias(namespace, tool.name as string);
      clientTools.push({
        name,
        description: namespace ? `[${namespace}] ${(tool.description as string) ?? ""}`.trimEnd() : ((tool.description as string) ?? ""),
        input_schema: (tool.parameters as Json) ?? { type: "object", properties: {} },
      });
      aliases.set(name, { name: tool.name as string, kind: "function", namespace });
    } else if (type === "custom") {
      const name = responsesToolAlias(namespace, tool.name as string);
      clientTools.push({ name, description: customDescription(tool), input_schema: FREEFORM_SCHEMA });
      aliases.set(name, { name: tool.name as string, kind: "custom", namespace });
    }
  };

  for (const tool of tools ?? []) {
    if ((tool as Json).type === "namespace") {
      const ns = (tool as Json).name as string;
      for (const nested of ((tool as Json).tools as Json[]) ?? []) push(ns, nested);
    } else {
      push(undefined, tool as Json);
    }
  }
  return { clientTools, aliases };
}
