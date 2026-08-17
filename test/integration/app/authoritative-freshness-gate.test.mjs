import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const LARK_CLI = path.join(ROOT, "dist/app/lark-cli.mjs");
const AGENT_CLI = path.join(ROOT, "dist/app/agent-cli.mjs");
const PROVIDER = path.join(ROOT, "test/support/runtime-agent-interface-v2-provider.mjs");

beforeAll(() => {
  const result = spawnSync(process.execPath, ["run", "build"], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, `build failed\n${result.stdout}\n${result.stderr}`);
});

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
}

function fixture(agentId = "cli_authoritativeA1") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-authoritative-freshness-"));
  fs.chmodSync(root, 0o700);
  const stateDir = path.join(root, "state", "agents", agentId);
  const inboxFile = path.join(stateDir, "feishu-inbox.ndjson");
  const callsFile = path.join(root, "provider-calls.ndjson");
  writePrivate(path.join(root, "config.json"), `${JSON.stringify({
    version: 4,
    serverId: "authoritative-freshness-integration",
    mentionPolicy: "require",
    activeAgent: agentId,
    agents: { [agentId]: { runtime: "pi", model: "default" } },
  }, null, 2)}\n`);
  const sourceFile = path.join(stateDir, "lark-channel-source", "config.json");
  const workspaceFile = path.join(stateDir, "lark-cli-config", "lark-channel", "config.json");
  writePrivate(sourceFile, `${JSON.stringify({
    accounts: { app: { id: agentId, secret: { source: "exec", provider: "larkin-bot-credential", id: agentId } } },
    secrets: { providers: { "larkin-bot-credential": {
      source: "exec", command: process.execPath, args: [],
      env: { LARKIN_AGENT_ID: agentId, LARKIN_SECRET_PROVIDER_CONTEXT: "bind" },
    } } },
  })}\n`);
  writePrivate(workspaceFile, `${JSON.stringify({
    apps: [{ appId: agentId, name: agentId,
      appSecret: { source: "keychain", id: `appsecret:${agentId}` },
      brand: "feishu", defaultAs: "bot", strictMode: "bot", users: [] }],
  })}\n`);
  const bin = path.join(root, "bin");
  const packageDir = path.join(root, "official", "node_modules", "@larksuite", "cli");
  const executable = path.join(packageDir, "scripts", "run.sh");
  fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 });
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version: "1.0.80", bin: { "lark-cli": "scripts/run.sh" },
  }), { mode: 0o600 });
  fs.writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.0.80\\n'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "bind" ] && [ "$3" = "--help" ]; then printf '%s\\n' 'Usage: lark-cli config bind --source lark-channel --identity bot-only'; exit 0; fi
export LARKIN_TEST_PROVIDER_PARENT_PID="$PPID"
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(PROVIDER)} "$@"
`, { mode: 0o700 });
  fs.symlinkSync(executable, path.join(bin, "lark-cli"));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const profile = `export PATH=${JSON.stringify(bin)}:$PATH\n`;
  fs.writeFileSync(path.join(home, ".bash_profile"), profile, { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".zprofile"), profile, { mode: 0o600 });
  const history = (messages, extra = {}) => JSON.stringify({ ok: true, identity: "bot", data: { messages, has_more: false, ...extra } });
  const env = {
    ...process.env,
    HOME: home,
    SHELL: "/bin/bash",
    BASH_ENV: path.join(home, ".bash_profile"),
    ZDOTDIR: home,
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    LARKIN_CONFIG_DIR: root,
    LARKIN_AGENT_ID: agentId,
    LARKIN_TEST_FRESHNESS_PROVIDER: PROVIDER,
    LARKIN_TEST_PROVIDER_CALLS: callsFile,
  };
  const lark = (argv, overrides = {}) => {
    const effective = { ...overrides };
    if (effective.LARKIN_TEST_PROVIDER_WRITE_STDOUT === undefined && typeof effective.LARKIN_TEST_PROVIDER_HISTORY === "string") {
      try {
        const parsed = JSON.parse(effective.LARKIN_TEST_PROVIDER_HISTORY);
        const rows = parsed?.data?.messages ?? parsed?.data?.items;
        if (Array.isArray(rows) && rows.length > 0) {
          effective.LARKIN_TEST_PROVIDER_WRITE_STDOUT = JSON.stringify({ ok: true, data: rows[0] });
        }
      } catch { /* malformed-history cases intentionally have no synthesized write response */ }
    }
    return spawnSync(process.execPath, [LARK_CLI, ...argv], {
    cwd: root,
    env: { ...env, ...effective },
    encoding: "utf8",
    timeout: 30_000,
    });
  };
  const agent = (argv, overrides = {}) => spawnSync(process.execPath, [AGENT_CLI, ...argv], {
    cwd: root,
    env: { ...env, ...overrides },
    encoding: "utf8",
    timeout: 30_000,
  });
  const calls = () => fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const appendInbox = (envelope) => fs.appendFileSync(inboxFile, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
  return { root, agentId, stateDir, inboxFile, history, lark, agent, calls, appendInbox };
}

test("provider history missing from Inbox blocks stale send before provider write", () => {
  const f = fixture();
  try {
    const result = f.lark(["im", "+messages-send", "--chat-id", "oc_a", "--text", "stale"], {
      LARKIN_TEST_PROVIDER_HISTORY: f.history([{
        message_id: "om_unseen_bot",
        chat_id: "oc_a",
        create_time: "1785200000000",
        update_time: "1785200000000",
        msg_type: "text",
        body: { content: "{\"text\":\"new bot context\"}" },
      }]),
    });
    assert.notEqual(result.status, 0, result.stdout);
    const envelope = JSON.parse(result.stderr);
    assert.equal(envelope.error.subtype, "freshness_conflict");
    assert.equal(envelope.target, "feishu.im/chat/oc_a");
    assert.deepEqual(f.calls().map((call) => call.argv.slice(0, 2)), [["api", "GET"]]);
    assert.equal(fs.existsSync(path.join(f.stateDir, "feishu-inbox.ndjson")), false, "provider history must not need Inbox delivery");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("conflict direct-acks the cursor, retry re-probes, and no draft surface or body is persisted", () => {
  const f = fixture();
  try {
    const snapshot = f.history([{ message_id: "om_1", chat_id: "oc_a", create_time: "100", body: { content: "{\"text\":\"context\"}" } }]);
    const argv = ["im", "+messages-send", "--chat-id", "oc_a", "--text", "candidate-secret"];
    const first = f.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: snapshot });
    assert.equal(first.status, 3);
    assert.equal(JSON.parse(first.stderr).unseen_messages[0].message_id, "om_1");
    const retried = f.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: snapshot });
    assert.equal(retried.status, 0, retried.stderr);
    assert.deepEqual(f.calls().map((call) => call.argv[1]), ["GET", "GET", "+messages-send"]);
    const stateText = fs.readFileSync(path.join(f.stateDir, "freshness-state.json"), "utf8");
    assert.equal(stateText.includes("candidate-secret"), false);
    assert.equal(fs.existsSync(path.join(f.stateDir, "inbox-state.json")), false, "authoritative gate must not create legacy draft state");
    const draft = f.lark(["larkin-draft", "list"]);
    assert.equal(draft.status, 2);
    assert.match(draft.stderr, /已移除/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("same-millisecond IDs and edits inside the bounded head window each conflict", () => {
  const f = fixture();
  try {
    const send = ["im", "+messages-send", "--chat-id", "oc_same", "--text", "candidate"];
    const one = f.history([{ message_id: "om_a", chat_id: "oc_same", create_time: "100" }]);
    assert.equal(f.lark(send, { LARKIN_TEST_PROVIDER_HISTORY: one }).status, 3);
    const sameMillis = f.history([
      { message_id: "om_a", chat_id: "oc_same", create_time: "100" },
      { message_id: "om_b", chat_id: "oc_same", create_time: "100" },
    ]);
    const second = f.lark(send, { LARKIN_TEST_PROVIDER_HISTORY: sameMillis });
    assert.equal(second.status, 3);
    assert.deepEqual(JSON.parse(second.stderr).unseen_messages.map((message) => message.message_id), ["om_b"]);
    const edited = f.history([
      { message_id: "om_a", chat_id: "oc_same", create_time: "100", update_time: "200" },
      { message_id: "om_b", chat_id: "oc_same", create_time: "100" },
    ]);
    const third = f.lark(send, { LARKIN_TEST_PROVIDER_HISTORY: edited });
    assert.equal(third.status, 3);
    assert.deepEqual(JSON.parse(third.stderr).current_cursor, { schema: 1, revisionTime: "200", messageIds: ["om_a"] });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("chat and thread cursors are isolated and thread probes use the exact locator", () => {
  const f = fixture();
  try {
    f.appendInbox({ message_id: "om_thread_anchor", chat_id: "oc_a", thread_id: "omt_topic", content: "anchor" });
    const threadHistory = f.history([{
      message_id: "om_thread_new", chat_id: "oc_a", thread_id: "omt_topic", create_time: "300",
    }]);
    const thread = f.lark(["im", "+messages-reply", "--message-id", "om_thread_anchor", "--text", "stale"], {
      LARKIN_TEST_PROVIDER_HISTORY: threadHistory,
    });
    assert.equal(thread.status, 3, thread.stderr);
    assert.equal(JSON.parse(thread.stderr).target, "feishu.im/thread/oc_a/omt_topic");
    const call = f.calls()[0].argv;
    assert.deepEqual(call.slice(0, 3), ["api", "GET", "/open-apis/im/v1/messages"]);
    assert.deepEqual(JSON.parse(call[call.indexOf("--params") + 1]), {
      container_id_type: "thread", container_id: "omt_topic", sort_type: "ByCreateTimeDesc", page_size: 20,
    });

    const chat = f.lark(["im", "+messages-send", "--chat-id", "oc_a", "--text", "chat current"], {
      LARKIN_TEST_PROVIDER_HISTORY: f.history([]),
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: JSON.stringify({ ok: true, data: {
        message_id: "om_chat_own", chat_id: "oc_a", create_time: "1",
      } }),
    });
    assert.equal(chat.status, 0, chat.stderr);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("empty first touch sends; probe failure, malformed payload, and history gap fail closed", () => {
  const f = fixture();
  try {
    const send = ["im", "+messages-send", "--chat-id", "oc_failure", "--text", "candidate"];
    assert.equal(f.lark(send, {
      LARKIN_TEST_PROVIDER_HISTORY: f.history([]),
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: JSON.stringify({ ok: true, data: {
        message_id: "om_failure_own", chat_id: "oc_failure", create_time: "1",
      } }),
    }).status, 0);
    const failed = f.lark(send, { LARKIN_TEST_PROVIDER_MODE: "fail" });
    assert.equal(failed.status, 3);
    assert.equal(JSON.parse(failed.stderr).error.subtype, "freshness_unavailable");
    const malformed = f.lark(send, { LARKIN_TEST_PROVIDER_HISTORY: "not-json" });
    assert.equal(malformed.status, 3);
    assert.equal(JSON.parse(malformed.stderr).error.subtype, "freshness_unavailable");
    const malformedRevision = f.lark(send, { LARKIN_TEST_PROVIDER_HISTORY: f.history([
      { message_id: "om_bad_revision", chat_id: "oc_failure", create_time: "not-ms" },
    ]) });
    assert.equal(malformedRevision.status, 3);
    assert.equal(JSON.parse(malformedRevision.stderr).error.subtype, "freshness_unavailable");

    const newer = f.history([{ message_id: "om_new", chat_id: "oc_failure", create_time: "500" }]);
    assert.equal(f.lark(send, { LARKIN_TEST_PROVIDER_HISTORY: newer }).status, 3);
    const older = f.history([{ message_id: "om_old", chat_id: "oc_failure", create_time: "100" }]);
    const gap = f.lark(send, { LARKIN_TEST_PROVIDER_HISTORY: older });
    assert.equal(gap.status, 3);
    assert.equal(JSON.parse(gap.stderr).error.subtype, "freshness_unavailable");
    assert.equal(f.calls().filter((call) => call.argv[1] === "+messages-send").length, 1, "only the empty first touch may write");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("idempotency is stable for independently current attempts at one seen boundary", () => {
  const f = fixture();
  try {
    const argv = ["im", "+messages-send", "--chat-id", "oc_race", "--text", "same"];
    const current = f.history([{ message_id: "om_race_seen", chat_id: "oc_race", create_time: "10" }]);
    assert.equal(f.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: current }).status, 3);
    assert.equal(f.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: current }).status, 0);
    assert.equal(f.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: current }).status, 0);
    const writes = f.calls().filter((call) => call.argv[1] === "+messages-send");
    const key = (call) => call.argv[call.argv.indexOf("--idempotency-key") + 1];
    assert.equal(key(writes[0]), key(writes[1]));
    assert.equal(writes.length, 2, "accepted no-lock race boundary permits independently fresh attempts");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("cursor update matrix advances poll and exact JSON head reads, but not check or paged history", () => {
  const f = fixture();
  try {
    const raw = { message_id: "om_matrix", chat_id: "oc_matrix", create_time: "700", update_time: "700", content: "full body" };
    const snapshot = f.history([raw]);
    f.appendInbox(raw);
    assert.equal(f.agent(["inbox", "check"]).status, 0);
    const afterCheck = f.lark(["im", "+messages-send", "--chat-id", "oc_matrix", "--text", "blocked"], {
      LARKIN_TEST_PROVIDER_HISTORY: snapshot,
    });
    assert.equal(afterCheck.status, 3, "content-light check must not advance provider cursor");

    assert.equal(f.agent(["inbox", "poll", "--target", "chat:oc_matrix"]).status, 0);
    assert.equal(f.lark(["im", "+messages-send", "--chat-id", "oc_matrix", "--text", "current"], {
      LARKIN_TEST_PROVIDER_HISTORY: snapshot,
    }).status, 0, "full Inbox poll advances the exact provider cursor");

    const head = f.lark(["im", "+chat-messages-list", "--chat-id", "oc_head", "--order", "desc", "--json"], {
      LARKIN_TEST_PROVIDER_HISTORY: f.history([{ ...raw, message_id: "om_head", chat_id: "oc_head", create_time: "800", update_time: "800" }]),
    });
    assert.equal(head.status, 0);
    assert.equal(head.stdout, f.history([{ ...raw, message_id: "om_head", chat_id: "oc_head", create_time: "800", update_time: "800" }]),
      "successful provider stdout must remain byte-for-byte unchanged");
    assert.equal(f.lark(["im", "+messages-send", "--chat-id", "oc_head", "--text", "current"], {
      LARKIN_TEST_PROVIDER_HISTORY: head.stdout,
    }).status, 0);

    const pagedSnapshot = f.history([{ ...raw, message_id: "om_paged", chat_id: "oc_paged", create_time: "900", update_time: "900" }]);
    assert.equal(f.lark(["im", "+chat-messages-list", "--chat-id", "oc_paged", "--order", "desc", "--page-token", "next", "--json"], {
      LARKIN_TEST_PROVIDER_HISTORY: pagedSnapshot,
    }).status, 0);
    assert.equal(f.lark(["im", "+messages-send", "--chat-id", "oc_paged", "--text", "blocked"], {
      LARKIN_TEST_PROVIDER_HISTORY: pagedSnapshot,
    }).status, 3, "paged history must not claim the target head was observed");

    const partialSnapshot = f.history([{ ...raw, message_id: "om_partial", chat_id: "oc_partial", create_time: "925", update_time: "925" }]);
    assert.equal(f.lark(["im", "+messages-mget", "--message-ids", "om_partial", "--json"], {
      LARKIN_TEST_PROVIDER_STDOUT: partialSnapshot,
    }).status, 0);
    assert.equal(f.lark(["im", "+messages-send", "--chat-id", "oc_partial", "--text", "blocked"], {
      LARKIN_TEST_PROVIDER_HISTORY: partialSnapshot,
    }).status, 3, "partial message reads must not advance a target head cursor");

    const threadSnapshot = f.history([{
      message_id: "om_thread_head", chat_id: "oc_thread_head", thread_id: "omt_head", create_time: "950", update_time: "950",
    }]);
    const threadRead = f.lark(["im", "+threads-messages-list", "--thread", "omt_head", "--order", "desc", "--json"], {
      LARKIN_TEST_PROVIDER_HISTORY: threadSnapshot,
    });
    assert.equal(threadRead.status, 0);
    f.appendInbox({ message_id: "om_thread_anchor_matrix", chat_id: "oc_thread_head", thread_id: "omt_head", content: "anchor" });
    assert.equal(f.lark(["im", "+messages-reply", "--message-id", "om_thread_anchor_matrix", "--text", "current"], {
      LARKIN_TEST_PROVIDER_HISTORY: threadSnapshot,
    }).status, 0, "successful exact thread head JSON advances the derived chat+thread cursor");
    const threadCalls = f.calls().filter((call) => call.argv[1] === "+threads-messages-list");
    assert.equal(threadCalls.every((call) => !call.argv.includes("--chat-id")), true, "thread shortcut does not accept --chat-id");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("reply and card locators resolve the same exact authoritative target before write", () => {
  const f = fixture();
  try {
    f.appendInbox({ message_id: "om_locator", chat_id: "oc_locator", content: "anchor" });
    const history = f.history([{ message_id: "om_new_locator", chat_id: "oc_locator", create_time: "975" }]);
    for (const argv of [
      ["im", "+messages-reply", "--message-id", "om_locator", "--text", "stale"],
      ["im", "messages", "patch", "--message-id", "om_locator", "--content", "{}"],
      ["im", "messages", "update", "--message-id", "om_locator", "--content", "{}"],
    ]) {
      const result = f.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: history,
        LARKIN_RUNTIME_OBSERVATION_GENERATION: `locator:${argv.join(":")}` });
      assert.equal(result.status, 3, result.stderr);
      assert.equal(JSON.parse(result.stderr).target, "feishu.im/chat/oc_locator");
    }
    assert.equal(f.calls().every((call) => call.argv[0] === "api" && call.argv[1] === "GET"), true,
      "conflicting reply/card writes must stop before provider mutation");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("an abnormal Runtime generation change invalidates prior direct-ack for only that Agent target", () => {
  const f = fixture();
  try {
    const history = f.history([{ message_id: "om_generation", chat_id: "oc_generation", create_time: "1000" }]);
    const argv = ["im", "+messages-send", "--chat-id", "oc_generation", "--text", "candidate"];
    assert.equal(f.lark(argv, {
      LARKIN_TEST_PROVIDER_HISTORY: history,
      LARKIN_RUNTIME_OBSERVATION_GENERATION: "launch-a:1",
    }).status, 3);
    assert.equal(f.lark(argv, {
      LARKIN_TEST_PROVIDER_HISTORY: history,
      LARKIN_RUNTIME_OBSERVATION_GENERATION: "launch-a:1",
    }).status, 0);
    const recovered = f.lark(argv, {
      LARKIN_TEST_PROVIDER_HISTORY: history,
      LARKIN_RUNTIME_OBSERVATION_GENERATION: "launch-a:2",
    });
    assert.equal(recovered.status, 3);
    assert.equal(JSON.parse(recovered.stderr).error.subtype, "freshness_conflict");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("the same provider target keeps independent cursors for different Agents", () => {
  const left = fixture();
  const right = fixture("cli_authoritativeB2");
  try {
    const history = left.history([{ message_id: "om_shared", chat_id: "oc_shared", create_time: "1100" }]);
    const argv = ["im", "+messages-send", "--chat-id", "oc_shared", "--text", "candidate"];
    assert.equal(left.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: history }).status, 3);
    assert.equal(left.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: history }).status, 0);
    assert.equal(right.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: history }).status, 3,
      "another Agent must not inherit the first Agent's direct-ack");
  } finally {
    fs.rmSync(left.root, { recursive: true, force: true });
    fs.rmSync(right.root, { recursive: true, force: true });
  }
});

test("a successful write observes its raw revision without rewriting stdout", () => {
  const f = fixture();
  try {
    const writePayload = JSON.stringify({ ok: true, data: {
      message_id: "om_own", chat_id: "oc_own", create_time: "1200", update_time: "1200",
    } });
    const argv = ["im", "+messages-send", "--chat-id", "oc_own", "--text", "own"];
    const sent = f.lark(argv, {
      LARKIN_TEST_PROVIDER_HISTORY: f.history([]),
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: writePayload,
    });
    assert.equal(sent.status, 0);
    assert.equal(sent.stdout, writePayload);
    const ownHistory = f.history([{ message_id: "om_own", chat_id: "oc_own", create_time: "1200", update_time: "1200" }]);
    assert.equal(f.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: ownHistory }).status, 0,
      "the next probe must not conflict on the Agent's own observed successful write");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("raw OpenAPI envelope uses identity plus data.items with millisecond revisions", () => {
  const f = fixture();
  try {
    const rawEnvelope = JSON.stringify({ ok: true, identity: "bot", data: { items: [{
      message_id: "om_raw_contract", chat_id: "oc_raw_contract", create_time: "1250", update_time: "1251",
    }], has_more: false, page_token: "" } });
    const result = f.lark(["im", "+messages-send", "--chat-id", "oc_raw_contract", "--text", "stale"], {
      LARKIN_TEST_PROVIDER_HISTORY: rawEnvelope,
    });
    assert.equal(result.status, 3, result.stderr);
    assert.deepEqual(JSON.parse(result.stderr).current_cursor, {
      schema: 1, revisionTime: "1251", messageIds: ["om_raw_contract"],
    });
    const probe = f.calls()[0].argv;
    assert.deepEqual(probe.slice(0, 3), ["api", "GET", "/open-apis/im/v1/messages"]);
    assert.deepEqual(JSON.parse(probe[probe.indexOf("--params") + 1]), {
      container_id_type: "chat", container_id: "oc_raw_contract", sort_type: "ByCreateTimeDesc", page_size: 20,
    });
    assert.equal(probe[probe.indexOf("--as") + 1], "bot");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("raw history missing or mismatching Bot identity stays closed across retries", () => {
  for (const identity of [undefined, "user"]) {
    const f = fixture();
    try {
      const envelope = JSON.stringify({ ok: true, ...(identity ? { identity } : {}), data: { items: [{
        message_id: `om_identity_${identity || "missing"}`, chat_id: "oc_identity", create_time: "1255",
      }] } });
      const argv = ["im", "+messages-send", "--chat-id", "oc_identity", "--text", "must-not-write"];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = f.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: envelope });
        assert.equal(result.status, 3, `${identity || "missing"} attempt ${attempt}: ${result.stderr}`);
        assert.equal(JSON.parse(result.stderr).error.subtype, "freshness_unavailable");
      }
      assert.equal(f.calls().every((call) => call.argv[0] === "api" && call.argv[1] === "GET"), true);
      assert.equal(fs.existsSync(path.join(f.stateDir, "freshness-state.json")), false,
        "unconfirmed identity must not direct-ack or update cursor state");
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("formatted public chat/thread shortcuts preserve stdout and advance only after exact raw reconciliation", () => {
  for (const kind of ["chat", "thread"]) {
    const f = fixture();
    try {
      const chatId = `oc_formatted_${kind}`;
      const threadId = kind === "thread" ? "omt_formatted" : undefined;
      const messageId = `om_formatted_${kind}`;
      const formattedRow = { message_id: messageId, chat_id: chatId,
        ...(threadId ? { thread_id: threadId } : {}), create_time: "2026-07-28 12:34:56" };
      const rawRow = { ...formattedRow, create_time: "1260", update_time: "1261" };
      const formatted = f.history([formattedRow]);
      const raw = JSON.stringify({ ok: true, identity: "bot", data: { items: [rawRow], has_more: false } });
      const readArgv = kind === "chat"
        ? ["im", "+chat-messages-list", "--chat-id", chatId, "--order", "desc", "--json"]
        : ["im", "+threads-messages-list", "--thread", threadId, "--order", "desc", "--json"];
      const read = f.lark(readArgv, { LARKIN_TEST_PROVIDER_HISTORY_SEQUENCE: JSON.stringify([formatted, raw]) });
      assert.equal(read.status, 0, read.stderr);
      assert.equal(read.stdout, formatted, "formatted shortcut bytes must be preserved exactly");
      const shortcut = f.calls().find((call) => call.argv[1] === (kind === "chat" ? "+chat-messages-list" : "+threads-messages-list"));
      assert.equal(shortcut.argv[shortcut.argv.indexOf("--page-size") + 1], "20");
      const targetKey = kind === "chat" ? `feishu.im/chat/${chatId}` : `feishu.im/thread/${chatId}/${threadId}`;
      assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir, "freshness-state.json"), "utf8"))
        .cursors[targetKey].cursor.revisionTime, "1261");
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("normalized and prefixed history shortcuts use the same default 20 window", () => {
  const f = fixture();
  try {
    for (const argv of [
      ["--json", "im", "+chat-messages-list", "--chat-id", "oc_prefixed", "--order", "desc"],
      ["im", "--json", "+threads-messages-list", "--thread", "omt_prefixed", "--order", "desc"],
    ]) {
      const command = argv.includes("+chat-messages-list") ? "+chat-messages-list" : "+threads-messages-list";
      const result = f.lark(argv, {
        LARKIN_TEST_PROVIDER_STDOUT: JSON.stringify({ ok: true, identity: "bot", data: { messages: [] } }),
      });
      assert.equal(result.status, 0, result.stderr);
      const shortcut = f.calls().findLast((call) => call.argv.includes(command));
      assert.equal(shortcut.argv[shortcut.argv.indexOf("--page-size") + 1], "20");
    }
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a raw reconciliation race or ID mismatch never acknowledges an undisplayed head", () => {
  const f = fixture();
  try {
    const displayed = f.history([{
      message_id: "om_displayed", chat_id: "oc_reconcile_race", create_time: "2026-07-28 12:34:56",
    }]);
    const raw = JSON.stringify({ ok: true, identity: "bot", data: { items: [
      { message_id: "om_displayed", chat_id: "oc_reconcile_race", create_time: "1270" },
      { message_id: "om_raced_new", chat_id: "oc_reconcile_race", create_time: "1271" },
    ] } });
    const read = f.lark(["im", "+chat-messages-list", "--chat-id", "oc_reconcile_race", "--order", "desc", "--json"], {
      LARKIN_TEST_PROVIDER_HISTORY_SEQUENCE: JSON.stringify([displayed, raw]),
    });
    assert.equal(read.status, 0);
    assert.equal(read.stdout, displayed);
    assert.equal(fs.existsSync(path.join(f.stateDir, "freshness-state.json")), false,
      "raw head containing an ID not shown to the model must not advance seen");
    const send = f.lark(["im", "+messages-send", "--chat-id", "oc_reconcile_race", "--text", "blocked"], {
      LARKIN_TEST_PROVIDER_HISTORY: raw,
    });
    assert.equal(send.status, 3, send.stderr);
    assert.deepEqual(JSON.parse(send.stderr).unseen_messages.map((message) => message.message_id), ["om_displayed", "om_raced_new"]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("an incomplete successful write is confirmed by one bounded post-write probe", () => {
  const f = fixture();
  try {
    const own = { message_id: "om_post_own", chat_id: "oc_post", create_time: "1300", update_time: "1300" };
    const sent = f.lark(["im", "+messages-send", "--chat-id", "oc_post", "--text", "post-confirm"], {
      LARKIN_TEST_PROVIDER_HISTORY_SEQUENCE: JSON.stringify([f.history([]), f.history([own])]),
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: JSON.stringify({ ok: true, data: { message_id: own.message_id } }),
    });
    assert.equal(sent.status, 0, sent.stderr);
    assert.deepEqual(f.calls().map((call) => call.argv[1]), ["GET", "+messages-send", "GET"]);
    const probes = f.calls().filter((call) => call.argv[0] === "api" && call.argv[1] === "GET");
    for (const probe of probes) assert.deepEqual(probe.argv, [
      "api", "GET", "/open-apis/im/v1/messages", "--params",
      JSON.stringify({ container_id_type: "chat", container_id: "oc_post", sort_type: "ByCreateTimeDesc", page_size: 20 }),
      "--as", "bot",
    ]);
    assert.equal(JSON.parse(fs.readFileSync(path.join(f.stateDir, "freshness-state.json"), "utf8"))
      .cursors["feishu.im/chat/oc_post"].cursor.revisionTime, "1300");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("post-write probe failure or a concurrent message reports committed once and preserves old seen", () => {
  for (const variant of ["failure", "concurrent"]) {
    const f = fixture();
    try {
      const targetKey = "feishu.im/chat/oc_post_guard";
      const old = { message_id: "om_old_seen", chat_id: "oc_post_guard", create_time: "1350" };
      assert.equal(f.lark(["im", "+messages-send", "--chat-id", "oc_post_guard", "--text", "direct-ack"], {
        LARKIN_TEST_PROVIDER_HISTORY: f.history([old]),
      }).status, 3);
      const before = JSON.parse(fs.readFileSync(path.join(f.stateDir, "freshness-state.json"), "utf8")).cursors[targetKey];
      const ownId = `om_${variant}_own`;
      const second = variant === "failure"
        ? { exit_code: 9, stderr: "post probe unavailable\n" }
        : f.history([
          { message_id: ownId, chat_id: "oc_post_guard", create_time: "1400" },
          { message_id: "om_concurrent_other", chat_id: "oc_post_guard", create_time: "1401" },
        ]);
      const result = f.lark(["im", "+messages-send", "--chat-id", "oc_post_guard", "--text", "write-happened"], {
        LARKIN_TEST_PROVIDER_HISTORY_SEQUENCE: JSON.stringify([null, f.history([old]), second]),
        LARKIN_TEST_PROVIDER_WRITE_STDOUT: JSON.stringify({ ok: true, data: { message_id: ownId } }),
        LARKIN_TEST_PROVIDER_STDERR: "retry the ordinary command\n",
      });
      assert.equal(result.status, 0, `${variant}: ${result.stderr}`);
      assert.equal(result.stderr, "", `${variant}: committed success must not include a contradictory retry error`);
      const committed = JSON.parse(result.stdout);
      assert.deepEqual({
        ok: committed.ok,
        committed: committed.committed,
        verified: committed.verified,
        cursor_advanced: committed.cursor_advanced,
      }, { ok: true, committed: true, verified: false, cursor_advanced: false });
      assert.equal(committed.data.message_id, ownId, `${variant}: provider response data must remain available`);
      assert.equal(committed.verification.subtype, "post_write_unverified");
      assert.equal(committed.provider_stderr_present, true);
      assert.doesNotMatch(JSON.stringify(committed), /retry/i);
      assert.equal(result.stdout.trim().split("\n").length, 1, `${variant}: exactly one structured document`);
      const state = JSON.parse(fs.readFileSync(path.join(f.stateDir, "freshness-state.json"), "utf8"));
      assert.deepEqual(state.cursors[targetKey], before,
        `${variant}: an unconfirmed post-probe must preserve the exact old cursor and not merge current`);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("a launcher killed during provider write retries in a new process with the same key and stores no body", () => {
  const f = fixture();
  try {
    const argv = ["im", "+messages-send", "--chat-id", "oc_process_kill", "--text", "sensitive-retry-body"];
    const killed = f.lark(argv, {
      LARKIN_TEST_PROVIDER_HISTORY: f.history([]),
      LARKIN_TEST_PROVIDER_WRITE_MODE: "kill-parent",
    });
    assert.equal(killed.signal, "SIGKILL");
    const firstWrite = f.calls().find((call) => call.argv[1] === "+messages-send");
    const retry = f.lark(argv, {
      LARKIN_TEST_PROVIDER_HISTORY: f.history([]),
      LARKIN_TEST_PROVIDER_WRITE_MODE: "kill-parent",
    });
    assert.equal(retry.signal, "SIGKILL");
    const writes = f.calls().filter((call) => call.argv[1] === "+messages-send");
    const key = (call) => call.argv[call.argv.indexOf("--idempotency-key") + 1];
    assert.equal(key(writes.at(-1)), key(firstWrite));
    const persisted = fs.existsSync(path.join(f.stateDir, "freshness-state.json"))
      ? fs.readFileSync(path.join(f.stateDir, "freshness-state.json"), "utf8") : "";
    assert.equal(persisted.includes("sensitive-retry-body"), false);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("history scope fields are mandatory and a second attempt never opens the gate", () => {
  for (const { name, inbox, argv, history } of [
    {
      name: "chat missing chat_id", inbox: null,
      argv: ["im", "+messages-send", "--chat-id", "oc_scope", "--text", "blocked"],
      history: [{ message_id: "om_scope", create_time: "1500" }],
    },
    {
      name: "chat wrong chat_id", inbox: null,
      argv: ["im", "+messages-send", "--chat-id", "oc_scope", "--text", "blocked"],
      history: [{ message_id: "om_scope", chat_id: "oc_wrong", create_time: "1500" }],
    },
    {
      name: "thread missing thread_id", inbox: { message_id: "om_anchor", chat_id: "oc_scope", thread_id: "omt_scope" },
      argv: ["im", "+messages-reply", "--message-id", "om_anchor", "--text", "blocked"],
      history: [{ message_id: "om_scope", chat_id: "oc_scope", create_time: "1500" }],
    },
    {
      name: "thread wrong chat/thread", inbox: { message_id: "om_anchor", chat_id: "oc_scope", thread_id: "omt_scope" },
      argv: ["im", "+messages-reply", "--message-id", "om_anchor", "--text", "blocked"],
      history: [{ message_id: "om_scope", chat_id: "oc_wrong", thread_id: "omt_wrong", create_time: "1500" }],
    },
  ]) {
    const f = fixture();
    try {
      if (inbox) f.appendInbox(inbox);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const result = f.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: f.history(history) });
        assert.equal(result.status, 3, `${name} attempt ${attempt}: ${result.stderr}`);
        assert.equal(JSON.parse(result.stderr).error.subtype, "freshness_unavailable");
      }
      assert.equal(f.calls().some((call) => ["+messages-send", "+messages-reply"].includes(call.argv[1])), false, name);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("cursor matrix never advances from formatted, ranged, partial, ascending, or failed reads", () => {
  const cases = [
    { id: "pretty", read: ["im", "+chat-messages-list", "--chat-id", "oc_pretty", "--order", "desc", "--format", "pretty"], chat: "oc_pretty" },
    { id: "table", read: ["im", "+chat-messages-list", "--chat-id", "oc_table", "--order", "desc", "--format", "table"], chat: "oc_table" },
    { id: "ndjson", read: ["im", "+chat-messages-list", "--chat-id", "oc_ndjson", "--order", "desc", "--format", "ndjson"], chat: "oc_ndjson" },
    { id: "start", read: ["im", "+chat-messages-list", "--chat-id", "oc_start", "--order", "desc", "--start", "100"], chat: "oc_start" },
    { id: "end", read: ["im", "+chat-messages-list", "--chat-id", "oc_end", "--order", "desc", "--end", "200"], chat: "oc_end" },
    { id: "search", read: ["im", "+messages-search", "--query", "marker"], chat: "oc_search" },
    { id: "member", read: ["im", "+chat-members-list", "--chat-id", "oc_member"], chat: "oc_member" },
    { id: "read_status", read: ["im", "+message-read-users-list", "--message-id", "om_status"], chat: "oc_read_status" },
  ];
  for (const item of cases) {
    const f = fixture();
    try {
      const row = { message_id: `om_${item.id}`, chat_id: item.chat, create_time: "1600" };
      const history = f.history([row]);
      const read = f.lark(item.read, { LARKIN_TEST_PROVIDER_HISTORY: history, LARKIN_TEST_PROVIDER_STDOUT: history });
      assert.equal(read.status, 0, `${item.id}: ${read.stderr}`);
      const send = f.lark(["im", "+messages-send", "--chat-id", item.chat, "--text", "blocked"], {
        LARKIN_TEST_PROVIDER_HISTORY: history,
      });
      assert.equal(send.status, 3, `${item.id} must not advance cursor: ${send.stderr}`);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }

  for (const order of [null, "asc"]) {
    const f = fixture();
    try {
      const threadId = order ? "omt_asc" : "omt_default";
      const anchor = order ? "om_anchor_asc" : "om_anchor_default";
      const row = { message_id: `om_${threadId}`, chat_id: "oc_thread_matrix", thread_id: threadId, create_time: "1700" };
      f.appendInbox({ message_id: anchor, chat_id: "oc_thread_matrix", thread_id: threadId });
      const readArgv = ["im", "+threads-messages-list", "--thread", threadId, ...(order ? ["--order", order] : []), "--json"];
      assert.equal(f.lark(readArgv, { LARKIN_TEST_PROVIDER_HISTORY: f.history([row]) }).status, 0);
      const reply = f.lark(["im", "+messages-reply", "--message-id", anchor, "--reply-in-thread", "--text", "blocked"], {
        LARKIN_TEST_PROVIDER_HISTORY: f.history([row]),
      });
      assert.equal(reply.status, 3, `thread ${order ?? "default"} must not advance cursor`);
      const probe = f.calls().at(-1).argv;
      assert.deepEqual(probe, [
        "api", "GET", "/open-apis/im/v1/messages", "--params",
        JSON.stringify({ container_id_type: "thread", container_id: threadId, sort_type: "ByCreateTimeDesc", page_size: 20 }),
        "--as", "bot",
      ]);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }

  const failed = fixture();
  try {
    const row = { message_id: "om_failed_read", chat_id: "oc_failed_read", create_time: "1800" };
    assert.notEqual(failed.lark(["im", "+chat-messages-list", "--chat-id", "oc_failed_read", "--order", "desc", "--json"], {
      LARKIN_TEST_PROVIDER_MODE: "fail",
    }).status, 0);
    assert.equal(failed.lark(["im", "+messages-send", "--chat-id", "oc_failed_read", "--text", "blocked"], {
      LARKIN_TEST_PROVIDER_HISTORY: failed.history([row]),
    }).status, 3, "failed provider read must not advance cursor");
  } finally { fs.rmSync(failed.root, { recursive: true, force: true }); }
}, { timeout: 30_000 });

test("Host append, callback/background checks, Dashboard refresh, and failed writes do not advance cursor", () => {
  const f = fixture();
  try {
    const targetKey = "feishu.im/chat/oc_nonadvancing";
    const old = { message_id: "om_nonadvancing_old", chat_id: "oc_nonadvancing", create_time: "2000" };
    const argv = ["im", "+messages-send", "--chat-id", "oc_nonadvancing", "--text", "candidate"];
    assert.equal(f.lark(argv, { LARKIN_TEST_PROVIDER_HISTORY: f.history([old]) }).status, 3);
    const stateFile = path.join(f.stateDir, "freshness-state.json");
    const before = JSON.parse(fs.readFileSync(stateFile, "utf8")).cursors[targetKey];

    const appendScript = `
import { createAgentStateStore } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "dist/agent/agent-state-store.mjs")).href)};
createAgentStateStore(process.argv[1], process.argv[2]).appendInboxOnce({
  message_id: "om_callback_append", chat_id: "oc_nonadvancing", create_time: "2001", content: "callback body"
});`;
    const appended = spawnSync(process.execPath, ["--input-type=module", "-e", appendScript, f.root, f.agentId], { encoding: "utf8" });
    assert.equal(appended.status, 0, appended.stderr);
    assert.equal(f.agent(["inbox", "check", "--target", "chat:oc_nonadvancing"]).status, 0,
      "background/check refresh remains content-light");

    const dashboardScript = `
import { collectStatus } from ${JSON.stringify(pathToFileURL(path.join(ROOT, "dist/dashboard/dashboard-view-model.mjs")).href)};
await collectStatus();`;
    const dashboard = spawnSync(process.execPath, ["--input-type=module", "-e", dashboardScript], {
      encoding: "utf8", env: { ...process.env, LARKIN_CONFIG_DIR: f.root, LARKIN_AGENT_ID: f.agentId },
    });
    assert.equal(dashboard.status, 0, dashboard.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).cursors[targetKey], before,
      "websocket/Host persistence and Dashboard/background observation must not acknowledge provider history");

    const failedWrite = f.lark(argv, {
      LARKIN_TEST_PROVIDER_HISTORY: f.history([old]),
      LARKIN_TEST_PROVIDER_WRITE_MODE: "fail",
    });
    assert.equal(failedWrite.status, 7, failedWrite.stderr);
    assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, "utf8")).cursors[targetKey], before,
      "a nonzero provider write must preserve the exact cursor");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
