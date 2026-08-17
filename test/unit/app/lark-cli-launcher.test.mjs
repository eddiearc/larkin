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
  const historyHolder = { value: history };
  let writeResult = { status: 7, signal: null, output: [], pid: 1,
    stdout: "native-out\n", stderr: "native-err\n", error: undefined };
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const isHistory = ["+chat-messages-list", "+threads-messages-list"].includes(args[2])
      || (args[1] === "api" && args[2] === "GET" && args[3] === "/open-apis/im/v1/messages");
    return isHistory
      ? { status: 0, signal: null, output: [], pid: 1, stdout: JSON.stringify(historyHolder.value), stderr: "", error: undefined }
      : writeResult;
  };
  const run = (argv) => {
    output.stdout = "";
    output.stderr = "";
    const code = launcher.runLarkCli(argv, { LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId }, {
      io: { stdout(text) { output.stdout += text; }, stderr(text) { output.stderr += text; } },
      spawn, nativeCommand: { command: process.execPath, argsPrefix: ["/fixed/@larksuite/cli/scripts/run.js"], version: "1.0.80" }, stateStore: store,
    });
    return { code, ...output };
  };
  return { root, store, calls, run, setWriteResult(value) { writeResult = value; }, setHistory(value) { historyHolder.value = value; } };
}

test("launcher classifies protected writes, removed drafts, bypasses, and observational help", () => {
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-send", "--chat-id", "oc_x", "--text", "hi"]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(["im", "+messages-reply", "--message-id", "om_x", "--text", "hi"]).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(["larkin-draft", "list"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["im", "messages", "create", "--data", "{}"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["api", "POST", "/open-apis/im/v1/messages"]).kind, "denied");
  assert.equal(launcher.classifyLarkCliCommand(["auth", "--help"]).kind, "passthrough");
  assert.equal(launcher.classifyLarkCliCommand(["docs", "+fetch", "--text", "api"]).kind, "passthrough");
  assert.equal(launcher.classifyLarkCliCommand(["comment", "reply", "--message-id", "doc_comment_x", "--text", "answer"]).kind, "comment-reply");
  assert.equal(launcher.classifyLarkCliCommand(["comment", "delete"]).kind, "denied");
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

test("document comment reply is bound to a polled Inbox locator, Bot identity, exact route, and local idempotency ledger", () => {
  const f = fixture();
  try {
    const messageId = `doc_comment_${"a".repeat(32)}`;
    const target = "document-comment:docx:doc_tokenA1:comment_A1:in-thread";
    f.store.appendInboxOnce({ message_id: messageId, target, kind: "document_comment", content: "question" });
    const beforePoll = f.run(["comment", "reply", "--message-id", messageId, "--text", "answer", "--json"]);
    assert.equal(beforePoll.code, 2);
    assert.match(beforePoll.stderr, /先 poll/);
    assert.equal(f.calls.length, 0);
    f.store.pollInbox({ target, limit: 1 });
    f.setWriteResult({ status: 0, signal: null, output: [], pid: 1,
      stdout: JSON.stringify({ ok: true, identity: "bot", data: {} }) + "\n", stderr: "", error: undefined });
    const sent = f.run(["comment", "reply", "--message-id", messageId, "--text", "answer", "--json"]);
    assert.equal(sent.code, 0, sent.stderr);
    assert.equal(f.calls.length, 1);
    const native = f.calls[0].args.slice(1);
    assert.deepEqual(native.slice(0, 7), [
      "drive", "file.comment.replys", "create",
      "--file-token", "doc_tokenA1",
      "--comment-id", "comment_A1",
    ]);
    assert.equal(native[native.indexOf("--file-type") + 1], "docx");
    assert.equal(native[native.indexOf("--as") + 1], "bot");
    assert.deepEqual(JSON.parse(native[native.indexOf("--data") + 1]), {
      content: { elements: [{ type: "text_run", text_run: { text: "answer" } }] },
    });
    const duplicate = f.run(["comment", "reply", "--message-id", messageId, "--text", "answer", "--json"]);
    assert.equal(duplicate.code, 0);
    assert.match(duplicate.stdout, /"duplicate":true/);
    assert.equal(f.calls.length, 1, "committed reply must not reach the provider twice");
    assert.equal(f.run(["comment", "reply", "--message-id", messageId, "--text", "changed", "--json"]).code, 2);
    assert.equal(f.calls.length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("whole-document Inbox locators select the explicit top-level fallback and reject guessed messages", () => {
  const f = fixture();
  try {
    const messageId = `doc_comment_${"b".repeat(32)}`;
    const target = "document-comment:sheet:sheet_tokenA1:comment_B1:top-level";
    f.store.appendInboxOnce({ message_id: messageId, target, kind: "document_comment", content: "question" });
    f.store.pollInbox({ target, limit: 1 });
    f.setWriteResult({ status: 0, signal: null, output: [], pid: 1, stdout: "{}\n", stderr: "", error: undefined });
    assert.equal(f.run(["comment", "reply", "--message-id", messageId, "--text", "answer"]).code, 0);
    const native = f.calls[0].args.slice(1);
    assert.deepEqual(native.slice(0, 5), [
      "drive", "file.comments", "create_v2", "--file-token", "sheet_tokenA1",
    ]);
    assert.deepEqual(JSON.parse(native[native.indexOf("--data") + 1]), {
      file_type: "sheet",
      reply_elements: [{ type: "text", text: "answer" }],
    });
    assert.equal(native[native.indexOf("--as") + 1], "bot");
    assert.equal(f.run(["comment", "reply", "--message-id", `doc_comment_${"c".repeat(32)}`, "--text", "answer"]).code, 2);
    assert.equal(f.calls.length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("document comment reply retains ambiguous native outcomes as sending and retries only definitive provider rejection", () => {
  const ambiguous = [
    { status: null, signal: "SIGKILL", output: [], pid: 1, stdout: "", stderr: "", error: undefined },
    { status: null, signal: null, output: [], pid: 1, stdout: "", stderr: "", error: Object.assign(new Error("spawn failed"), { code: "EIO" }) },
    { status: null, signal: null, output: [], pid: 1, stdout: "", stderr: "", error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) },
    { status: 7, signal: null, output: [], pid: 1, stdout: "", stderr: "unknown local failure", error: undefined },
  ];
  for (const [index, result] of ambiguous.entries()) {
    const f = fixture();
    try {
      const messageId = `doc_comment_${String(index + 1).repeat(32)}`;
      const target = `document-comment:docx:doc_token${index}:comment_${index}:in-thread`;
      f.store.appendInboxOnce({ message_id: messageId, target, kind: "document_comment", content: "question" });
      f.store.pollInbox({ target, limit: 1 });
      f.setWriteResult(result);
      assert.notEqual(f.run(["comment", "reply", "--message-id", messageId, "--text", "answer"]).code, 0);
      assert.equal(f.store.readJson("freshnessState", {}).document_comment_replies[messageId].status, "sending");
      const retry = f.run(["comment", "reply", "--message-id", messageId, "--text", "answer"]);
      assert.equal(retry.code, 2);
      assert.match(retry.stderr, /结果不明确/);
      assert.equal(f.calls.length, 1, "ambiguous outcome must never resend");
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }

  const rejected = fixture();
  try {
    const messageId = `doc_comment_${"e".repeat(32)}`;
    const target = "document-comment:docx:doc_tokenE:comment_E:in-thread";
    rejected.store.appendInboxOnce({ message_id: messageId, target, kind: "document_comment", content: "question" });
    rejected.store.pollInbox({ target, limit: 1 });
    rejected.setWriteResult({ status: 7, signal: null, output: [], pid: 1, stdout: "", stderr: JSON.stringify({
      ok: false, error: { code: 1069302, message: "provider rejected" },
    }), error: undefined });
    assert.equal(rejected.run(["comment", "reply", "--message-id", messageId, "--text", "answer"]).code, 7);
    assert.equal(rejected.store.readJson("freshnessState", {}).document_comment_replies[messageId].status, "failed");
    assert.equal(rejected.run(["comment", "reply", "--message-id", messageId, "--text", "answer"]).code, 7);
    assert.equal(rejected.calls.length, 2, "definitive provider rejection may be retried");
  } finally { fs.rmSync(rejected.root, { recursive: true, force: true }); }
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

test("Runtime-bound history shortcuts default to 20 while preserving explicit page sizes", () => {
  const f = fixture();
  try {
    for (const argv of [
      ["im", "+chat-messages-list", "--chat-id", "oc_default", "--order", "desc", "--json"],
      ["im", "+threads-messages-list", "--thread", "omt_default", "--order", "desc", "--json"],
    ]) {
      const before = f.calls.length;
      f.run(argv);
      const shortcut = f.calls.slice(before).find((call) => call.args[2] === argv[1]).args.slice(1);
      assert.equal(shortcut[shortcut.indexOf("--page-size") + 1], "20");
    }

    const explicitBefore = f.calls.length;
    f.run(["im", "+chat-messages-list", "--chat-id", "oc_explicit", "--page-size", "7", "--json"]);
    const explicit = f.calls.slice(explicitBefore).find((call) => call.args[2] === "+chat-messages-list").args.slice(1);
    assert.equal(explicit[explicit.indexOf("--page-size") + 1], "7");
    assert.equal(explicit.filter((argument) => argument === "--page-size").length, 1);

    f.run(["im", "+threads-messages-list", "--thread", "omt_inline", "--page-size=9", "--json"]);
    const inline = f.calls.at(-1).args.slice(1);
    assert.equal(inline.includes("--page-size=9"), true);
    assert.equal(inline.includes("20"), false);

    const boundaryBefore = f.calls.length;
    f.run(["im", "+chat-messages-list", "--chat-id", "oc_boundary", "--json", "--", "--page-size", "99"]);
    const bounded = f.calls.slice(boundaryBefore).find((call) => call.args[2] === "+chat-messages-list").args.slice(1);
    const boundary = bounded.indexOf("--");
    assert.deepEqual(bounded.slice(boundary - 2), ["--page-size", "20", "--", "--page-size", "99"]);

    for (const argv of [
      ["--json", "im", "+chat-messages-list", "--chat-id", "oc_prefixed", "--order", "desc"],
      ["im", "--json", "+threads-messages-list", "--thread", "omt_middle", "--order", "desc"],
    ]) {
      const before = f.calls.length;
      f.run(argv);
      const shortcut = f.calls.slice(before).find((call) => call.args.includes(argv.includes("+chat-messages-list")
        ? "+chat-messages-list" : "+threads-messages-list")).args.slice(1);
      assert.equal(shortcut[shortcut.indexOf("--page-size") + 1], "20");
    }
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

function ownBotMessage(overrides = {}) {
  return {
    message_id: "om_own_urgent",
    chat_id: "oc_urgent",
    create_time: "1786957010773",
    sender: { id: "cli_nativeLarkA1", id_type: "app_id", sender_type: "app" },
    ...overrides,
  };
}

function urgentArgv(overrides = {}) {
  return [
    "im", "+messages-urgent-app",
    "--chat-id", overrides.chatId ?? "oc_urgent",
    "--message-id", overrides.messageId ?? "om_own_urgent",
    "--user-id-type", overrides.userIdType ?? "open_id",
    "--data", overrides.data ?? JSON.stringify({ user_id_list: ["ou_10937ddc38cfd9fd239591c634fed234"] }),
  ];
}

function seedUrgentCursor(store, revisionTime = "1786957010773", messageIds = ["om_own_urgent"]) {
  store.mergeFreshnessCursor("feishu.im/chat/oc_urgent", {
    schema: 1, revisionTime, messageIds,
  }, (seen, current) => current ?? seen);
}

test("protected urgent-app classifies as guarded and keeps raw urgent denied", () => {
  assert.equal(launcher.classifyLarkCliCommand(urgentArgv()).kind, "guarded");
  assert.equal(launcher.classifyLarkCliCommand(urgentArgv()).operation, "urgent-app");
  assert.equal(launcher.classifyLarkCliCommand(["im", "messages", "urgent_app", "--message-id", "om_own_urgent"]).kind, "denied");
});

test("protected urgent-app probes freshness then rewrites to native urgent_app for the bot's own message", () => {
  const f = fixture({
    ok: true,
    identity: "bot",
    data: { messages: [ownBotMessage()] },
  });
  try {
    seedUrgentCursor(f.store);
    f.setWriteResult({
      status: 0, signal: null, output: [], pid: 1,
      stdout: `${JSON.stringify({ ok: true, identity: "bot", data: { invalid_user_id_list: [] } })}\n`,
      stderr: "", error: undefined,
    });
    const sent = f.run(urgentArgv());
    assert.equal(sent.code, 0, sent.stderr);
    const writeCall = f.calls.find((call) => call.args[2] === "messages" && call.args[3] === "urgent_app");
    assert.ok(writeCall, "native urgent_app must be spawned after freshness");
    const write = writeCall.args.slice(1);
    assert.deepEqual(write.slice(0, 3), ["im", "messages", "urgent_app"]);
    assert.equal(write.includes("+messages-urgent-app"), false);
    assert.equal(write.includes("--chat-id"), false);
    assert.equal(write[write.indexOf("--message-id") + 1], "om_own_urgent");
    assert.equal(write[write.indexOf("--user-id-type") + 1], "open_id");
    assert.equal(write[write.indexOf("--as") + 1], "bot");
    assert.deepEqual(JSON.parse(write[write.indexOf("--data") + 1]), {
      user_id_list: ["ou_10937ddc38cfd9fd239591c634fed234"],
    });
    const again = f.run(urgentArgv());
    assert.equal(again.code, 0, again.stderr);
    assert.equal(f.calls.filter((call) => call.args[2] === "messages" && call.args[3] === "urgent_app").length, 2);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("protected urgent-app fails closed for foreign, synthetic, malformed, and unseen messages", () => {
  const f = fixture({
    ok: true,
    identity: "bot",
    data: { messages: [
      ownBotMessage(),
      ownBotMessage({ message_id: "om_other", sender: { id: "ou_human", sender_type: "user" } }),
    ] },
  });
  try {
    seedUrgentCursor(f.store, "1786957010773", ["om_own_urgent", "om_other"]);
    for (const argv of [
      urgentArgv({ messageId: "om_other" }),
      urgentArgv({ messageId: "rem_not_a_message" }),
      urgentArgv({ messageId: "om_missing" }),
      urgentArgv({ userIdType: "user_id" }),
      urgentArgv({ data: JSON.stringify({ user_id_list: ["not-an-open-id"] }) }),
      ["im", "+messages-urgent-app", "--user-id", "ou_10937ddc38cfd9fd239591c634fed234", "--message-id", "om_own_urgent", "--user-id-type", "open_id", "--data", JSON.stringify({ user_id_list: ["ou_10937ddc38cfd9fd239591c634fed234"] })],
    ]) {
      const before = f.calls.length;
      assert.equal(f.run(argv).code, 2, argv.join(" "));
      assert.equal(f.calls.slice(before).some((call) => call.args[2] === "urgent_app"), false, argv.join(" "));
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("protected urgent-app does not submit after a freshness conflict", () => {
  const f = fixture({
    ok: true,
    identity: "bot",
    data: { messages: [ownBotMessage({ create_time: "1786957010774" })] },
  });
  try {
    f.store.mergeFreshnessCursor("feishu.im/chat/oc_urgent", {
      schema: 1, revisionTime: "1786957010773", messageIds: ["om_seen"],
    }, (seen, current) => current ?? seen, "gen");
    const conflicted = f.run(urgentArgv());
    assert.equal(conflicted.code, 3, conflicted.stderr);
    assert.match(conflicted.stderr, /freshness_conflict/);
    assert.equal(f.calls.some((call) => call.args[2] === "urgent_app"), false);
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
    assert.equal(f.run(argv).code, 137);
    keys.push(f.calls.at(-1).args[f.calls.at(-1).args.indexOf("--idempotency-key") + 1]);
    assert.equal(keys[0], keys[1]);
    assert.match(keys[0], /^larkin-[0-9a-f]{32}$/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("--mention is no longer translated: argv passes through to the native CLI untouched", () => {
  const f = fixture();
  try {
    // --mention 不再触发任何重写：不注入 --content/--msg-type，正文原样透传。
    const result = f.run(["im", "+messages-send", "--chat-id", "oc_mention", "--mention", "ou_mention123", "--text", "hello"]);
    assert.deepEqual({ code: result.code, stdout: result.stdout, stderr: result.stderr }, {
      code: 7, stdout: "native-out\n", stderr: "native-err\n",
    });
    assert.deepEqual(f.calls.map((call) => call.args[2]), ["GET", "+messages-send"]);
    const write = f.calls[1].args;
    assert.equal(write.includes("--content"), false);
    assert.equal(write.includes("--msg-type"), false);
    assert.equal(write.includes("--mention"), true);
    assert.equal(write[write.indexOf("--text") + 1], "hello");

    // 非 im +messages-send/reply 命令同样原样透传。
    assert.equal(launcher.classifyLarkCliCommand(["im", "+chat-list", "--mention", "ou_ok123"]).kind, "passthrough");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("cursor advancement between attempts keeps the derived idempotency key stable and flags provider dedup", () => {
  const f = fixture();
  try {
    const argv = ["im", "+messages-send", "--chat-id", "oc_retry", "--text", "same intent"];
    f.setWriteResult({ status: 7, signal: null, output: [], pid: 1, stdout: "", stderr: "failed\n", error: undefined });
    assert.equal(f.run(argv).code, 7);
    const firstKey = f.calls.at(-1).args[f.calls.at(-1).args.indexOf("--idempotency-key") + 1];

    // 两次尝试之间 Agent 读了一次历史：观察读会推进 freshness 水位（正是事故中的解除 gate 动作）。
    f.setHistory({ ok: true, identity: "bot", data: { messages: [
      { message_id: "om_seen1", chat_id: "oc_retry", create_time: "1786553650353" },
    ] } });
    assert.equal(f.run(["im", "+chat-messages-list", "--chat-id", "oc_retry", "--order", "desc", "--json"]).code, 0);

    f.setWriteResult({ status: 0, signal: null, output: [], pid: 1,
      stdout: `${JSON.stringify({ ok: true, identity: "bot", data: { message_id: "om_dedup1", chat_id: "oc_retry", create_time: "1786553650354" } })}\n`,
      stderr: "", error: undefined });
    const sent = f.run(argv);
    assert.equal(sent.code, 0, sent.stderr);
    const retryKey = f.calls.at(-1).args[f.calls.at(-1).args.indexOf("--idempotency-key") + 1];
    assert.equal(retryKey, firstKey, "水位推进后，同一命令重试的幂等 key 必须不变");
    assert.equal(JSON.parse(sent.stdout).duplicate, undefined, "首次成功不是 duplicate");

    // 服务端幂等去重：同 key 返回同一个 message_id → 标注 duplicate，不产生第二条消息。
    // 首次成功后 provider 历史里已有该消息，探测才能建立可比对的 head。
    f.setHistory({ ok: true, identity: "bot", data: { messages: [
      { message_id: "om_dedup1", chat_id: "oc_retry", create_time: "1786553650354" },
      { message_id: "om_seen1", chat_id: "oc_retry", create_time: "1786553650353" },
    ] } });
    const duplicated = f.run(argv);
    assert.equal(duplicated.code, 0, duplicated.stderr);
    assert.equal(JSON.parse(duplicated.stdout).duplicate, true);
    assert.match(duplicated.stdout, /om_dedup1/);

    // 不同内容 → 不同 key。
    const changed = f.run(["im", "+messages-send", "--chat-id", "oc_retry", "--text", "different"]);
    const changedKey = f.calls.at(-1).args[f.calls.at(-1).args.indexOf("--idempotency-key") + 1];
    assert.notEqual(changedKey, retryKey);

    // 显式传入的 --idempotency-key 被尊重：不注入默认编号。
    f.run(["im", "+messages-send", "--chat-id", "oc_retry", "--text", "same intent", "--idempotency-key", "forced-fresh-key"]);
    const forced = f.calls.at(-1).args.slice(1);
    assert.equal(forced[forced.indexOf("--idempotency-key") + 1], "forced-fresh-key");
    assert.equal(forced.filter((argument) => argument === "--idempotency-key").length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
