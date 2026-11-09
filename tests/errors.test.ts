import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyUpstreamError } from "../src/services/errorClassifier.js";

const cls = (msg: string) => classifyUpstreamError(new Error(msg));

test("a model the plan lacks is a 402, not a retryable error", () => {
  const c = cls(
    "Claude Code returned an error result: Fable 5.1 requires usage credits. Switch to another model, or manage usage credits at https://claude.ai/settings/usage?from=cc_cli_limit_message, to continue.",
  );
  assert.equal(c.status, 402);
  assert.equal(c.type, "billing_error");
});

test("usage limits are a 429 with a retry time", () => {
  const c = cls("You have hit your usage limit, resets 3pm");
  assert.equal(c.status, 429);
  assert.ok((c.retryAfterSeconds ?? 0) > 0);
});

test("auth and unknown errors", () => {
  assert.equal(cls("OAuth token has expired. Please run /login").status, 401);
  assert.equal(cls("something new and strange").status, 500);
});
