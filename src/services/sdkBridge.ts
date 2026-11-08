import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { registerTask, unregisterTask } from "./taskTracker.js";
import { insertPendingRequest, completeRequest } from "./historyService.js";
import { recordTokensForRateLimit } from "../middleware/rateLimiter.js";
import { invalidateBudgetCache } from "../middleware/budgetCheck.js";
import { getOAuthToken } from "./settingsService.js";
import { attachUpstreamText } from "./errorClassifier.js";

const STDERR_TAIL_CHARS = 4000;

interface TrackedQueryParams {
  completionId: string;
  // A string, or an async iterable of SDKUserMessage (structured blocks / images).
  prompt: string | AsyncIterable<SDKUserMessage>;
  promptPreview?: string;
  requestedModel: string;
  resolvedModel: string;
  isStreaming: boolean;
  apiKeyId: number | null;
  apiKeyName: string | null;
  includePartialMessages?: boolean;
  // Optional, for tool-use support on /v1/messages:
  mcpServers?: Record<string, unknown>;
  allowedTools?: string[];
  disallowedTools?: string[];
  builtInTools?: string[] | { type: "preset"; preset: "claude_code" };
  systemPrompt?: string;
  maxTurns?: number;
  permissionMode?: string;
  cwd?: string;
  // Local patch: native-path options.
  thinking?:
    | { type: "adaptive"; display?: "summarized" | "omitted" }
    | { type: "enabled"; budgetTokens: number; display?: "summarized" | "omitted" }
    | { type: "disabled" };
  effort?: string;
  extraEnv?: Record<string, string>;
  // Local patch: raw SDK options merged last (hooks, resume, sessionStore, persistSession...).
  extraOptions?: Record<string, unknown>;
}

// Local patch: env applied to every SDK subprocess. Skips the session-title call,
// the /api/hello probe and telemetry, so a request costs exactly one API call.
const QUIET_ENV: Record<string, string> = {
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  // The official preset would otherwise attach this server's own auto-memory / org memory.
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_ORG_MEMORY: "1",
};

interface TrackedQueryResult {
  generator: AsyncGenerator<any, void>;
  queryHandle: Query;
}

export function trackedQuery(params: TrackedQueryParams): TrackedQueryResult {
  const startTime = Date.now();

  const promptStr = params.promptPreview ?? (typeof params.prompt === "string" ? params.prompt : "(multi-modal input)");

  // Insert pending request log (with full prompt for detail view)
  const logId = insertPendingRequest({
    apiKeyId: params.apiKeyId,
    completionId: params.completionId,
    requestedModel: params.requestedModel,
    resolvedModel: params.resolvedModel,
    isStream: params.isStreaming,
    promptPreview: promptStr.slice(0, 200),
    fullPrompt: promptStr,
  });

  // Assemble SDK options. maxTurns defaults to 1 (existing contract); callers
  // may override. settingSources: [] is set unconditionally so Claude Code
  // doesn't load CLAUDE.md or user settings that could leak instructions.
  const sdkOptions: Record<string, unknown> = {
    model: params.resolvedModel,
    maxTurns: params.maxTurns ?? 1,
    settingSources: [],
    // Local patch: never write session transcripts for proxied requests.
    persistSession: false,
  };
  // Capture the CLI's stderr so failures are logged with the real cause instead of
  // just "process exited with code 1". Only the tail is kept to bound memory.
  let stderrTail = "";
  sdkOptions.stderr = (data: string) => {
    stderrTail = (stderrTail + data).slice(-STDERR_TAIL_CHARS);
  };
  if (params.includePartialMessages) sdkOptions.includePartialMessages = true;
  if (params.mcpServers) sdkOptions.mcpServers = params.mcpServers;
  if (params.allowedTools) sdkOptions.allowedTools = params.allowedTools;
  if (params.disallowedTools) sdkOptions.disallowedTools = params.disallowedTools;
  if (params.permissionMode) sdkOptions.permissionMode = params.permissionMode;
  if (params.cwd) sdkOptions.cwd = params.cwd;
  // Local patch: default to NO built-in tools. The SDK default is the full Claude Code
  // tool set (Bash/Write/...), which would run on this server and add ~17k tokens of context.
  sdkOptions.tools = params.builtInTools ?? [];
  if (params.thinking) sdkOptions.thinking = params.thinking;
  if (params.effort) sdkOptions.effort = params.effort;
  if (params.systemPrompt !== undefined) sdkOptions.systemPrompt = params.systemPrompt;

  // Inject the OAuth token from database/env into the SDK subprocess environment.
  // This allows the token to be managed via the admin UI instead of env vars.
  const oauthToken = getOAuthToken();
  if (oauthToken) {
    const env: Record<string, string> = {};
    // Only pass the auth-related env vars to the subprocess, plus PATH
    if (process.env.PATH) env.PATH = process.env.PATH;
    if (process.env.HOME) env.HOME = process.env.HOME;
    if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
    if (process.env.TEMP) env.TEMP = process.env.TEMP;
    if (process.env.TMP) env.TMP = process.env.TMP;
    // Set the token — auto-detect which env var to use based on prefix
    if (oauthToken.startsWith("sk-ant-oat")) {
      env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
    } else {
      env.ANTHROPIC_API_KEY = oauthToken;
    }
    Object.assign(env, QUIET_ENV, params.extraEnv ?? {});
    sdkOptions.env = env;
  } else {
    sdkOptions.env = { ...process.env, ...QUIET_ENV, ...(params.extraEnv ?? {}) };
  }

  if (params.extraOptions) Object.assign(sdkOptions, params.extraOptions);

  const sdkQuery = query({
    prompt: params.prompt,
    options: sdkOptions,
  });

  // Register active task
  registerTask(
    {
      id: params.completionId,
      model: params.resolvedModel,
      promptPreview: typeof params.prompt === "string" ? params.prompt.slice(0, 200) : "(multi-modal input)",
      apiKeyId: params.apiKeyId,
      apiKeyName: params.apiKeyName,
      startedAt: new Date().toISOString(),
      isStreaming: params.isStreaming,
      requestLogId: logId,
    },
    async () => { await sdkQuery.interrupt(); }
  );

  // Wrap the generator to handle cleanup and capture full response
  async function* wrappedGenerator() {
    let inputTokens = 0;
    let outputTokens = 0;
    let totalCostUsd = 0;
    const responseChunks: string[] = [];

    try {
      for await (const message of sdkQuery) {
        // Capture text from assistant messages for full_response logging
        if (message.type === "assistant") {
          const content = message.message?.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if ((block as { type: string }).type === "text") {
                responseChunks.push((block as { text: string }).text);
              } else if ((block as { type: string }).type === "tool_use") {
                const tu = block as { name?: string; input?: unknown };
                responseChunks.push(`[tool_use: ${tu.name}(${JSON.stringify(tu.input)})]`);
              }
            }
          }
        }
        // Capture usage from result messages
        if (message.type === "result") {
          inputTokens = message.usage?.input_tokens ?? 0;
          outputTokens = message.usage?.output_tokens ?? 0;
          totalCostUsd = message.total_cost_usd ?? 0;
          // Also capture result text if available
          if (message.subtype === "success" && message.result && responseChunks.length === 0) {
            responseChunks.push(message.result as string);
          }
        }
        yield message;
      }

      completeRequest(logId, "success", {
        inputTokens,
        outputTokens,
        totalCostUsd,
        durationMs: Date.now() - startTime,
        fullResponse: responseChunks.join("\n"),
      });

      // Record token usage for rate limiting and invalidate budget cache
      if (params.apiKeyId) {
        recordTokensForRateLimit(params.apiKeyId, inputTokens + outputTokens);
        invalidateBudgetCache(params.apiKeyId);
      }
    } catch (err: any) {
      // Hand the CLI's own words to the route layer so it can pick a status code.
      attachUpstreamText(err, [responseChunks.join("\n"), stderrTail].join("\n"));
      completeRequest(logId, "error", {
        inputTokens,
        outputTokens,
        totalCostUsd,
        durationMs: Date.now() - startTime,
        // The CLI reports API failures (404 model, usage limits) as assistant text
        // before exiting 1, so include that text and stderr alongside the exit error.
        errorMessage: [
          err.message ?? "Unknown error",
          responseChunks.join("\n").trim(),
          stderrTail.trim() && `--- stderr ---\n${stderrTail.trim()}`,
        ].filter(Boolean).join("\n"),
        fullResponse: responseChunks.length > 0 ? responseChunks.join("\n") : undefined,
      });
      throw err;
    } finally {
      unregisterTask(params.completionId);
    }
  }

  return { generator: wrappedGenerator(), queryHandle: sdkQuery };
}

export function markCancelled(completionId: string, logId: number, startTime: number): void {
  completeRequest(logId, "cancelled", {
    durationMs: Date.now() - startTime,
  });
  unregisterTask(completionId);
}
