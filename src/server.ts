import { PORT } from "./config.js";
// Importing connection module triggers DB init + migrations
import "./db/connection.js";
import { app } from "./app.js";
import { startModelDiscovery } from "./services/modelDiscovery.js";
import { markInterruptedRequests, pruneHistory } from "./services/historyService.js";

// Local patch: discover available models in the background.
startModelDiscovery();

// Local patch: housekeeping of the request log.
{
  const n = markInterruptedRequests();
  if (n) console.log(`[history] marked ${n} request(s) left pending by the last run as interrupted`);
  const keep = parseFloat(process.env.REQUEST_LOG_KEEP_DAYS || "30");
  const keepText = parseFloat(process.env.REQUEST_LOG_KEEP_TEXT_DAYS || "7");
  const prune = () => {
    try {
      const r = pruneHistory(keep, keepText);
      if (r.deleted || r.trimmed) console.log(`[history] pruned ${r.deleted} old row(s), dropped text of ${r.trimmed}`);
    } catch (e) {
      console.warn("[history] prune failed:", (e as Error).message);
    }
  };
  prune();
  setInterval(prune, 24 * 3600_000).unref();
}

app.listen(PORT, () => {
  console.log(`Claude Code OpenAI-compatible API server running on port ${PORT}`);
  console.log(`  POST http://localhost:${PORT}/v1/chat/completions`);
  console.log(`  GET  http://localhost:${PORT}/v1/models`);
  console.log(`  GET  http://localhost:${PORT}/health`);
  console.log(`  Admin API at http://localhost:${PORT}/api/admin/*`);
});
