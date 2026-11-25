import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "bun:test";
import { createNativeRuntimeAdapter } from "../../../dist/runtime/runtime-adapters.mjs";

const children = new Set();
afterEach(() => {
  for (const child of children) { child.stdin.destroyed = true; child.stdout.destroy(); child.stderr.destroy(); }
  children.clear();
});

class FakeAcpProcess extends EventEmitter {
  constructor() { super(); children.add(this); }
  stdout = new PassThrough();
  stderr = new PassThrough();
  writes = [];
  killed = [];
  stdin = {
    destroyed: false,
    write: (data, callback) => { this.writes.push(JSON.parse(data)); callback?.(); return true; },
    end: () => {},
  };
  kill(signal) { this.killed.push(signal); return true; }
  send(message) { this.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`); }
  request(method) { return this.writes.filter((write) => write.method === method).at(-1); }
  requests(method) { return this.writes.filter((write) => write.method === method); }
  respond(method, result) { this.send({ id: this.request(method).id, result }); }
  update(sessionId, update) { this.send({ method: "session/update", params: { sessionId, update } }); }
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

const create = (overrides = {}) => ({
  agentId: "cli_cursor",
  workspaceDir: "/tmp/cursor-workspace",
  stateDir: "/tmp/cursor-state",
  standingPrompt: { version: "v1", content: "standing rules", hash: "abc" },
  ...overrides,
});

async function startSession(overrides = {}, options = {}) {
  const child = new FakeAcpProcess();
  const launches = [];
  const files = [];
  const session = await createNativeRuntimeAdapter("cursor", {
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

async function ready(child, sessionId = "cur-1", model = "claude-opus-5-5[effort=medium]") {
  child.respond("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  await flush();
  child.respond("session/new", { sessionId, models: { currentModelId: model, availableModels: [] } });
  await flush();
}

test("Cursor launches the ACP server in the workspace and passes --model only for a pinned model", async () => {
  const unpinned = await startSession({ model: "default" });
  assert.deepEqual(unpinned.launches.map(({ args, cwd }) => ({ args, cwd })), [{ args: ["acp"], cwd: "/tmp/cursor-workspace" }]);
  const pinned = await startSession({ model: "gpt-5.5" });
  assert.deepEqual(pinned.launches[0].args, ["--model", "gpt-5.5", "acp"]);
});

test("Cursor gets the standing prompt as an always-applied workspace rule, leaving AGENTS.md to the user", async () => {
  const { files } = await startSession();
  assert.deepEqual(files.map(({ file }) => file), [path.join("/tmp/cursor-workspace", ".cursor", "rules", "larkin-standing-prompt.mdc")]);
  assert.match(files[0].content, /^---\n[^]*alwaysApply: true\n---\nstanding rules\n$/);
});

test("Cursor creates a session after initialize and reports its id and model", async () => {
  const { child, session, events } = await startSession();
  assert.deepEqual(child.request("initialize").params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false });
  assert.equal(session.sessionId, null);
  await ready(child, "cur-1", "gpt-5.5[reasoning=medium]");
  assert.deepEqual(child.request("session/new").params, { cwd: "/tmp/cursor-workspace", mcpServers: [] });
  assert.equal(session.sessionId, "cur-1");
  assert.deepEqual(events.filter((event) => event.type === "session-init"), [{ type: "session-init", sessionId: "cur-1", model: "gpt-5.5[reasoning=medium]" }]);
});

test("Cursor defers input until its session exists, then starts a turn with session/prompt", async () => {
  const { child, session, events } = await startSession();
  assert.equal((await session.prompt({ inputId: "early", kind: "initial", text: "hi" })).status, "deferred");
  await ready(child);
  assert.deepEqual(await session.prompt({ inputId: "i1", kind: "initial", text: "hello" }), { status: "accepted", inputId: "i1" });
  assert.deepEqual(child.request("session/prompt").params, { sessionId: "cur-1", prompt: [{ type: "text", text: "hello" }] });
  assert.deepEqual(events.filter((event) => event.type === "turn-start"), [{ type: "turn-start" }]);
});

test("Cursor session updates become card text, reasoning, tool steps and one turn end", async () => {
  const { child, session, events } = await startSession();
  await ready(child);
  await session.prompt({ inputId: "i1", kind: "initial", text: "go" });
  child.update("cur-1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "plan " } });
  child.update("cur-1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "it" } });
  child.update("cur-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "我先" } });
  child.update("cur-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "看一下" } });
  child.update("cur-1", { sessionUpdate: "tool_call", toolCallId: "t1", title: "`echo hi`", kind: "execute", status: "pending", rawInput: { command: "echo hi" } });
  child.update("cur-1", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "in_progress" });
  child.update("cur-1", { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: { exitCode: 0 } });
  child.update("cur-1", { sessionUpdate: "tool_call", toolCallId: "t2", title: "Read missing.txt", kind: "read", status: "pending" });
  child.update("cur-1", { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "failed" });
  child.update("cur-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "完成" } });
  child.respond("session/prompt", { stopReason: "end_turn" });
  await flush();
  assert.deepEqual(events.filter((event) => event.type !== "session-init"), [
    { type: "turn-start" },
    { type: "activity", activity: "thinking", text: "plan it" },
    { type: "text-delta", text: "我先", newBlock: true },
    { type: "text-delta", text: "看一下" },
    { type: "activity", activity: "text", text: "我先看一下" },
    { type: "activity", activity: "tool", name: "execute", text: "echo hi", toolId: "t1" },
    { type: "tool-result", ok: true, toolId: "t1" },
    { type: "activity", activity: "tool", name: "read", text: "Read missing.txt", toolId: "t2" },
    { type: "tool-result", ok: false, toolId: "t2" },
    { type: "text-delta", text: "完成", newBlock: true },
    { type: "activity", activity: "text", text: "完成" },
    { type: "turn-end", sessionId: "cur-1" },
  ]);
});

test("Cursor busy input interrupts the running prompt and continues as the same turn", async () => {
  const { child, session, events } = await startSession();
  await ready(child);
  await session.prompt({ inputId: "i1", kind: "initial", text: "long task" });
  child.update("cur-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "working" } });
  assert.deepEqual(await session.busyInput({ inputId: "i2", kind: "inbox_update", text: "new message" }), { status: "accepted", inputId: "i2" });
  const [first, second] = child.requests("session/prompt");
  assert.deepEqual(second.params.prompt, [{ type: "text", text: "new message" }]);
  child.update("cur-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " stale tail" } });
  child.update("cur-1", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "stale thought" } });
  child.send({ id: first.id, result: { stopReason: "cancelled" } });
  await flush();
  assert.equal(events.filter((event) => event.type === "turn-end").length, 0, "the superseded prompt does not end the turn");
  child.update("cur-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "both handled" } });
  child.send({ id: second.id, result: { stopReason: "end_turn" } });
  await flush();
  assert.deepEqual(events.filter((event) => event.type === "text-delta" || event.type === "activity").map(({ type, text, newBlock }) => [type, text, newBlock]), [
    ["text-delta", "working", true],
    ["activity", "working", undefined],
    ["text-delta", "both handled", true],
    ["activity", "both handled", undefined],
  ], "output the superseded prompt flushes before its cancelled reply is dropped");
  assert.equal(events.filter((event) => event.type === "turn-start").length, 1);
  assert.deepEqual(events.filter((event) => event.type === "turn-end"), [{ type: "turn-end", sessionId: "cur-1" }]);
});

test("a superseded prompt that never replies does not silence the next turn", async () => {
  const { child, session, events } = await startSession();
  await ready(child);
  await session.prompt({ inputId: "i1", kind: "initial", text: "a" });
  await session.busyInput({ inputId: "i2", kind: "inbox_update", text: "b" });
  child.send({ id: child.requests("session/prompt")[1].id, result: { stopReason: "end_turn" } });
  await flush();
  await session.prompt({ inputId: "i3", kind: "initial", text: "c" });
  child.update("cur-1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "answer c" } });
  await flush();
  assert.deepEqual(events.filter((event) => event.type === "text-delta").map((event) => event.text), ["answer c"]);
});

test("Cursor busy input while idle starts a fresh turn", async () => {
  const { child, session, events } = await startSession();
  await ready(child);
  assert.equal((await session.busyInput({ inputId: "i1", kind: "inbox_update", text: "x" })).status, "accepted");
  assert.equal(child.requests("session/prompt").length, 1);
  assert.equal(events.filter((event) => event.type === "turn-start").length, 1);
});

test("Cursor permission requests are answered with the broadest allow option; other client requests are refused", async () => {
  const { child } = await startSession();
  await ready(child);
  child.send({ id: 900, method: "session/request_permission", params: { sessionId: "cur-1", toolCall: { toolCallId: "t1" }, options: [
    { optionId: "reject", kind: "reject_once", name: "Reject" },
    { optionId: "once", kind: "allow_once", name: "Allow once" },
    { optionId: "always", kind: "allow_always", name: "Allow always" },
  ] } });
  child.send({ id: 901, method: "session/request_permission", params: { sessionId: "cur-1", options: [{ optionId: "once", kind: "allow_once", name: "Allow" }] } });
  child.send({ id: 902, method: "fs/read_text_file", params: { sessionId: "cur-1", path: "/etc/hosts" } });
  await flush();
  const replies = Object.fromEntries(child.writes.filter((write) => write.id >= 900).map((write) => [write.id, write.result ?? write.error]));
  assert.deepEqual(replies[900], { outcome: { outcome: "selected", optionId: "always" } });
  assert.deepEqual(replies[901], { outcome: { outcome: "selected", optionId: "once" } });
  assert.equal(replies[902].code, -32601);
});

test("Cursor resume loads the saved session and ignores the replayed history", async () => {
  const { child, session, events } = await startSession({ resumeSessionId: "cur-old" });
  child.respond("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  await flush();
  assert.deepEqual(child.request("session/load").params, { sessionId: "cur-old", cwd: "/tmp/cursor-workspace", mcpServers: [] });
  child.update("cur-old", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "old question" } });
  child.update("cur-old", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "old answer" } });
  child.respond("session/load", { models: { currentModelId: "gpt-5.5" } });
  await flush();
  assert.equal(session.sessionId, "cur-old");
  assert.deepEqual(events, [{ type: "session-init", sessionId: "cur-old", model: "gpt-5.5" }]);
});

test("Cursor falls back to a new session when the saved one cannot be loaded", async () => {
  const { child, session } = await startSession({ resumeSessionId: "cur-gone" });
  child.respond("initialize", { protocolVersion: 1, agentCapabilities: { loadSession: true } });
  await flush();
  child.send({ id: child.request("session/load").id, error: { code: -32603, message: "Session not found: cur-gone" } });
  await flush();
  child.respond("session/new", { sessionId: "cur-fresh" });
  await flush();
  assert.equal(session.sessionId, "cur-fresh");
});

test("Cursor cancel sends session/cancel and a failed prompt reports the error and ends the turn", async () => {
  const { child, session, events } = await startSession();
  await ready(child);
  await session.prompt({ inputId: "i1", kind: "initial", text: "go" });
  await session.cancel("stop");
  assert.deepEqual(child.request("session/cancel"), { jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "cur-1" } });
  child.send({ id: child.request("session/prompt").id, error: { code: -32603, message: "Usage limit reached" } });
  await flush();
  assert.deepEqual(events.slice(-2), [
    { type: "input-error", inputId: "i1", retryable: true, message: "Usage limit reached" },
    { type: "turn-end", sessionId: "cur-1" },
  ]);
});

test("Cursor reports process exit as closed", async () => {
  const { child, events } = await startSession();
  child.emit("exit", 1, null);
  assert.deepEqual(events.at(-1), { type: "closed", code: 1, signal: null });
});
