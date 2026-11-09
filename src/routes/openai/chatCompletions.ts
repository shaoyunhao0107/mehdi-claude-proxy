// OpenAI protocol layer — POST /v1/chat/completions.
//
// Translates the OpenAI request to Anthropic, runs it through the hardened core
// (anthropicNative.ts handleNative) exactly as /v1/messages does, and streams the result
// back in OpenAI shape via OpenAIChatResAdapter. The core is untouched; everything
// OpenAI-specific lives under src/routes/openai/.
import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { resolve as resolvePath } from "path";
import { mkdirSync } from "fs";
import { resolveModel } from "../../models.js";
import { handleNative } from "../anthropicNative.js";
import { translateChatRequest, type OpenAIChatBody } from "./translateRequest.js";
import { OpenAIChatResAdapter } from "./resAdapter.js";

const SDK_CWD = resolvePath(process.env.SDK_CWD || "./data/sdk-cwd");
mkdirSync(SDK_CWD, { recursive: true });

const MAX_TOOLS = parseInt(process.env.OPENAI_MAX_TOOLS || "256", 10);

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { message, type: "invalid_request_error" } });
}

export async function handleChatCompletions(req: Request, res: Response): Promise<void> {
  const raw = req.body as OpenAIChatBody;
  if (!raw || !Array.isArray(raw.messages) || raw.messages.length === 0) {
    badRequest(res, "messages: a non-empty array is required");
    return;
  }
  if (!raw.model) {
    badRequest(res, "model is required");
    return;
  }

  let translated;
  try {
    translated = translateChatRequest(raw);
  } catch (err) {
    badRequest(res, `could not parse request: ${(err as Error).message}`);
    return;
  }
  if (translated.clientTools.length > MAX_TOOLS) {
    badRequest(res, `too many tools (${translated.clientTools.length} > ${MAX_TOOLS})`);
    return;
  }

  const stream = raw.stream === true;
  const requestedModel = raw.model;
  const resolvedModel = resolveModel(requestedModel);

  // Model restrictions, as in the Anthropic route.
  if (req.allowedModels && req.allowedModels.length > 0 && !req.allowedModels.includes(resolvedModel)) {
    res.status(403).json({
      error: { message: `model '${resolvedModel}' is not allowed for this API key`, type: "invalid_request_error" },
    });
    return;
  }

  const adapter = new OpenAIChatResAdapter(res, {
    id: `chatcmpl-${uuidv4().replace(/-/g, "")}`,
    model: requestedModel, // echo back what the client asked for
    stream,
    created: Math.floor(Date.now() / 1000),
    includeUsage: translated.includeUsage,
    emitReasoning: process.env.OPENAI_EMIT_REASONING === "true",
  });

  try {
    await handleNative(req, adapter as unknown as Response, {
      messageId: `msg_${uuidv4().replace(/-/g, "")}`, // internal upstream id, never shown to the client
      requestedModel,
      resolvedModel,
      stream,
      body: translated.body,
      clientTools: translated.clientTools,
      sdkCwd: SDK_CWD,
    });
  } catch (err) {
    console.error("[openai] /v1/chat/completions error:", (err as Error)?.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: (err as Error)?.message ?? "server error", type: "server_error" } });
    }
  }
}
