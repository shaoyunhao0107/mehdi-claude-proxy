// Local patch: keep prewarmed Claude Code processes ready for the next request.
//
// Every request otherwise starts a fresh CLI process (~1-2 s before the API call).
// Claude Code clients send many requests per prompt (one per tool round trip) with the
// same system prompt, tools and settings, so after each such request a spare CLI is
// started in the background with exactly those options (the SDK's official prewarm()),
// and the next matching request claims it, setting only cwd and model.
// A spare holds ~250 MB while parked; at most PREWARM_MAX_SPARES are kept, each for
// PREWARM_IDLE_MINUTES. Anything that refuses or fails falls back to a cold start.
import { prewarm } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "crypto";
import { buildSdkOptions, type ClaimableSpare, type SdkOptionParams } from "./sdkBridge.js";
import { tooLowForEarlyStart } from "./memoryGuard.js";

const ENABLED = process.env.PREWARM !== "false";
const MAX_SPARES = Math.max(1, parseInt(process.env.PREWARM_MAX_SPARES || "2", 10));
const IDLE_MS = parseFloat(process.env.PREWARM_IDLE_MINUTES || "10") * 60_000;

interface Entry {
  ready: Promise<ClaimableSpare | null>;
  timer: NodeJS.Timeout;
}
const pool = new Map<string, Entry>(); // insertion order = age

export function prewarmEnabled(): boolean {
  return ENABLED;
}

/**
 * Which spare fits: everything fixed at prewarm time. `toolsSig` stands in for the
 * in-process MCP servers (their tool definitions); cwd and model are set by the claim.
 */
export function spareKey(p: SdkOptionParams, toolsSig: string): string {
  const fixed = {
    includePartialMessages: p.includePartialMessages,
    builtInTools: p.builtInTools,
    systemPrompt: p.systemPrompt,
    maxTurns: p.maxTurns,
    permissionMode: p.permissionMode,
    thinking: p.thinking,
    effort: p.effort,
    extraEnv: p.extraEnv,
    extraOptions: p.extraOptions, // functions (hooks) drop out of JSON; they are static
    toolsSig,
  };
  return createHash("sha256").update(JSON.stringify(fixed)).digest("hex");
}

function discard(key: string, e: Entry): void {
  clearTimeout(e.timer);
  if (pool.get(key) === e) pool.delete(key);
  void e.ready.then((s) => s?.process.close()).catch(() => {});
}

/** Take the spare for `key` if one exists (waits for it to finish starting). */
export async function takeSpare(key: string): Promise<ClaimableSpare | null> {
  const e = pool.get(key);
  if (!e) return null;
  pool.delete(key);
  clearTimeout(e.timer);
  return e.ready.catch(() => null);
}

/** Start a spare for `key` in the background unless one is already parked. */
export function ensureSpare(key: string, params: () => SdkOptionParams): void {
  if (!ENABLED || pool.has(key)) return;
  if (tooLowForEarlyStart("a spare CLI")) {
    for (const [k, e] of [...pool.entries()]) discard(k, e); // parked spares go first
    return;
  }
  while (pool.size >= MAX_SPARES) {
    const [oldKey, old] = pool.entries().next().value as [string, Entry];
    discard(oldKey, old);
  }
  const sink: ClaimableSpare["stderrSink"] = {};
  const options = buildSdkOptions(params());
  delete options.cwd; // the claim sets the session's folder
  delete options.model; // and the model
  options.stderr = (d: string) => sink.fn?.(d);

  const entry: Entry = {
    ready: Promise.resolve(null),
    timer: setTimeout(() => discard(key, entry), IDLE_MS),
  };
  entry.timer.unref();
  entry.ready = prewarm({ options: options as never })
    .then((proc) => {
      // A parked spare that dies is dropped; a claimed one has already left the pool.
      void proc.exited.then(() => {
        if (pool.get(key) === entry) pool.delete(key);
      });
      return { process: proc, stderrSink: sink };
    })
    .catch((err: Error) => {
      console.warn("[prewarm] could not start a spare:", err.message);
      if (pool.get(key) === entry) {
        clearTimeout(entry.timer);
        pool.delete(key);
      }
      return null;
    });
  pool.set(key, entry);
}

export function spareStatus() {
  return { enabled: ENABLED, parked: pool.size, max: MAX_SPARES, idleMinutes: IDLE_MS / 60_000 };
}
