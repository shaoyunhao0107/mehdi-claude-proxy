import express from "express";
import proxyRoutes from "./routes/proxy.js";
import openaiLayerRoutes, { OPENAI_LAYER_ENABLED } from "./routes/openai/index.js";
import anthropicRoutes from "./routes/anthropic.js";
import embeddingsRoutes from "./routes/embeddings.js";
import adminApiRoutes from "./routes/adminApi.js";
import healthRoutes from "./routes/health.js";
import { apiKeyAuth } from "./middleware/apiKeyAuth.js";
import { rateLimitMiddleware } from "./middleware/rateLimiter.js";
import { budgetCheckMiddleware } from "./middleware/budgetCheck.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { concurrencyLimit } from "./middleware/concurrency.js";

const app = express();
app.use(express.json({ limit: "10mb" }));

// Health check — no auth
app.use(healthRoutes);

// Admin API — protected by admin secret
app.use("/api/admin", adminApiRoutes);

// /v1/* routes: API key auth, budget check and rate limiting, then a cap on concurrently
// running model requests (one CLI process each). The chain is mounted ONCE. Mounting it
// per router ran it again for every router a request fell through: /v1/messages was
// counted twice against its key's requests-per-minute (three times in the OpenAI role),
// /v1/embeddings up to four times, and the key was validated (a database write) each time.
// Rejections come before the concurrency cap, so a refused request never waits for a slot.
app.use("/v1", apiKeyAuth, budgetCheckMiddleware, rateLimitMiddleware, concurrencyLimit);
// OpenAI protocol layer: translate OpenAI -> Anthropic and run through the hardened core.
// On by default (ENABLE_OPENAI_LAYER=false leaves it out), and mounted BEFORE the legacy
// proxyRoutes so it takes precedence on /v1/chat/completions.
if (OPENAI_LAYER_ENABLED) app.use("/v1", openaiLayerRoutes);
// OpenAI-compatible (legacy): GET /v1/models, POST /v1/chat/completions (tools run on server)
app.use("/v1", proxyRoutes);
// Native Anthropic Messages: POST /v1/messages
app.use("/v1", anthropicRoutes);
// Embeddings: POST /v1/embeddings (proxied to Ollama)
app.use("/v1", embeddingsRoutes);

// Centralized error handler
app.use(errorHandler);

export { app };
