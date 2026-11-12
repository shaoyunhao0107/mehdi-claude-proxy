#!/usr/bin/env node
/**
 * Compares, item by item, the request the Claude Code CLI sends when driven
 * through this proxy with the one it sends when driven directly by the Agent
 * SDK. Both runs use the CLI's own login and are pointed at a recorder on this
 * machine, so nothing reaches Anthropic. The recorder answers with a canned
 * stream; credentials are never written out.
 *
 *   npm run build && node scripts/compare-upstream.mjs [--model claude-haiku-4-5] [--endpoint chat|messages] [--keep <dir>]
 *
 * The direct run is given the settings this proxy passes on purpose (see
 * MATCHED below). Everything else is the CLI's default. Exit code 1 when an
 * item differs that is not expected to.
 *
 * What this cannot show: a custom base URL makes the CLI treat the endpoint as
 * not first-party, for both runs alike, so it compares like with like but is
 * not a capture of traffic to api.anthropic.com.
 */
import { createServer } from "node:http"
import { spawn } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, realpathSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const args = process.argv.slice(2)
const option = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback)
const model = option("--model", "claude-haiku-4-5")
const endpoint = option("--endpoint", "chat")
const keep = option("--keep", undefined)
const PROMPT = "Reply with exactly the word: pong"

/** Headers that differ between any two requests of the same client. */
const VOLATILE_HEADERS = new Set(["content-length", "x-claude-code-session-id", "x-client-request-id", "authorization", "host"])

function startRecorder() {
  const requests = []
  const sse = (res, event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  const server = createServer((req, res) => {
    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    req.on("end", () => {
      let body = null
      try { body = JSON.parse(Buffer.concat(chunks).toString()) } catch { /* not JSON */ }
      const headers = { ...req.headers }
      for (const secret of ["authorization", "x-api-key", "cookie"]) if (headers[secret]) headers[secret] = "<redacted>"
      requests.push({ method: req.method, path: req.url, headers, body })
      if (!req.url.startsWith("/v1/messages") || !body?.stream) {
        res.writeHead(200, { "content-type": "application/json" })
        res.end("{}")
        return
      }
      res.writeHead(200, { "content-type": "text/event-stream" })
      sse(res, "message_start", { type: "message_start", message: { id: "msg_recorded", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })
      sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } })
      sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "pong" } })
      sse(res, "content_block_stop", { type: "content_block_stop", index: 0 })
      sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } })
      sse(res, "message_stop", { type: "message_stop" })
      res.end()
    })
  })
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ server, requests, url: `http://127.0.0.1:${server.address().port}` })))
}

/** The conversation request: the CLI's side calls (a session title) ask for structured output. */
const firstMessages = (requests) => requests.find((request) =>
  request.path.startsWith("/v1/messages") && request.body?.messages && !request.body.output_config?.format)
/** Every request of a run, as "METHOD path [kind]", for comparing what else the CLI sent. */
const requestKinds = (requests) => requests.filter((request) => !isReachabilityCheck(request)).map((request) =>
  `${request.method} ${request.path.split("?")[0]}${request.body?.output_config?.format ? " [structured side call]" : ""}`).sort().join(" | ")
/**
 * The CLI checks that it can reach the API when it starts; how many starts a
 * run takes is not part of the request.
 */
const isReachabilityCheck = (request) => request.method === "HEAD" && request.path.startsWith("/api/hello")

function cleanEnv(extra) {
  const env = { ...process.env, ...extra }
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]) delete env[name]
  for (const name of Object.keys(env)) if (name.startsWith("MERIDIAN_") || name.startsWith("CLAUDE_PROXY_")) delete env[name]
  return { ...env, ...extra }
}

/**
 * Settings this proxy passes on purpose, given to the direct run as well:
 * no auto-memory or organisation memory (their instructions would have the
 * model write files on this server), no claude.ai connectors (tools a client
 * cannot run), no session title (a side request per session), no automatic
 * compaction (the client owns its history).
 */
const MATCHED = {
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_ORG_MEMORY: "1",
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  CLAUDE_CODE_DISABLE_TERMINAL_TITLE: "1",
  DISABLE_AUTO_COMPACT: "1",
}

async function directRun(recorderUrl, cwd) {
  const { query } = await import(join(root, "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs"))
  Object.assign(process.env, { ANTHROPIC_BASE_URL: recorderUrl, ...MATCHED })
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete process.env[name]
  try {
    for await (const message of query({
      prompt: PROMPT,
      options: {
        model,
        cwd,
        tools: [],
        settingSources: [],
        maxTurns: 1,
        systemPrompt: { type: "preset", preset: "claude_code", excludeDynamicSections: true },
      },
    })) {
      if (message.type === "result") break
    }
    await new Promise((r) => setTimeout(r, 2500))
  } finally {
    delete process.env.ANTHROPIC_BASE_URL
  }
}

async function proxyRun(recorderUrl, cwd, dataDir) {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const env = { ...process.env, ANTHROPIC_BASE_URL: recorderUrl, PORT: String(port), ENABLE_OPENAI_LAYER: "1",
    DATABASE_PATH: join(dataDir, "proxy.db"), SESSION_DIR: join(dataDir, "sessions"), AUDIT_DIR: join(dataDir, "audit"),
    SDK_CWD: cwd, MODEL_DISCOVERY: "false", SDK_VERSION_CHECK: "false", PREWARM: "false", WARM_SESSIONS: "false", MIRROR_CLIENT_CWD: "false" }
  for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", ...Object.keys(MATCHED)]) delete env[name]
  const proxy = spawn(process.execPath, [join(root, "dist/server.js")], { cwd: root, env, stdio: "ignore" })
  try {
    const base = `http://127.0.0.1:${port}`
    for (let attempt = 0; ; attempt++) {
      try { if ((await fetch(`${base}/health`)).ok) break } catch { /* not up yet */ }
      if (attempt > 120) throw new Error("the proxy did not start; run `npm run build` first")
      await new Promise((r) => setTimeout(r, 250))
    }
    const request = endpoint === "messages"
      ? { path: "/v1/messages", body: { model, max_tokens: 32000, messages: [{ role: "user", content: PROMPT }] } }
      : { path: "/v1/chat/completions", body: { model, messages: [{ role: "user", content: PROMPT }] } }
    const response = await fetch(`${base}${request.path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify(request.body),
    })
    if (!response.ok) throw new Error(`proxy answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
    await response.text()
    await new Promise((r) => setTimeout(r, 2500))
  } finally {
    proxy.kill()
  }
}

function blocksOf(messages) {
  const out = []
  for (const message of messages) {
    const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content
    for (const block of content) out.push({ role: message.role, type: block.type, text: block.text ?? JSON.stringify(block), cache: JSON.stringify(block.cache_control ?? null) })
  }
  return out
}

function compare(direct, proxied) {
  const rows = []
  const add = (item, a, b, volatile = false) => rows.push({ item, same: a === b, volatile, direct: a, proxy: b })
  const text = (value) => (value === undefined ? "<absent>" : typeof value === "string" ? value : JSON.stringify(value))
  for (const name of [...new Set([...Object.keys(direct.headers), ...Object.keys(proxied.headers)])].sort()) {
    add(`header ${name}`, text(direct.headers[name]), text(proxied.headers[name]), VOLATILE_HEADERS.has(name))
  }
  add("path", direct.path, proxied.path)
  for (const key of [...new Set([...Object.keys(direct.body), ...Object.keys(proxied.body)])].sort()) {
    if (["messages", "system", "tools", "metadata"].includes(key)) continue
    add(`body.${key}`, text(direct.body[key]), text(proxied.body[key]))
  }
  const metadataKeys = (body) => { try { return Object.keys(JSON.parse(body.metadata?.user_id ?? "{}")).sort().join(",") } catch { return "<not json>" } }
  add("body.metadata.user_id fields", metadataKeys(direct.body), metadataKeys(proxied.body))
  const system = (body) => (body.system ?? []).map((block) => ({ text: String(block.text ?? "").replace(/cch=[0-9a-f]+/, "cch=<hash>"), cache: JSON.stringify(block.cache_control ?? null) }))
  const [ds, ps] = [system(direct.body), system(proxied.body)]
  for (let i = 0; i < Math.max(ds.length, ps.length); i++) {
    add(`system[${i}] text`, ds[i]?.text ?? "<absent>", ps[i]?.text ?? "<absent>")
    add(`system[${i}] cache_control`, ds[i]?.cache ?? "<absent>", ps[i]?.cache ?? "<absent>")
  }
  add("tools", JSON.stringify(direct.body.tools ?? []), JSON.stringify(proxied.body.tools ?? []))
  const [dm, pm] = [blocksOf(direct.body.messages), blocksOf(proxied.body.messages)]
  add("messages: roles and block types", dm.map((b) => `${b.role}/${b.type}`).join(" "), pm.map((b) => `${b.role}/${b.type}`).join(" "))
  for (let i = 0; i < Math.max(dm.length, pm.length); i++) {
    add(`message block ${i} text`, dm[i]?.text ?? "<absent>", pm[i]?.text ?? "<absent>")
    add(`message block ${i} cache_control`, dm[i]?.cache ?? "<absent>", pm[i]?.cache ?? "<absent>")
  }
  return rows
}

const work = keep ? resolve(keep) : mkdtempSync(join(tmpdir(), "compare-upstream-"))
mkdirSync(work, { recursive: true })
// One working directory for both runs: the CLI names it in the request.
const cwd = realpathSync(mkdtempSync(join(work, "cwd-")))
let failed = false
try {
  const direct = await startRecorder()
  await directRun(direct.url, cwd)
  direct.server.close()
  const proxied = await startRecorder()
  await proxyRun(proxied.url, cwd, join(work, "data"))
  proxied.server.close()
  const [a, b] = [firstMessages(direct.requests), firstMessages(proxied.requests)]
  if (!a || !b) throw new Error(`no /v1/messages request recorded (direct: ${!!a}, proxy: ${!!b})`)
  const rows = compare(a, b)
  rows.unshift({ item: "requests made", same: requestKinds(direct.requests) === requestKinds(proxied.requests), volatile: false, direct: requestKinds(direct.requests), proxy: requestKinds(proxied.requests) })
  writeFileSync(join(work, "compare.json"), JSON.stringify({ model, direct: a, proxy: b, rows, allDirect: direct.requests, allProxy: proxied.requests }, null, 1))
  const different = rows.filter((row) => !row.same && !row.volatile)
  console.log(`reachability checks (HEAD /api/hello): direct ${direct.requests.filter(isReachabilityCheck).length}, proxy ${proxied.requests.filter(isReachabilityCheck).length}`)
  console.log(`auth: direct ${a.headers.authorization ? "login (bearer)" : "api key"}, proxy ${b.headers.authorization ? "login (bearer)" : "api key"}`)
  console.log(`items compared: ${rows.length}   identical: ${rows.filter((row) => row.same).length}   differ by nature: ${rows.filter((row) => !row.same && row.volatile).length}   different: ${different.length}`)
  for (const row of different) {
    console.log(`\nDIFFERENT  ${row.item}`)
    console.log(`  direct: ${row.direct.slice(0, 300)}`)
    console.log(`  proxy:  ${row.proxy.slice(0, 300)}`)
  }
  failed = different.length > 0
  if (keep) console.log(`\nrecords: ${join(work, "compare.json")}`)
} finally {
  if (!keep) rmSync(work, { recursive: true, force: true })
}
process.exit(failed ? 1 : 0)
