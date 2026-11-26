import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "bun:test";
import {
  antigravityStandingPromptRules,
  createNativeRuntimeAdapter,
  resolveAntigravityModelArgs,
} from "../../../dist/runtime/runtime-adapters.mjs";

const children = new Set();
afterEach(() => {
  for (const child of children) { child.stdin.destroyed = true; child.stdout.destroy(); child.stderr.destroy(); }
  children.clear();
});

class FakeAgyProcess extends EventEmitter {
  constructor() { super(); children.add(this); }
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes = [];
  killed = [];
  ended = false;
  stdin = {
    destroyed: false,
    write: (data, callback) => { this.writes.push(JSON.parse(data)); callback?.(); return true; },
    end: () => { this.ended = true; },
  };
  kill(signal) { this.killed.push(signal); return true; }
  send(message) { this.stdout.write(`${JSON.stringify(message)}\n`); }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const create = (overrides = {}) => ({
  agentId: "cli_agy",
  workspaceDir: "/tmp/agy-workspace",
  stateDir: "/tmp/agy-state",
  standingPrompt: { version: "v1", content: "standing rules", hash: "abc" },
  ...overrides,
});

async function startSession(overrides = {}, options = {}) {
  const child = new FakeAgyProcess();
  const launches = [];
  const files = [];
  const session = await createNativeRuntimeAdapter("antigravity", {
    spawn: (command, args, spawnOptions) => { launches.push({ command, args, cwd: spawnOptions.cwd }); return child; },
    mkdir: () => {},
    writeFile: (file, content) => files.push({ file, content }),
    ...options,
  }).createSession(create(overrides));
  const events = [];
  session.subscribe((event) => events.push(event));
  await flush();
  return { child, launches, files, session, events };
}

test("Antigravity launches stream-json headless mode with --model, --effort, and --conversation only when set", async () => {
  const unpinned = await startSession({ model: "default" });
  assert.deepEqual(unpinned.launches, [{
    command: "agy",
    args: ["--input-format", "stream-json", "--output-format", "stream-json", "--dangerously-skip-permissions", "--disable-slash-commands"],
    cwd: "/tmp/agy-workspace",
  }]);
  const pinned = await startSession({ model: "gemini-4-neon-medium", reasoningEffort: "high", resumeSessionId: "conv-42" });
  assert.deepEqual(pinned.launches[0].args, [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--model", "gemini-4-neon-high",
    "--effort", "high",
    "--conversation", "conv-42",
  ]);
  assert.deepEqual(resolveAntigravityModelArgs("gemini-pro-orchestrator-neon", null), ["--model", "gemini-pro-orchestrator-neon"]);
  assert.deepEqual(resolveAntigravityModelArgs("default", null), []);
});

test("Antigravity writes standing prompt into .agents/rules/larkin-standing-prompt.md and splits prompts above 24KB", async () => {
  const { files } = await startSession();
  assert.deepEqual(files.map(({ file }) => file), [path.join("/tmp/agy-workspace", ".agents", "rules", "larkin-standing-prompt.md")]);
  assert.match(files[0].content, /^---\ntrigger: always_on\ndescription: "Larkin standing prompt"\n---\nstanding rules\n$/);

  const largePrompt = Array.from({ length: 400 }, (_, i) => `Rule line ${i}: ${"x".repeat(70)}`).join("\n");
  const parts = antigravityStandingPromptRules(largePrompt);
  assert.ok(parts.length >= 2);
  assert.equal(parts[0].fileName, "larkin-standing-prompt.md");
  assert.equal(parts[1].fileName, "larkin-standing-prompt-part-2.md");
  for (const part of parts) {
    assert.ok(Buffer.byteLength(part.content, "utf8") <= 23_500);
    assert.match(part.content, /^---\ntrigger: always_on\n/);
  }
});

test("Antigravity defers prompts before init, then maps streaming text_delta, tool steps, and result to normalized events", async () => {
  const { child, session, events } = await startSession();
  assert.equal((await session.prompt({ inputId: "early", kind: "initial", text: "too early" })).status, "deferred");
  assert.equal(child.writes.length, 0);

  child.send({ event: "init", conversation_id: "conv-1", init: { cwd: "/tmp/agy-workspace", model: "gemini-4-neon-high", permission_mode: "always-proceed" } });
  await flush();
  assert.equal(session.sessionId, "conv-1");
  assert.deepEqual(await session.prompt({ inputId: "i1", kind: "initial", text: "hello" }), { status: "accepted", inputId: "i1" });
  assert.deepEqual(child.writes, [{ event: "user", message: { content: [{ type: "text", text: "hello" }] } }]);

  child.send({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 0, state: "DONE", step_type: "user_input" } });
  child.send({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "我先" } });
  child.send({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "看一下" } });
  child.send({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 2, state: "ACTIVE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" } } } });
  child.send({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 2, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo hi" }, output: "hi\n" } } });
  child.send({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 3, state: "DONE", step_type: "tool", tool_name: "read_file", tool_info: { name: "read_file", parameters: { Path: "/missing" }, error: { type: "NOT_FOUND", message: "missing" } } } });
  child.send({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 4, state: "DONE", step_type: "agent_response", text_delta: "完成" } });
  child.send({ event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", response: "我先看一下完成", num_turns: 1 } });
  await flush();

  assert.equal(session.sessionId, "conv-1");
  assert.deepEqual(events, [
    { type: "session-init", sessionId: "conv-1", model: "gemini-4-neon-high" },
    { type: "turn-start" },
    { type: "text-delta", text: "我先", newBlock: true },
    { type: "text-delta", text: "看一下" },
    { type: "activity", activity: "text", text: "我先看一下" },
    { type: "activity", activity: "tool", name: "run_command", text: "echo hi", toolId: "step-2" },
    { type: "tool-result", ok: true, name: "run_command", toolId: "step-2" },
    { type: "activity", activity: "tool", name: "read_file", text: "{\"Path\":\"/missing\"}", toolId: "step-3" },
    { type: "tool-result", ok: false, name: "read_file", toolId: "step-3" },
    { type: "text-delta", text: "完成", newBlock: true },
    { type: "activity", activity: "text", text: "完成" },
    { type: "turn-end", sessionId: "conv-1" },
  ]);
});

test("Antigravity gates busyInput until the active turn emits result, then starts the next turn", async () => {
  const { child, session, events } = await startSession();
  child.send({ event: "init", conversation_id: "conv-1", init: { cwd: "/tmp/agy-workspace" } });
  await flush();
  await session.prompt({ inputId: "i1", kind: "initial", text: "first" });
  const queued = session.busyInput({ inputId: "i2", kind: "inbox_update", text: "second" });
  await flush();
  assert.equal(child.writes.length, 1, "busyInput waits for the active turn result");

  child.send({ event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", response: "done 1", num_turns: 1 } });
  assert.deepEqual(await queued, { status: "accepted", inputId: "i2" });
  assert.equal(child.writes.length, 2);
  assert.deepEqual(child.writes[1].message.content, [{ type: "text", text: "second" }]);
  assert.equal(events.filter((e) => e.type === "turn-start").length, 2);
  assert.equal(events.filter((e) => e.type === "turn-end").length, 1);
});

test("Antigravity classifies invalid model, auth errors, cancel, and process close", async () => {
  const { child, session, events } = await startSession();
  child.send({ event: "init", conversation_id: "conv-1", init: { cwd: "/tmp/agy-workspace" } });
  await flush();
  await session.prompt({ inputId: "i1", kind: "initial", text: "go" });
  await session.cancel("stop");
  assert.deepEqual(child.killed, ["SIGINT"]);
  child.send({ event: "result", result: { conversation_id: "conv-1", status: "ERROR", error: "authentication required" } });
  await flush();
  const authErr = events.find((e) => e.type === "input-error");
  assert.equal(authErr.errorCategory, "auth");
  assert.equal(authErr.retryable, false);

  await session.prompt({ inputId: "i2", kind: "initial", text: "bad model" });
  child.send({ event: "result", result: { conversation_id: "conv-1", status: "ERROR", error: "invalid model selection: nope" } });
  await flush();
  assert.equal(events.some((e) => e.type === "configuration-error"), true);

  const closing = session.close("done");
  assert.equal(child.ended, true);
  assert.equal(child.killed.at(-1), "SIGINT", "close waits for graceful stdin EOF exit before SIGTERM");
  child.emit("exit", 0, null);
  await closing;
  assert.deepEqual(events.at(-1), { type: "closed", code: 0, signal: null });
});
