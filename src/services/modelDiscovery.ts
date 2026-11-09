// Local patch: discover which Claude models this subscription can actually use.
//
// 1. supportedModels() from the official CLI (no API call): the latest model of each
//    family, e.g. opus -> claude-opus-5-5. New releases show up here automatically.
// 2. Probe a grid of version ids around each latest model (older minors, the previous
//    major, and a few "next" versions) with a tiny one-word request. Unknown ids fail
//    with "may not exist" before any tokens are billed; real ones cost ~600 tokens once.
// Results are cached in data/models.json; each id is re-probed after REPROBE_DAYS, ids
// that need paid credits on every refresh (a plan upgrade may include them), and all of
// them at once when the login's plan or organization changes (e.g. Pro -> Max).
// Probes run one at a time: every probe is a CLI process and parallel ones exhaust RAM.
import { query } from "@anthropic-ai/claude-agent-sdk";
import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, resolve } from "path";

type Status = "ok" | "missing" | "paid" | "error";
interface ProbeEntry {
  status: Status;
  at: string;
  detail?: string;
}
interface Cache {
  updatedAt: string | null;
  latest: Record<string, string>; // family -> latest model id (from supportedModels)
  account?: string; // plan + organization of the login the probes were made with
  probes: Record<string, ProbeEntry>;
}
export interface DiscoveredModel {
  id: string;
  name: string;
}

const CACHE_PATH = resolve(process.env.MODELS_CACHE_PATH || "./data/models.json");
const SDK_CWD = resolve(process.env.SDK_CWD || "./data/sdk-cwd");
const REFRESH_HOURS = parseFloat(process.env.MODEL_REFRESH_HOURS || "24");
const REPROBE_DAYS = parseFloat(process.env.MODEL_REPROBE_DAYS || "7");
const INCLUDE_PAID = process.env.INCLUDE_PAID_MODELS === "true";
const FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"];
const ID_RE = /^claude-([a-z]+)-(\d+)-(\d+)$/;

// Used until the first discovery finishes (and if it never can).
const FALLBACK: DiscoveredModel[] = [
  "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5",
  "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6",
  "claude-opus-4-5", "claude-sonnet-4-5", "claude-haiku-4-5", "claude-opus-4-1",
].map((id) => ({ id, name: displayName(id) }));

let cache: Cache = load();
let running: Promise<void> | null = null;

function load(): Cache {
  try {
    if (existsSync(CACHE_PATH)) return JSON.parse(readFileSync(CACHE_PATH, "utf8")) as Cache;
  } catch (e) {
    console.error("[models] cache unreadable, starting fresh:", (e as Error).message);
  }
  return { updatedAt: null, latest: {}, probes: {} };
}

function save(): void {
  mkdirSync(dirname(CACHE_PATH), { recursive: true });
  writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

export function displayName(id: string): string {
  const m = ID_RE.exec(id);
  if (!m) return id;
  return `Claude ${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
}

function sortKey(id: string): [number, number, number] {
  const m = ID_RE.exec(id);
  if (!m) return [99, 0, 0];
  const f = FAMILY_ORDER.indexOf(m[1]);
  return [f < 0 ? 50 : f, -parseInt(m[2], 10), -parseInt(m[3], 10)];
}

/** Models to advertise: discovered ones if any, else the static fallback. */
export function getModels(): DiscoveredModel[] {
  const ids = Object.entries(cache.probes)
    .filter(([, p]) => p.status === "ok" || (INCLUDE_PAID && p.status === "paid"))
    .map(([id]) => id);
  if (ids.length === 0) return FALLBACK;
  ids.sort((a, b) => {
    const ka = sortKey(a), kb = sortKey(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
  return ids.map((id) => ({ id, name: displayName(id) }));
}

export function getDiscoveryStatus() {
  return { cachePath: CACHE_PATH, running: running !== null, ...cache, advertised: getModels().map((m) => m.id) };
}

function quietEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    DISABLE_TELEMETRY: "1",
    ...extra,
  };
}

/** Latest model per family from the CLI's model picker (no inference call), and the login. */
async function fetchLatest(): Promise<{ latest: Record<string, string>; account: string }> {
  const ac = new AbortController();
  async function* idle(): AsyncGenerator<never> {
    await new Promise<void>((r) => ac.signal.addEventListener("abort", () => r()));
  }
  const q = query({
    prompt: idle(),
    options: { settingSources: [], persistSession: false, cwd: SDK_CWD, tools: [], env: quietEnv(), abortController: ac },
  });
  try {
    const list = await q.supportedModels();
    const info = await q.accountInfo().catch(() => ({}) as Record<string, string | undefined>);
    // Only a digest is kept: enough to notice another plan or account, nothing readable.
    const account = createHash("sha256")
      .update([info.subscriptionType, info.organization, info.email, info.apiProvider].join("|"))
      .digest("hex").slice(0, 16) + `:${info.subscriptionType ?? "?"}`;
    const latest: Record<string, string> = {};
    for (const m of list) {
      const id = (m.resolvedModel ?? m.value).replace(/\[.*\]$/, "");
      const fm = ID_RE.exec(id);
      if (fm && !latest[fm[1]]) latest[fm[1]] = id;
    }
    return { latest, account };
  } finally {
    ac.abort();
    try { q.close(); } catch { /* already closed */ }
  }
}

/** Version ids worth probing around one family's latest model. */
function candidates(family: string, latestId: string): string[] {
  const m = ID_RE.exec(latestId);
  if (!m) return [latestId];
  const major = parseInt(m[2], 10), minor = parseInt(m[3], 10);
  const out: string[] = [];
  for (let n = minor + 2; n >= 0; n--) out.push(`claude-${family}-${major}-${n}`); // incl. 2 "next" minors
  out.push(`claude-${family}-${major + 1}-0`);
  for (let n = 9; n >= 0; n--) out.push(`claude-${family}-${major - 1}-${n}`); // previous major
  return out;
}

async function probe(id: string): Promise<ProbeEntry> {
  const at = new Date().toISOString();
  let text = "";
  let ok = false;
  try {
    for await (const m of query({
      prompt: "hi",
      options: {
        model: id, maxTurns: 1, settingSources: [], persistSession: false, cwd: SDK_CWD, tools: [],
        systemPrompt: "Reply with one word.", thinking: { type: "disabled" },
        env: quietEnv({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: "16" }),
      },
    })) {
      if (m.type === "assistant") {
        for (const b of m.message.content as Array<{ type: string; text?: string }>) if (b.text) text += b.text;
      }
      if (m.type === "result" && m.subtype === "success" && !m.is_error) ok = true;
    }
  } catch (e) {
    text += " " + String((e as Error)?.message ?? e);
  }
  if (ok) return { status: "ok", at };
  const t = text.toLowerCase();
  if (t.includes("may not exist") || t.includes("not_found") || t.includes("not found")) return { status: "missing", at };
  if (t.includes("usage credits") || t.includes("requires") && t.includes("credit")) {
    return { status: "paid", at, detail: text.trim().slice(0, 160) };
  }
  return { status: "error", at, detail: text.trim().slice(0, 200) }; // transient: don't trust, retry next run
}

function due(id: string, full: boolean): boolean {
  const p = cache.probes[id];
  if (!p || full || p.status === "error" || p.status === "paid") return true;
  return Date.now() - Date.parse(p.at) > REPROBE_DAYS * 86400_000;
}

/** Refresh the model list. full=true re-probes every candidate. */
export function refreshModels(full = false): Promise<void> {
  if (running) return running;
  running = (async () => {
    const t0 = Date.now();
    try {
      const { latest, account } = await fetchLatest();
      if (Object.keys(latest).length === 0) throw new Error("supportedModels() returned no Claude ids");
      cache.latest = latest;
      if (cache.account && cache.account !== account) {
        console.log(`[models] login changed (${cache.account.split(":")[1]} -> ${account.split(":")[1]}), re-probing everything`);
        full = true;
      }
      cache.account = account;

      const ids = new Set<string>();
      for (const [family, id] of Object.entries(latest)) for (const c of candidates(family, id)) ids.add(c);
      for (const id of Object.keys(cache.probes)) ids.add(id); // keep re-checking known ids (retirements)

      let probed = 0;
      for (const id of ids) {
        if (!due(id, full)) continue;
        const prev = cache.probes[id];
        const r = await probe(id);
        // A transient failure must not hide a model that worked before.
        cache.probes[id] = r.status === "error" && prev?.status === "ok" ? { ...prev, detail: `last probe error: ${r.detail}` } : r;
        probed++;
        save();
      }
      cache.updatedAt = new Date().toISOString();
      save();
      console.log(`[models] refreshed in ${Math.round((Date.now() - t0) / 1000)}s, probed ${probed}: ${getModels().map((m) => m.id).join(", ")}`);
    } catch (e) {
      console.error("[models] refresh failed, keeping previous list:", (e as Error).message);
    } finally {
      running = null;
    }
  })();
  return running;
}

/** Refresh shortly after start, then every MODEL_REFRESH_HOURS. */
export function startModelDiscovery(): void {
  if (process.env.MODEL_DISCOVERY === "false") return;
  mkdirSync(SDK_CWD, { recursive: true });
  setTimeout(() => void refreshModels(false), 20_000).unref();
  setInterval(() => void refreshModels(false), REFRESH_HOURS * 3600_000).unref();
  // A new login (another plan or account) rewrites the CLI's credentials file: refresh
  // within the hour instead of waiting for the daily run. Only the file's time is read.
  const cred = resolve(process.env.CLAUDE_CONFIG_DIR || resolve(homedir(), ".claude"), ".credentials.json");
  const mtime = () => { try { return statSync(cred).mtimeMs; } catch { return 0; } };
  let seen = mtime();
  setInterval(() => {
    const now = mtime();
    if (now !== seen) {
      seen = now;
      void refreshModels(false);
    }
  }, 3600_000).unref();
}
