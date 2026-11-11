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

## Looked at and left alone

- `ENABLE_OPENAI_LAYER` stays opt-in: the two-role layout (Anthropic role unchanged, OpenAI
  role on its own port) is deliberate.
- The legacy `/v1/chat/completions` in `src/routes/proxy.ts` (with its "You are NOT Claude
  Code" prompt) is still what the Anthropic role serves. Removing it changes that role's
  API and is better decided together with a deployment change.
