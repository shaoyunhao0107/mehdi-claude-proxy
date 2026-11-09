// OpenAI protocol layer — POST /v1/responses (Codex CLI).
//
// Same shape as chatCompletions.ts: translate the Responses request to Anthropic, run it
// through the hardened core (handleNative, unchanged), and re-emit the result as a
// Responses object / event stream via OpenAIResponsesResAdapter.
import type { Request, Response } from "express";
import { v4 as uuidv4 } from "uuid";
import { resolve as resolvePath } from "path";
import { mkdirSync } from "fs";
import { resolveModel } from "../../models.js";
import { handleNative } from "../anthropicNative.js";
import { translateResponsesRequest, type ResponsesBody } from "./translateResponses.js";
import { OpenAIResponsesResAdapter } from "./responsesAdapter.js";

const SDK_CWD = resolvePath(process.env.SDK_CWD || "./data/sdk-cwd");
mkdirSync(SDK_CWD, { recursive: true });

function badRequest(res: Response, message: string): void {
  res.status(400).json({ error: { message, type: "invalid_request_error" } });
}

export async function handleResponses(req: Request, res: Response): Promise<void> {
  const raw = req.body as ResponsesBody;
  if (!raw || (raw.input === undefined || raw.input === null)) {
    badRequest(res, "input is required");
    return;
  }
  if (!raw.model) {
    badRequest(res, "model is required");
    return;
  }

  let translated;
  try {
    translated = translateResponsesRequest(raw);
  } catch (err) {
    badRequest(res, `could not parse request: ${(err as Error).message}`);
    return;
  }

  const stream = raw.stream === true;
  const requestedModel = raw.model;
  const resolvedModel = resolveModel(requestedModel);

  if (req.allowedModels && req.allowedModels.length > 0 && !req.allowedModels.includes(resolvedModel)) {
    res.status(403).json({ error: { message: `model '${resolvedModel}' is not allowed for this API key`, type: "invalid_request_error" } });
    return;
  }

  const adapter = new OpenAIResponsesResAdapter(res, {
    responseId: `resp_${uuidv4().replace(/-/g, "")}`,
    model: requestedModel,
    stream,
    created: Math.floor(Date.now() / 1000),
    aliases: translated.aliases,
    reasoningRequested: translated.reasoningRequested,
  });

  try {
    await handleNative(req, adapter as unknown as Response, {
      messageId: `msg_${uuidv4().replace(/-/g, "")}`,
      requestedModel,
      resolvedModel,
      stream,
      body: translated.body,
      clientTools: translated.clientTools,
      sdkCwd: SDK_CWD,
    });
  } catch (err) {
    console.error("[openai] /v1/responses error:", (err as Error)?.message);
    if (!res.headersSent) {
      res.status(500).json({ error: { message: (err as Error)?.message ?? "server error", type: "server_error" } });
    }
  }
}
