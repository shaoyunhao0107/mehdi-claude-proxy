# Local improvements (branch `local-improvements`)

Not pushed. Each item has a test in `tests/hardening.test.ts` or `tests/openai.test.ts`.

## Fixed

- **Requests were counted several times against the per-key rate limit.** The auth,
  budget and rate-limit chain was mounted once per router, and a request ran it again for
  every router it fell through. `/v1/messages` counted twice (three times in the OpenAI
  role), `/v1/embeddings` up to four times, so a key set to 30 requests per minute got 15
  on `/v1/messages`. Each pass also validated the key again, with a database write. The
  chain is now mounted once (`src/app.ts`).
- **`/v1/responses` was outside the concurrency cap** (`MAX_CONCURRENT_REQUESTS`), so Codex
  traffic could start any number of CLI processes at once.
- **The OpenAI adapters could write to a response they had already ended** after an error
  that arrived mid-stream.

## Safer

- **No API key configured: only this machine is served.** Before, a fresh install that was
  reachable from the network served the logged-in subscription to anyone until the first
  key was created. `AUTH_DISABLED=true` remains the explicit way to run open.
- **Client-run built-in tools: what stops a call the hook missed.** With the CLI's own
  `Bash`, `Read`, `Edit`… enabled, the PreToolUse hook hands every call to the client. If
  the hook did not act, the CLI's default permission mode refuses the call, because nobody
  can be asked (measured on CLI 2.1.322 for Bash, Write, Read and WebFetch with no hook
  installed). The native path leaves that mode in place, and a test now pins it.
  An earlier version of this branch added permission rules (`Edit(**)`, `Read(**)`…) as a
  second barrier. **That was wrong and is removed:** a rule on a file tool is applied
  before the hook, so the hook never saw the call and the client never received it.
- **Admin secret compared in constant time.**

## OpenAI layer

- With `stream_options.include_usage`, usage is sent as OpenAI sends it: a last chunk with
  empty `choices`. It used to ride on the finish chunk.
- `content` given as an array of text parts is read as text for system, assistant
  (alongside tool calls) and tool messages. System and tool arrays used to be passed on as
  raw JSON text, and assistant text next to tool calls was dropped.
- `reasoning_effort` (`low`…`max`) turns thinking on at that effort. `none`, `minimal` and
  no value leave it off, as before.

## Smaller

- `/health` keeps the Ollama probe's answer for 30 s; without Ollama every health check
  used to wait out the 3 s timeout.

## Second round: matching an ordinary request, one port, one instance

`scripts/compare-upstream.mjs` sends the same prompt once through the proxy and once
straight through the Agent SDK, both with the CLI's own login and both pointed at a
recorder on this machine (nothing reaches Anthropic), and compares the two requests item
by item: every header, every body field, each system block and message block with its
cache marker, the tool list. Result on CLI 2.1.322, for `/v1/chat/completions` and for
`/v1/messages`: 47 items, 45 identical, 2 that differ between any two requests
(`content-length`, the session id), 0 different. It was 12 different before these changes:

- **The CLI's feature flags are left on.** `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` and
  `DISABLE_TELEMETRY` made the CLI skip its remote flags, which changed the system prompt,
  shortened the `anthropic-beta` list and added a `<total_tokens>` reminder.
  `CLAUDE_CODE_DISABLE_TERMINAL_TITLE` now turns off the one side call those two also
  suppressed (the session title) and leaves the conversation request byte-identical.
  `QUIET_UPSTREAM=true` brings the old pair back.
- **A request that names no thinking gets the CLI's default.** Forcing thinking off
  changed four items (thinking, temperature, context_management, the beta list). The
  thinking blocks are not relayed to a client that did not ask for them.
  `DEFAULT_THINKING=off` restores the old behaviour and saves the thinking tokens.

The direct run is given the settings the proxy passes on purpose: no auto-memory or
organisation memory, no claude.ai connectors, no session title, no automatic compaction.
In one run of several the direct side came out without its feature flags (the CLI had
not loaded them yet) and showed the differences on its own.

Also:

- **Default port 3457** (was 3456, the default of Meridian and of most tools of this kind).
- **The OpenAI layer is on by default.** One instance serves `/v1/messages`,
  `/v1/chat/completions` and `/v1/responses` through the same core.
  `ENABLE_OPENAI_LAYER=false` restores the legacy `/v1/chat/completions`.
- **Plain chats of third-party clients keep their session.** Continuity was limited to
  requests with tools that stream, the shape of Claude Code's main loop; for any other
  client a tool-less or non-streamed chat was re-sent as a new session each turn and never
  read from the prompt cache. Measured on the second turn of a long chat: 2082 of 23403
  tokens cached before, 23027 of 23453 after. `THIRD_PARTY_CHAT_CONTINUITY=false` undoes it.
- An unknown model is answered with 404 instead of 500.

Checked with the real login on one instance (port 3457): 15 local checks (chat, three-round
tool loop, a `Bash` call handed to the client and not run here, history, responses,
messages, cache, concurrency, Sonnet, reasoning effort, streaming), a local Claude Code
client writing and reading a file, and from another machine through a gateway: 14 API
checks over its three provider types, Claude Code 2.1.321 and Codex 0.167 creating files on
their own machine.

## Looked at and left alone

- The legacy `/v1/chat/completions` in `src/routes/proxy.ts` (with its "You are NOT Claude
  Code" prompt) is still what the Anthropic role serves. Removing it changes that role's
  API and is better decided together with a deployment change.
