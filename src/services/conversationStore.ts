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
// Storage (the SDK's sessionStore adapter, not this server's ~/.claude):
//  - memory is the working cache (no disk read on the hot path);
//  - every write also goes to SESSION_DIR (default data/sessions): one JSONL per CLI
//    session plus conversations.json, so a proxy restart resumes the same sessions
//    instead of rebuilding them from the client's history;
//  - transcripts idle for MEMORY_IDLE_MINUTES leave memory but stay on disk (the
//    upstream prompt cache is gone after an hour anyway); conversations idle for
//    SESSION_IDLE_HOURS, or beyond SESSION_MAX_CONVERSATIONS, are deleted.
import { createHash } from "crypto";
import {
  appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "fs";
import { homedir } from "os";
import { join, resolve } from "path";
import type { SessionStore, SessionStoreEntry } from "@anthropic-ai/claude-agent-sdk";

export const CONTINUITY_ENABLED = process.env.SESSION_CONTINUITY !== "false";
const MAX_CONVERSATIONS = Math.max(1, parseInt(process.env.SESSION_MAX_CONVERSATIONS || "100", 10));
const IDLE_MS = parseFloat(process.env.SESSION_IDLE_HOURS || "72") * 3600_000;
const MEMORY_IDLE_MS = parseFloat(process.env.SESSION_MEMORY_IDLE_MINUTES || "60") * 60_000;
const PERSIST = process.env.SESSION_PERSIST !== "false";
const DIR = resolve(process.env.SESSION_DIR || "./data/sessions");
const INDEX = join(DIR, "conversations.json");
const SID_RE = /^[0-9a-f-]{16,64}$/i;

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

const conversations = new Map<string, ConversationState>(); // insertion order = LRU
const transcripts = new Map<string, SessionStoreEntry[]>(); // memory cache

// ---------------- disk ----------------

const fileOf = (sid: string) => join(DIR, `${sid}.jsonl`);

function diskWrite(fn: () => void): void {
  if (!PERSIST) return;
  try {
    fn();
  } catch (e) {
    console.warn("[session] disk write failed (continuing in memory):", (e as Error).message);
  }
}

function readTranscript(sid: string): SessionStoreEntry[] | null {
  if (!PERSIST || !SID_RE.test(sid)) return null;
  let text: string;
  try {
    text = readFileSync(fileOf(sid), "utf8");
  } catch {
    return null;
  }
  const out: SessionStoreEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionStoreEntry);
    } catch {
      /* a torn last line after a crash: skip it */
    }
  }
  return out;
}

let indexTimer: NodeJS.Timeout | null = null;
function saveIndexSoon(): void {
  if (!PERSIST || indexTimer) return;
  indexTimer = setTimeout(() => {
    indexTimer = null;
    diskWrite(() => {
      const tmp = `${INDEX}.tmp`;
      writeFileSync(tmp, JSON.stringify([...conversations.entries()]));
      renameSync(tmp, INDEX);
    });
  }, 200);
  indexTimer.unref?.();
}

function loadFromDisk(): void {
  if (!PERSIST) return;
  try {
    mkdirSync(DIR, { recursive: true });
  } catch {
    return;
  }
  try {
    const rows = JSON.parse(readFileSync(INDEX, "utf8")) as Array<[string, ConversationState]>;
    const now = Date.now();
    for (const [key, st] of rows) {
      if (st && SID_RE.test(st.sdkSessionId) && now - st.lastUsed <= IDLE_MS && existsSync(fileOf(st.sdkSessionId))) {
        conversations.set(key, st);
      }
    }
  } catch {
    /* no index yet */
  }
  // Remove transcripts nothing points at (rebuild seeds, sessions replaced by a fork).
  const live = new Set([...conversations.values()].map((s) => s.sdkSessionId));
  try {
    for (const f of readdirSync(DIR)) {
      const m = /^(.+)\.jsonl$/.exec(f);
      if (m && !live.has(m[1])) rmSync(join(DIR, f), { force: true });
    }
  } catch {
    /* ignore */
  }
  if (conversations.size) console.log(`[session] restored ${conversations.size} conversation(s) from ${DIR}`);
}
loadFromDisk();

// Idle transcripts leave memory (they stay on disk and load again on demand).
setInterval(() => {
  const now = Date.now();
  for (const [key, st] of conversations) {
    if (now - st.lastUsed > IDLE_MS) forget(key);
    else if (PERSIST && now - st.lastUsed > MEMORY_IDLE_MS) transcripts.delete(st.sdkSessionId);
  }
}, 10 * 60_000).unref();

// ---------------- the SDK's session store ----------------

/** The SDK's transcript mirror: everything the CLI writes for our sessions lands here. */
export const memorySessionStore: SessionStore = {
  async append(key, entries) {
    const sid = key.sessionId;
    const list = transcripts.get(sid) ?? readTranscript(sid) ?? [];
    const seen = new Set(list.map((e) => e.uuid).filter(Boolean));
    const added = entries.filter((e) => !e.uuid || !seen.has(e.uuid));
    list.push(...added);
    transcripts.set(sid, list);
    if (added.length && SID_RE.test(sid)) {
      diskWrite(() => appendFileSync(fileOf(sid), added.map((e) => JSON.stringify(e)).join("\n") + "\n"));
    }
  },
  async load(key) {
    const sid = key.sessionId;
    const cached = transcripts.get(sid);
    if (cached) return cached;
    const fromDisk = readTranscript(sid);
    if (fromDisk) transcripts.set(sid, fromDisk);
    return fromDisk;
  },
};

export function seedTranscript(sessionId: string, entries: SessionStoreEntry[]): void {
  transcripts.set(sessionId, entries);
  if (SID_RE.test(sessionId)) {
    diskWrite(() => writeFileSync(fileOf(sessionId), entries.map((e) => JSON.stringify(e)).join("\n") + "\n"));
  }
}

export function dropTranscript(sessionId: string | undefined): void {
  if (!sessionId) return;
  transcripts.delete(sessionId);
  if (SID_RE.test(sessionId)) diskWrite(() => rmSync(fileOf(sessionId), { force: true }));
}

// ---------------- conversations ----------------

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
  if (typeof sid !== "string" || !SID_RE.test(sid)) return null;
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
  if (conversations.delete(key)) saveIndexSoon();
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
  saveIndexSoon();
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
    persisted: PERSIST ? DIR : false,
    conversations: conversations.size,
    transcriptsInMemory: transcripts.size,
    entriesInMemory: entries,
    maxConversations: MAX_CONVERSATIONS,
    idleHours: IDLE_MS / 3600_000,
    memoryIdleMinutes: MEMORY_IDLE_MS / 60_000,
  };
}
