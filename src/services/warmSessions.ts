// Local patch: start the CLI for a conversation's NEXT request while the client is still
// busy (running the tools it was just handed, or the user reading the answer).
//
// In session mode every request resumes a kept session, which prewarm() spares cannot do
// (resume is fixed at spawn). But when a turn ends we already know exactly how the next
// one will start: resume this session, at this checkpoint, with a fork when it stopped at
// tool calls. The SDK's startup() spawns and initialises a process with those options
// (including loading the transcript from the session store) and hands back a one-shot
// query. Measured: first event 1.4 s warm vs 2.7 s cold.
//
// One warm process per conversation, at most WARM_SESSION_MAX in total (~250 MB each),
// closed after WARM_SESSION_IDLE_MINUTES. A request whose plan or options differ from the
// prediction closes it and starts cold, as before.
import { startup, type WarmQuery } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "crypto";
import { buildSdkOptions, type SdkOptionParams } from "./sdkBridge.js";
import { tooLowForEarlyStart } from "./memoryGuard.js";

const ENABLED = process.env.WARM_SESSIONS !== "false";
const MAX = Math.max(1, parseInt(process.env.WARM_SESSION_MAX || "4", 10));
const IDLE_MS = parseFloat(process.env.WARM_SESSION_IDLE_MINUTES || "5") * 60_000;

export interface WarmHandle {
  query: WarmQuery;
  /** The warm process's PreToolUse hooks wait on this gate (deny-hold). */
  releaseDenies: () => void;
  stderrSink: { fn?: (data: string) => void };
}

interface Entry {
  key: string;
  ready: Promise<WarmHandle | null>;
  timer: NodeJS.Timeout;
}
const byConversation = new Map<string, Entry>(); // insertion order = age

export function warmSessionsEnabled(): boolean {
  return ENABLED;
}

/**
 * Identity of a session-mode start: everything fixed at spawn. Functions (hooks, the
 * store's methods) drop out of the JSON; they are the same on both sides.
 */
export function warmKey(p: SdkOptionParams, toolsSig: string): string {
  const x = (p.extraOptions ?? {}) as Record<string, unknown>;
  const fixed = {
    model: p.resolvedModel,
    cwd: p.cwd,
    includePartialMessages: p.includePartialMessages,
    builtInTools: p.builtInTools,
    systemPrompt: p.systemPrompt,
    maxTurns: p.maxTurns,
    thinking: p.thinking,
    effort: p.effort,
    extraEnv: p.extraEnv,
    presetSystemPrompt: x.systemPrompt,
    resume: x.resume,
    resumeSessionAt: x.resumeSessionAt,
    forkSession: x.forkSession,
    toolsSig,
  };
  return createHash("sha256").update(JSON.stringify(fixed)).digest("hex");
}

function discard(conv: string, e: Entry): void {
  clearTimeout(e.timer);
  if (byConversation.get(conv) === e) byConversation.delete(conv);
  void e.ready
    .then((h) => {
      h?.releaseDenies();
      h?.query.close();
    })
    .catch(() => {});
}

export function dropWarm(conv: string): void {
  const e = byConversation.get(conv);
  if (e) discard(conv, e);
}

/**
 * Start the predicted next request of `conv`. `params` must be built exactly as the next
 * request's run() will build them (key compared with warmKey).
 */
export function warmNext(
  conv: string,
  params: SdkOptionParams,
  toolsSig: string,
  makeHooks: (gate: Promise<void>) => unknown,
): void {
  if (!ENABLED) return;
  dropWarm(conv);
  if (tooLowForEarlyStart("the next request")) {
    // Low on memory: also close the oldest warm process (its request starts cold).
    const oldest = byConversation.entries().next().value as [string, Entry] | undefined;
    if (oldest) discard(oldest[0], oldest[1]);
    return;
  }
  while (byConversation.size >= MAX) {
    const [oldConv, old] = byConversation.entries().next().value as [string, Entry];
    discard(oldConv, old);
  }
  let releaseDenies!: () => void;
  const gate = new Promise<void>((r) => (releaseDenies = r));
  const stderrSink: WarmHandle["stderrSink"] = {};
  const options = buildSdkOptions({
    ...params,
    extraOptions: { ...(params.extraOptions ?? {}), hooks: makeHooks(gate) },
  });
  options.stderr = (d: string) => stderrSink.fn?.(d);

  const entry: Entry = {
    key: warmKey(params, toolsSig),
    ready: Promise.resolve(null),
    timer: setTimeout(() => discard(conv, entry), IDLE_MS),
  };
  entry.timer.unref();
  entry.ready = startup({ options: options as never })
    .then((query) => ({ query, releaseDenies, stderrSink }))
    .catch((err: Error) => {
      console.warn("[warm] could not start the next request early:", err.message);
      if (byConversation.get(conv) === entry) {
        clearTimeout(entry.timer);
        byConversation.delete(conv);
      }
      return null;
    });
  byConversation.set(conv, entry);
}

/** The warm process for `conv` if it was started with exactly `key`; otherwise null. */
export async function takeWarm(conv: string, key: string): Promise<WarmHandle | null> {
  const e = byConversation.get(conv);
  if (!e) return null;
  byConversation.delete(conv);
  clearTimeout(e.timer);
  if (e.key !== key) {
    discard(conv, e);
    return null;
  }
  return e.ready.catch(() => null);
}

export function warmStatus() {
  return { enabled: ENABLED, warm: byConversation.size, max: MAX, idleMinutes: IDLE_MS / 60_000 };
}
