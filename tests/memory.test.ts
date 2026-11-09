import { test } from "node:test";
import assert from "node:assert/strict";

test("early starts are skipped below the free-memory minimum", async () => {
  process.env.MIN_FREE_MEMORY_MB = "99999999"; // read when the module loads
  const m = await import("../src/services/memoryGuard.js");
  assert.equal(m.tooLowForEarlyStart("test"), true);
  assert.equal(m.memoryStatus().earlyStartsSkipped, 1);
  assert.ok(m.memoryStatus().freeMb > 0);
});
