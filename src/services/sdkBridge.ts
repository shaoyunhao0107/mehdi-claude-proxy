import { query, type Query, type SDKUserMessage, type SpareProcess } from "@anthropic-ai/claude-agent-sdk";
import { registerTask, unregisterTask } from "./taskTracker.js";
import { insertPendingRequest, completeRequest } from "./historyService.js";
import { recordTokensForRateLimit } from "../middleware/rateLimiter.js";
import { invalidateBudgetCache } from "../middleware/budgetCheck.js";
import { getOAuthToken } from "./settingsService.js";
import { attachUpstreamText } from "./errorClassifier.js";

const STDERR_TAIL_CHARS = 4000;

/** Everything that decides the CLI's options (and so which prewarmed spare fits). */
export interface SdkOptionParams {
  resolvedModel: string;
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

/** A prewarmed CLI started with buildSdkOptions() of the same params (minus cwd/model). */
export interface ClaimableSpare {
  process: SpareProcess;
  // The spare's stderr callback was fixed at prewarm time; it forwards here.
  stderrSink: { fn?: (data: string) => void };
}

interface TrackedQueryParams extends SdkOptionParams {
  completionId: string;
  // A string, or an async iterable of SDKUserMessage (structured blocks / images).
  prompt: string | AsyncIterable<SDKUserMessage>;
  promptPreview?: string;
  requestedModel: string;
  isStreaming: boolean;
  apiKeyId: number | null;
  apiKeyName: string | null;
  spare?: ClaimableSpare;
  /** A process started early with startup() for exactly these options (warmSessions). */
  warm?: { query: { query(prompt: string | AsyncIterable<SDKUserMessage>): Query }; stderrSink: { fn?: (d: string) => void } };
}

// Local patch: env applied to every SDK subprocess, so a request costs exactly one API
// call and nothing of this server's own setup reaches it.
//
// CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC and DISABLE_TELEMETRY are NOT set (they were).
// With either one the CLI does not load its remote feature flags, and the request it
// builds differs from an ordinary one: other system prompt text, a shorter anthropic-beta
// list and a <total_tokens> reminder (measured with scripts/compare-upstream.mjs).
// CLAUDE_CODE_DISABLE_TERMINAL_TITLE turns off the one side call those two also
// suppressed, the session title, and leaves the conversation request byte-identical.
// QUIET_UPSTREAM=true brings the old pair back.
const LEGACY_QUIET = process.env.QUIET_UPSTREAM === "true";
const QUIET_ENV: Record<string, string> = {
  ...(LEGACY_QUIET ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", DISABLE_TELEMETRY: "1" } : {}),
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  DISABLE_ERROR_REPORTING: "1",
  // The official preset would otherwise attach this server's own auto-memory / org memory.
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_ORG_MEMORY: "1",
  // This server account's claude.ai connectors (e.g. Claude Docs) must not be loaded:
  // a prewarmed CLI otherwise attaches their tools and instructions to every request.
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  // The client owns compaction: it decides when to compact, and the proxy rebuilds the
  // session from the compacted history it then sends. A server-side auto-compaction would
  // summarise behind the client's back (an extra billed call, two diverging histories).
  // Manual compaction requests from the client still pass through as ordinary requests.
  DISABLE_AUTO_COMPACT: "1",
};

interface TrackedQueryResult {
  generator: AsyncGenerator<any, void>;
  queryHandle: Query;
}

/**
 * SDK options for a request (everything except the stderr callback). Exported so the
 * prewarm pool starts spare processes with exactly the options a cold query would use.
 */
export function buildSdkOptions(params: SdkOptionParams): Record<string, unknown> {
  // maxTurns defaults to 1 (existing contract); callers may override. settingSources: []
  // is set unconditionally so Claude Code doesn't load CLAUDE.md or user settings that
  // could leak instructions.
  const sdkOptions: Record<string, unknown> = {
    model: params.resolvedModel,
    maxTurns: params.maxTurns ?? 1,
    settingSources: [],
    // Local patch: never write session transcripts for proxied requests.
    persistSession: false,
  };
  if (params.includePartialMessages) sdkOptions.includePartialMessages = true;
  if (params.mcpServers) sdkOptions.mcpServers = params.mcpServers;
  if (params.allowedTools) sdkOptions.allowedTools = params.allowedTools;
  if (params.disallowedTools) sdkOptions.disallowedTools = params.disallowedTools;
  // No permission rules are added for the CLI's own built-ins. A rule that refuses a file
  // tool (`Edit(**)`, `Read(**)`) is applied BEFORE the PreToolUse hook, so the hook never
  // sees the call and the client never receives it (measured on CLI 2.1.322: Write with
  // such a rule reaches no hook; Bash does). What keeps a call the hook missed from running
  // here is the permission mode: native requests leave it at the CLI's default, where a
  // tool that was not allowed is refused when nobody can be asked (measured for Bash,
  // Write, Read and WebFetch with no hook installed).
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
  return sdkOptions;
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

  // Capture the CLI's stderr so failures are logged with the real cause instead of
  // just "process exited with code 1". Only the tail is kept to bound memory.
  let stderrTail = "";
  const onStderr = (data: string) => {
    stderrTail = (stderrTail + data).slice(-STDERR_TAIL_CHARS);
  };

  // Local patch: a prewarmed CLI (see sparePool) was started with these same options
  // minus cwd/model; claiming it skips process start-up. A refused claim surfaces as an
  // error result before any output, and the caller retries cold.
  let sdkQuery: Query;
  if (params.warm) {
    params.warm.stderrSink.fn = onStderr;
    sdkQuery = params.warm.query.query(params.prompt);
  } else if (params.spare) {
    params.spare.stderrSink.fn = onStderr;
    sdkQuery = params.spare.process.claim({
      prompt: params.prompt,
      options: { cwd: params.cwd ?? process.cwd(), model: params.resolvedModel },
    });
    params.spare.process.claimed.catch((e: Error) => console.warn("[prewarm] claim refused:", e.message));
  } else {
    const sdkOptions = buildSdkOptions(params);
    sdkOptions.stderr = onStderr;
    sdkQuery = query({ prompt: params.prompt, options: sdkOptions });
  }

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
    // Local patch: upstream usage straight from the relayed stream (main thread only);
    // the result message may be missing or lack cache fields when the run is cut short.
    let cacheRead = 0;
    let cacheWrite = 0;
    let streamInput = 0;
    let streamOutput = 0;
    let sawMessageStop = false;
    const responseChunks: string[] = [];
    const usage = () => ({
      inputTokens: inputTokens || streamInput,
      outputTokens: outputTokens || streamOutput,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      totalCostUsd,
      durationMs: Date.now() - startTime,
    });
    const recordForKey = () => {
      if (params.apiKeyId) {
        recordTokensForRateLimit(params.apiKeyId, (inputTokens || streamInput) + (outputTokens || streamOutput));
        invalidateBudgetCache(params.apiKeyId);
      }
    };

    try {
      for await (const message of sdkQuery) {
        if (message.type === "stream_event" && !message.parent_tool_use_id) {
          const ev = message.event as { type: string; message?: { usage?: Record<string, number> }; usage?: Record<string, number> };
          if (ev.type === "message_start" && ev.message?.usage) {
            const u = ev.message.usage;
            streamInput += u.input_tokens ?? 0;
            cacheRead += u.cache_read_input_tokens ?? 0;
            cacheWrite += u.cache_creation_input_tokens ?? 0;
          } else if (ev.type === "message_delta" && ev.usage) {
            streamOutput += ev.usage.output_tokens ?? 0;
          } else if (ev.type === "message_stop") {
            sawMessageStop = true;
          }
        }
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
          if (!cacheRead && !cacheWrite) {
            cacheRead = message.usage?.cache_read_input_tokens ?? 0;
            cacheWrite = message.usage?.cache_creation_input_tokens ?? 0;
          }
          // Also capture result text if available
          if (message.subtype === "success" && message.result && responseChunks.length === 0) {
            responseChunks.push(message.result as string);
          }
        }
        yield message;
      }

      completeRequest(logId, "success", { ...usage(), fullResponse: responseChunks.join("\n") });
      recordForKey();
    } catch (err: any) {
      // Hand the CLI's own words to the route layer so it can pick a status code.
      attachUpstreamText(err, [responseChunks.join("\n"), stderrTail].join("\n"));
      // A complete upstream message followed by "max turns" is the normal end of an
      // intercepted tool call (maxTurns: 1), not a failure.
      if (sawMessageStop && /maximum number of turns|max_turns/i.test(String(err?.message ?? ""))) {
        completeRequest(logId, "success", { ...usage(), fullResponse: responseChunks.join("\n") });
        recordForKey();
        throw err;
      }
      completeRequest(logId, "error", {
        ...usage(),
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
