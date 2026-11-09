// Session continuity and the upstream session id. What goes wrong silently (a wrong id
// upstream, a parent's transcript deleted by its subagent) is checked here without any
// API call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import {
  conversationKey, forget, freshRunsSettled, getConversation, lockFreshStart, memorySessionStore, messageHash,
  saveConversation, scrubDenials, seedTranscript, sharedUpstreamId, storeFor, trackFreshRun,
} from "../src/services/conversationStore.js";
import { __test } from "../src/routes/anthropicNative.js";

const { planSession } = __test;
type M = { role: string; content: string | Array<Record<string, unknown>> };
const plan = (key: string, msgs: M[]) =>
  planSession(key, msgs as never, msgs.map((m) => messageHash(m as never)), new Map(), "C:/work", "claude-haiku-5-5", [], {});
const load = (sid: string) => memorySessionStore.load({ projectKey: "p", sessionId: sid } as never);
const entry = (uuid: string, parentUuid: string | null, type: string, content: unknown) =>
  ({ type, uuid, parentUuid, sessionId: "x", message: { role: type, content } });

const user = (text: string): M => ({ role: "user", content: text });
const toolCall: M = { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: "a" } }] };
const toolResult: M = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "11" }] };

test("conversation keys: Claude Code session id, subagents add their agent id", () => {
  const sid = randomUUID();
  const meta = { user_id: JSON.stringify({ session_id: sid }) };
  assert.equal(conversationKey(meta, undefined), sid);
  assert.equal(conversationKey(meta, "abc123"), `${sid}:agent:abc123`);
  assert.equal(conversationKey({ user_id: "not json" }, undefined), null);
});

test("main conversation: a fresh start uses the client's own session id", () => {
  const sid = randomUUID();
  const p = plan(sid, [user("hi")])!;
  assert.equal(p.kind, "fresh");
  assert.equal(p.sessionId, sid);
  assert.equal(p.storeId, sid);
});

test("a session id a local CLI already uses is not taken", () => {
  const sid = randomUUID();
  const dir = join(process.env.CLAUDE_CONFIG_DIR!, "projects", "C--work");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}.jsonl`), "{}\n");
  const p = plan(sid, [user("hi")])!;
  assert.notEqual(p.sessionId, sid);
});

test("tool results continue the same session at the tool-call entry (no fork)", () => {
  const sid = randomUUID();
  const first = [user("read a")];
  saveConversation(sid, {
    sdkSessionId: sid, msgHashes: first.map((m) => messageHash(m as never)),
    checkpointUuid: "A1", pendingToolIds: ["t1"], tipUuid: "A1", checkpoints: [{ n: 1, uuid: "A1", pending: ["t1"] }],
  });
  const p = plan(sid, [...first, toolCall, toolResult])!;
  assert.equal(p.kind, "continue");
  assert.equal(p.sessionId, sid);
  assert.equal(p.storeId, sid);
  assert.equal(p.resumeAt, "A1");
  assert.equal(p.fork, false);
});

test("a subagent uses its parent's session id and never touches the parent's transcript", async () => {
  const sid = randomUUID();
  seedTranscript(sid, [entry("p1", null, "user", "parent prompt")] as never);
  saveConversation(sid, { sdkSessionId: sid, msgHashes: ["h"], tipUuid: "p1" });
  const sub = `${sid}:agent:a1`;
  const p = plan(sub, [user("subagent task")])!;
  assert.equal(p.kind, "fresh");
  assert.equal(p.sessionId, sid, "upstream id = the parent's");
  assert.notEqual(p.storeId, sid, "a transcript name of its own");
  assert.equal((await load(sid))?.length, 1, "parent transcript kept after the subagent's fresh start");

  saveConversation(sub, { sdkSessionId: sid, storeId: p.storeId, msgHashes: ["x"] });
  forget(sub);
  assert.equal((await load(sid))?.length, 1, "forgetting the subagent keeps the parent's transcript");
  assert.ok(getConversation(sid));
});

test("a subagent that arrives before the main request is saved still gets the main id", () => {
  const sid = randomUUID();
  plan(sid, [user("hi")]); // the main request is planned, not saved yet
  assert.equal(getConversation(sid), undefined);
  assert.equal(sharedUpstreamId(sid), sid);
  assert.equal(plan(`${sid}:agent:b2`, [user("task")])!.sessionId, sid);
});

test("storeFor maps the shared id to the subagent's own transcript", async () => {
  const shared = randomUUID(), own = randomUUID();
  const s = storeFor(shared, own);
  await s.append({ projectKey: "p", sessionId: shared } as never, [entry("e1", null, "user", "x")] as never);
  assert.equal((await load(own))?.length, 1);
  assert.equal(await load(shared), null);
  assert.equal(storeFor(own, own), memorySessionStore);
});

test("scrubDenials drops the hook denials and what hangs off them, nothing else", async () => {
  const sid = randomUUID();
  const denial = [{ type: "tool_result", tool_use_id: "t1", content: "PreToolUse hook error: Executed by the client." }];
  seedTranscript(sid, [
    entry("u1", null, "user", "read a"),
    entry("a1", "u1", "assistant", [{ type: "tool_use", id: "t1" }]),
    entry("d1", "a1", "user", denial),
    entry("x1", "d1", "attachment", []),
    entry("r1", "a1", "user", [{ type: "tool_result", tool_use_id: "t1", content: "11" }]),
  ] as never);
  assert.equal(scrubDenials(sid, "Executed by the client."), 2);
  assert.deepEqual((await load(sid))!.map((e) => (e as { uuid: string }).uuid), ["u1", "a1", "r1"]);
});

test("fresh starts on one shared id go one at a time; settled waits for running ones", async () => {
  const sid = randomUUID();
  const order: string[] = [];
  const r1 = await lockFreshStart(sid);
  const second = lockFreshStart(sid).then((r) => {
    order.push("second");
    return r;
  });
  await new Promise((r) => setTimeout(r, 30));
  order.push("first-release");
  r1();
  (await second)();
  assert.deepEqual(order, ["first-release", "second"]);

  const end = trackFreshRun(sid);
  assert.equal(await freshRunsSettled(sid, 50), false, "times out while a run is going");
  setTimeout(end, 20);
  assert.equal(await freshRunsSettled(sid, 2000), true);
});

test("tests write to a temp folder only", () => {
  assert.match(process.env.SESSION_DIR!, /proxy-test-/);
  assert.match(process.env.DATABASE_PATH!, /proxy-test-/);
});
