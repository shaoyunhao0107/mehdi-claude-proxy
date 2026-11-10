import { Router } from "express";
import { db } from "../db/connection.js";
import { getTaskCount } from "../services/taskTracker.js";
import { getTokenStatus } from "../services/settingsService.js";
import { OLLAMA_URL } from "../config.js";

const router = Router();

// The Ollama probe can take its full 3 s timeout when Ollama is not running. Health checks
// arrive every few seconds from load balancers and monitors, so its answer is kept briefly
// and concurrent checks share one probe.
const OLLAMA_STATUS_TTL_MS = 30_000;
let ollamaCached: { status: string; at: number } | null = null;
let ollamaProbe: Promise<string> | null = null;
function ollamaHealth(): Promise<string> {
  if (ollamaCached && Date.now() - ollamaCached.at < OLLAMA_STATUS_TTL_MS) return Promise.resolve(ollamaCached.status);
  ollamaProbe ??= (async () => {
    let status: string;
    try {
      const r = await fetch(`${OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(3000) });
      status = r.ok ? "ok" : "error";
    } catch {
      status = "unreachable";
    }
    ollamaCached = { status, at: Date.now() };
    ollamaProbe = null;
    return status;
  })();
  return ollamaProbe;
}

router.get("/health", async (_req, res) => {
  let dbStatus = "ok";
  try {
    db.pragma("quick_check");
  } catch {
    dbStatus = "error";
  }

  const token = getTokenStatus();

  const ollamaStatus = await ollamaHealth();

  res.json({
    status: "ok",
    backend: "claude-code-sdk",
    db_status: dbStatus,
    active_tasks: getTaskCount(),
    token_configured: token.configured,
    token_source: token.source,
    ollama_status: ollamaStatus,
  });
});

export default router;
