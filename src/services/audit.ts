// Local patch: per-request audit log (what the client sent, what the proxy did with it,
// what went upstream, what it cost). One JSON line per request in AUDIT_DIR/<date>.jsonl.
// Never records keys or auth headers. AUDIT_BODIES=true additionally saves each client
// request body to AUDIT_DIR/bodies/<id>.json (auth headers are never in it), for debugging
// only; or touch AUDIT_DIR/bodies.on to switch that on without a restart.
import { appendFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import type { Request } from "express";

const ENABLED = process.env.AUDIT_LOG !== "false";
const DIR = resolve(process.env.AUDIT_DIR || "./data/audit");
// AUDIT_BODIES=true, or a file named "bodies.on" in AUDIT_DIR (switch without a restart).
const bodiesOn = () => process.env.AUDIT_BODIES === "true" || existsSync(join(DIR, "bodies.on"));
const KEEP_DAYS = parseFloat(process.env.AUDIT_KEEP_DAYS || "14");

// Header names worth recording (values shortened); everything auth-like is skipped.
const KEEP_HEADERS = /^(user-agent|x-app|anthropic-version|anthropic-beta|x-stainless-[a-z-]+|x-claude-code-[a-z-]+|x-[a-z-]*(client|session|request)[a-z-]*)$/i;
const SECRET_HEADER = /authorization|api-key|cookie|token|secret/i;

export interface AuditRecord {
  id: string;
  t: string;
  client: Record<string, unknown>;
  request: Record<string, unknown>;
  handling: Record<string, unknown>;
  upstream: Record<string, unknown>;
  result: Record<string, unknown>;
}

export function auditStart(req: Request, id: string, body: Record<string, unknown>): AuditRecord | null {
  if (!ENABLED) return null;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (SECRET_HEADER.test(k) || !KEEP_HEADERS.test(k)) continue;
    headers[k] = String(Array.isArray(v) ? v.join(",") : v).slice(0, 200);
  }
  if (bodiesOn()) {
    try {
      mkdirSync(join(DIR, "bodies"), { recursive: true });
      writeFileSync(join(DIR, "bodies", `${id}.json`), JSON.stringify({ headers, body }, null, 1));
    } catch {
      /* best effort */
    }
  }
  return {
    id,
    t: new Date().toISOString(),
    client: { ip: req.ip, apiKey: (req as { apiKeyName?: string }).apiKeyName ?? null, headers },
    request: {},
    handling: {},
    upstream: {},
    result: {},
  };
}

export function auditFinish(rec: AuditRecord | null): void {
  if (!rec) return;
  try {
    mkdirSync(DIR, { recursive: true });
    appendFileSync(join(DIR, `${rec.t.slice(0, 10)}.jsonl`), JSON.stringify(rec) + "\n");
  } catch {
    /* best effort */
  }
}

/** First characters of a text, for the log. */
export function snippet(text: string | undefined, n = 160): string | undefined {
  if (!text) return undefined;
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

// Delete audit files (and saved bodies) older than AUDIT_KEEP_DAYS.
function sweep(): void {
  const cutoff = Date.now() - KEEP_DAYS * 86400_000;
  for (const dir of [DIR, join(DIR, "bodies")]) {
    try {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        try {
          const st = statSync(p);
          if (st.isFile() && st.mtimeMs < cutoff) rmSync(p, { force: true });
        } catch {
          /* ignore */
        }
      }
    } catch {
      /* dir missing */
    }
  }
}
if (ENABLED) {
  setTimeout(sweep, 60_000).unref();
  setInterval(sweep, 6 * 3600_000).unref();
}
