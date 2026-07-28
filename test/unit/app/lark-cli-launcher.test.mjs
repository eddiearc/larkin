import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const launcher = await import(pathToFileURL(path.join(ROOT, "dist/app/lark-cli.mjs")).href);
const stateModule = await import(pathToFileURL(path.join(ROOT, "dist/agent/agent-state-store.mjs")).href);

function fixture(history = { ok: true, identity: "bot", data: { messages: [] } }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-native-lark-cli-"));
  const agentId = "cli_nativeLarkA1";
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-native-lark", mentionPolicy: "require", activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "default" } },
  })}\n`, { mode: 0o600 });
  const store = stateModule.createAgentStateStore(root, agentId);
  const output = { stdout: "", stderr: "" };
  const calls = [];
  let writeResult = { status: 7, signal: null, output: [], pid: 1,
    stdout: "native-out\n", stderr: "native-err\n", error: undefined };
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const isHistory = ["+chat-messages-list", "+threads-messages-list"].includes(args[2])
      || (args[1] === "api" && args[2] === "GET" && args[3] === "/open-apis/im/v1/messages");
    return isHistory
      ? { status: 0, signal: null, output: [], pid: 1, stdout: JSON.stringify(history), stderr: "", error: undefined }
      : writeResult;
  };
  const run = (argv) => {
    output.stdout = "";
    output.stderr = "";
    const code = launcher.runLarkCli(argv, { LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId }, {
      io: { stdout(text) { output.stdout += text; }, stderr(text) { output.stderr += text; } },
      spawn, upstreamScript: "/fixed/@larksuite/cli/scripts/run.js", stateStore: store,
    });
    return { code, ...output };
  };
  return { root, store, calls, run, setWriteResult(value) { writeResult = value; } };
}

test("launcher classifies protected writes, removed drafts, bypasses, and observational help", () => {
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-send", "--chat-id", "oc_x", "--text", "hi"]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-reply", "--message-id", "om_x", "--text", "hi"]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(["larkin-draft", "list"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["im", "messages", "create", "--data", "{}"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["api", "POST", "/open-apis/im/v1/messages"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["auth", "--help"]).kind, "passthrough");
  assert.equal(launcher.classifyLarkCliCommand(["docs", "+fetch", "--text", "api"]).kind, "passthrough");
  assert.equal(launcher.classifyLarkCliCommand([
    "im", "+messages-send", "--chat-id", "oc_x", "--thread-id", "omt_x", "--text", "hi",
  ]).kind, "denied", "+messages-send has no native --thread-id support");
  assert.equal(launcher.classifyLarkCliCommand([
    "im", "+messages-reply", "--message-id", "om_x", "--reply-in-thread", "--text", "hi",
  ]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand([
    "im", "+messages-send", "--thread-id", "omt_x", "--help",
  ]).kind, "passthrough", "native help remains observational even for unsupported write flags");
});

test("guarded writes probe with locked Bot identity before preserving provider write bytes", () => {
  const f = fixture();
  try {
    const result = f.run(["im", "+messages-send", "--chat-id", "oc_exact", "--text", "current"]);
    assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, {
      code: 7, stdout: "native-out\n", stderr: "native-err\n",
    });
    assert.deepEqual(f.calls.map((call) => call.args[2]), ["GET", "+messages-send"]);
    const probe = f.calls[0].args.slice(1);
    assert.deepEqual(JSON.parse(probe[probe.indexOf("--params") + 1]), {
      container_id_type: "chat", container_id: "oc_exact", sort_type: "ByCreateTimeDesc", page_size: 20,
    });
    assert.equal(probe[probe.indexOf("--as") + 1], "bot");
    assert.equal(f.calls[1].args.includes("--idempotency-key"), true);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("identity switches and raw write bypasses fail before provider invocation", () => {
  const f = fixture();
  try {
    for (const argv of [
      ["im", "+messages-send", "--chat-id", "oc_x", "--as", "user", "--text", "x"],
      ["im", "+chat-list", "--profile", "other"],
      ["api", "POST", "/open-apis/im/v1/messages", "--data", "{}"],
      ["im", "messages", "create", "--data", "{}"],
      ["larkin-draft", "send", "--draft-id", "draft_old"],
    ]) assert.equal(f.run(argv).code, 2, argv.join(" "));
    assert.equal(f.calls.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("native help and safe reads remain byte-preserving passthroughs", () => {
  const f = fixture();
  try {
    const help = f.run(["im", "+messages-send", "--as", "user", "--help"]);
    assert.deepEqual({ code: help.code, stdout: help.stdout, stderr: help.stderr }, {
      code: 7, stdout: "native-out\n", stderr: "native-err\n",
    });
    assert.equal(f.calls.length, 1);
    assert.equal(fs.existsSync(f.store.paths.freshnessState), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("normalized and prefixed policy syntax cannot bypass the authoritative gate", () => {
  assert.equal(launcher.classifyLarkCliCommand(["--chat-id", "oc_x", "im", "+messages-send", "--text", "x"]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(["im", "--chat-id", "oc_x", "+messages-send", "--text", "x"]).kind, "guarded");
  for (const argv of [
    ["--text", "stale", "im", "+messages-send", "--chat-id", "oc_x"],
    ["im", "--text", "stale", "+messages-send", "--chat-id", "oc_x"],
    ["-q", ".", "im", "+messages-send", "--chat-id", "oc_x"],
  ]) assert.equal(launcher.classifyLarkCliCommand(argv).kind, "denied", argv.join(" "));
});

test("duplicate policy flags and values after -- cannot alter target or identity", () => {
  const f = fixture();
  try {
    for (const argv of [
      ["im", "+messages-send", "--chat-id", "oc_a", "--chat-id=oc_b", "--text", "x"],
      ["im", "+messages-send", "--chat-id", "oc_a", "--idempotency-key=one", "--idempotency-key", "two", "--text", "x"],
      ["im", "+messages-reply", "--message-id", "om_a", "--message-id=om_b", "--text", "x"],
      ["im", "+messages-send", "--chat-id", "oc_a", "--as", "bot", "--as=user", "--text", "x"],
    ]) assert.equal(f.run(argv).code, 2, argv.join(" "));
    const bounded = f.run(["im", "+messages-send", "--chat-id", "oc_exact", "--text", "x", "--", "--chat-id", "oc_other", "--as", "user", "--help"]);
    assert.equal(bounded.code, 7);
    assert.equal(f.calls.length, 2, "only authoritative probe and guarded write may run");
    const write = f.calls[1].args.slice(1);
    const boundary = write.indexOf("--");
    assert.equal(write[write.indexOf("--chat-id") + 1], "oc_exact");
    assert.equal(write[write.indexOf("--as") + 1], "bot");
    assert.deepEqual(write.slice(boundary + 1), ["--chat-id", "oc_other", "--as", "user", "--help"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("forward merge urgent and raw/API write surfaces remain denied before spawn", () => {
  const f = fixture();
  try {
    for (const argv of [
      ["api", "POST", "/open-apis/im/v1/messages", "--data", "{}"],
      ["im", "messages", "create", "--data", "{}"],
      ["im", "messages", "reply", "--data", "{}"],
      ["im", "messages", "forward", "--message-id", "om_a"],
      ["im", "messages", "merge_forward", "--message-id", "om_a"],
      ["im", "messages", "urgent_app", "--message-id", "om_a"],
      ["im", "messages", "urgent_phone", "--message-id", "om_a"],
      ["im", "messages", "urgent_sms", "--message-id", "om_a"],
      ["im", "threads", "forward", "--message-id", "om_a"],
      ["im", "threads", "merge_forward", "--message-id", "om_a"],
    ]) assert.equal(f.run(argv).code, 2, argv.join(" "));
    assert.equal(f.calls.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("provider failure and ambiguous termination retain a stable idempotency key", () => {
  const f = fixture();
  try {
    const argv = ["im", "+messages-send", "--chat-id", "oc_retry", "--text", "same intent"];
    const keys = [];
    f.setWriteResult({ status: 7, signal: null, output: [], pid: 1, stdout: "", stderr: "failed\n", error: undefined });
    assert.equal(f.run(argv).code, 7);
    keys.push(f.calls.at(-1).args[f.calls.at(-1).args.indexOf("--idempotency-key") + 1]);
    f.setWriteResult({ status: null, signal: "SIGKILL", output: [], pid: 1, stdout: "", stderr: "", error: undefined });
    assert.equal(f.run(argv).code, 1);
    keys.push(f.calls.at(-1).args[f.calls.at(-1).args.indexOf("--idempotency-key") + 1]);
    assert.equal(keys[0], keys[1]);
    assert.match(keys[0], /^larkin-[0-9a-f]{32}$/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
