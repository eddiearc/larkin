import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const AGENT_CLI = path.join(ROOT, "dist/app/agent-cli.mjs");
const LARK_CLI = path.join(ROOT, "dist/app/lark-cli.mjs");
const PRELOAD = path.join(ROOT, "test/support/runtime-agent-interface-v2-provider-preload.cjs");
const PROVIDER = path.join(ROOT, "test/support/runtime-agent-interface-v2-provider.mjs");

beforeAll(() => {
  const result = spawnSync(process.execPath, ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, `build failed\n${result.stdout}\n${result.stderr}`);
});

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-freshness-integration-"));
  fs.chmodSync(root, 0o700);
  const agentId = "cli_freshnessA1";
  const stateDir = path.join(root, "state", "agents", agentId);
  const inboxFile = path.join(stateDir, "feishu-inbox.ndjson");
  const stateFile = path.join(stateDir, "inbox-state.json");
  const callsFile = path.join(root, "provider-calls.ndjson");
  writePrivate(path.join(root, "config.json"), `${JSON.stringify({
    version: 4,
    serverId: "freshness-integration",
    mentionPolicy: "require",
    activeAgent: agentId,
    agents: { [agentId]: { runtime: "pi", model: "default" } },
  }, null, 2)}\n`);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(stateDir, "lark-cli-config"), { recursive: true, mode: 0o700 });
  writePrivate(path.join(stateDir, "lark-cli-config", "config.json"), `${JSON.stringify({
    apps: [{ appId: agentId, name: agentId, appSecret: "fixture-only", brand: "feishu", defaultAs: "bot", strictMode: "bot", users: [] }],
  })}\n`);
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    LARKIN_CONFIG_DIR: root,
    LARKIN_AGENT_ID: agentId,
    LARKIN_TEST_FRESHNESS_PROVIDER: PROVIDER,
    LARKIN_TEST_PROVIDER_CALLS: callsFile,
    BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${PRELOAD}`].filter(Boolean).join(" "),
  };
  const run = (entry, argv, overrides = {}) => spawnSync(process.execPath, [entry, ...argv], {
    cwd: root,
    env: { ...env, ...overrides },
    encoding: "utf8",
    timeout: 30_000,
  });
  const agent = (argv, overrides) => run(AGENT_CLI, argv, overrides);
  const lark = (argv, overrides) => run(LARK_CLI, argv, overrides);
  const append = ({ target = "chat:oc_a", seq, messageId = `om_${seq}`, content = `body-${seq}` }) => {
    const chatId = target.slice("chat:".length);
    fs.appendFileSync(inboxFile, `${JSON.stringify({
      envelope_version: 2,
      target,
      target_seq: seq,
      message_id: messageId,
      chat_id: chatId,
      sender_id: "ou_fixture",
      content,
    })}\n`, { mode: 0o600 });
  };
  const calls = () => {
    try { return fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map(JSON.parse); }
    catch (error) { if (error.code === "ENOENT") return []; throw error; }
  };
  const state = () => JSON.parse(fs.readFileSync(stateFile, "utf8"));
  const json = (result, label) => {
    assert.equal(result.status, 0, `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    return JSON.parse(result.stdout);
  };
  return { root, agentId, stateDir, inboxFile, callsFile, env, agent, lark, append, calls, state, json };
}

function cleanup(f) {
  fs.rmSync(f.root, { recursive: true, force: true });
}

test("process CLI check is byte-stable and poll is bounded, target-local, direct-ack, repeatable, and fail-closed", () => {
  const f = fixture();
  try {
    f.append({ seq: 1, messageId: "om_a1", content: "secret-a1" });
    f.append({ seq: 2, messageId: "om_a2", content: "secret-a2" });
    f.append({ target: "chat:oc_b", seq: 1, messageId: "om_b1", content: "secret-b1" });
    const before = fs.readFileSync(f.inboxFile);
    const first = f.json(f.agent(["inbox", "check"]), "first check");
    const second = f.json(f.agent(["inbox", "check"]), "second check");
    assert.deepEqual(first, second);
    assert.equal(JSON.stringify(first).includes("secret-"), false);
    assert.deepEqual(fs.readFileSync(f.inboxFile), before);

    const invalid = f.agent(["inbox", "poll", "--target", "chat:oc_a", "--limit", "0"]);
    assert.equal(invalid.status, 2);
    assert.deepEqual(fs.readFileSync(f.inboxFile), before, "invalid poll must not consume Inbox bytes");
    const one = f.json(f.agent(["inbox", "poll", "--target", "chat:oc_a", "--limit", "1"]), "bounded poll");
    assert.equal(one.delivery, "direct_ack");
    assert.equal(one.at_most_once, true);
    assert.deepEqual(one.events.map((event) => event.message_id), ["om_a1"]);
    assert.deepEqual(f.json(f.agent(["inbox", "poll", "--target", "chat:oc_a"]), "second poll").events.map((event) => event.message_id), ["om_a2"]);
    assert.deepEqual(f.json(f.agent(["inbox", "poll", "--target", "chat:oc_a"]), "empty poll").events, []);
    assert.deepEqual(f.json(f.agent(["inbox", "poll", "--target", "chat:oc_b"]), "other target poll").events.map((event) => event.message_id), ["om_b1"]);

    writePrivate(f.inboxFile, '{"message_id":"om_bad"}\nnot-json\n');
    const malformedBytes = fs.readFileSync(f.inboxFile);
    const malformed = f.agent(["inbox", "poll"]);
    assert.equal(malformed.status, 2);
    assert.match(malformed.stderr, /invalid NDJSON/);
    assert.deepEqual(fs.readFileSync(f.inboxFile), malformedBytes);
  } finally { cleanup(f); }
});

test("stale send is idempotently held, target-local, listable, sendable once, and abandonable", () => {
  const f = fixture();
  try {
    const sendA = ["im", "+messages-send", "--chat-id", "oc_a", "--text", "stale-a"];
    f.append({ seq: 1, messageId: "om_a1" });
    const held = f.json(f.lark(sendA), "first stale send");
    const repeated = f.json(f.lark(sendA), "repeated stale send");
    assert.equal(held.status, "held");
    assert.equal(repeated.draft_id, held.draft_id);
    assert.equal(f.calls().length, 0);
    assert.deepEqual(f.json(f.lark(["larkin-draft", "list"]), "draft list").drafts.map((draft) => draft.draft_id), [held.draft_id]);

    const other = f.lark(["im", "+messages-send", "--chat-id", "oc_b", "--text", "fresh-b"]);
    assert.equal(other.status, 0, other.stderr);
    assert.equal(f.calls().length, 1, "unseen oc_a must not block oc_b");
    assert.equal(f.calls()[0].as, "bot");
    assert.match(f.calls()[0].idempotency_key, /^larkin-[a-f0-9]{32}$/);

    f.json(f.agent(["inbox", "poll", "--target", "chat:oc_a"]), "poll held target");
    const sent = f.lark(["larkin-draft", "send", "--draft-id", held.draft_id]);
    assert.equal(sent.status, 0, sent.stderr);
    assert.equal(f.calls().length, 2);
    assert.equal(f.state().drafts[held.draft_id].status, "sent");
    const duplicate = f.lark(["larkin-draft", "send", "--draft-id", held.draft_id]);
    assert.equal(duplicate.status, 2);
    assert.equal(f.calls().length, 2, "sent draft must not call provider twice");

    f.append({ seq: 2, messageId: "om_a2" });
    const discard = f.json(f.lark(["im", "+messages-send", "--chat-id", "oc_a", "--text", "discard"]), "held discard draft");
    const abandoned = f.json(f.lark(["larkin-draft", "abandon", "--draft-id", discard.draft_id]), "abandon held draft");
    assert.equal(abandoned.status, "abandoned");
    assert.equal(f.lark(["larkin-draft", "send", "--draft-id", discard.draft_id]).status, 2);
    assert.equal(f.calls().length, 2);
  } finally { cleanup(f); }
});

test("provider failure returns a draft to held and retries with the same idempotency key", () => {
  const f = fixture();
  try {
    f.append({ seq: 1, messageId: "om_retry" });
    const held = f.json(f.lark(["im", "+messages-send", "--chat-id", "oc_a", "--text", "retry"]), "hold retry draft");
    f.json(f.agent(["inbox", "poll", "--target", "chat:oc_a"]), "poll retry target");
    const failed = f.lark(["larkin-draft", "send", "--draft-id", held.draft_id], { LARKIN_TEST_PROVIDER_MODE: "fail" });
    assert.equal(failed.status, 7);
    assert.equal(f.state().drafts[held.draft_id].status, "held");
    const failedKey = f.calls()[0].idempotency_key;
    const retried = f.lark(["larkin-draft", "send", "--draft-id", held.draft_id]);
    assert.equal(retried.status, 0, retried.stderr);
    assert.equal(f.calls()[1].idempotency_key, failedKey);
    assert.equal(f.state().drafts[held.draft_id].status, "sent");
  } finally { cleanup(f); }
});

test("a killed provider parent leaves sending durable and recovery reuses the committed key", () => {
  const f = fixture();
  try {
    f.append({ seq: 1, messageId: "om_crash" });
    const held = f.json(f.lark(["im", "+messages-send", "--chat-id", "oc_a", "--text", "recover"]), "hold crash draft");
    f.json(f.agent(["inbox", "poll", "--target", "chat:oc_a"]), "poll crash target");
    const killed = f.lark(["larkin-draft", "send", "--draft-id", held.draft_id], { LARKIN_TEST_PROVIDER_MODE: "kill-parent" });
    assert.equal(killed.signal, "SIGKILL");
    assert.equal(f.state().drafts[held.draft_id].status, "sending");
    const committedKey = f.calls()[0].idempotency_key;
    const abandon = f.lark(["larkin-draft", "abandon", "--draft-id", held.draft_id]);
    assert.equal(abandon.status, 2);
    assert.match(abandon.stderr, /too late to abandon/);
    const recovered = f.lark(["larkin-draft", "send", "--draft-id", held.draft_id]);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.equal(f.calls()[1].idempotency_key, committedKey);
    assert.equal(f.state().drafts[held.draft_id].status, "sent");
  } finally { cleanup(f); }
});

test("provider-time inbound remains pending, re-holds the next write, and model-seen boundaries rotate idempotency", () => {
  const f = fixture();
  try {
    const send = ["im", "+messages-send", "--chat-id", "oc_a", "--text", "same intent"];
    assert.equal(f.lark(send).status, 0);
    assert.equal(f.lark(send).status, 0);
    assert.equal(f.calls()[0].idempotency_key, f.calls()[1].idempotency_key);

    const concurrent = { envelope_version: 2, target: "chat:oc_a", target_seq: 1, message_id: "om_concurrent", chat_id: "oc_a", content: "arrived during provider" };
    assert.equal(f.lark(["im", "+messages-send", "--chat-id", "oc_a", "--text", "boundary"], {
      LARKIN_TEST_PROVIDER_APPEND_FILE: f.inboxFile,
      LARKIN_TEST_PROVIDER_APPEND_ENVELOPE: JSON.stringify(concurrent),
    }).status, 0);
    assert.equal(f.calls().length, 3, "committed provider call completes despite later inbound");
    const held = f.json(f.lark(send), "write after provider-time inbound");
    assert.equal(held.status, "held");
    assert.equal(f.calls().length, 3);
    f.json(f.agent(["inbox", "poll", "--target", "chat:oc_a"]), "poll provider-time inbound");
    assert.equal(f.lark(send).status, 0);
    assert.notEqual(f.calls().at(-1).idempotency_key, f.calls()[0].idempotency_key);
  } finally { cleanup(f); }
});

test("reply and card writes resolve message locators, hold stale targets, send once when current, and reject unknown locators", () => {
  const f = fixture();
  try {
    f.append({ seq: 1, messageId: "om_ref" });
    const replyArgv = ["im", "+messages-reply", "--message-id", "om_ref", "--text", "reply"];
    const heldReply = f.json(f.lark(replyArgv), "stale reply");
    assert.equal(heldReply.status, "held");
    assert.equal(f.calls().length, 0);
    f.json(f.agent(["inbox", "poll", "--target", "chat:oc_a"]), "poll reply target");
    assert.equal(f.lark(replyArgv).status, 0);
    assert.equal(f.calls().length, 1);
    const unknown = f.lark(["im", "+messages-reply", "--message-id", "om_unknown", "--text", "no"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /无法从 Inbox 状态确定/);
    assert.equal(f.calls().length, 1);

    f.append({ seq: 2, messageId: "om_new" });
    for (const operation of ["patch", "update"]) {
      const card = f.json(f.lark(["im", "messages", operation, "--message-id", "om_ref", "--content", `{\"op\":\"${operation}\"}`]), `stale card ${operation}`);
      assert.equal(card.status, "held");
    }
    assert.equal(f.calls().length, 1);
    f.json(f.agent(["inbox", "poll", "--target", "chat:oc_a"]), "poll card target");
    assert.equal(f.lark(["im", "messages", "patch", "--message-id", "om_ref", "--content", "{}"]).status, 0);
    assert.equal(f.lark(["im", "messages", "update", "--message-id", "om_ref", "--content", "{}"]).status, 0);
    assert.equal(f.calls().length, 3);
  } finally { cleanup(f); }
});

test("identity and write bypasses fail before provider while help and safe reads preserve provider bytes", () => {
  const f = fixture();
  try {
    for (const argv of [
      ["im", "+chat-list", "--profile", "other"],
      ["im", "+chat-list", "--config-dir", "/tmp/escape"],
      ["im", "+messages-send", "--chat-id", "oc_a", "--as", "user", "--text", "x"],
      ["config", "list"],
      ["event", "listen"],
      ["attendance", "+user-task-list"],
      ["api", "POST", "/open-apis/im/v1/messages"],
      ["im", "messages", "create", "--chat-id", "oc_a", "--content", "{}"],
      ["im", "messages", "forward", "--message-id", "om_a"],
      ["im", "threads", "merge_forward", "--message-id", "om_a"],
    ]) {
      const result = f.lark(argv);
      assert.equal(result.status, 2, `${argv.join(" ")} must be denied`);
    }
    assert.equal(f.calls().length, 0);

    const read = f.lark(["im", "+chat-list"], {
      LARKIN_TEST_PROVIDER_STDOUT: "READ-STDOUT\n",
      LARKIN_TEST_PROVIDER_STDERR: "READ-STDERR\n",
    });
    assert.deepEqual({ status: read.status, stdout: read.stdout, stderr: read.stderr }, {
      status: 0, stdout: "READ-STDOUT\n", stderr: "READ-STDERR\n",
    });
    const help = f.lark(["im", "+messages-send", "--as", "user", "--chat-id", "a", "--chat-id=b", "--help"], {
      LARKIN_TEST_PROVIDER_STDOUT: "NATIVE-HELP\n",
    });
    assert.deepEqual({ status: help.status, stdout: help.stdout, stderr: help.stderr }, {
      status: 0, stdout: "NATIVE-HELP\n", stderr: "",
    });
    assert.equal(f.calls().length, 2);
  } finally { cleanup(f); }
});
