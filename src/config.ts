import { mkdirSync } from "fs";
import { dirname } from "path";

export const PORT = parseInt(process.env.PORT || "3457");

// Local patch: the CLI subprocesses inherit ANTHROPIC_BASE_URL. Pointing it at this proxy
// itself (easy to do when a client's env leaks into the service's) makes every request
// call back into the proxy, which fills the concurrency slots and hangs everything.
{
  const base = process.env.ANTHROPIC_BASE_URL;
  if (base) {
    try {
      const u = new URL(base);
      const local = ["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"].includes(u.hostname);
      if (local && parseInt(u.port || (u.protocol === "https:" ? "443" : "80"), 10) === PORT) {
        console.warn(`[config] ANTHROPIC_BASE_URL=${base} points at this proxy itself; ignoring it`);
        delete process.env.ANTHROPIC_BASE_URL;
      }
    } catch {
      /* not a URL: leave it to the CLI */
    }
  }
}
export const DATABASE_PATH = process.env.DATABASE_PATH || "./data/proxy.db";
export const ADMIN_API_SECRET = process.env.ADMIN_API_SECRET || "";
export const AUTH_DISABLED = process.env.AUTH_DISABLED === "true";
export const OLLAMA_URL = process.env.OLLAMA_URL || "http://ollama:11434";

// Ensure the database directory exists
mkdirSync(dirname(DATABASE_PATH), { recursive: true });
