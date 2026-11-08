// Local patch: keep an eye on the bundled Agent SDK / CLI version.
// The proxy runs the CLI that ships inside @anthropic-ai/claude-agent-sdk (SDK 0.3.N ships
// CLI 2.1.N), not this server's own `claude`. Clients (Claude Desktop's bundled CLI,
// Claude Code) update themselves, and a client's system prompt is forwarded as is, so the
// SDK should follow them. Once a day this checks npm for the latest SDK; nothing is
// installed automatically (scripts/update-sdk.ps1 does that, with a regression test).
import { readFileSync } from "fs";
import { join } from "path";

export interface SdkVersionStatus {
  installedSdk: string;
  installedCli: string;
  latestSdk?: string;
  latestCli?: string;
  checkedAt?: string;
  updateAvailable?: boolean;
}

const status: SdkVersionStatus = { installedSdk: readInstalled(), installedCli: "" };
status.installedCli = status.installedSdk.replace(/^0\.3\./, "2.1.");

function readInstalled(): string {
  try {
    const p = join(process.cwd(), "node_modules", "@anthropic-ai", "claude-agent-sdk", "package.json");
    return (JSON.parse(readFileSync(p, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

function newer(a: string, b: string): boolean {
  const pa = a.split(".").map((x) => parseInt(x, 10));
  const pb = b.split(".").map((x) => parseInt(x, 10));
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}

async function check(): Promise<void> {
  try {
    const r = await fetch("https://registry.npmjs.org/@anthropic-ai/claude-agent-sdk/latest", {
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return;
    const v = ((await r.json()) as { version?: string }).version;
    if (!v) return;
    status.latestSdk = v;
    status.latestCli = v.replace(/^0\.3\./, "2.1.");
    status.checkedAt = new Date().toISOString();
    status.updateAvailable = newer(v, status.installedSdk);
    if (status.updateAvailable) {
      console.log(`[version] Agent SDK ${v} (CLI ${status.latestCli}) is available; installed ${status.installedSdk}. Run scripts/update-sdk.ps1`);
    }
  } catch {
    /* offline: try again tomorrow */
  }
}

/** A client newer than the bundled CLI is the case worth acting on. */
export function clientIsAhead(clientCli: string): boolean {
  return status.installedCli !== "" && newer(clientCli, status.installedCli);
}

export function sdkVersionStatus(): SdkVersionStatus {
  return status;
}

if (process.env.SDK_VERSION_CHECK !== "false") {
  setTimeout(() => void check(), 30_000).unref();
  setInterval(() => void check(), 24 * 3600_000).unref();
}
