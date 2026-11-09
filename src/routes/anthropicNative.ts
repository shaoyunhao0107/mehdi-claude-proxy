// Local patch: native /v1/messages handler for plain chat and client-side tools.
//
// Goal: the request the official CLI sends upstream should look like ordinary
// official traffic, carrying as little client-specific scaffolding as possible.
//  - Tools whose names are CLI built-ins (Bash, Read, Edit, ...) are enabled as the
//    CLI's OWN official definitions; other client tools keep their own names
//    (mcp__server__tool stays as is). A PreToolUse hook denies every call, so nothing
//    runs on this server - the tool_use is captured from the stream and returned.
//  - "session" mode (Claude Code clients, main loop): one real CLI session per client
//    conversation (metadata.user_id session id), kept in conversationStore. Each request
//    resumes it and sends only what is new; tool results resume at the tool-call entry
//    with resumeSessionAt + forkSession, which drops the synthetic denial (mechanism from
//    rynfar/meridian). Upstream sees exactly a direct CLI session's messages, and the
//    prompt cache extends like one. History that does not extend the kept session
//    (proxy restart, client rewind/compaction) is rebuilt once from the client's messages.
//  - "native" mode (other clients): the conversation is handed to the CLI as a
//    synthetic session (sessionStore + resume) for genuine multi-turn messages.
//  - "transcript" mode: history as per-message text blocks. Only the fallback now
//    (session/native failure, non-Claude-Code tool loops); resuming a synthetic history
//    that ends in a tool_result makes the CLI insert "interrupted" markers.
//  - Images / PDFs pass as real blocks; the upstream event stream is relayed as-is;
//    thinking / effort / max_tokens follow the client.
import type { Request, Response } from "express";
import {
  tool,
  createSdkMcpServer,
  type SDKUserMessage,
  type HookCallbackMatcher,
  type HookEvent,
} from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir, release as osRelease, tmpdir, version as osVersion } from "os";
import { execFileSync } from "child_process";
import { join } from "path";
import { trackedQuery, type ClaimableSpare, type SdkOptionParams } from "../services/sdkBridge.js";
import { auditFinish, auditStart, snippet } from "../services/audit.js";
import { clientIsAhead } from "../services/sdkVersion.js";
import { dropWarm, takeWarm, warmKey, warmNext, warmSessionsEnabled, type WarmHandle } from "../services/warmSessions.js";
import { ensureSpare, prewarmEnabled, spareKey, takeSpare } from "../services/sparePool.js";
import {
  awaitTurn, beginTurn, CONTINUITY_ENABLED, conversationKey, dropTranscript, fingerprintKey, forget, getConversation, memorySessionStore,
  messageHash, removeLocalTranscript, saveConversation, seedTranscript,
} from "../services/conversationStore.js";
import { cancelTask } from "../services/taskTracker.js";
import { classifyUpstreamError } from "../services/errorClassifier.js";
import { jsonSchemaToZodShape, sanitizeToolName } from "../services/toolBridge.js";
import type { ClientTool } from "../types/toolBridge.js";

type Block = { type?: string; [k: string]: unknown };
interface Msg {
  role: string;
  content: string | Block[];
}
export interface NativeBody {
  model: string;
  messages: Msg[];
  system?: string | Block[];
  stream?: boolean;
  max_tokens?: number;
  thinking?: unknown;
  output_config?: unknown;
  tool_choice?: { type?: string };
  metadata?: unknown;
}
export interface NativeParams {
  messageId: string;
  requestedModel: string;
  resolvedModel: string;
  stream: boolean;
  body: NativeBody;
  clientTools: ClientTool[];
  sdkCwd: string;
}

const NATIVE_HISTORY = process.env.NATIVE_HISTORY !== "false";
// true = old behaviour: native mode for every new prompt, even after tool calls (costs a
// full-history cache re-write per prompt).
const NATIVE_AFTER_TOOLS = process.env.NATIVE_AFTER_TOOLS === "true";
// "official" (default): upstream system prompt is the CLI's own Claude Code preset; the
// client's system prompt is either dropped (if it is itself a Claude Code prompt) or moved
// into a <system-reminder> in the first user message, the way Claude Code carries CLAUDE.md.
// "client": legacy behaviour, client system prompt becomes the SDK system prompt.
const SYSTEM_PROMPT_MODE = process.env.SYSTEM_PROMPT_MODE === "client" ? "client" : "official";
// CLIENT_SYSTEM=drop discards third-party system prompts entirely (default: reminder).
const CLIENT_SYSTEM = process.env.CLIENT_SYSTEM === "drop" ? "drop" : "reminder";
const OFFICIAL_PRESET = { type: "preset", preset: "claude_code", excludeDynamicSections: true };
const LOOKS_OFFICIAL = /You are Claude Code|Claude Agent SDK|Anthropic's official CLI/;
// MCP server name for client tools that are neither built-ins nor mcp__-named.
const BRIDGE_SERVER = sanitizeToolName(process.env.BRIDGE_MCP_SERVER || "local");
const LABEL: Record<string, string> = { user: "User", assistant: "Assistant", system: "System" };
// Keep only the most recent N images/documents from history (older ones become a placeholder).
const MAX_MEDIA = parseInt(process.env.MAX_HISTORY_IMAGES || "8", 10);
// CLI version stamped on transcript entries: the bundled SDK's (SDK 0.3.N ships CLI 2.1.N)
// until the CLI's own init message reports the real one.
function bundledSdkVersion(): string {
  try {
    const p = join(process.cwd(), "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
    return (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version;
  } catch {
    return process.env.CLAUDE_AGENT_SDK_VERSION || "0.3.319";
  }
}
let CLI_VERSION = bundledSdkVersion().replace(/^0\.3\./, "2.1.");

// A Claude Code client's system prompt is forwarded as is, while upstream sees this
// server's CLI version: different versions mean prompt text and version header disagree.
const warnedClientVersions = new Set<string>();
export const versionInfo = { serverCli: () => CLI_VERSION, clients: new Map<string, string>() };
function checkClientVersion(req: Request): void {
  const m = /^claude-cli\/(\d+\.\d+\.\d+)/.exec(String(req.headers["user-agent"] ?? ""));
  if (!m) return;
  versionInfo.clients.set(m[1], new Date().toISOString());
  if (m[1] !== CLI_VERSION && !warnedClientVersions.has(m[1])) {
    warnedClientVersions.add(m[1]);
    console.warn(
      `[version] client Claude Code ${m[1]} differs from this server's CLI ${CLI_VERSION}. ` +
        `Its system prompt is forwarded as is, so keep both on the same version` +
        (clientIsAhead(m[1]) ? ` (the client is newer: run scripts/update-sdk.ps1).` : `.`),
    );
  }
}

// Transcript mode only. Stable across requests so it stays inside the cached prefix.
const TRANSCRIPT_NOTE =
  "The conversation so far is given to you as a transcript whose turns are labelled " +
  "[User], [Assistant] and [System]. Reply as the assistant to the latest turn. Do not prefix " +
  "your reply with a label. Lines like [called tool ...] and [tool result ...] record earlier tool " +
  "calls; to call a tool yourself, use the tool-use mechanism, never write such lines as text.";

// ---------------- tools: official built-ins + name-preserving MCP ----------------

// CLI built-in tools that can be enabled by name, so upstream carries the CLI's own
// official definition. A built-in the CLI does not load in this mode (seen in its init
// message, e.g. Agent) is simply left out - never re-exposed under an MCP name.
const KNOWN_BUILTINS = new Set([
  "Agent", "Task", "Bash", "PowerShell", "BashOutput", "KillShell", "Edit", "MultiEdit", "Write",
  "Read", "Glob", "Grep", "NotebookEdit", "WebFetch", "WebSearch", "TodoWrite", "ToolSearch",
  "Skill", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode", "EnterWorktree", "ExitWorktree",
  "Monitor", "TaskStop", "TaskOutput", "ListAgents", "SendMessage", "ScheduleWakeup",
  "CronCreate", "CronDelete", "CronList", "ReportFindings", "PushNotification", "RemoteTrigger", "LSP",
  "TaskCreate", "TaskGet", "TaskList", "TaskUpdate",
]);
// Persisted across restarts: re-learning it costs the first conversation a cache miss
// (the tool list, which leads the cached prefix, shrinks between its first two requests).
const NOT_BUILTIN_PATH = join(process.cwd(), "data", "not-builtin.json");
const TOOL_ALIASES: Array<[string, string]> = [["Agent", "Task"]];
const notBuiltin = new Set<string>(loadNotBuiltin());
function loadNotBuiltin(): string[] {
  try {
    const v = JSON.parse(readFileSync(NOT_BUILTIN_PATH, "utf8")) as { version?: string; tools?: string[] };
    // Learned per CLI version: a newer CLI may load these tools.
    // format 2: learned with TOOL_ALIASES and the PowerShell switch (format 1 wrongly listed Agent/PowerShell).
    return v.version === CLI_VERSION && (v as { format?: number }).format === 2 && Array.isArray(v.tools) ? v.tools : [];
  } catch {
    return [];
  }
}
function saveNotBuiltin(): void {
  try {
    mkdirSync(join(process.cwd(), "data"), { recursive: true });
    writeFileSync(NOT_BUILTIN_PATH, JSON.stringify({ format: 2, version: CLI_VERSION, tools: [...notBuiltin] }));
  } catch {
    /* best effort */
  }
}

const MCP_NAME_RE = /^mcp__([A-Za-z0-9_-]+?)__(.+)$/;

interface ToolPlan {
  builtins: string[];
  mcpServers: Record<string, ReturnType<typeof createSdkMcpServer>> | undefined;
  toClient: Map<string, string>; // upstream name -> client name
  toUpstream: Map<string, string>; // client name -> upstream name
}

function planTools(clientTools: ClientTool[]): ToolPlan {
  const builtins: string[] = [];
  const groups = new Map<string, ReturnType<typeof tool>[]>();
  const toClient = new Map<string, string>();
  const toUpstream = new Map<string, string>();
  const handler = async () => ({ content: [{ type: "text" as const, text: "Executed by the client." }] });

  for (const t of clientTools) {
    if (KNOWN_BUILTINS.has(t.name)) {
      if (!notBuiltin.has(t.name)) builtins.push(t.name);
      continue;
    }
    const m = MCP_NAME_RE.exec(t.name);
    const server = m ? m[1] : BRIDGE_SERVER;
    const name = sanitizeToolName(m ? m[2] : t.name);
    const upstream = `mcp__${server}__${name}`;
    if (toClient.has(upstream)) throw new Error(`Tool name collision: '${t.name}' maps to '${upstream}' twice`);
    toClient.set(upstream, t.name);
    toUpstream.set(t.name, upstream);
    if (!groups.has(server)) groups.set(server, []);
    groups.get(server)!.push(tool(name, t.description ?? "", jsonSchemaToZodShape(t.input_schema), handler));
  }

  let mcpServers: ToolPlan["mcpServers"];
  if (groups.size > 0) {
    mcpServers = {};
    for (const [server, tools] of groups) mcpServers[server] = createSdkMcpServer({ name: server, version: "1.0.0", tools });
  }
  return { builtins, mcpServers, toClient, toUpstream };
}

// Every tool call is denied before execution: the client runs it, never this server.
const DENY_ALL_TOOLS: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
  PreToolUse: [
    {
      hooks: [
        async () => ({
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            permissionDecision: "deny" as const,
            permissionDecisionReason: "Executed by the client.",
          },
        }),
      ],
    },
  ],
};

// Same denial, released only once `gate` resolves (the response finished streaming), or
// after DENY_HOLD_MAX_MS as a safety net.
const DENY_HOLD_MAX_MS = 10 * 60_000;
function holdingDenyHooks(gate: Promise<void>): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PreToolUse: [
      {
        hooks: [
          async () => {
            let timer: NodeJS.Timeout | undefined;
            await Promise.race([gate, new Promise<void>((r) => (timer = setTimeout(r, DENY_HOLD_MAX_MS)))]);
            clearTimeout(timer);
            return {
              hookSpecificOutput: {
                hookEventName: "PreToolUse" as const,
                permissionDecision: "deny" as const,
                permissionDecisionReason: "Executed by the client.",
              },
            };
          },
        ],
        timeout: DENY_HOLD_MAX_MS / 1000 + 60,
      },
    ],
  };
}

/**
 * The client's tools plus the ones it announces in its messages: tool_addition
 * definitions, and built-in tools named in its deferred-tool lists (built-ins need no
 * schema: the server CLI has its own definitions). Client MCP tools that are only named
 * (deferred, schema not sent until loaded) arrive in its tools array once loaded.
 */
const DEFERRED_LIST_RE = /The following deferred tools are now available via ToolSearch[^\n]*\n([\s\S]*?)(?:\n\n|$)/g;
function withAnnouncedTools(tools: ClientTool[], messages: Msg[]): ClientTool[] {
  const out = [...tools];
  const have = new Set(tools.map((t) => t.name));
  const add = (t: ClientTool) => {
    if (!t.name || have.has(t.name)) return;
    have.add(t.name);
    out.push(t);
  };
  for (const m of messages) {
    if (!Array.isArray(m.content)) {
      if (m.role === "system") scanDeferred(m.content, add);
      continue;
    }
    for (const b of m.content) {
      if (b.type === "tool_addition") {
        const d = ((b.tool as Block | undefined)?.definition ?? {}) as Partial<ClientTool>;
        if (typeof d.name === "string") add({ name: d.name, description: d.description, input_schema: d.input_schema ?? { type: "object" } });
      } else if (m.role === "system" && b.type === "text" && typeof b.text === "string") {
        scanDeferred(b.text, add);
      }
    }
  }
  return out;
}
function scanDeferred(text: string, add: (t: ClientTool) => void): void {
  for (const m of text.matchAll(DEFERRED_LIST_RE)) {
    for (const line of m[1].split("\n")) {
      const name = line.trim();
      if (KNOWN_BUILTINS.has(name)) add({ name, input_schema: { type: "object" } });
    }
  }
}

// ---------------- shared helpers ----------------

function isMedia(b: Block): boolean {
  return (b.type === "image" || b.type === "document") && !!b.source && typeof b.source === "object";
}

function cleanMedia(b: Block): Block {
  const out: Block = { type: b.type, source: b.source };
  if (b.type === "document") {
    if (b.title) out.title = b.title;
    if (b.context) out.context = b.context;
  }
  return out; // drops client cache_control etc. (the CLI places its own breakpoints)
}

function textOf(c: Msg["content"]): string {
  if (typeof c === "string") return c;
  return c.filter((b) => b.type === "text").map((b) => b.text as string).join("\n");
}

function systemText(system: NativeBody["system"]): string | undefined {
  if (!system) return undefined;
  if (typeof system === "string") return system || undefined;
  const t = system.filter((b) => b.type === "text").map((b) => b.text as string).join("\n\n");
  return t || undefined;
}

/**
 * The client's own "# Environment" section (cwd, platform, shell...), latest occurrence,
 * from its system prompt, role:"system" turns or reminder text. The CLI always attaches
 * THIS server's environment too; re-stating the client's one last, in the CLI's own
 * "# Environment update" form, keeps the model working against the client's machine.
 */
function clientEnvironment(messages: Msg[], clientSystem?: string): string | null {
  const texts: string[] = [];
  if (clientSystem) texts.push(clientSystem);
  for (const m of messages) {
    if (typeof m.content === "string") texts.push(m.content);
    else for (const b of m.content) if (b.type === "text" && typeof b.text === "string") texts.push(b.text);
  }
  for (let i = texts.length - 1; i >= 0; i--) {
    const t = texts[i];
    const k = t.lastIndexOf("# Environment");
    if (k < 0 || !/working directory/i.test(t.slice(k, k + 600))) continue;
    let sec = t.slice(k);
    const next = sec.search(/\n#{1,2} (?!Environment)/);
    if (next > 0) sec = sec.slice(0, next);
    sec = sec.replace(/<\/system-reminder>[\s\S]*$/, "").replace(/^# Environment( update)?\s*/, "").trim();
    if (sec) return sec;
  }
  return null;
}

/**
 * Run the CLI in the CLIENT's working directory when that path is usable on this OS, so
 * the environment the CLI always attaches (last in the request) names the same directory
 * the client works in. The directory is created empty if missing; no tool ever runs here.
 */
const MIRROR_CLIENT_CWD = process.env.MIRROR_CLIENT_CWD !== "false";
const DEDUPE_CLI_ATTACHMENTS = process.env.DEDUPE_CLI_ATTACHMENTS !== "false";
function mirroredCwd(env: string | null): string | null {
  if (!MIRROR_CLIENT_CWD || !env) return null;
  const m = /Primary working directory:\s*(.+)/.exec(env);
  const dir = m?.[1].trim();
  if (!dir) return null;
  const usable = process.platform === "win32" ? /^[A-Za-z]:[\\/]/.test(dir) : dir.startsWith("/");
  if (!usable || dir.includes("\0")) return null;
  try {
    if (process.platform === "win32") ensureDrive(dir[0].toUpperCase());
    mkdirSync(dir, { recursive: true });
    // Same answer to "Is a git repository" as the client's environment gives.
    if (/Is a git repository:\s*true/i.test(env) && !existsSync(join(dir, ".git"))) {
      execFileSync("git", ["init", "-q", dir], { stdio: "ignore", timeout: 15_000 });
    }
    return dir;
  } catch {
    return null;
  }
}

/**
 * A client drive letter this server lacks (the home PC works on I:) is mapped with subst
 * to a folder under data/drives, so the CLI runs in the very path the client reports and
 * its environment says the same as the client's. Only for letters that do not exist.
 */
const substituted = new Set<string>();
function ensureDrive(letter: string): void {
  if (!MIRROR_SUBST_DRIVES || substituted.has(letter) || existsSync(`${letter}:\\`)) return;
  const target = join(process.cwd(), "data", "drives", letter);
  mkdirSync(target, { recursive: true });
  execFileSync("subst", [`${letter}:`, target], { stdio: "ignore", timeout: 15_000 });
  substituted.add(letter);
  console.log(`[native] mapped missing drive ${letter}: to ${target} for client working directories`);
}
const MIRROR_SUBST_DRIVES = process.env.MIRROR_SUBST_DRIVES !== "false";

/** Would the server CLI describe this machine the way the client's environment does? */
function serverEnvMatches(env: string): boolean {
  const line = (k: string) => new RegExp(`${k}:\\s*([^\\n]+)`).exec(env)?.[1].trim();
  if (line("Platform") && line("Platform") !== process.platform) return false;
  const osv = line("OS Version");
  if (osv && osv !== `${osVersion()} ${osRelease()}`) return false;
  return true;
}

/**
 * The Claude Code client's system prompt without its billing header and identity line,
 * which the server CLI writes itself (blocks 0 and 1). Upstream then gets the CLI's usual
 * layout: [billing header, identity (cached), body (cached)] instead of one merged block.
 */
const IDENTITY_LINE_RE = /^\s*You are (Claude Code, Anthropic's official CLI for Claude|a Claude agent, built on Anthropic's Claude Agent SDK)[^\n]*$/;
function officialPromptBody(system: NativeBody["system"]): string | undefined {
  if (!system) return undefined;
  const parts = typeof system === "string" ? [system] : system.filter((b) => b.type === "text").map((b) => String(b.text ?? ""));
  const kept = parts
    .map((t) => t.split("\n").filter((l, i) => !(i === 0 && l.startsWith("x-anthropic-billing-header:"))).join("\n"))
    .filter((t) => t.trim() && !IDENTITY_LINE_RE.test(t.trim()) && !t.trim().startsWith("x-anthropic-billing-header:"));
  return kept.join("\n\n") || undefined;
}

function previewOf(messages: Msg[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const c = messages[i].content;
    if (typeof c === "string") return c.slice(0, 200);
    const t = c.find((b) => b.type === "text");
    if (t) return String(t.text).slice(0, 200);
    if (c.some((b) => b.type === "tool_result")) return "(tool_result turn)";
  }
  return "(no text)";
}

type SdkThinking =
  | { type: "adaptive"; display?: "summarized" | "omitted" }
  | { type: "enabled"; budgetTokens: number; display?: "summarized" | "omitted" }
  | { type: "disabled" };

// Models that only support a fixed thinking budget (no adaptive thinking).
const BUDGET_ONLY = /haiku-4-5|-4-5-|sonnet-4-0|opus-4-0|opus-4-1|3-7/;

// Client asks for thinking -> adaptive (summarized, so the client can show it); the CLI
// ignores fixed budgets on 4.6+/5.x models. No thinking requested -> disabled (the CLI
// still forces adaptive on 5.x models, where the model decides whether to think).
function mapThinking(t: unknown, model: string, maxTokens?: number): SdkThinking {
  if (!t || typeof t !== "object") return { type: "disabled" };
  const o = t as { type?: string; budget_tokens?: number; display?: string };
  if (o.type !== "adaptive" && o.type !== "enabled") return { type: "disabled" };
  // As the client asked. "omitted" is what a CLI sends by default, so then no display is
  // set and the server CLI sends its own default (passing "omitted" through the SDK makes
  // it send "updates" instead); otherwise "summarized", which shows thinking in the UI.
  const display = o.display === "omitted" ? undefined : "summarized";
  if (!BUDGET_ONLY.test(model)) return display ? { type: "adaptive", display } : { type: "adaptive" };
  let budget = typeof o.budget_tokens === "number" ? o.budget_tokens : 8000;
  if (maxTokens && budget >= maxTokens) budget = maxTokens - 1;
  if (budget < 1024) return { type: "disabled" };
  return display ? { type: "enabled", budgetTokens: budget, display } : { type: "enabled", budgetTokens: budget };
}

function mapEffort(oc: unknown): string | undefined {
  const e = oc && typeof oc === "object" ? (oc as { effort?: unknown }).effort : undefined;
  return typeof e === "string" && ["low", "medium", "high", "xhigh", "max"].includes(e) ? e : undefined;
}

// ---------------- native mode: real session history ----------------

interface NMsg {
  role: "user" | "assistant";
  content: Block[];
}

function cleanUserBlock(b: Block, toUpstream: Map<string, string>, known?: Set<string>): Block | null {
  if (b.type === "text") return b.text ? { type: "text", text: b.text } : null;
  if (isMedia(b)) return cleanMedia(b);
  if (b.type === "tool_result") {
    const out: Block = { type: "tool_result", tool_use_id: b.tool_use_id };
    if (b.is_error) out.is_error = true;
    if (typeof b.content === "string") out.content = b.content;
    else if (Array.isArray(b.content)) {
      out.content = (b.content as Block[])
        .map((c) => {
          if (c.type === "text") return { type: "text", text: c.text };
          if (isMedia(c)) return cleanMedia(c);
          // ToolSearch results: the reference is what makes the API load the deferred
          // tool, exactly as in a direct session. Only for tools this request declares.
          if (c.type === "tool_reference" && typeof c.tool_name === "string") {
            const name = toUpstream.get(c.tool_name) ?? c.tool_name;
            return !known || known.has(name) ? { type: "tool_reference", tool_name: name } : null;
          }
          return null;
        })
        .filter(Boolean);
    }
    return out;
  }
  return null;
}

function cleanAssistantBlock(b: Block, toUpstream: Map<string, string>): Block | null {
  switch (b.type) {
    case "text":
      return b.text ? { type: "text", text: b.text } : null;
    case "thinking":
      return b.signature ? { type: "thinking", thinking: b.thinking ?? "", signature: b.signature } : null;
    case "redacted_thinking":
      return b.data ? { type: "redacted_thinking", data: b.data } : null;
    case "tool_use":
      return { type: "tool_use", id: b.id, name: toUpstream.get(b.name as string) ?? b.name, input: b.input ?? {} };
    default:
      return null;
  }
}

/**
 * What the server's own CLI generates for every request anyway. A Claude Code client
 * sends its own copies (it is the same CLI); forwarding them too would put each one in
 * the upstream request twice, which a direct CLI session never does. Only these exact,
 * CLI-generated shapes are dropped; anything client-specific (CLAUDE.md, its MCP server
 * instructions, its tool lists) is kept.
 */
export interface NormalizeOpts {
  /** "Attribution for git commits and pull requests ..." reminder. */
  dropAttribution?: boolean;
  /** <total_tokens>N tokens left</total_tokens> system turns. */
  dropTotalTokens?: boolean;
  /** The "# Environment" section of system turns (only when the server's one is equal). */
  dropEnvSection?: boolean;
  /** Upstream tool names this request declares; tool_reference blocks to others are dropped. */
  knownTools?: Set<string>;
}
const ATTRIBUTION_RE = /^<system-reminder>\s*Attribution for git commits and pull requests\b/;
const TOTAL_TOKENS_RE = /^\s*<total_tokens>[^<]*tokens left<\/total_tokens>\s*$/;

/** The text without its "# Environment" section (up to the next other heading). */
function withoutEnvSection(t: string): string {
  const k = t.indexOf("# Environment");
  if (k < 0) return t;
  const rest = t.slice(k);
  const next = rest.search(/\n#{1,2} (?!Environment)/);
  return (t.slice(0, k) + (next > 0 ? rest.slice(next + 1) : "")).trim();
}

/** Client messages -> strictly alternating user/assistant messages; system turns become reminders. */
function normalize(messages: Msg[], toUpstream: Map<string, string>, opts: NormalizeOpts = {}): NMsg[] | null {
  const out: NMsg[] = [];
  let pendingSystem: Block[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      let t = textOf(m.content);
      if (opts.dropTotalTokens && TOTAL_TOKENS_RE.test(t)) continue;
      if (opts.dropEnvSection) t = withoutEnvSection(t);
      if (t) pendingSystem.push({ type: "text", text: `<system-reminder>\n${t}\n</system-reminder>` });
      continue;
    }
    if (m.role !== "user" && m.role !== "assistant") return null;
    const raw: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    let blocks = raw
      .map((b) => (m.role === "user" ? cleanUserBlock(b, toUpstream, opts.knownTools) : cleanAssistantBlock(b, toUpstream)))
      .filter((b): b is Block => b !== null)
      .filter((b) => !(opts.dropAttribution && b.type === "text" && ATTRIBUTION_RE.test(String(b.text))));
    if (m.role === "user" && pendingSystem.length) {
      // tool_result blocks must stay first in a user message
      const results = blocks.filter((b) => b.type === "tool_result");
      blocks = [...results, ...pendingSystem, ...blocks.filter((b) => b.type !== "tool_result")];
      pendingSystem = [];
    }
    if (blocks.length === 0) continue;
    const prev = out[out.length - 1];
    if (prev && prev.role === m.role) prev.content.push(...blocks);
    else out.push({ role: m.role, content: blocks });
  }
  if (pendingSystem.length) {
    const last = out[out.length - 1];
    if (!last || last.role !== "user") return null;
    last.content.push(...pendingSystem);
  }
  if (out.length === 0 || out[0].role !== "user" || out[out.length - 1].role !== "user") return null;
  return out;
}

/** Session-store entries for everything before the final user turn. */
function buildEntries(history: NMsg[], sessionId: string, cwd: string, model: string): Record<string, unknown>[] {
  const entries: Record<string, unknown>[] = [];
  let parent: string | null = null;
  const t0 = Date.now() - history.length * 1000;
  history.forEach((m, i) => {
    const uuid = randomUUID();
    const base = {
      parentUuid: parent, isSidechain: false, userType: "external", cwd, sessionId,
      version: CLI_VERSION, type: m.role, uuid, timestamp: new Date(t0 + i * 1000).toISOString(),
    };
    if (m.role === "user") {
      entries.push({ ...base, message: { role: "user", content: m.content } });
    } else {
      const hasToolUse = m.content.some((b) => b.type === "tool_use");
      entries.push({
        ...base,
        requestId: `req_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        message: {
          id: `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`, type: "message", role: "assistant", model,
          content: m.content, stop_reason: hasToolUse ? "tool_use" : "end_turn", stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    parent = uuid;
  });
  return entries;
}

// The resume path copies credentials WITHOUT the refresh token, so it can never refresh
// an expiring access token itself. Before a native request, if the token is close to
// expiry, run one tiny ordinary request, which makes the CLI refresh it on disk.
const CREDS_PATH = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
const REFRESH_MARGIN_MS = 4.5 * 60_000;
let refreshing: Promise<void> | null = null;

function tokenExpiresAt(): number | null {
  try {
    if (!existsSync(CREDS_PATH)) return null;
    const c = JSON.parse(readFileSync(CREDS_PATH, "utf8")) as { claudeAiOauth?: { expiresAt?: number } };
    return c.claudeAiOauth?.expiresAt ?? null;
  } catch {
    return null;
  }
}

async function ensureFreshToken(cwd: string): Promise<void> {
  const exp = tokenExpiresAt();
  if (exp === null || exp - Date.now() > REFRESH_MARGIN_MS) return;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const { query } = await import("@anthropic-ai/claude-agent-sdk");
        for await (const _ of query({
          prompt: "hi",
          options: {
            model: "claude-haiku-4-5", maxTurns: 1, tools: [], settingSources: [], persistSession: false, cwd,
            systemPrompt: "Reply with one word.", thinking: { type: "disabled" },
            env: { ...(process.env as Record<string, string>), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", CLAUDE_CODE_MAX_OUTPUT_TOKENS: "8" },
          },
        })) { /* drain */ }
        console.log("[native] token refresh call done; expires in",
          Math.round(((tokenExpiresAt() ?? 0) - Date.now()) / 60000), "min");
      } catch (e) {
        console.error("[native] token refresh call failed:", (e as Error).message);
      } finally {
        refreshing = null;
      }
    })();
  }
  await refreshing;
}

// The SDK materializes resumed sessions (with a credentials copy) under tmp/claude-resume-*.
// It removes them itself; this sweeps anything left behind by a crash.
setInterval(() => {
  try {
    const dir = tmpdir();
    for (const n of readdirSync(dir)) {
      if (!n.startsWith("claude-resume-")) continue;
      const p = join(dir, n);
      if (Date.now() - statSync(p).mtimeMs > 15 * 60_000) rmSync(p, { recursive: true, force: true });
    }
  } catch { /* best effort */ }
}, 10 * 60_000).unref();

// ---------------- transcript mode: per-message text blocks ----------------

function countMedia(messages: Msg[]): number {
  let n = 0;
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (isMedia(b)) n++;
      if (b.type === "tool_result" && Array.isArray(b.content)) {
        for (const c of b.content as Block[]) if (isMedia(c)) n++;
      }
    }
  }
  return n;
}

export function buildTranscriptBlocks(messages: Msg[]): Block[] {
  let skipMedia = Math.max(0, countMedia(messages) - MAX_MEDIA);
  const blocks: Block[] = [];
  for (const m of messages) {
    let buf = `[${LABEL[m.role] ?? m.role}]: `;
    const flush = () => {
      if (buf.trim()) blocks.push({ type: "text", text: buf });
      buf = "";
    };
    const media = (b: Block) => {
      if (skipMedia > 0) {
        skipMedia--;
        buf += `[${b.type} omitted: older attachment]\n`;
        return;
      }
      flush();
      blocks.push(cleanMedia(b));
    };
    if (typeof m.content === "string") {
      buf += m.content;
    } else {
      for (const b of m.content) {
        switch (b.type) {
          case "text":
            buf += `${b.text as string}\n`;
            break;
          case "tool_use":
            buf += `[called tool "${b.name as string}" (id=${b.id as string}) with input: ${JSON.stringify(b.input ?? {})}]\n`;
            break;
          case "tool_result": {
            buf += `[${b.is_error ? "tool error" : "tool result"} (id=${b.tool_use_id as string})]: `;
            if (typeof b.content === "string") buf += `${b.content}\n`;
            else if (Array.isArray(b.content)) {
              for (const c of b.content as Block[]) {
                if (c.type === "text") buf += `${c.text as string}\n`;
                else if (isMedia(c)) media(c);
              }
            } else buf += "\n";
            break;
          }
          case "image":
          case "document":
            if (isMedia(b)) media(b);
            break;
        }
      }
    }
    flush();
  }
  return blocks;
}

// ---------------- response accumulation ----------------

interface Acc {
  blocks: Block[];
  partialJson: Record<number, string>;
  stopReason: string | null;
  stopSequence: string | null;
  usage: Record<string, unknown>;
}

function accumulate(acc: Acc, ev: Block): void {
  switch (ev.type) {
    case "message_start": {
      const u = (ev.message as { usage?: Record<string, unknown> })?.usage;
      if (u) Object.assign(acc.usage, u);
      break;
    }
    case "content_block_start":
      acc.blocks[ev.index as number] = { ...(ev.content_block as Block) };
      if ((ev.content_block as Block).type === "tool_use") acc.partialJson[ev.index as number] = "";
      break;
    case "content_block_delta": {
      const b = acc.blocks[ev.index as number];
      const d = ev.delta as Block;
      if (!b) break;
      if (d.type === "text_delta") b.text = ((b.text as string) ?? "") + (d.text as string);
      else if (d.type === "thinking_delta") b.thinking = ((b.thinking as string) ?? "") + (d.thinking as string);
      else if (d.type === "signature_delta") b.signature = d.signature;
      else if (d.type === "input_json_delta") acc.partialJson[ev.index as number] += d.partial_json as string;
      break;
    }
    case "content_block_stop": {
      const i = ev.index as number;
      if (acc.partialJson[i] !== undefined) {
        try {
          acc.blocks[i].input = acc.partialJson[i] ? JSON.parse(acc.partialJson[i]) : {};
        } catch {
          acc.blocks[i].input = {};
        }
      }
      break;
    }
    case "message_delta": {
      const d = ev.delta as { stop_reason?: string; stop_sequence?: string | null };
      if (d?.stop_reason) acc.stopReason = d.stop_reason;
      if (d?.stop_sequence !== undefined) acc.stopSequence = d.stop_sequence;
      const u = ev.usage as Record<string, unknown> | undefined;
      if (u) for (const [k, v] of Object.entries(u)) if (v !== null && v !== undefined) acc.usage[k] = v;
      break;
    }
  }
}

function sse(res: Response, ev: Block): void {
  res.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
}

function errorPayload(err: unknown): Block {
  const c = classifyUpstreamError(err);
  return { type: "error", error: { type: c.status >= 500 ? "api_error" : c.type, message: c.message } };
}

// ---------------- handler ----------------

export async function handleNative(req: Request, res: Response, p: NativeParams): Promise<void> {
  const { body } = p;
  checkClientVersion(req);
  // Besides its tools array, a Claude Code client announces tools in system turns: MCP
  // tools as tool_addition blocks (full definitions) and deferred tools by name. Giving
  // the server CLI the same tools lets it run tool search and deferred loading itself,
  // as in a direct session (otherwise ToolSearch can never load anything).
  const clientTools = body.tool_choice?.type === "none" ? [] : withAnnouncedTools(p.clientTools, body.messages);
  const t0 = Date.now();
  const audit = auditStart(req, p.messageId, body as unknown as Record<string, unknown>);
  if (audit) {
    audit.request = {
      model: p.requestedModel,
      resolvedModel: p.resolvedModel,
      stream: p.stream,
      messages: body.messages.length,
      lastRoles: body.messages.slice(-3).map((m) => m.role).join(","),
      systemChars: systemText(body.system)?.length ?? 0,
      systemStart: snippet(systemText(body.system), 120),
      tools: clientTools.length,
      toolNames: clientTools.map((t) => t.name).slice(0, 400),
      thinking: body.thinking ?? null,
      maxTokens: body.max_tokens ?? null,
      hasSessionMetadata: !!(body.metadata as { user_id?: unknown } | undefined)?.user_id,
    };
  }

  let plan: ToolPlan;
  try {
    plan = planTools(clientTools);
  } catch (err) {
    res.status(400).json({ type: "error", error: { type: "invalid_request_error", message: (err as Error).message } });
    return;
  }

  const clientSystem = systemText(body.system);
  // A Claude Code client's own (official) system prompt.
  const clientIsOfficial = !!clientSystem && LOOKS_OFFICIAL.test(clientSystem.slice(0, 400));
  const clientEnv = clientIsOfficial ? clientEnvironment(body.messages, clientSystem) : null;
  const runCwd = mirroredCwd(clientEnv) ?? p.sdkCwd;
  // A Claude Code client: drop its copies of what the server CLI adds itself (see
  // NormalizeOpts). The environment only when the server's would say the same thing.
  const nopts: NormalizeOpts = clientIsOfficial && DEDUPE_CLI_ATTACHMENTS
    ? {
        dropAttribution: true,
        dropTotalTokens: true,
        dropEnvSection: runCwd !== p.sdkCwd && !!clientEnv && serverEnvMatches(clientEnv),
        knownTools: new Set([...plan.builtins, ...plan.toClient.keys()]),
      }
    : { knownTools: new Set([...plan.builtins, ...plan.toClient.keys()]) };
  // The client's own system prompt without the parts the server CLI writes itself (its
  // billing header and identity line), so upstream gets the CLI's usual three blocks.
  const clientSystemBody = clientIsOfficial ? officialPromptBody(body.system) : clientSystem;
  const extraEnv: Record<string, string> = {};
  if (typeof body.max_tokens === "number" && body.max_tokens > 0) {
    extraEnv.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(body.max_tokens);
  }
  // The CLI loads its PowerShell tool only with this switch (default off outside its
  // interactive Windows setup); turn it on when the client offers PowerShell.
  if (plan.builtins.includes("PowerShell")) extraEnv.CLAUDE_CODE_USE_POWERSHELL_TOOL = "1";

  // Pick the mode.
  // Claude Code appends role:"system" turns after the user message; look past them.
  const nonSystem = body.messages.filter((m) => m.role !== "system");
  const last = nonSystem[nonSystem.length - 1];
  const lastHasToolResult = Array.isArray(last?.content) && last.content.some((b) => b.type === "tool_result");
  let native: NMsg[] | null = null;
  // Once tools were used, stay in transcript mode: rebuilding the history in native form for
  // each new prompt changes the whole message prefix and re-writes it to the prompt cache.
  const hasToolHistory = body.messages.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "tool_use" || b.type === "tool_result"),
  );
  if (NATIVE_HISTORY && last?.role === "user" && !lastHasToolResult && (!hasToolHistory || NATIVE_AFTER_TOOLS)) {
    native = normalize(body.messages, plan.toUpstream, nopts);
  }

  // Session continuity (see conversationStore): a Claude Code client's main loop (tools,
  // streamed; its tool-less side calls share the session id and stay stateless) keeps
  // one real CLI session across requests and sends only what is new.
  // Claude Code is identified by its session id; other clients (WorkBuddy, Cherry, or a
  // gateway that drops metadata) by a fingerprint of their first message.
  const convCandidate =
    CONTINUITY_ENABLED && clientTools.length > 0 && p.stream && last?.role === "user"
      ? (clientIsOfficial ? conversationKey(body.metadata, req.header("x-claude-code-agent-id") ?? undefined) : null)
        ?? fingerprintKey(req.apiKeyId, body.messages)
      : null;
  // Wait for this conversation's previous request to save its state (see awaitTurn);
  // if it is still running after that, this request stays stateless.
  const convKey = convCandidate && (await awaitTurn(convCandidate, 30_000)) ? convCandidate : null;
  const endTurn = convKey ? beginTurn(convKey) : null;
  const msgHashes = convKey ? body.messages.map(messageHash) : [];
  // What official mode puts at the start of the conversation instead of the system prompt:
  // a third-party client's own prompt (and a per-key prompt) as reminders. A session holds
  // it in its first message, so it goes in when the session is created or rebuilt.
  const leadReminders: Block[] = SYSTEM_PROMPT_MODE !== "official" ? [] : [
    ...(req.keySystemPrompt ? [req.keySystemPrompt] : []),
    ...(clientSystem && !clientIsOfficial && CLIENT_SYSTEM === "reminder" ? [clientSystem] : []),
  ].map((t) => ({ type: "text", text: `<system-reminder>
${t}
</system-reminder>` }));
  const session = convKey
    ? planSession(convKey, body.messages, msgHashes, plan.toUpstream, runCwd, p.resolvedModel, leadReminders, nopts)
    : null;
  if (DEBUG_CONTINUITY && convCandidate) console.log(`[session] ${p.messageId.slice(-6)} key=${convCandidate.slice(0, 8)} waited-ok=${!!convKey} plan=${session?.kind ?? "none"} resume=${session?.sessionId?.slice(0, 8)} at=${session?.resumeAt?.slice(0, 8)} msgs=${body.messages.length}`);

  const acc: Acc = { blocks: [], partialJson: {}, stopReason: null, stopSequence: null, usage: {} };
  let started = false; // stream: message_start relayed
  let finished = false; // first upstream message_stop seen
  let responded = false;
  let clientGone = false;
  res.on("close", () => {
    if (!responded) {
      clientGone = true;
      cancelTask(p.messageId);
    }
  });

  const finishNonStream = () => {
    responded = true;
    res.json({
      id: p.messageId, type: "message", role: "assistant", model: p.resolvedModel,
      content: acc.blocks.filter(Boolean),
      stop_reason: acc.stopReason ?? "end_turn", stop_sequence: acc.stopSequence, usage: acc.usage,
    });
  };

  // Client MCP tool definitions, part of what a prewarmed spare must match.
  const toolsSig = JSON.stringify(clientTools.map((t) => [t.name, t.description ?? "", t.input_schema ?? null]));
  let usedSpare = false;
  let usedFallback = false;
  let limitedError = false; // a usage/rate limit: the kept session is still valid

  // What the CLI reported for this request's session (continuity bookkeeping).
  let runSessionId: string | undefined;
  let lastAssistantUuid: string | undefined;

  // The options of this request's session-mode run, to predict the next one (warmSessions).
  let lastSessionParams: SdkOptionParams | null = null;
  let usedWarm = false;

  async function run(mode: "session" | "native" | "transcript", allowSpare = true, allowWarm = true): Promise<void> {
    let content: Block[];
    let systemPrompt: string | undefined;
    // Session mode holds every denial until the whole response has streamed (deny-hold,
    // as in meridian): the CLI fires a tool's PreToolUse as soon as that call's input is
    // complete, so with parallel calls an immediate deny lands in the transcript BEFORE
    // the later calls. The resume point (the last tool-call entry) would then keep that
    // early denial and send "Executed by the client." upstream as a tool result.
    let releaseDenies: () => void = () => {};
    const denyGate = new Promise<void>((resolve) => (releaseDenies = resolve));
    const extraOptions: Record<string, unknown> = {
      hooks: mode === "session" ? holdingDenyHooks(denyGate) : DENY_ALL_TOOLS,
    };

    const sysParts: string[] = [];
    if (req.keySystemPrompt) sysParts.push(req.keySystemPrompt);
    if (clientSystem) sysParts.push(clientSystem);
    // Official mode: what goes into the first user message instead of the system prompt.
    // A Claude Code client's system prompt is official text already, and it carries the
    // CLIENT's environment (cwd, OS, git); replacing it with this server's preset makes the
    // model work against the server's paths. So: Claude Code prompt -> used as is;
    // third-party prompt -> official preset + the prompt as a reminder.
    const reminders: string[] = [];
    if (SYSTEM_PROMPT_MODE === "official") {
      if (req.keySystemPrompt) reminders.push(req.keySystemPrompt);
      if (clientSystem && !clientIsOfficial && CLIENT_SYSTEM === "reminder") reminders.push(clientSystem);
    }
    const reminderBlocks = (extra: string[] = []): Block[] =>
      [...extra, ...reminders].map((t) => ({ type: "text", text: `<system-reminder>\n${t}\n</system-reminder>` }));

    if (mode === "session" && session) {
      // The CLI's own session, held in memorySessionStore. continue: only the new
      // input (tool results resume at the tool-call entry, forking past the denial);
      // rebuild: a synthetic transcript of the client history, resumed the same way;
      // fresh: a new session.
      content = session.content; // planSession already put the lead reminders in
      systemPrompt = sysParts.join("\n\n") || undefined;
      extraOptions.persistSession = true;
      extraOptions.sessionStore = memorySessionStore;
      if (session.kind === "fresh") {
        extraOptions.sessionId = session.sessionId;
      } else {
        await ensureFreshToken(p.sdkCwd);
        extraOptions.resume = session.sessionId;
        if (session.resumeAt) extraOptions.resumeSessionAt = session.resumeAt;
        if (session.fork) extraOptions.forkSession = true;
      }
    } else if (mode === "native" && native) {
      if (SYSTEM_PROMPT_MODE === "official" && reminders.length) {
        native = [{ ...native[0], content: [...reminderBlocks(), ...native[0].content] }, ...native.slice(1)];
      }
      const history = native.slice(0, -1);
      content = native[native.length - 1].content;
      systemPrompt = sysParts.join("\n\n") || undefined;
      if (history.length > 0) {
        await ensureFreshToken(p.sdkCwd);
        const sessionId = randomUUID();
        const entries = buildEntries(history, sessionId, runCwd, p.resolvedModel);
        extraOptions.resume = sessionId;
        extraOptions.persistSession = true; // required by sessionStore; writes go to the SDK's temp resume dir
        extraOptions.sessionStore = {
          append: async () => {},
          load: async (key: { sessionId: string }) => (key.sessionId === sessionId ? entries : null),
        };
      }
    } else {
      const single = body.messages.length === 1 && body.messages[0].role === "user";
      content = single
        ? (normalize(body.messages, plan.toUpstream, nopts)?.[0]?.content ?? buildTranscriptBlocks(body.messages))
        : buildTranscriptBlocks(body.messages);
      systemPrompt = (single ? sysParts : [TRANSCRIPT_NOTE, ...sysParts]).join("\n\n") || undefined;
      if (SYSTEM_PROMPT_MODE === "official") content = [...reminderBlocks(single ? [] : [TRANSCRIPT_NOTE]), ...content];
    }
    // Claude Code client whose cwd could not be mirrored (e.g. a Mac client on this Windows
    // server, or a drive letter this server lacks): restate the client's environment last
    // instead (see clientEnvironment). A continued session already holds it from its first
    // request (~10k chars), so it is not repeated there.
    const continuing = mode === "session" && (session?.kind === "continue" || session?.kind === "rewind");
    if (clientIsOfficial && clientEnv && runCwd === p.sdkCwd && !continuing) {
      content = [...content, { type: "text", text: `<system-reminder>\n# Environment update\n${clientEnv}\n</system-reminder>` }];
    }
    if (SYSTEM_PROMPT_MODE === "official") {
      if (clientIsOfficial) {
        systemPrompt = clientSystemBody;
      } else {
        systemPrompt = undefined;
        extraOptions.systemPrompt = OFFICIAL_PRESET;
      }
    }

    async function* input(): AsyncGenerator<SDKUserMessage> {
      yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: "" } as unknown as SDKUserMessage;
    }

    const optionParams: SdkOptionParams = {
      resolvedModel: p.resolvedModel,
      includePartialMessages: true,
      mcpServers: plan.mcpServers,
      builtInTools: plan.builtins,
      systemPrompt,
      maxTurns: 1,
      cwd: runCwd,
      thinking: mapThinking(body.thinking, p.resolvedModel, body.max_tokens),
      effort: mapEffort(body.output_config),
      extraEnv,
      extraOptions,
    };

    // Session mode: a process the previous request started early for exactly this start
    // (same session, checkpoint and options) skips spawn and transcript loading.
    let warm: WarmHandle | null = null;
    if (mode === "session" && session && convKey) {
      if (allowWarm && session.kind === "continue") warm = await takeWarm(convKey, warmKey(optionParams, toolsSig));
      else dropWarm(convKey);
      if (warm) releaseDenies = warm.releaseDenies; // its hooks wait on its own gate
      lastSessionParams = optionParams;
    }
    usedWarm = warm !== null;

    // Prewarmed CLI (see sparePool): transcript-mode requests of a tool-using client share
    // all start-up options, so the next one can claim a process started in advance.
    // Native mode resumes a session, which a spare cannot take, but it refills the pool.
    let spare: ClaimableSpare | null = null;
    if (prewarmEnabled() && clientTools.length > 0 && mode !== "session") {
      const transcriptExtra: Record<string, unknown> = { hooks: DENY_ALL_TOOLS };
      if (extraOptions.systemPrompt) transcriptExtra.systemPrompt = extraOptions.systemPrompt;
      const spareParams: SdkOptionParams = { ...optionParams, extraOptions: transcriptExtra };
      const key = spareKey(spareParams, toolsSig);
      if (mode === "transcript" && allowSpare) spare = await takeSpare(key);
      ensureSpare(key, () => ({ ...spareParams, mcpServers: planTools(clientTools).mcpServers }));
    }
    usedSpare = spare !== null;

    const { generator } = trackedQuery({
      ...optionParams,
      completionId: p.messageId,
      prompt: input(),
      promptPreview: `[${mode}${spare || warm ? ", warm" : ""}] ${previewOf(body.messages)}`,
      requestedModel: p.requestedModel,
      isStreaming: p.stream,
      apiKeyId: req.apiKeyId ?? null,
      apiKeyName: req.apiKeyName ?? null,
      spare: spare ?? undefined,
      warm: warm ?? undefined,
    });

    // Watchdog: a CLI that goes silent (hung resume, an upstream that never answers, a
    // misconfiguration looping back into this proxy) must not hold a concurrency slot
    // forever. No SDK message for REQUEST_IDLE_TIMEOUT_MS -> interrupt and fail.
    let lastActivity = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivity < REQUEST_IDLE_TIMEOUT_MS) return;
      clearInterval(watchdog);
      console.warn(`[native] ${p.messageId}: no activity for ${Math.round(REQUEST_IDLE_TIMEOUT_MS / 1000)}s, aborting`);
      cancelTask(p.messageId);
      fail(new Error(`The upstream session went silent for ${Math.round(REQUEST_IDLE_TIMEOUT_MS / 1000)}s; request aborted`));
      releaseDenies();
    }, 5_000);
    watchdog.unref();
    try {
      await consume();
    } finally {
      clearInterval(watchdog);
      releaseDenies();
    }

    async function consume(): Promise<void> {
    for await (const m of generator) {
      lastActivity = Date.now();
      if (clientGone) break;
      const sid = (m as { session_id?: string }).session_id;
      if (sid && (m.type === "system" || m.type === "result")) runSessionId = sid;
      if (m.type === "assistant" && !m.parent_tool_use_id) lastAssistantUuid = (m as { uuid?: string }).uuid ?? lastAssistantUuid;
      if (finished) continue; // drain the rest so the request log completes
      if (m.type === "system" && (m as { subtype?: string }).subtype === "init") {
        const v = (m as { claude_code_version?: string }).claude_code_version;
        if (v && v !== CLI_VERSION) CLI_VERSION = v;
        const loaded = new Set((m as { tools?: string[] }).tools ?? []);
        // The CLI reports some tools under their internal names: the Agent tool is
        // "Task" in the init list (upstream it is still "Agent").
        for (const [a, b] of TOOL_ALIASES) {
          if (loaded.has(a)) loaded.add(b);
          if (loaded.has(b)) loaded.add(a);
        }
        for (const b of plan.builtins) {
          if (!loaded.has(b) && !notBuiltin.has(b)) {
            notBuiltin.add(b);
            saveNotBuiltin();
            console.warn(`[native] CLI does not load built-in '${b}' here; it is left out from now on`);
          }
        }
        continue;
      }
      if (m.type !== "stream_event" || m.parent_tool_use_id) continue;

      const ev = { ...(m.event as Block) };
      if (ev.type === "message_start") {
        ev.message = { ...(ev.message as Block), id: p.messageId, model: p.resolvedModel };
      } else if (ev.type === "content_block_start" && (ev.content_block as Block)?.type === "tool_use") {
        const cb = { ...(ev.content_block as Block) };
        cb.name = plan.toClient.get(cb.name as string) ?? cb.name;
        ev.content_block = cb;
      }
      accumulate(acc, ev);

      if (p.stream) {
        if (!started) {
          if (ev.type !== "message_start") continue;
          res.setHeader("Content-Type", "text/event-stream");
          res.setHeader("Cache-Control", "no-cache");
          res.setHeader("Connection", "keep-alive");
          res.flushHeaders();
          started = true;
        }
        sse(res, ev);
      }

      if (ev.type === "message_stop") {
        finished = true;
        releaseDenies(); // every tool call is in the transcript now
        if (p.stream) {
          responded = true;
          res.end();
        } else {
          finishNonStream();
        }
      }
    }
    }
  }

  const fail = (err: unknown) => {
    if (audit) audit.result.error = String((err as Error)?.message ?? err).slice(0, 400);
    if (clientGone || responded) return;
    console.error("[native] upstream error:", (err as Error)?.message);
    responded = true;
    if (started) {
      sse(res, errorPayload(err));
      res.end();
    } else if (!res.headersSent) {
      const c = classifyUpstreamError(err);
      if (c.retryAfterSeconds !== undefined) res.setHeader("Retry-After", String(c.retryAfterSeconds));
      res.status(c.status).json(errorPayload(err));
    }
  };

  const firstMode = session ? "session" : native ? "native" : "transcript";
  if (audit) {
    audit.handling = {
      client: clientIsOfficial ? "claude-code" : "third-party",
      mode: firstMode,
      session: session ? { kind: session.kind, fork: session.fork, key: convKey?.slice(0, 8) } : null,
      cwd: runCwd === p.sdkCwd ? "server sdk-cwd" : "mirrored client cwd",
    };
    audit.upstream = {
      systemPrompt: SYSTEM_PROMPT_MODE !== "official" ? "client (legacy mode)"
        : clientIsOfficial ? "client Claude Code prompt as is" : "official claude_code preset",
      clientPromptAsReminder: !clientIsOfficial && !!clientSystem && SYSTEM_PROMPT_MODE === "official" && CLIENT_SYSTEM === "reminder",
      builtinTools: plan.builtins,
      mcpTools: [...plan.toClient.keys()].slice(0, 400),
      model: p.resolvedModel,
    };
  }
  try {
    await runAndRecord();
  } finally {
    endTurn?.();
    if (audit) {
      const u = acc.usage as Record<string, number | undefined>;
      const text = acc.blocks.filter((b) => b?.type === "text").map((b) => String(b.text ?? "")).join("");
      audit.result = {
        ...audit.result,
        ok: finished,
        ms: Date.now() - t0,
        stopReason: acc.stopReason,
        toolCalls: acc.blocks.filter((b) => b?.type === "tool_use").map((b) => b.name),
        usage: {
          input: u.input_tokens, output: u.output_tokens,
          cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens,
        },
        warmSpare: usedSpare || undefined,
        warmSession: usedWarm || undefined,
        fallback: usedFallback || undefined,
        limited: limitedError || undefined,
        textStart: snippet(text, 120),
        apiErrorText: /^API Error:/.test(text) ? snippet(text, 300) : undefined,
      };
      auditFinish(audit);
    }
  }

  async function runAndRecord(): Promise<void> {
  try {
    try {
      await run(firstMode);
    } catch (err) {
      // An early-started process that failed before any output (expired token copy, a
      // stale prediction): the same plan, started cold. The session is still intact.
      if (!finished && usedWarm && !started && acc.blocks.length === 0 && !clientGone) {
        console.warn("[warm] early-started request failed before output, retrying cold:", (err as Error)?.message);
        usedWarm = false;
        await run(firstMode, true, false);
      } else {
        throw err;
      }
    }
  } catch (err) {
    // After message_stop the SDK typically throws error_max_turns (it tried to go past the
    // intercepted tool call). That is the normal path, not a failure.
    if (!finished) {
      const nothingSent = !started && acc.blocks.length === 0;
      // Usage/rate limits fail the same way in any mode: report them, don't retry.
      const limited = /hit your .{0,20}limit|usage limit|rate[ _]limit|overloaded/i.test(String((err as Error)?.message ?? ""));
      limitedError = limited;
      if (session && convKey && !limited) {
        // The kept session is not trustworthy any more: forget it, rebuild next time.
        forget(convKey);
        dropTranscript(session.seededId);
      }
      if ((firstMode !== "transcript" || usedSpare) && nothingSent && !clientGone && !limited) {
        // Session / native mode failed, or a prewarmed spare refused the claim: retry cold
        // in transcript mode (same request, nothing has reached the client yet).
        console.warn(`[native] ${usedSpare ? "prewarmed spare" : `${firstMode} mode`} failed before any output, retrying cold in transcript mode:`, (err as Error)?.message);
        usedFallback = true;
        try {
          await run("transcript", false);
        } catch (err2) {
          if (!finished) fail(err2);
        }
      } else {
        fail(err);
      }
    }
  }

  if (!finished && !clientGone && !responded) fail(new Error("Upstream ended without a complete message"));

  // Continuity bookkeeping: the session now holds this request's messages plus the reply.
  if (session && convKey && firstMode === "session") {
    if (finished && runSessionId && !usedFallback) {
      const toolIds = acc.blocks.filter((b) => b?.type === "tool_use").map((b) => b.id as string);
      // Earlier turns that this request builds on stay valid rewind points.
      const prev = getConversation(convKey);
      const kept = session.basisN !== undefined ? (prev?.checkpoints ?? []).filter((c) => c.n <= session.basisN!) : [];
      const checkpoints = lastAssistantUuid
        ? [...kept, { n: msgHashes.length, uuid: lastAssistantUuid, pending: toolIds.length ? toolIds : undefined }].slice(-60)
        : kept;
      // saveConversation also frees the session this one forked from.
      saveConversation(convKey, {
        sdkSessionId: runSessionId,
        msgHashes,
        checkpointUuid: toolIds.length ? lastAssistantUuid : undefined,
        pendingToolIds: toolIds.length ? toolIds : undefined,
        checkpoints,
      });
      if (session.seededId && session.seededId !== runSessionId) dropTranscript(session.seededId);
      if (session.kind === "fresh") removeLocalTranscript(runSessionId);
      // Start the next request now: resume this session (at the tool-call entry, forking,
      // when the client is about to send tool results), with the same options.
      if (warmSessionsEnabled() && lastSessionParams) {
        const x = (lastSessionParams.extraOptions ?? {}) as Record<string, unknown>;
        const nextExtra: Record<string, unknown> = {
          persistSession: true,
          sessionStore: memorySessionStore,
          resume: runSessionId,
          ...(toolIds.length && lastAssistantUuid ? { resumeSessionAt: lastAssistantUuid, forkSession: true } : {}),
          ...(x.systemPrompt ? { systemPrompt: x.systemPrompt } : {}),
        };
        warmNext(
          convKey,
          { ...lastSessionParams, mcpServers: planTools(clientTools).mcpServers, extraOptions: nextExtra },
          toolsSig,
          (gate) => holdingDenyHooks(gate),
        );
      }
      if (DEBUG_CONTINUITY) {
        console.log(`[session] ${session.kind}${session.fork ? "+fork" : ""} ${convKey.slice(0, 8)} -> ${runSessionId.slice(0, 8)} tools=${toolIds.length}`);
      }
    } else {
      if (!limitedError) forget(convKey);
      dropTranscript(session.seededId);
      dropWarm(convKey);
    }
  }
  }
}

// ---------------- session continuity planning ----------------

const DEBUG_CONTINUITY = process.env.DEBUG_SESSION_CONTINUITY === "true";
const REQUEST_IDLE_TIMEOUT_MS = Math.max(30_000, parseInt(process.env.REQUEST_IDLE_TIMEOUT_MS || "300000", 10));

interface SessionPlan {
  kind: "fresh" | "continue" | "rewind" | "rebuild";
  /** continue/rewind: how many client messages of the kept session this request builds on. */
  basisN?: number;
  /** fresh: the id to create; continue/rebuild: the session to resume. */
  sessionId: string;
  resumeAt?: string;
  fork: boolean;
  content: Block[];
  /** rebuild: synthetic transcript to drop once the fork exists. */
  seededId?: string;
}

/**
 * continue: the request extends the kept session exactly (same message prefix, then our
 * reply, then one new user turn that answers precisely the pending tool calls, if any).
 * Otherwise rebuild the session from the client's history (one full cache write), or
 * start fresh when there is no history yet.
 */
function planSession(
  key: string,
  messages: Msg[],
  hashes: string[],
  toUpstream: Map<string, string>,
  cwd: string,
  model: string,
  lead: Block[],
  nopts: NormalizeOpts,
): SessionPlan | null {
  const st = getConversation(key);
  if (st) {
    const n = st.msgHashes.length;
    const prefixOk = messages.length > n + 1 && st.msgHashes.every((h, i) => h === hashes[i]);
    if (prefixOk && messages[n].role === "assistant") {
      const delta = normalize(messages.slice(n + 1), toUpstream, nopts);
      if (delta && delta.length === 1) {
        const results = delta[0].content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id as string);
        const pending = st.pendingToolIds ?? [];
        const answersExactly = pending.length
          ? pending.length === results.length && pending.every((id) => results.includes(id)) && !!st.checkpointUuid
          : results.length === 0;
        if (answersExactly) {
          return {
            kind: "continue",
            basisN: n,
            sessionId: st.sdkSessionId,
            resumeAt: pending.length ? st.checkpointUuid : undefined,
            fork: pending.length > 0,
            content: delta[0].content,
          };
        }
      }
    }
    // Rewind / edit: the history matches the kept session up to an earlier turn, then goes
    // another way. Fork the session at that turn's reply instead of rebuilding it all.
    for (const c of [...(st.checkpoints ?? [])].reverse()) {
      if (c.n >= n || c.n + 1 >= messages.length) continue;
      if (messages[c.n].role !== "assistant") continue;
      let same = true;
      for (let i = 0; i < c.n; i++) if (st.msgHashes[i] !== hashes[i]) { same = false; break; }
      if (!same) continue;
      const delta = normalize(messages.slice(c.n + 1), toUpstream, nopts);
      if (!delta || delta.length !== 1) continue;
      const results = delta[0].content.filter((b) => b.type === "tool_result").map((b) => b.tool_use_id as string);
      const pending = c.pending ?? [];
      const ok = pending.length
        ? pending.length === results.length && pending.every((id) => results.includes(id))
        : results.length === 0;
      if (!ok) continue;
      if (DEBUG_CONTINUITY) console.log(`[session] ${key.slice(0, 8)}: rewind to turn after ${c.n} message(s)`);
      return { kind: "rewind", basisN: c.n, sessionId: st.sdkSessionId, resumeAt: c.uuid, fork: true, content: delta[0].content };
    }
    if (DEBUG_CONTINUITY) console.log(`[session] ${key.slice(0, 8)}: history does not extend the kept session, rebuilding`);
  }
  const all = normalize(messages, toUpstream, nopts);
  if (!all) return null;
  const history = all.slice(0, -1);
  const content = all[all.length - 1].content;
  if (history.length === 0) return { kind: "fresh", sessionId: randomUUID(), fork: false, content: [...lead, ...content] };
  if (lead.length) history[0] = { ...history[0], content: [...lead, ...history[0].content] };
  const seed = randomUUID();
  const entries = buildEntries(history, seed, cwd, model);
  seedTranscript(seed, entries as Array<{ type: string; [k: string]: unknown }>);
  return {
    kind: "rebuild",
    sessionId: seed,
    resumeAt: entries[entries.length - 1].uuid as string,
    fork: true,
    content,
    seededId: seed,
  };
}
