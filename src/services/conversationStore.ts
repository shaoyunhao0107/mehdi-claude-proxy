// Local patch: real CLI sessions that persist across a Claude Code client's requests.
//
// Idea borrowed from rynfar/meridian (the mechanism only): instead of re-sending the
// whole conversation as text on every request, the proxy keeps the official CLI's own
// session and sends only what is new. A tool call is denied on this server and the turn
// stops at maxTurns 1; the next request resumes the session at the assistant tool-call
// entry (resumeSessionAt + forkSession, which drops the synthetic denial) with the
// client's real tool_result as the new input. Upstream then sees genuine multi-turn
// messages, with the CLI's per-turn environment in place, so the prompt cache extends
// exactly as in a direct CLI session.
//
// Transcripts live in memory here (the SDK's sessionStore adapter), not in this
// server's ~/.claude. Bounded by conversation count and idle time; a proxy restart only
// costs one rebuild of each conversation from the client's history.
import { createHash } from "crypto";
import { existsSync, readdirSync, rmSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

export const CONTINUITY_ENABLED = process.env.SESSION_CONTINUITY !== "false";
const MAX_CONVERSATIONS = Math.max(1, parseInt(process.env.SESSION_MAX_CONVERSATIONS || "40", 10));
const IDLE_MS = parseFloat(process.env.SESSION_IDLE_HOURS || "6") * 3600_000;

export interface ConversationState {
  /** The CLI session that holds this conversation now (changes on every fork). */
  sdkSessionId: string;
  /** Hashes of the client messages this state covers (the request that produced it). */
  msgHashes: string[];
  /** Set when the turn stopped at client tool calls: resume point and the awaited ids. */
  checkpointUuid?: string;
  pendingToolIds?: string[];
  lastUsed: number;
}

const conversations = new Map<string, ConversationState>();
const transcripts = new Map<string, SessionStoreEntry[]>();

/** The SDK's transcript mirror: everything the CLI writes for our sessions lands here. */
export const memorySessionStore: SessionStore = {
  async append(key, entries) {
    const list = transcripts.get(key.sessionId) ?? [];
    const seen = new Set(list.map((e) => e.uuid).filter(Boolean));
    for (const e of entries) if (!e.uuid || !seen.has(e.uuid)) list.push(e);
    transcripts.set(key.sessionId, list);
  },
  async load(key) {
    return transcripts.get(key.sessionId) ?? null;
  },
};

export function seedTranscript(sessionId: string, entries: SessionStoreEntry[]): void {
  transcripts.set(sessionId, entries);
}

export function dropTranscript(sessionId: string | undefined): void {
  if (sessionId) transcripts.delete(sessionId);
}

/**
 * Conversation identity from Claude Code: metadata.user_id is a JSON string with the
 * CLI's session_id; an Agent-tool subagent shares it and adds x-claude-code-agent-id.
 */
export function conversationKey(metadata: unknown, agentId: string | undefined): string | null {
  const raw = (metadata as { user_id?: unknown } | undefined)?.user_id;
  if (typeof raw !== "string") return null;
  let sid: unknown;
  try {
    sid = (JSON.parse(raw) as { session_id?: unknown }).session_id;
  } catch {
    return null;
  }
  if (typeof sid !== "string" || !/^[0-9a-f-]{16,64}$/i.test(sid)) return null;
  return agentId && /^[A-Za-z0-9_-]{1,128}$/.test(agentId) ? `${sid}:agent:${agentId}` : sid;
}

type Block = { type?: string; [k: string]: unknown };

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      if (k === "cache_control") continue; // moves between requests
      out[k] = canonical((value as Record<string, unknown>)[k]);
    }
    return out;
  }
  return value;
}

/** Stable hash of one client message; a string and a single text block are equal. */
export function messageHash(m: { role: string; content: string | Block[] }): string {
  const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
  return createHash("sha256").update(JSON.stringify([m.role, canonical(content)])).digest("hex");
}

export function getConversation(key: string): ConversationState | undefined {
  const s = conversations.get(key);
  if (s && Date.now() - s.lastUsed > IDLE_MS) {
    forget(key);
    return undefined;
  }
  return s;
}

export function forget(key: string): void {
  const s = conversations.get(key);
  if (s) dropTranscript(s.sdkSessionId);
  conversations.delete(key);
}

/** Record the session that now holds the conversation; frees the one it replaced. */
export function saveConversation(key: string, next: Omit<ConversationState, "lastUsed">): void {
  const prev = conversations.get(key);
  if (prev && prev.sdkSessionId !== next.sdkSessionId) dropTranscript(prev.sdkSessionId);
  conversations.delete(key); // re-insert: Map order = least recently used first
  conversations.set(key, { ...next, lastUsed: Date.now() });
  while (conversations.size > MAX_CONVERSATIONS) {
    const oldest = conversations.keys().next().value as string;
    forget(oldest);
  }
}

// One request per conversation at a time. The client sends its next request as soon as
// it has run the tools, which can be before the previous request has drained the CLI
// and saved its state, so the next one waits for that instead of losing continuity.
const inflight = new Map<string, Promise<void>>();

/** Wait (bounded) for the conversation's running request. false = still busy. */
export async function awaitTurn(key: string, maxMs: number): Promise<boolean> {
  const running = inflight.get(key);
  if (!running) return true;
  let timer: NodeJS.Timeout | undefined;
  const ok = await Promise.race([
    running.then(() => true),
    new Promise<boolean>((r) => (timer = setTimeout(() => r(false), maxMs))),
  ]);
  clearTimeout(timer);
  return ok;
}

/** Mark the conversation as running; call the returned function when done. */
export function beginTurn(key: string): () => void {
  let done!: () => void;
  const p = new Promise<void>((r) => (done = r));
  inflight.set(key, p);
  return () => {
    if (inflight.get(key) === p) inflight.delete(key);
    done();
  };
}

/**
 * A session the CLI started fresh (not resumed) also writes its transcript under this
 * server's ~/.claude/projects; the store already holds a copy, so remove the file.
 * (Resumed and forked sessions are written to the SDK's temp resume dir instead.)
 */
export function removeLocalTranscript(sessionId: string): void {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  try {
    for (const dir of readdirSync(root)) {
      const file = join(root, dir, `${sessionId}.jsonl`);
      if (existsSync(file)) rmSync(file, { force: true });
      const sub = join(root, dir, sessionId);
      if (existsSync(sub)) rmSync(sub, { recursive: true, force: true });
    }
  } catch {
    /* best effort */
  }
}

export function continuityStatus() {
  let entries = 0;
  for (const list of transcripts.values()) entries += list.length;
  return {
    enabled: CONTINUITY_ENABLED,
    conversations: conversations.size,
    transcripts: transcripts.size,
    entries,
    maxConversations: MAX_CONVERSATIONS,
    idleHours: IDLE_MS / 3600_000,
  };
}
