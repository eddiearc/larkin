import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, test } from "bun:test";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";
import { resolveAgentCliExecutable } from "../../../dist/agent/agent-cli-capabilities.mjs";
import {
  classifyPiProviderError,
  createNativeRuntimeAdapter,
  createPiSessionManager,
  requirePiResumeSessionFile,
  resolvePiProcessExtensionArgs,
} from "../../../dist/runtime/runtime-adapters.mjs";
import { classifyStrictProviderError } from "../../../dist/runtime/provider-error-classifier.mjs";

const fakeProcesses = new Set();

afterEach(() => {
  for (const child of fakeProcesses) {
    child.stdin.destroyed = true;
    child.stdout.destroy();
    child.stderr.destroy();
  }
  fakeProcesses.clear();
});

class FakeProcess extends EventEmitter {
  constructor() {
    super();
    fakeProcesses.add(this);
  }
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
}

const create = (overrides = {}) => ({
  agentId: "cli_test",
  workspaceDir: "/tmp/workspace",
  stateDir: "/tmp/state",
  standingPrompt: { version: "v1", content: "standing", hash: "abc" },
  model: "test-model",
  ...overrides,
});

async function startedCodexTurn(inputId = "input-A", turnId = "turn-A") {
  const child = new FakeProcess();
  const session = await createNativeRuntimeAdapter("codex", { spawn: () => child }).createSession(create());
  const events = [];
  session.subscribe((event) => events.push(event));
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const threadRequest = child.writes.find((request) => request.method === "thread/start");
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: threadRequest.id, result: { thread: { id: "thread-owned" } } })}\n`);
  const prompt = session.prompt({ inputId, kind: "wake", text: "wake", attempt: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const start = child.writes.at(-1);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: start.id, result: { turn: { id: turnId } } })}\n`);
  assert.equal((await prompt).status, "accepted");
  child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-owned", turn: { id: turnId } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  return { child, session, events, turnId };
}

test("context prompt is capability-driven, versioned and produces bounded notifications", () => {
  const builder = new ContextPromptBuilder();
  const prompt = builder.buildStandingPrompt({
    agent: { id: "cli_test", name: "Test" },
    runtime: "codex",
    cli: { executable: "larkin", commands: [
      { command: "inbox check", purpose: "Drain pending canonical messages." },
      { command: "profile show", purpose: "Show this agent identity." },
    ] },
  });
  assert.match(prompt.content, /larkin inbox check/);
  assert.match(prompt.content, /larkin profile show/);
  assert.equal(prompt.hash.length, 64);
  assert.match(prompt.version, /^larkin-standing-/);
  const update = builder.buildRuntimeInput("inbox_update", "input-1", { count: 3, deliveryId: "delivery-1" });
  assert.match(update.text, /3 pending messages/);
  assert.equal(update.deliveryId, "delivery-1");
});

test("default context prompt consumes the Agent CLI manifest", () => {
  const prompt = new ContextPromptBuilder().build({ agentId: "cli_test", runtime: "pi" });
  assert.equal(prompt.version, "larkin-standing-v20");
  assert.match(prompt.content, /larkin reminder schedule/);
  assert.match(prompt.content, /larkin reminder cancel/);
  assert.match(prompt.content, /larkin interaction resolve/);
  assert.match(prompt.content, /larkin comment reply --message-id/);
  assert.match(prompt.content, /kind=document_comment/);
  assert.match(prompt.content, /comment_subscription_mode\/status\/source\/dimension.*mentioned_bot.*IM require\/free settings do not apply/);
  assert.doesNotMatch(prompt.content, /document_comment is a verified explicit @/);
  assert.match(prompt.content, /not an IM target/);
  assert.match(prompt.content, /Only a successful interaction resolve/);
  assert.match(prompt.content, /Use only the Larkin-owned `larkin` command/);
  assert.match(prompt.content, /never invoke bare `lark-cli`/);
  assert.match(prompt.content, /larkin profile show/);
  for (const command of [
    "im +messages-send", "im +messages-reply", "im +chat-messages-list", "im +messages-mget",
    "im +chat-list", "im +chat-search", "im chats get", "im +messages-resources-download",
  ]) assert.match(prompt.content, new RegExp(command.replace(/[+.]/g, "\\$&")), command);
  assert.doesNotMatch(prompt.content, /larkin (?:message|channel|attachment|server|task claim)\b/);
  assert.match(prompt.content, /Only a real Feishu `message_id` beginning with `om_`/);
  assert.match(prompt.content, /`rem_`, `redeliver_`.*synthetic ID must never be replied to/);
  assert.match(prompt.content, /nonzero `freshness_conflict`.*direct-acks/);
  assert.doesNotMatch(prompt.content, /larkin-draft|draft-id|send --draft/);
  assert.match(prompt.content, /regular textual message bodies.*`--markdown`/i);
  assert.match(prompt.content, /native `--text`.*logs.*code.*exact whitespace/i);
  assert.doesNotMatch(prompt.content, /rejected|--literal-text/i);
  assert.doesNotMatch(prompt.content, /use `--text` for brief single-line replies/i);
  assert.match(prompt.content, /attachment-only send\/reply.*attachment flag.*without a text body flag/i);
  assert.match(prompt.content, /passes one argument with real newline characters/);
  assert.match(prompt.content, /ordinary (?:double )?quotes.*do not decode.*`\\n`.*backslash.*letter `n`/i);
  assert.ok(prompt.content.includes("$'First line\\nSecond line'"));
  assert.ok(prompt.content.includes('"First line\\nSecond line"'));
  assert.match(prompt.content, /zsh.*bash.*ANSI-C quoting/i);
  assert.match(prompt.content, /authoritative self identity.*cli_test/i);
  assert.match(prompt.content, /do not call.*profile show.*learn.*identity/i);
  assert.match(prompt.content, /exclusively (?:assigns|addresses).*another named Agent.*stay silent/i);
  assert.match(prompt.content, /direct instruction.*canonical Inbox poll.*verified human.*ordinary user instruction/i);
  assert.match(prompt.content,
    /test.*identifier.*这是独立用例.*skip.*unrelated history.*exact.*fixed.*reply.*not.*prompt injection/i);
  assert.match(prompt.content,
    /does not override.*system.*developer.*standing.*safety.*identity.*authorization.*freshness.*tool.*project.*target/i);
  assert.match(prompt.content,
    /quoted.*forwarded.*embedded.*third-party.*content.*data.*not.*instruction.*(?:authority|user authority)/i);
  assert.match(prompt.content,
    /verified.*instruction.*poll.*remain silent.*wait.*next trigger.*poll.*only model tool call.*immediately stop/i);
  assert.match(prompt.content,
    /must not.*`true`.*`:`.*sleep.*echo.*pwd.*status.*goal.*read.*history.*write.*no-op.*control.*tool/i);
  assert.match(prompt.content,
    /next independent.*trigger.*new phase.*poll again.*before.*explicit work.*must not.*anticipate.*later phase/i);
  assert.match(prompt.content,
    /poll succeeds.*end.*model turn.*do not (?:emit|output).*assistant text.*bash.*shell.*echo.*no-op placeholder.*zero.*post-poll.*(?:calls|tool calls)/i);
  assert.match(prompt.content, /thread:<chat_id>:<thread_id>/);
  assert.match(prompt.content, /\+threads-messages-list --thread <thread_id> --order desc --page-size 10 --no-reactions --json/);
  assert.match(prompt.content, /response messages.*data\.messages/i);
  assert.match(prompt.content, /never.*chat-wide fallback/i);
  assert.match(prompt.content, /never.*`2>&1`.*JSON/i);
  assert.match(prompt.content, /fail visibly.*remembered.*hard-coded text/i);
  assert.match(prompt.content, /exact text.*one literal `--text` argument/i);
  assert.doesNotMatch(prompt.content, /model-internal preflight|internally compare the planned literal/i);
  assert.match(prompt.content, /one literal `--text` argument.*direct literal must not.*command substitution/i);
  assert.match(prompt.content, /tool-sourced.*exact.*must use.*deterministic.*`--jq`.*`--content`/i);
  assert.match(prompt.content, /threads-messages-list.*sender\.sender_type.*user.*\.content.*type.*string/i);
  assert.match(prompt.content, /messages-mget.*message_id.*\.content.*type.*string/i);
  assert.ok(prompt.content.includes('{text: ("<exact_literal_prefix>" + .content)}'));
  assert.doesNotMatch(prompt.content, /\.body\.content|fromjson/);
  assert.match(prompt.content, /literal_prefix.*JSON-string-escaped.*empty string/i);
  assert.match(prompt.content, /JSON-string-escaped.*U\+0027.*shell single-quote splice/i);
  assert.match(prompt.content, /do not restrict.*msg_type=text.*post/i);
  assert.match(prompt.content, /shell substitution.*double-quoted.*`--content`.*one argument/i);
  assert.match(prompt.content, /one model tool call.*one.*scoped read.*one guarded reply/i);
  assert.match(prompt.content, /current Inbox event.*first model tool call.*inbox poll.*target supplied.*must not.*inbox check.*before/i);
  assert.match(prompt.content, /known thread.*latest human.*first and only post-poll model tool call/i);
  assert.match(prompt.content,
    /official API discriminator.*exact literal.*sender\.sender_type == "user".*human.*natural-language.*must never.*(?:replace|paraphrase)/i);
  assert.match(prompt.content, /thread.*never.*preview.*extract.*message id.*switch.*messages-mget/i);
  assert.match(prompt.content, /known source message id.*messages-mget.*first and only post-poll model tool call.*no preview/i);
  assert.match(prompt.content, /inner read.*replaces.*separate.*history read/i);
  assert.match(prompt.content, /must not.*unquoted.*substitution.*`eval`.*`echo`.*`2>&1`.*temporary/i);
  assert.match(prompt.content,
    /source's thread membership.*structural Inbox fact.*not a guess.*MUST stay in that same thread.*messages-reply --message-id <real_om_message_id> --text '<exact_body_as_one_literal_argument>' --reply-in-thread --json.*chat-level source.*omit.*--reply-in-thread/i);
  assert.match(prompt.content,
    /chat-level source.*no thread.*main timeline.*omit.*--reply-in-thread/i);
  assert.match(prompt.content,
    /Use the .--reply-in-thread. recipe only when the source is a thread or the user or current Inbox event explicitly asks.*topic.*in-thread.*thread reply.*Never invent a topic request from ordinary reply wording or a bare source message id.*thread membership.*thread:.*target.*thread_id.*explicit request.*never from wording alone/i);
  assert.match(prompt.content,
    /exactly one post-poll.*model tool call.*must not.*skill.*reference.*help.*discovery.*without.*freshness_conflict.*two.*model tool calls.*pre-commit.*provider-not-reached.*retry.*identical.*three.*model tool calls/i);
  assert.match(prompt.content,
    /larkin im \+messages-send --chat-id <confirmed_chat_id> --text '<exact_body_as_one_literal_argument>' --json/i);
  assert.match(prompt.content, /complete canonical exact send and reply paths.*must not.*messages-send --help.*messages-reply --help/i);
  assert.match(prompt.content, /known canonical.*Inbox poll.*scoped.*history.*exact send.*reply.*directly.*must not.*(?:read|re-read).*skill.*reference/i);
  assert.match(prompt.content,
    /exact group name.*user.*bot counts.*required Inbox poll.*\+chat-search --query '<exact_group_name>' --json.*exact name.*oc_.*chats get --chat-id <confirmed_oc_chat_id> --json.*user_count.*bot_count/i);
  assert.match(prompt.content,
    /group.*user.*bot counts.*exactly two.*post-poll.*read calls.*must not.*skill.*reference.*help.*schema.*bare.*lark-cli.*chat\.members.*\+chat-members-list/i);
  assert.match(prompt.content, /does not waive.*skill.*safety.*unknown.*high-risk/i);
  assert.match(prompt.content, /exact.*`--text`.*overrides.*markdown default/i);
  assert.match(prompt.content, /wrapper derives.*stable.*idempotency key.*do not pass.*--idempotency-key/i);
  assert.match(prompt.content, /freshness_unavailable.*freshness_conflict.*pre-commit.*provider-not-reached.*retry.*identical.*`--text`.*`--content`.*wrapper reuses/i);
  assert.match(prompt.content, /target or body changes.*revised ordinary command.*derive a new key/i);
  assert.match(prompt.content, /`committed=true` must not be repeated.*ambiguous termination.*wrapper same-key recovery/i);
  assert.doesNotMatch(prompt.content, /oc_eval_exact|om_eval_anchor|原文：“修复 A\/B”|收到：“A\/B”|引用：“抢到”|消息原文：“保持”/);
});

test("Codex, Claude and Pi receive the clickable-link and exact-content standing contracts", async () => {
  const standingPrompt = (runtime) => new ContextPromptBuilder().build({ agentId: "cli_test", runtime });
  const assertContract = (content) => {
    assert.match(content, /regular textual message bodies.*`--markdown`/i);
    assert.match(content, /URL must be visible, clickable, or openable.*complete bare `https:\/\/\.\.\.` URL.*visible text/i);
    assert.match(content, /Do not rely solely on `\[label\]\(URL\)`.*Feishu client rendering is unreliable/i);
    assert.match(content, /label may also be included.*bare URL must remain present/i);
    assert.match(content, /Never rewrite or normalize.*exact or verbatim user-supplied body.*existing exact-content paths.*authoritative.*unchanged/i);
    assert.match(content, /exact text supplied directly.*body unchanged as one literal `--text` argument/i);
    assert.match(content, /explicit exact or verbatim direct literal uses `--text`.*overrides.*markdown default/i);
    assert.match(content, /tool-sourced exact or verbatim text.*deterministic native `--jq`.*`--content`/i);
    assert.match(content, /native `--text`.*logs.*code.*exact whitespace/i);
    assert.doesNotMatch(content, /rejected|--literal-text/i);
    assert.doesNotMatch(content, /use `--text` for brief single-line replies/i);
    assert.match(content, /attachment-only send\/reply.*attachment flag.*without a text body flag/i);
  };

  const codex = new FakeProcess();
  await createNativeRuntimeAdapter("codex", { spawn: () => codex }).createSession(create({ standingPrompt: standingPrompt("codex") }));
  codex.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assertContract(codex.writes.find((request) => request.method === "thread/start").params.developerInstructions);

  const claude = new FakeProcess();
  let claudePrompt;
  await createNativeRuntimeAdapter("claude", {
    spawn: () => claude,
    mkdir: () => {},
    writeFile: (_file, content) => { claudePrompt = content; },
  }).createSession(create({ standingPrompt: standingPrompt("claude") }));
  assertContract(claudePrompt);

  let piPrompt;
  await createNativeRuntimeAdapter("pi", {
    createPiSession: async (input) => {
      piPrompt = input.standingPrompt.content;
      return { sessionId: "pi-contract", prompt() {}, steer() {}, abort() {} };
    },
  }).createSession(create({ standingPrompt: standingPrompt("pi") }));
  assertContract(piPrompt);
});

test("context prompt uses the single Larkin-owned executable surface", () => {
  const executable = "'/opt/bun with space/$()/`bin`/bun' '/app/larkin agent'\"'\"'cli.mjs'";
  const prompt = new ContextPromptBuilder().buildStandingPrompt({
    agent: { id: "cli_test" }, runtime: "codex",
    cli: { executable, commands: [
      { command: "inbox check", purpose: "Drain." },
      { command: "profile show", purpose: "Identity." },
    ] },
  }).content;
  for (const suffix of ["inbox check", "profile show"]) {
    assert.ok(prompt.includes(`${executable} ${suffix}`), suffix);
  }
  for (const suffix of ["im +messages-reply", "im +chat-list", "im +messages-resources-download"]) {
    assert.ok(prompt.includes(`${executable} ${suffix}`), suffix);
  }
  assert.match(prompt, /never invoke bare `lark-cli`/);
  assert.doesNotMatch(prompt, /\/installed\/agent-cli.* im /);
  assert.match(prompt, /Only a real Feishu `message_id` beginning with `om_`/);
});

test("Agent CLI executable uses POSIX-safe quoting for shell metacharacters and single quotes", () => {
  const quote = (value) => `'${value.replaceAll("'", `'"'"'`)}'`;
  const runtime = "/opt/bun $() `tick` ' binary";
  const cli = "/app/agent cli's.mjs";
  assert.equal(resolveAgentCliExecutable(cli, runtime), `${quote(runtime)} ${quote(cli)}`);
});

test("Codex adapter initializes a thread and maps busy input to turn/steer", async () => {
  const child = new FakeProcess();
  const session = await createNativeRuntimeAdapter("codex", { spawn: () => child }).createSession(create());
  assert.equal(child.writes[0].method, "initialize");
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { userAgent: "codex" } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.writes[1].method, "initialized");
  assert.equal(child.writes[2].method, "thread/start");
  assert.equal(child.writes[2].params.developerInstructions, "standing");
  assert.equal(Object.keys(child.writes[2].params).filter((key) => /instructions|prompt/i.test(key)).length, 1);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, result: { thread: { id: "thread-1" } } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-1" } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const pending = session.busyInput({ inputId: "busy-1", kind: "inbox_update", text: "check inbox", attempt: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const steerRequest = child.writes.at(-1);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: steerRequest.id, result: {} })}\n`);
  const result = await pending;
  assert.deepEqual(result, { status: "accepted", inputId: "busy-1" });
  assert.equal(steerRequest.method, "turn/steer");
  assert.equal(steerRequest.params.expectedTurnId, "turn-1");
});

test("Codex native notifications normalize start, intermediate output, and terminal boundary", async () => {
  const { child, events, turnId } = await startedCodexTurn("eye-codex", "turn-eye-codex");
  child.stdout.write(`${JSON.stringify({ method: "item/reasoning/summaryTextDelta", params: { delta: "thinking" } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "answer" } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.filter((event) => ["turn-start", "activity", "turn-end"].includes(event.type))
    .map((event) => event.type === "activity" ? `${event.type}:${event.activity}` : event.type),
  ["turn-start", "activity:thinking", "activity:text", "turn-end"]);
});

test("Codex resume failure falls back to a fresh thread with the same standing prompt", async () => {
  const child = new FakeProcess();
  await createNativeRuntimeAdapter("codex", { spawn: () => child }).createSession(create({ resumeSessionId: "stale-thread" }));
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { userAgent: "codex" } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const resume = child.writes.find((request) => request.method === "thread/resume");
  assert.equal(resume.params.threadId, "stale-thread");
  assert.equal(resume.params.developerInstructions, "standing");
  assert.equal(Object.keys(resume.params).filter((key) => /instructions|prompt/i.test(key)).length, 1);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: resume.id, error: { code: -32602, message: "rollout not found" } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const fallback = child.writes.at(-1);
  assert.equal(fallback.method, "thread/start");
  assert.equal(fallback.params.threadId, undefined);
  assert.equal(fallback.params.developerInstructions, "standing");
});

test("Codex rejects unsupported app-server requests without treating them as notifications", async () => {
  const child = new FakeProcess();
  await createNativeRuntimeAdapter("codex", { spawn: () => child }).createSession(create());
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 88, method: "item/requestApproval", params: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.writes.at(-1), {
    jsonrpc: "2.0",
    id: 88,
    error: { code: -32601, message: "Unsupported Codex app-server request: item/requestApproval" },
  });
});

test("Codex steer precondition failure is deferred and clears the stale active turn", async () => {
  const child = new FakeProcess();
  const session = await createNativeRuntimeAdapter("codex", { spawn: () => child }).createSession(create());
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const threadRequest = child.writes.find((request) => request.method === "thread/start");
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: threadRequest.id, result: { thread: { id: "thread-1" } } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-stale" } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const pending = session.busyInput({ inputId: "busy-stale", kind: "inbox_update", text: "update", attempt: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const steer = child.writes.at(-1);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: steer.id, error: { code: -32000, message: "expectedTurnId no longer active" } })}\n`);
  assert.deepEqual(await pending, { status: "deferred", inputId: "busy-stale", reason: "expectedTurnId no longer active" });
  assert.equal((await session.busyInput({ inputId: "busy-again", kind: "inbox_update", text: "again", attempt: 0 })).status, "deferred");
});

test("Claude adapter appends standing prompt and gates busy input to assistant boundaries", async () => {
  const child = new FakeProcess();
  let promptWrite;
  let launchArgs;
  const session = await createNativeRuntimeAdapter("claude", {
    spawn: (_command, args) => { launchArgs = args; return child; },
    mkdir: () => {},
    writeFile: (...args) => { promptWrite = args; },
  }).createSession(create());
  assert.equal(promptWrite[1], "standing");
  assert.equal(launchArgs.filter((arg) => arg === "--append-system-prompt-file").length, 1);
  assert.equal(launchArgs.includes("--system-prompt"), false);
  const initial = await session.prompt({ inputId: "initial", kind: "initial", text: "start" });
  assert.equal(initial.status, "accepted");
  const gated = session.busyInput({ inputId: "early", kind: "inbox_update", text: "update" });
  child.stdout.write(`${JSON.stringify({ type: "assistant", session_id: "claude-1", message: { content: [{ type: "text", text: "partial" }] } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await gated).status, "accepted");
  assert.equal(child.writes.at(-1).type, "user");
  assert.equal(child.writes.at(-1).session_id, "claude-1");
});

test("Claude native stream normalizes start, text/tool output, and result boundary", async () => {
  const child = new FakeProcess();
  const session = await createNativeRuntimeAdapter("claude", {
    spawn: () => child, mkdir: () => {}, writeFile: () => {},
  }).createSession(create());
  const events = [];
  session.subscribe((event) => events.push(event));
  child.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: "claude-eye" })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "assistant", session_id: "claude-eye", message: { content: [
    { type: "thinking", thinking: "reason" }, { type: "text", text: "answer" }, { type: "tool_use", name: "Read" },
  ] } })}\n`);
  child.stdout.write(`${JSON.stringify({ type: "result", session_id: "claude-eye", is_error: false })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.filter((event) => ["turn-start", "activity", "turn-end"].includes(event.type))
    .map((event) => event.type === "activity" ? `${event.type}:${event.activity}` : event.type),
  ["turn-start", "activity:thinking", "activity:text", "activity:tool", "turn-end"]);
});

test("Claude resume keeps exactly one append standing-prompt file", async () => {
  const child = new FakeProcess();
  let launchArgs;
  await createNativeRuntimeAdapter("claude", {
    spawn: (_command, args) => { launchArgs = args; return child; },
    mkdir: () => {}, writeFile: () => {},
  }).createSession(create({ resumeSessionId: "claude-resume-session" }));
  assert.deepEqual(launchArgs.slice(launchArgs.indexOf("--resume"), launchArgs.indexOf("--resume") + 2),
    ["--resume", "claude-resume-session"]);
  assert.equal(launchArgs.filter((arg) => arg === "--append-system-prompt-file").length, 1);
  assert.equal(launchArgs.includes("--system-prompt"), false);
});

test("Pi adapter maps prompt, steer and abort to its process backend", async () => {
  const calls = [];
  const sdk = {
    sessionId: "pi-1",
    model: { provider: "provider", id: "model" },
    thinkingLevel: "high",
    async prompt(text) { calls.push(["prompt", text]); },
    steer(text) { calls.push(["steer", text]); },
    abort() { calls.push(["abort"]); },
  };
  const adapter = createNativeRuntimeAdapter("pi", { createPiSession: async () => sdk });
  assert.equal(adapter.capabilities.busyInput, "boundary");
  const session = await adapter.createSession(create());
  const events = [];
  session.subscribe((event) => events.push(event));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events[0], { type: "session-init", sessionId: "pi-1", model: "provider/model", reasoningEffort: "high" });
  await session.prompt({ inputId: "p", kind: "user", text: "one" });
  await session.busyInput({ inputId: "s", kind: "inbox_update", text: "two" });
  await session.cancel("stop");
  assert.deepEqual(calls, [["prompt", "one"], ["steer", "two"], ["abort"]]);
});

test.each(["win32", "linux"])("builtin Pi resolves no -e extension args on simulated %s", (platform) => {
  let resolverCalls = 0;
  const args = resolvePiProcessExtensionArgs({
    distribution: "builtin", piCommand: "builtin-pi", env: {}, platform,
  }, {
    subagents: () => { resolverCalls += 1; return "/must/not/resolve-subagents.js"; },
    bashTimeout: () => { resolverCalls += 1; return "/must/not/resolve-bash-timeout.js"; },
  });
  assert.deepEqual(args, []);
  assert.equal(resolverCalls, 0, "builtin must not resolve file-based extensions");
});

test.each(["win32", "linux"])("external Pi retains both -e extension args on simulated %s", (platform) => {
  const args = resolvePiProcessExtensionArgs({
    distribution: "external", piCommand: "external-pi", env: {}, platform,
  }, {
    subagents: () => "/fixture/pi-subagents.bundle.js",
    bashTimeout: () => "/fixture/pi-bash-timeout.bundle.js",
  });
  assert.deepEqual(args, [
    "-e", "/fixture/pi-subagents.bundle.js",
    "-e", "/fixture/pi-bash-timeout.bundle.js",
  ]);
});

test.each(["external", "builtin"])("%s Pi launches one shared append standing-prompt path without replacement", async (distribution) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-pi-single-prompt-${distribution}-`));
  const child = new FakeProcess();
  child.kill = (signal) => {
    child.killed.push(signal);
    child.emit("exit", 0, null);
    return true;
  };
  let launch;
  try {
    const input = create({
      workspaceDir: path.join(root, "workspace"), stateDir: path.join(root, "state"), model: "default",
      resumeSessionId: `resume-${distribution}`,
      env: distribution === "builtin" ? { LARKIN_PI_DISTRIBUTION: "builtin", LARKIN_CONFIG_DIR: path.join(root, "config") } : {},
    });
    fs.mkdirSync(input.workspaceDir, { recursive: true });
    const sessionDir = path.join(input.stateDir, "runtime", "pi-sessions");
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionFile = path.join(sessionDir, `${input.resumeSessionId}.jsonl`);
    fs.writeFileSync(sessionFile, `${JSON.stringify({ type: "session", id: input.resumeSessionId })}\n`);
    const piCommand = "/fixture/external-pi";
    const pending = createNativeRuntimeAdapter("pi", {
      env: { LARKIN_PI_COMMAND: piCommand },
      resolvePiProcessExtensionArgs: () => [],
      spawn: (command, args, options) => { launch = { command, args: [...args], options }; return child; },
    }).createSession(input);
    await new Promise((resolve) => setImmediate(resolve));
    for (const request of child.writes.slice(0, 2)) {
      const data = request.type === "get_state"
        ? { sessionId: `session-${distribution}`, model: { provider: "fixture", id: "model" }, thinkingLevel: "off" }
        : { models: [{ provider: "fixture", id: "model" }] };
      child.stdout.write(`${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data })}\n`);
    }
    const session = await pending;
    const appendIndex = launch.args.indexOf("--append-system-prompt");
    assert.notEqual(appendIndex, -1);
    assert.equal(launch.args.filter((arg) => arg === "--append-system-prompt").length, 1);
    assert.equal(launch.args.includes("--system-prompt"), false);
    assert.deepEqual(launch.args.slice(launch.args.indexOf("--session"), launch.args.indexOf("--session") + 2),
      ["--session", sessionFile]);
    const promptFile = launch.args[appendIndex + 1];
    assert.equal(fs.readFileSync(promptFile, "utf8"), "standing");
    if (process.platform !== "win32") assert.equal(fs.statSync(promptFile).mode & 0o777, 0o600);
    if (distribution === "external") {
      assert.equal(launch.command, piCommand);
      assert.deepEqual(launch.args.slice(0, 2), ["--mode", "rpc"]);
      assert.equal(launch.options.env.LARKIN_PI_DISTRIBUTION, undefined);
    } else {
      assert.ok(launch.args.includes("__internal") && launch.args.includes("pi-rpc"));
      assert.equal(launch.args.includes("-e"), false, "builtin extensions are passed inline by binary-entry");
      assert.equal(launch.options.env.LARKIN_PI_DISTRIBUTION, "builtin");
      assert.equal(launch.options.env.PI_TELEMETRY, "0");
    }
    await session.close("test complete");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi prompt reports acceptance only after the RPC command acknowledgement", async () => {
  let acknowledge;
  const acceptedByRpc = new Promise((resolve) => { acknowledge = resolve; });
  const sdk = {
    sessionId: "pi-pending",
    prompt() { return acceptedByRpc; },
    steer() {},
    abort() {},
  };
  const session = await createNativeRuntimeAdapter("pi", { createPiSession: async () => sdk }).createSession(create());
  let settled = false;
  const pending = session.prompt({ inputId: "pi-input", kind: "user", text: "work", attempt: 0 }).then((result) => { settled = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  acknowledge();
  const result = await pending;
  assert.deepEqual(result, { status: "accepted", inputId: "pi-input" });
});

test("bundled Pi normalizes preflight compaction, retry, and terminal timeout without payload fields or a false turn", async () => {
  let listener; let rejectPrompt;
  const sdk = {
    sessionId: "pi-preflight", prompt() { return new Promise((_resolve, reject) => { rejectPrompt = reject; }); },
    steer() {}, abort() {}, subscribe(next) { listener = next; return () => {}; },
  };
  const session = await createNativeRuntimeAdapter("pi", {
    createPiSession: async () => sdk, env: { LARKIN_PI_DISTRIBUTION: "builtin" },
  }).createSession(create());
  const events = []; session.subscribe((event) => events.push(event));
  const pending = session.prompt({ inputId: "PRIVATE_INPUT", kind: "user", text: "PRIVATE_PROMPT", attempt: 0 });
  listener({ type: "compaction_start", reason: "threshold", privateSummary: "PRIVATE_SUMMARY" });
  listener({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3, delayMs: 5,
    errorMessage: "PRIVATE_PROVIDER_ERROR" });
  listener({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
    result: { summary: "PRIVATE_SUMMARY" } });
  listener({ type: "larkin_rpc_failure", message: "Pi RPC prompt preflight timed out at absolute 600000ms limit" });
  rejectPrompt(new Error("Pi RPC prompt preflight timed out at absolute 600000ms limit"));
  assert.equal((await pending).status, "rejected");
  const observations = events.filter((event) => event.type === "runtime-observation");
  assert.deepEqual(observations.map((event) => event.phase), [
    "rpc_submit", "compaction_start", "retry_progress", "compaction_end", "rpc_timeout",
  ]);
  assert.equal(events.some((event) => event.type === "turn-start"), false);
  assert.doesNotMatch(JSON.stringify(observations), /PRIVATE|summary|provider|message|input/i);
});

test("bundled Pi emits content-free RPC timing phases while preserving normalized activity", async () => {
  let listener;
  const sdk = {
    sessionId: "pi-eye", prompt() {}, steer() {}, abort() {},
    subscribe(next) { listener = next; return () => {}; },
  };
  const session = await createNativeRuntimeAdapter("pi", {
    createPiSession: async () => sdk,
    env: { LARKIN_PI_DISTRIBUTION: "builtin" },
  }).createSession(create());
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.prompt({ inputId: "pi-eye-input", kind: "user", text: "work", attempt: 0 });
  listener({ type: "turn_start" });
  listener({ type: "turn_start" });
  listener({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "reason" } });
  listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "answer" } });
  listener({ type: "tool_execution_end", toolName: "out-of-order", result: "FORBIDDEN_EARLY_RESULT" });
  listener({ type: "tool_execution_start", toolName: "read" });
  listener({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
  listener({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
  listener({ type: "agent_settled" });
  listener({ type: "agent_settled" });
  assert.deepEqual(events.filter((event) => ["turn-start", "activity", "turn-end"].includes(event.type))
    .map((event) => event.type === "activity" ? `${event.type}:${event.activity}` : event.type),
  ["turn-start", "activity:thinking", "activity:text", "activity:tool", "turn-end"]);
  const observations = events.filter((event) => event.type === "runtime-observation");
  assert.deepEqual(observations.map((event) => event.phase), [
    "rpc_submit", "rpc_accepted", "turn_start", "first_output", "tool_call", "agent_end", "completed", "tool_result", "settled",
  ]);
  assert.ok(observations.every((event) => event.runtime === "pi" && event.distribution === "builtin"));
  assert.equal(events.filter((event) => event.type === "turn-start").length, 1);
  assert.equal(events.filter((event) => event.type === "turn-end").length, 1);
  assert.doesNotMatch(JSON.stringify(observations), /answer|read|out-of-order|FORBIDDEN|toolName|toolResult|message|text/);
});

test("bundled Pi closes an epoch RPC observation only from its original submit owner", async () => {
  let acknowledgePrompt; let listener;
  const sdk = {
    sessionId: "pi-overlap", prompt() { return new Promise((resolve) => { acknowledgePrompt = resolve; }); },
    steer() {}, abort() {}, subscribe(next) { listener = next; return () => {}; },
  };
  const session = await createNativeRuntimeAdapter("pi", {
    createPiSession: async () => sdk, env: { LARKIN_PI_DISTRIBUTION: "builtin" },
  }).createSession(create());
  const events = []; session.subscribe((event) => events.push(event));
  const original = session.prompt({ inputId: "pi-overlap-original", kind: "user", text: "one", attempt: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await session.busyInput({ inputId: "pi-overlap-steer", kind: "inbox_update", text: "two", attempt: 0 }),
    { status: "accepted", inputId: "pi-overlap-steer" });
  assert.deepEqual(events.filter((event) => event.type === "runtime-observation").map((event) => event.phase), ["rpc_submit"]);
  acknowledgePrompt();
  assert.deepEqual(await original, { status: "accepted", inputId: "pi-overlap-original" });
  assert.deepEqual(events.filter((event) => event.type === "runtime-observation").map((event) => event.phase), ["rpc_submit", "rpc_accepted"]);
  listener({ type: "turn_start" });
  listener({ type: "agent_end", messages: [{ role: "assistant", stopReason: "stop" }] });
  listener({ type: "agent_settled" });
});

test("Pi partial output followed by an aborted assistant remains an interrupted delivery", async () => {
  let listener;
  const sdk = {
    sessionId: "pi-aborted", prompt() {}, steer() {}, abort() {},
    subscribe(next) { listener = next; return () => {}; },
  };
  const session = await createNativeRuntimeAdapter("pi", { createPiSession: async () => sdk }).createSession(create());
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.prompt({ inputId: "pi-aborted-input", kind: "user", text: "work", attempt: 0 });
  listener({ type: "turn_start", turnIndex: 0 });
  listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
  listener({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "aborted" }] });
  listener({ type: "agent_settled" });

  const interrupted = events.find((event) => event.type === "input-error");
  assert.deepEqual(interrupted, {
    type: "input-error", inputId: "pi-aborted-input", retryable: true, willRetry: false,
    message: "Pi assistant turn aborted",
  });
  assert.ok(events.indexOf(interrupted) < events.findIndex((event) => event.type === "turn-end"));
});

test("Pi aborted assistant interrupts every prompt and busy-steer owner before the terminal boundary", async () => {
  let listener;
  const sdk = {
    sessionId: "pi-aborted-owned", prompt() {}, steer() {}, abort() {},
    subscribe(next) { listener = next; return () => {}; },
  };
  const session = await createNativeRuntimeAdapter("pi", { createPiSession: async () => sdk }).createSession(create());
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.prompt({ inputId: "pi-aborted-owner-a", kind: "user", text: "one", attempt: 0 });
  listener({ type: "turn_start", turnIndex: 0 });
  await session.busyInput({ inputId: "pi-aborted-owner-b", kind: "inbox_update", text: "two", attempt: 0 });
  listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial" } });
  listener({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "aborted" }] });
  listener({ type: "agent_settled" });

  const terminalIndex = events.findIndex((event) => event.type === "turn-end");
  const interrupted = events.filter((event) => event.type === "input-error");
  assert.deepEqual(interrupted.map((event) => event.inputId).sort(), ["pi-aborted-owner-a", "pi-aborted-owner-b"]);
  assert.ok(interrupted.every((event) => event.retryable && event.willRetry === false));
  assert.ok(interrupted.every((event) => events.indexOf(event) < terminalIndex));
});

test("Pi waits for agent_settled, suppresses RPC retry boundaries, and closes owned inputs once", async () => {
  let listener;
  const sdk = {
    sessionId: "pi-events",
    prompt() {},
    steer() {},
    abort() {},
    subscribe(next) { listener = next; return () => {}; },
  };
  const session = await createNativeRuntimeAdapter("pi", { createPiSession: async () => sdk }).createSession(create());
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.prompt({ inputId: "pi-owner-a", kind: "user", text: "one", attempt: 0 });
  listener({ type: "agent_start" });
  listener({ type: "turn_start" });
  await session.busyInput({ inputId: "pi-owner-b", kind: "inbox_update", text: "two", attempt: 0 });
  listener({ type: "agent_end", willRetry: true, messages: [{ role: "assistant", stopReason: "error", errorMessage: "fetch failed" }] });
  listener({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 10, error: "fetch failed" });
  listener({ type: "agent_start" });
  listener({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "ok" }] }] });
  listener({ type: "agent_settled" });

  assert.equal(events.filter((event) => event.type === "turn-start").length, 1);
  assert.equal(events.filter((event) => event.type === "turn-end").length, 1);
  assert.equal(events.some((event) => event.type === "input-error"), false);
});

test("Pi reports an exhausted transport failure against every owned input before replacing the session", async () => {
  let listener;
  const sdk = {
    sessionId: "pi-failed",
    prompt() {},
    steer() {},
    abort() {},
    subscribe(next) { listener = next; return () => {}; },
  };
  const session = await createNativeRuntimeAdapter("pi", { createPiSession: async () => sdk }).createSession(create());
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.prompt({ inputId: "pi-failed-a", kind: "user", text: "one", attempt: 0 });
  listener({ type: "turn_start" });
  await session.busyInput({ inputId: "pi-failed-b", kind: "inbox_update", text: "two", attempt: 0 });
  const assistant = {
    role: "assistant",
    stopReason: "error",
    errorMessage: "fetch failed",
    diagnostics: [{ type: "provider_transport_failure", message: "Received network error or non-101 status code." }],
  };
  listener({ type: "agent_end", willRetry: true, messages: [assistant] });
  listener({ type: "agent_end", willRetry: false, messages: [assistant] });
  listener({ type: "agent_settled" });
  listener({ type: "agent_settled" });

  const failures = events.filter((event) => event.type === "input-error");
  assert.deepEqual(failures.map((event) => event.inputId).sort(), ["pi-failed-a", "pi-failed-b"]);
  assert.ok(failures.every((event) => event.retryable && event.willRetry === false));
  assert.ok(failures.every((event) => /fetch failed/.test(event.message)));
  assert.equal(events.filter((event) => event.type === "turn-end").length, 1);
  assert.equal(events.filter((event) => event.type === "error").length, 0);
});

test("strict classifier accepts only the exact categorized Pi context projection", () => {
  const canonical = "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.";
  const projection = classifyPiProviderError({ message: canonical }).reason;
  assert.equal(classifyStrictProviderError({ message: projection, errorCategory: "context_window" }), "context_window");
  assert.equal(classifyStrictProviderError({ message: projection }), undefined);
  assert.equal(classifyStrictProviderError({ message: projection.replace("exceeded", "exceedeD"), errorCategory: "context_window" }), undefined);
  assert.equal(classifyStrictProviderError({ message: "provider rejected the input because context overflow happened", errorCategory: "context_window" }), undefined);
  assert.equal(classifyStrictProviderError({ message: "Codex error: provider rejected the input because the context window was exceeded", errorCategory: "context_window" }), undefined);
});

test("Pi provider failures preserve safe actionable categories", () => {
  for (const [upstream, category] of [
    [{ provider: "openai-codex", message: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again." }, "context_window"],
    [{ status: 402, message: "payment required" }, "billing"],
    [{ status: 429, code: "insufficient_quota", message: "monthly allowance exhausted" }, "quota"],
    [{ status: 429, message: "too many requests" }, "rate_limit"],
    [{ status: 401, message: "credentials rejected Bearer fixture-secret" }, "auth"],
    [{ provider: "bigmodel-anthropic", code: "key_command_failed", message: "API key auth failed: resolver command exited nonzero at /Users/example/cc-switch-token" }, "auth"],
    [{ status: 403, message: "billing policy review" }, "provider"],
  ]) {
    const result = classifyPiProviderError(upstream);
    assert.equal(result.category, category);
    assert.ok(result.nextAction.length > 10);
    assert.doesNotMatch(result.reason, /fixture-secret/);
  }
  for (const upstream of [
    { provider: "policy-gateway", message: "Authorization metadata documents the API key policy for this workspace" },
    { provider: "openai-codex", message: "The context policy token limit may apply" },
    { provider: "policy-gateway", code: "policy_error", message: "API key authorization requirements are controlled by tenant policy" },
  ]) {
    assert.equal(classifyPiProviderError(upstream).category, "provider");
  }
  const unknown = classifyPiProviderError({ provider: "gateway", code: "server_error", status: 502,
    message: "unusual failure Authorization: Bearer auth-secret Cookie=session-secret request body: {\"description\":\"useful detail\",\"api_key\":\"private\"}" });
  assert.equal(unknown.category, "provider");
  assert.match(unknown.reason, /unusual failure/);
  assert.match(unknown.reason, /request body.*useful detail/);
  assert.doesNotMatch(unknown.reason, /auth-secret|session-secret|private/);
});

test("Pi carries the structured 0.82 provider fixture without flattening fields or guessing a 403 category", async () => {
  const fixture = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "../../fixtures/runtime/pi-provider-errors.json"), "utf8"));
  for (const [key, expected] of [["quota", "quota"], ["unknown403", "provider"], ["authKeyCommand", "auth"]]) {
    let listener;
    const sdk = { sessionId: `pi-${key}`, prompt() {}, steer() {}, abort() {}, subscribe(next) { listener = next; return () => {}; } };
    const session = await createNativeRuntimeAdapter("pi", { createPiSession: async () => sdk }).createSession(create());
    const events = [];
    session.subscribe((event) => events.push(event));
    await session.prompt({ inputId: `input-${key}`, kind: "user", text: "work", attempt: 0 });
    listener({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
    listener({ type: "agent_end", messages: [fixture[key]] });
    listener({ type: "agent_settled" });
    const failure = events.find((event) => event.type === "input-error");
    assert.equal(failure.errorCategory, expected);
    assert.equal(failure.upstream.provider, fixture[key].diagnostics[0].details.provider);
    assert.equal(failure.upstream.code, fixture[key].diagnostics[0].details.error.code);
    assert.equal(failure.upstream.status, fixture[key].diagnostics[0].details.status);
    assert.equal(failure.upstream.message.includes("Workspace is not enabled"), key === "unknown403");
    assert.doesNotMatch(failure.upstream.message, /fixture-secret/);
    if (key === "unknown403") assert.match(failure.upstream.message, /request body description remains useful/);
    if (key === "authKeyCommand") {
      assert.match(failure.message, /bigmodel-anthropic.*authentication failed/i);
      assert.match(failure.nextAction, /login|API-key resolver/i);
      assert.doesNotMatch(failure.message + failure.nextAction, /Users\/example|cc-switch-token|fixture-secret/);
    }
  }
});

test("Pi exposes terminal provider errors without resubmitting them", async () => {
  let listener;
  const sdk = {
    sessionId: "pi-invalid",
    prompt() {},
    steer() {},
    abort() {},
    subscribe(next) { listener = next; return () => {}; },
  };
  const session = await createNativeRuntimeAdapter("pi", { createPiSession: async () => sdk }).createSession(create());
  const events = [];
  session.subscribe((event) => events.push(event));
  await session.prompt({ inputId: "pi-invalid-a", kind: "user", text: "one", attempt: 0 });
  listener({ type: "turn_start" });
  listener({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "error", errorMessage: "Invalid request: unsupported parameter" }] });
  listener({ type: "agent_settled" });

  assert.deepEqual(events.filter((event) => event.type === "input-error"), [{
    type: "input-error", inputId: "pi-invalid-a", retryable: false, willRetry: false,
    message: "Invalid request: unsupported parameter", errorCategory: "provider",
    nextAction: "Inspect the provider status and request settings, then retry.",
    upstream: { message: "Invalid request: unsupported parameter" },
  }]);
  assert.equal(events.filter((event) => event.type === "turn-end").length, 1);
});

test("Pi correlates settled terminals to the armed request epoch and leaves a second Agent usable", async () => {
  const listeners = new Map();
  const adapter = createNativeRuntimeAdapter("pi", { createPiSession: async (input) => ({
    sessionId: `session-${input.agentId}`, prompt() {}, steer() {}, abort() {},
    subscribe(next) { listeners.set(input.agentId, next); return () => listeners.delete(input.agentId); },
  }) });
  const first = await adapter.createSession(create({ agentId: "cli_providerFailA1" }));
  const second = await adapter.createSession(create({ agentId: "cli_providerHealthyB2" }));
  const firstEvents = [];
  const secondEvents = [];
  first.subscribe((event) => firstEvents.push(event));
  second.subscribe((event) => secondEvents.push(event));

  await first.prompt({ inputId: "first-old", kind: "user", text: "old", attempt: 0 });
  listeners.get("cli_providerFailA1")({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  listeners.get("cli_providerFailA1")({ type: "agent_end", messages: [{ role: "assistant", provider: "gateway", stopReason: "error", errorMessage: "invalid request" }] });
  listeners.get("cli_providerFailA1")({ type: "agent_settled" });
  await first.prompt({ inputId: "first-new", kind: "user", text: "new", attempt: 0 });
  listeners.get("cli_providerFailA1")({ type: "agent_settled" });
  assert.equal(firstEvents.filter((event) => event.type === "input-error").length, 1, "late settled cannot close the unstarted next request");
  listeners.get("cli_providerFailA1")({ type: "turn_start", turnIndex: 1, timestamp: Date.now() });
  listeners.get("cli_providerFailA1")({ type: "agent_end", messages: [{ role: "assistant", provider: "gateway", stopReason: "stop" }] });
  listeners.get("cli_providerFailA1")({ type: "agent_settled" });
  assert.equal(firstEvents.filter((event) => event.type === "turn-end").length, 2);

  assert.equal((await second.prompt({ inputId: "second-ok", kind: "user", text: "ok", attempt: 0 })).status, "accepted");
  listeners.get("cli_providerHealthyB2")({ type: "turn_start", turnIndex: 0, timestamp: Date.now() });
  listeners.get("cli_providerHealthyB2")({ type: "agent_end", messages: [{ role: "assistant", provider: "gateway", stopReason: "stop" }] });
  listeners.get("cli_providerHealthyB2")({ type: "agent_settled" });
  assert.equal(secondEvents.filter((event) => event.type === "turn-end").length, 1);
});

test("Pi resume requires the exact persisted session and recognizes the old 0.73 header shape", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-resume-"));
  try {
    const fixture = path.join(directory, "2026-01-01T00-00-00_old-session.jsonl");
    fs.writeFileSync(fixture, `${JSON.stringify({ type: "session", version: 3, id: "old-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/old" })}\n`);
    assert.equal(requirePiResumeSessionFile(directory, "old-session"), fixture);
    assert.throws(() => requirePiResumeSessionFile(directory, "missing-session"), /resume session not found.*silently create a fresh/i);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("Pi replaces only a provably zero-turn missing session and keeps meaningful missing resumes fail-closed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-zero-turn-"));
  try {
    const stateDir = path.join(root, "state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "status.json"), JSON.stringify({ session: { runtime: "pi", id: "empty-session", turns: 0 } }));
    const replacement = createPiSessionManager({ workspaceDir: path.join(root, "workspace"), stateDir, resumeSessionId: "empty-session" });
    assert.notEqual(replacement.getSessionId(), "empty-session");

    fs.writeFileSync(path.join(stateDir, "status.json"), JSON.stringify({ session: { runtime: "pi", id: "meaningful-session", turns: 1 } }));
    assert.throws(
      () => createPiSessionManager({ workspaceDir: path.join(root, "workspace"), stateDir, resumeSessionId: "meaningful-session" }),
      /resume session not found.*silently create a fresh/i,
    );
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Pi default runtime fails closed with an empty unauthenticated official agent directory", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-no-auth-"));
  const child = new FakeProcess();
  child.kill = () => { child.emit("exit", 0, null); return true; };
  try {
    const pending = createNativeRuntimeAdapter("pi", {
      env: { LARKIN_PI_COMMAND: process.execPath },
      resolvePiProcessExtensionArgs: () => [],
      spawn: () => child,
    }).createSession(create({
      workspaceDir: path.join(root, "workspace"),
      stateDir: path.join(root, "state"),
      model: "default",
    }));
    await new Promise((resolve) => setImmediate(resolve));
    for (const request of child.writes.slice(0, 2)) {
      const data = request.type === "get_available_models"
        ? { models: [] }
        : { model: null, thinkingLevel: "off" };
      child.stdout.write(`${JSON.stringify({
        type: "response", id: request.id, command: request.type, success: true, data,
      })}\n`);
    }
    await assert.rejects(pending, /no authenticated available models.*will not create a fallback session/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("literal default model is omitted from Codex and Claude native launch protocols", async () => {
  const codex = new FakeProcess();
  await createNativeRuntimeAdapter("codex", { spawn: () => codex }).createSession(create({ model: "default" }));
  codex.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(codex.writes.find((request) => request.method === "thread/start").params.model, undefined);

  const claude = new FakeProcess();
  let args;
  await createNativeRuntimeAdapter("claude", {
    spawn: (_command, spawnArgs) => { args = spawnArgs; return claude; },
    mkdir: () => {},
    writeFile: () => {},
  }).createSession(create({ model: "default" }));
  assert.equal(args.includes("--model"), false);
  assert.equal(args.includes("default"), false);
});

test("Codex v2 ErrorNotification correlates nested willRetry and terminal turn errors without session fatal", async () => {
  const child = new FakeProcess();
  const session = await createNativeRuntimeAdapter("codex", { spawn: () => child }).createSession(create());
  const events = [];
  session.subscribe((event) => events.push(event));
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const threadRequest = child.writes.find((request) => request.method === "thread/start");
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: threadRequest.id, result: { thread: { id: "thread-v2" } } })}\n`);
  const pending = session.prompt({ inputId: "input-v2", kind: "wake", text: "exact inbox check", attempt: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const turnRequest = child.writes.at(-1);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: turnRequest.id, result: {} })}\n`);
  assert.equal((await pending).status, "accepted");
  child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { turn: { id: "turn-v2" } } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "error", params: { error: { message: "temporary upstream failure" }, willRetry: true } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "error", params: { error: { message: "terminal turn failure" }, willRetry: false } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.filter((event) => event.type === "input-error"), [
    { type: "input-error", inputId: "input-v2", retryable: true, willRetry: true, message: "temporary upstream failure" },
    { type: "input-error", inputId: "input-v2", retryable: false, willRetry: false, message: "terminal turn failure" },
  ]);
  assert.equal(events.some((event) => event.type === "error"), false);
});

test("Codex turn errors terminate every accepted input owned by the prompt and its steers", async () => {
  const child = new FakeProcess();
  const session = await createNativeRuntimeAdapter("codex", { spawn: () => child }).createSession(create());
  const events = [];
  session.subscribe((event) => events.push(event));
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  const threadRequest = child.writes.find((request) => request.method === "thread/start");
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: threadRequest.id, result: { thread: { id: "thread-correlation" } } })}\n`);
  const prompt = session.prompt({ inputId: "input-A", kind: "wake", text: "A", attempt: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const start = child.writes.at(-1);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: start.id, result: { turn: { id: "turn-A" } } })}\n`);
  assert.equal((await prompt).status, "accepted");
  child.stdout.write(`${JSON.stringify({ method: "turn/started", params: { threadId: "thread-correlation", turn: { id: "turn-A" } } })}\n`);
  const steer = session.busyInput({ inputId: "input-B", kind: "inbox_update", text: "B", attempt: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const steerRequest = child.writes.at(-1);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: steerRequest.id, result: {} })}\n`);
  assert.equal((await steer).status, "accepted");
  child.stdout.write(`${JSON.stringify({ method: "error", params: {
    threadId: "thread-correlation", turnId: "turn-A", error: { message: "turn-A failed" }, willRetry: false,
  } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.filter((event) => event.type === "input-error" && event.message === "turn-A failed")
    .map((event) => event.inputId).sort(), ["input-A", "input-B"]);
});

test("Codex 0.144.6 failed TurnCompletedNotification closes inputs without a preceding ErrorNotification", async () => {
  const { child, events, turnId } = await startedCodexTurn();
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: {
    id: turnId, status: "failed", error: { message: "provider rejected turn" },
  } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === "input-error" && event.inputId === "input-A"
    && event.retryable === false && event.message === "provider rejected turn"));
  assert.ok(events.some((event) => event.type === "turn-end" && event.turnId === turnId));
});

test("Codex interrupted TurnCompletedNotification returns every owned input as retryable", async () => {
  const { child, session, events, turnId } = await startedCodexTurn();
  const steer = session.busyInput({ inputId: "input-B", kind: "inbox_update", text: "B", attempt: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: child.writes.at(-1).id, result: {} })}\n`);
  assert.equal((await steer).status, "accepted");
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: {
    id: turnId, status: "interrupted", error: { message: "turn interrupted" },
  } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.filter((event) => event.type === "input-error" && event.message === "turn interrupted")
    .map((event) => [event.inputId, event.retryable]).sort(), [["input-A", true], ["input-B", true]]);
});

test("Codex willRetry remains transient, then failed completion terminally closes the same input once", async () => {
  const { child, events, turnId } = await startedCodexTurn();
  const temporary = { method: "error", params: { turnId, error: { message: "upstream retry" }, willRetry: true } };
  child.stdout.write(`${JSON.stringify(temporary)}\n${JSON.stringify(temporary)}\n`);
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: {
    id: turnId, status: "failed", error: { message: "upstream exhausted" },
  } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === "input-error" && event.willRetry).length, 1);
  assert.equal(events.filter((event) => event.type === "input-error" && event.willRetry === false).length, 1);
});

test("Codex retains bounded completed-turn ownership for late errors and deduplicates terminal handling", async () => {
  const { child, events, turnId } = await startedCodexTurn();
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } })}\n`);
  const late = { method: "error", params: { turnId, error: { message: "late terminal error" }, willRetry: false } };
  child.stdout.write(`${JSON.stringify(late)}\n${JSON.stringify(late)}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === "input-error" && event.message === "late terminal error").length, 1);
});

test("Codex normal completed turn emits no input error", async () => {
  const { child, events, turnId } = await startedCodexTurn();
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event.type === "input-error"), false);
});

test("Codex normal completion before steer response defers the unconfirmed steer instead of accepting it", async () => {
  const { child, session, events, turnId } = await startedCodexTurn();
  const steer = session.busyInput({ inputId: "input-late-B", kind: "inbox_update", text: "B", attempt: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const steerRequest = child.writes.at(-1);
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: { id: turnId, status: "completed" } } })}\n`);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: steerRequest.id, result: {} })}\n`);
  const result = await steer;
  assert.deepEqual(result, { status: "rejected", inputId: "input-late-B", retryable: true,
    reason: "Codex turn ended before steer acceptance" });
  assert.equal(events.filter((event) => event.type === "input-error" && event.inputId === "input-late-B").length, 1);
});

test("Codex interrupted completion before steer response applies the recorded retryable outcome to the late steer", async () => {
  const { child, session, events, turnId } = await startedCodexTurn();
  const steer = session.busyInput({ inputId: "input-late-interrupted-B", kind: "inbox_update", text: "B", attempt: 0 });
  await new Promise((resolve) => setImmediate(resolve));
  const steerRequest = child.writes.at(-1);
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: {
    id: turnId, status: "interrupted", error: { message: "owner interrupted" },
  } } })}\n`);
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: steerRequest.id, result: {} })}\n`);
  assert.deepEqual(await steer, { status: "rejected", inputId: "input-late-interrupted-B", retryable: true,
    reason: "owner interrupted" });
  assert.equal(events.filter((event) => event.type === "input-error"
    && event.inputId === "input-late-interrupted-B" && event.message === "owner interrupted").length, 1);
});

test("Codex failed turn compatibility error enters configuration recovery", async () => {
  const { child, events, turnId } = await startedCodexTurn();
  child.stdout.write(`${JSON.stringify({ method: "turn/completed", params: { turn: {
    id: turnId, status: "failed", error: { message: "model requires a newer version of Codex" },
  } } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === "configuration-error").length, 1);
  assert.equal(events.some((event) => event.type === "input-error"), false);
});

test("Codex v2 compatibility and fatal notifications are classified separately", async () => {
  const child = new FakeProcess();
  const session = await createNativeRuntimeAdapter("codex", { spawn: () => child }).createSession(create());
  const events = [];
  session.subscribe((event) => events.push(event));
  child.stdout.write(`${JSON.stringify({ method: "error", params: { error: { message: "model requires a newer version of Codex" }, willRetry: false } })}\n`);
  child.stdout.write(`${JSON.stringify({ method: "error", params: { error: { message: "stdio transport broke", type: "transport-error" }, fatal: true } })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(events.some((event) => event.type === "configuration-error" && /newer version/.test(event.message)));
  assert.ok(events.some((event) => event.type === "error" && event.message === "stdio transport broke"));
});

test("Codex explicit runtime model override wins without changing stored config defaults", async () => {
  const child = new FakeProcess();
  await createNativeRuntimeAdapter("codex", { spawn: () => child, codexModelOverride: "escape-model" }).createSession(create({ model: "stored-new-model" }));
  child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} })}\n`);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.writes.find((request) => request.method === "thread/start").params.model, "escape-model");
});

test("Codex compatibility recovery updates the exact configured executable once per startup", async () => {
  const calls = [];
  const update = new FakeProcess();
  const adapter = createNativeRuntimeAdapter("codex", {
    codexCommand: "/opt/pinned/codex",
    spawn: () => new FakeProcess(),
    spawnCodexUpdate(command, args, options) {
      calls.push({ command, args, options });
      return update;
    },
  });
  const message = "model requires a newer version of Codex";
  let eventLoopTicked = false;
  setTimeout(() => { eventLoopTicked = true; update.stdout.write("updated to 0.144.6"); update.emit("exit", 0, null); }, 5);
  const pending = Promise.all([
    adapter.recoverConfigurationError(message),
    adapter.recoverConfigurationError(message),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(eventLoopTicked, false, "update remains in flight while the event loop continues");
  const [first, second] = await pending;
  assert.equal(eventLoopTicked, true);
  assert.deepEqual(first, second);
  assert.equal(first.recovered, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "/opt/pinned/codex");
  assert.deepEqual(calls[0].args, ["update"]);
  assert.equal(calls[0].options.cwd, undefined, "shared adapters never borrow another Agent's workspace cwd");
  const later = await adapter.recoverConfigurationError(message);
  assert.equal(later.recovered, false);
  assert.match(later.reason, /already attempted/);
  assert.equal(calls.length, 1, "completed recovery cannot update-loop");
});

test("Codex recovery never updates for unrelated errors and preserves failed update diagnostics", async () => {
  let calls = 0;
  const update = new FakeProcess();
  const adapter = createNativeRuntimeAdapter("codex", {
    spawnCodexUpdate() { calls += 1; queueMicrotask(() => { update.stderr.write("permission denied"); update.emit("exit", 1, null); }); return update; },
  });
  const unrelated = await adapter.recoverConfigurationError("authentication failed");
  assert.equal(unrelated.recovered, false);
  assert.equal(calls, 0);
  const original = "selected model requires a newer version of Codex";
  const [failed, concurrent] = await Promise.all([
    adapter.recoverConfigurationError(original), adapter.recoverConfigurationError(original),
  ]);
  assert.deepEqual(failed, concurrent);
  assert.equal(failed.recovered, false);
  assert.match(failed.reason, /selected model requires a newer version of Codex/);
  assert.match(failed.reason, /Codex update failed \(1\): permission denied/);
  assert.equal(calls, 1);
});

test("Codex update timeout terminates then kills the child and settles once", async () => {
  const update = new FakeProcess();
  const adapter = createNativeRuntimeAdapter("codex", {
    spawnCodexUpdate: () => update,
    codexUpdateTimeoutMs: 5,
    codexUpdateKillGraceMs: 5,
  });
  const result = await adapter.recoverConfigurationError("model requires a newer version of Codex");
  assert.equal(result.recovered, false);
  assert.match(result.reason, /timed out/);
  assert.deepEqual(update.killed, ["SIGTERM", "SIGKILL"]);
});
