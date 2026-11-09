// Loaded before every test file (see the "test" script): all state goes to a temp folder,
// nothing reaches the real database, sessions, audit log, ~/.claude or the network.
import { mkdtempSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const root = mkdtempSync(join(tmpdir(), "proxy-test-"));
const env: Record<string, string> = {
  DATABASE_PATH: join(root, "proxy.db"),
  SESSION_DIR: join(root, "sessions"),
  AUDIT_DIR: join(root, "audit"),
  CLAUDE_CONFIG_DIR: join(root, "claude-config"),
  MODELS_CACHE_PATH: join(root, "models.json"),
  SDK_VERSION_CHECK: "false",
  MODEL_DISCOVERY: "false",
  WARM_SESSIONS: "false",
  PREWARM: "false",
  SESSION_PERSIST: "true",
};
for (const [k, v] of Object.entries(env)) process.env[k] = v;
mkdirSync(join(root, "claude-config", "projects"), { recursive: true });
(globalThis as { __TEST_ROOT__?: string }).__TEST_ROOT__ = root;
