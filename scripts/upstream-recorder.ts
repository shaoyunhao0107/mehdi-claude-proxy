// Records what the CLI sends upstream, for comparing proxied requests with a direct
// official CLI session. Run with Bun (the same runtime and version the official CLI is
// built with), so the TLS handshake towards Anthropic stays the CLI's own: verified that
// Bun 1.4.4 fetch and the CLI produce the identical ClientHello (JA3
// 1523504b38f0fae0d881d4b6554aac1b, ALPN http/1.1), while Node's https differs.
//
//   ~/.bun/bin/bun.exe scripts/upstream-recorder.ts <out_dir> [port=3461]
//   then point a TEST proxy instance (or a CLI) at it: ANTHROPIC_BASE_URL=http://127.0.0.1:3461
//
// Each request is saved as <out_dir>/upN.json with authorization / x-api-key / cookie
// redacted; the request goes on to https://api.anthropic.com unchanged and the response
// streams back. For short comparisons only: never leave production pointed at it.
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";

const out = process.argv[2];
const port = parseInt(process.argv[3] || "3461", 10);
if (!out) {
  console.error("usage: bun scripts/upstream-recorder.ts <out_dir> [port]");
  process.exit(1);
}
mkdirSync(out, { recursive: true });
let n = 0;
const SECRET = new Set(["authorization", "x-api-key", "cookie"]);

Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 255,
  async fetch(req) {
    const url = new URL(req.url);
    const body = new Uint8Array(await req.arrayBuffer());
    const logged: Record<string, string> = {};
    req.headers.forEach((v, k) => (logged[k] = SECRET.has(k) ? `<redacted len=${v.length}>` : v));
    let json: unknown = null;
    try {
      json = JSON.parse(new TextDecoder().decode(body));
    } catch {
      /* not JSON */
    }
    writeFileSync(join(out, `up${++n}.json`), JSON.stringify({ method: req.method, path: url.pathname + url.search, headers: logged, body: json }, null, 1));

    const headers = new Headers(req.headers);
    headers.delete("host");
    headers.delete("content-length");
    const upstream = await fetch(`https://api.anthropic.com${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
    });
    // fetch has already decoded the body, so the encoding headers no longer apply.
    const resHeaders = new Headers(upstream.headers);
    resHeaders.delete("content-encoding");
    resHeaders.delete("content-length");
    return new Response(upstream.body, { status: upstream.status, headers: resHeaders });
  },
});
console.log(`upstream recorder on http://127.0.0.1:${port} -> https://api.anthropic.com, saving to ${out}`);
