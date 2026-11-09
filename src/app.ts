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

// /v1/* routes — protected by API key auth + budget check + rate limiting
// Local patch: then a cap on concurrently running model requests (one CLI process each).
app.use("/v1", apiKeyAuth, concurrencyLimit);
// OpenAI protocol layer (new): translate OpenAI -> Anthropic and run through the hardened
// core. Mounted only in the OpenAI role (ENABLE_OPENAI_LAYER), and BEFORE the legacy
// proxyRoutes so it takes precedence on /v1/chat/completions. In the Anthropic role it is
// absent, so that deployment is unchanged.
if (OPENAI_LAYER_ENABLED) {
  app.use("/v1", apiKeyAuth, budgetCheckMiddleware, rateLimitMiddleware, openaiLayerRoutes);
}
// OpenAI-compatible (legacy): GET /v1/models, POST /v1/chat/completions (tools run on server)
app.use("/v1", apiKeyAuth, budgetCheckMiddleware, rateLimitMiddleware, proxyRoutes);
// Native Anthropic Messages: POST /v1/messages
app.use("/v1", apiKeyAuth, budgetCheckMiddleware, rateLimitMiddleware, anthropicRoutes);
// Embeddings: POST /v1/embeddings (proxied to Ollama)
app.use("/v1", apiKeyAuth, budgetCheckMiddleware, rateLimitMiddleware, embeddingsRoutes);

// Centralized error handler
app.use(errorHandler);

export { app };
