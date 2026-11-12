// OpenAI protocol layer — router.
//
// Mounted by default, so one instance serves /v1/messages, /v1/chat/completions and
// /v1/responses through the same hardened core. ENABLE_OPENAI_LAYER=false leaves it out
// and restores the legacy /v1/chat/completions. Endpoints translate to/from the core.
import { Router } from "express";
import type { Request, Response } from "express";
import { handleChatCompletions } from "./chatCompletions.js";
import { handleResponses } from "./responses.js";

// On unless ENABLE_OPENAI_LAYER is "0" or "false". It used to be opt-in, which left
// /v1/chat/completions on the legacy handler (tools run on this server, its own system
// prompt) and /v1/responses missing unless a second instance was started for it.
export const OPENAI_LAYER_ENABLED = process.env.ENABLE_OPENAI_LAYER !== "0" && process.env.ENABLE_OPENAI_LAYER !== "false";

const router = Router();

router.post("/chat/completions", (req: Request, res: Response) => {
  void handleChatCompletions(req, res);
});

router.post("/responses", (req: Request, res: Response) => {
  void handleResponses(req, res);
});

export default router;
