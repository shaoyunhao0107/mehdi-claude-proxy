// OpenAI protocol layer — router.
//
// Mounted only when ENABLE_OPENAI_LAYER is set (the 3458 "OpenAI backup" role). When it is
// not set (the 3457 Anthropic role), this router is never registered, so that deployment
// behaves exactly as before. Endpoints translate to/from the hardened Anthropic core.
import { Router } from "express";
import type { Request, Response } from "express";
import { handleChatCompletions } from "./chatCompletions.js";

export const OPENAI_LAYER_ENABLED = process.env.ENABLE_OPENAI_LAYER === "1" || process.env.ENABLE_OPENAI_LAYER === "true";

const router = Router();

router.post("/chat/completions", (req: Request, res: Response) => {
  void handleChatCompletions(req, res);
});

// /v1/responses (Codex CLI) is added in a later step.

export default router;
