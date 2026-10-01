import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const LARK_CLI = path.join(ROOT, "dist/app/lark-cli.mjs");
const PROVIDER = path.join(ROOT, "test/support/runtime-agent-interface-v2-provider.mjs");
const stateModule = await import(pathToFileURL(path.join(ROOT, "dist/agent/agent-state-store.mjs")).href);

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-soft-freshness-"));
  const agentId = "cli_softFreshnessA1";
  const stateDir = path.join(root, "state", "agents", agentId);
  const callsFile = path.join(root, "provider-calls.ndjson");
  const store = stateModule.createAgentStateStore(root, agentId);
  writePrivate(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "soft-freshness", mentionPolicy: "require", activeAgent: agentId,
    agents: { [agentId]: { runtime: "pi", model: "default" } },
  })}\n`);
  writePrivate(path.join(stateDir, "lark-channel-source", "config.json"), JSON.stringify({
    accounts: { app: { id: agentId, secret: { source: "exec", provider: "larkin-bot-credential", id: agentId } } },
    secrets: { providers: { "larkin-bot-credential": {
      source: "exec", command: process.execPath, args: [],
      env: { LARKIN_AGENT_ID: agentId, LARKIN_SECRET_PROVIDER_CONTEXT: "bind" },
    } } },
  }));
  writePrivate(path.join(stateDir, "lark-cli-config", "lark-channel", "config.json"), JSON.stringify({
    apps: [{
      appId: agentId, name: agentId, appSecret: { source: "keychain", id: `appsecret:${agentId}` },
      brand: "feishu", defaultAs: "bot", strictMode: "bot", users: [],
    }],
  }));
  const packageDir = path.join(root, "official", "node_modules", "@larksuite", "cli");
  const executable = path.join(packageDir, "scripts", "run.sh");
  const bin = path.join(root, "bin");
  const home = path.join(root, "home");
  fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 });
  fs.mkdirSync(bin, { mode: 0o700 });
  fs.mkdirSync(home, { mode: 0o700 });
  writePrivate(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version: "1.0.80", bin: { "lark-cli": "scripts/run.sh" },
  }));
  fs.writeFileSync(executable, `#!/bin/sh
if [ "$1" = "--version" ]; then printf '1.0.80\\n'; exit 0; fi
if [ "$1" = "config" ] && [ "$2" = "bind" ] && [ "$3" = "--help" ]; then
  printf '%s\\n' 'Usage: lark-cli config bind --source lark-channel --identity bot-only'; exit 0
fi
export LARKIN_TEST_PROVIDER_PARENT_PID="$PPID"
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(PROVIDER)} "$@"
`, { mode: 0o700 });
  fs.symlinkSync(executable, path.join(bin, "lark-cli"));
  const profile = `export PATH=${JSON.stringify(bin)}:$PATH\n`;
  fs.writeFileSync(path.join(home, ".bash_profile"), profile, { mode: 0o600 });
  fs.writeFileSync(path.join(home, ".zprofile"), profile, { mode: 0o600 });
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
  const run = (argv, overrides = {}) => spawnSync(process.execPath, [LARK_CLI, ...argv], {
    cwd: root, env: { ...env, ...overrides }, encoding: "utf8", timeout: 30_000,
  });
  const calls = () => fs.existsSync(callsFile)
    ? fs.readFileSync(callsFile, "utf8").split("\n").filter(Boolean).map(JSON.parse)
    : [];
  return { root, env, run, calls, store };
}

test("stale context emits a soft stderr notice after the provider send succeeds", () => {
  const f = fixture();
  try {
    writePrivate(path.join(f.root, "state", "agents", "cli_softFreshnessA1", "freshness-state.json"), JSON.stringify({
      version: 1,
      cursors: {
        "feishu.im/chat/oc_soft": {
          generation: "external",
          cursor: { schema: 1, revisionTime: "99", messageIds: ["om_seen"] },
        },
      },
    }));
    const stale = JSON.stringify({ ok: true, identity: "bot", data: { messages: [{
      message_id: "om_newer", chat_id: "oc_soft", create_time: "100",
    }] } });
    const write = JSON.stringify({ ok: true, data: {
      message_id: "om_own", chat_id: "oc_soft", create_time: "101",
    } });
    const result = f.run(["im", "+messages-send", "--chat-id", "oc_soft", "--text", "answer"], {
      LARKIN_TEST_PROVIDER_HISTORY: stale,
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: write,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, write);
    const notice = JSON.parse(result.stderr);
    assert.equal(notice.larkin_notice, "freshness");
    assert.equal(notice.target, "feishu.im/chat/oc_soft");
    assert.deepEqual(notice.latest_message_ids, ["om_newer"]);
    assert.match(notice.hint, /Re-read.*larkin/);
    assert.deepEqual(f.calls().map((call) => call.argv[1]), ["+messages-send", "GET"]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("a current freshness cursor does not emit a stale-context notice", () => {
  const f = fixture();
  try {
    writePrivate(path.join(f.root, "state", "agents", "cli_softFreshnessA1", "freshness-state.json"), JSON.stringify({
      version: 1,
      cursors: {
        "feishu.im/chat/oc_current": {
          generation: "external",
          cursor: { schema: 1, revisionTime: "100", messageIds: ["om_current"] },
        },
      },
    }));
    const history = JSON.stringify({ ok: true, identity: "bot", data: { messages: [{
      message_id: "om_current", chat_id: "oc_current", create_time: "100",
    }] } });
    const write = JSON.stringify({ ok: true, data: {
      message_id: "om_own", chat_id: "oc_current", create_time: "101",
    } });
    const result = f.run(["im", "+messages-send", "--chat-id", "oc_current", "--text", "answer"], {
      LARKIN_TEST_PROVIDER_HISTORY: history,
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: write,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, write);
    assert.doesNotMatch(result.stderr, /"larkin_notice":"freshness"/);
    assert.deepEqual(f.calls().map((call) => call.argv[1]), ["+messages-send", "GET"]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("the first successful write bootstraps quietly and a later newer message emits a notice", () => {
  const f = fixture();
  try {
    const firstHistory = JSON.stringify({ ok: true, identity: "bot", data: { messages: [{
      message_id: "om_baseline", chat_id: "oc_bootstrap", create_time: "100",
    }] } });
    const firstWrite = JSON.stringify({ ok: true, data: {
      message_id: "om_first_own", chat_id: "oc_bootstrap", create_time: "101",
    } });
    const first = f.run(["im", "+messages-send", "--chat-id", "oc_bootstrap", "--text", "first"], {
      LARKIN_TEST_PROVIDER_HISTORY: firstHistory,
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: firstWrite,
    });
    assert.equal(first.status, 0, first.stderr);
    assert.doesNotMatch(first.stderr, /"larkin_notice":"freshness"/);

    const newerHistory = JSON.stringify({ ok: true, identity: "bot", data: { messages: [
      { message_id: "om_newer", chat_id: "oc_bootstrap", create_time: "102" },
      { message_id: "om_baseline", chat_id: "oc_bootstrap", create_time: "100" },
    ] } });
    const secondWrite = JSON.stringify({ ok: true, data: {
      message_id: "om_second_own", chat_id: "oc_bootstrap", create_time: "103",
    } });
    const second = f.run(["im", "+messages-send", "--chat-id", "oc_bootstrap", "--text", "second"], {
      LARKIN_TEST_PROVIDER_HISTORY: newerHistory,
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: secondWrite,
    });
    assert.equal(second.status, 0, second.stderr);
    const notice = JSON.parse(second.stderr);
    assert.equal(notice.larkin_notice, "freshness");
    assert.deepEqual(notice.latest_message_ids, ["om_newer"]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("a first freshness check requests and stores only the latest 20-message window", () => {
  const f = fixture();
  try {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      message_id: `om_window_${index}`,
      chat_id: "oc_window",
      create_time: String(100 + index),
    }));
    const result = f.run(["im", "+messages-send", "--chat-id", "oc_window", "--text", "first"], {
      LARKIN_TEST_PROVIDER_HISTORY: JSON.stringify({ ok: true, identity: "bot", data: { messages } }),
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: JSON.stringify({ ok: true, data: {
        message_id: "om_window_own", chat_id: "oc_window", create_time: "120",
      } }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /"larkin_notice":"freshness"/);
    const probe = f.calls().find((call) => call.argv[0] === "api" && call.argv[1] === "GET");
    assert.ok(probe);
    assert.deepEqual(JSON.parse(probe.argv[probe.argv.indexOf("--params") + 1]), {
      container_id_type: "chat", container_id: "oc_window", sort_type: "ByCreateTimeDesc", page_size: 20,
    });
    assert.deepEqual(f.store.readFreshnessCursor("feishu.im/chat/oc_window", "external"), {
      schema: 1, revisionTime: "119", messageIds: ["om_window_19"],
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("an empty first freshness result saves nothing and the next observed window becomes the baseline", () => {
  const f = fixture();
  try {
    const empty = f.run(["im", "+messages-send", "--chat-id", "oc_empty", "--text", "first"], {
      LARKIN_TEST_PROVIDER_HISTORY: JSON.stringify({ ok: true, identity: "bot", data: { messages: [] } }),
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: JSON.stringify({ ok: true, data: {
        message_id: "om_empty_own", chat_id: "oc_empty", create_time: "100",
      } }),
    });
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(f.store.readFreshnessCursor("feishu.im/chat/oc_empty", "external"), null);

    const next = f.run(["im", "+messages-send", "--chat-id", "oc_empty", "--text", "second"], {
      LARKIN_TEST_PROVIDER_HISTORY: JSON.stringify({ ok: true, identity: "bot", data: { messages: [{
        message_id: "om_first_observed", chat_id: "oc_empty", create_time: "101",
      }] } }),
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: JSON.stringify({ ok: true, data: {
        message_id: "om_empty_second", chat_id: "oc_empty", create_time: "102",
      } }),
    });
    assert.equal(next.status, 0, next.stderr);
    assert.doesNotMatch(next.stderr, /"larkin_notice":"freshness"/);
    assert.deepEqual(f.store.readFreshnessCursor("feishu.im/chat/oc_empty", "external"), {
      schema: 1, revisionTime: "101", messageIds: ["om_first_observed"],
    });
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("a slow post-write freshness probe times out without delaying or failing the send", () => {
  const f = fixture();
  try {
    const startedAt = Date.now();
    const result = f.run(["im", "+messages-send", "--chat-id", "oc_slow_probe", "--text", "sent"], {
      LARKIN_TEST_PROVIDER_HISTORY_DELAY_MS: "2000",
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: JSON.stringify({ ok: true, data: {
        message_id: "om_slow_own", chat_id: "oc_slow_probe", create_time: "100",
      } }),
    });
    const elapsedMs = Date.now() - startedAt;
    assert.equal(result.status, 0, result.stderr);
    assert.ok(elapsedMs < 1_500, `freshness observation took ${elapsedMs}ms`);
    assert.doesNotMatch(result.stderr, /"larkin_notice":"freshness"/);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("unavailable freshness observation cannot reject a successful provider write", () => {
  const f = fixture();
  try {
    const write = JSON.stringify({ ok: true, data: {
      message_id: "om_own", chat_id: "oc_unavailable", create_time: "101",
    } });
    const result = f.run(["im", "+messages-send", "--chat-id", "oc_unavailable", "--text", "answer"], {
      LARKIN_TEST_PROVIDER_HISTORY: "not-json",
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: write,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, write);
    assert.doesNotMatch(result.stderr, /freshness_(?:conflict|unavailable)/);
    assert.deepEqual(f.calls().map((call) => call.argv[1]), ["+messages-send", "GET"]);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test.skipIf(!fs.existsSync("/bin/bash"))("real shell preserves a quoted multiline reply body as one provider argument", () => {
  const f = fixture();
  try {
    const body = "first line\n\"quoted\" and $literal's value";
    f.store.appendInboxOnce({ message_id: "om_shell_reply", chat_id: "oc_shell_reply", content: "question" });
    f.store.pollInbox({ target: "chat:oc_shell_reply", limit: 1 });
    const command = [
      shellQuote(process.execPath), shellQuote(LARK_CLI),
      "im", "+messages-reply", "--message-id", "om_shell_reply", "--markdown", shellQuote(body),
    ].join(" ");
    const result = spawnSync("/bin/bash", ["-lc", command], {
      cwd: f.root,
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...f.env,
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: JSON.stringify({ ok: true, data: {
        message_id: "om_shell_own", chat_id: "oc_shell_reply", create_time: "101",
      } }),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const reply = f.calls().find((call) => call.argv[1] === "+messages-reply");
    assert.ok(reply);
    assert.equal(reply.argv[reply.argv.indexOf("--markdown") + 1], body);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("retrying after a SIGKILL uses the same derived idempotency key and stores no body", () => {
  const f = fixture();
  try {
    const body = "sensitive body that must not be persisted";
    const first = f.run(["im", "+messages-send", "--chat-id", "oc_killed", "--text", body], {
      LARKIN_TEST_PROVIDER_WRITE_MODE: "kill-parent",
    });
    assert.equal(first.signal, "SIGKILL", first.stderr);
    const firstCall = f.calls().find((call) => call.argv[1] === "+messages-send");
    assert.ok(firstCall?.idempotency_key);
    const statePath = path.join(f.root, "state", "agents", "cli_softFreshnessA1", "freshness-state.json");
    if (fs.existsSync(statePath)) assert.doesNotMatch(fs.readFileSync(statePath, "utf8"), new RegExp(body));

    const second = f.run(["im", "+messages-send", "--chat-id", "oc_killed", "--text", body], {
      LARKIN_TEST_PROVIDER_WRITE_STDOUT: JSON.stringify({ ok: true, data: {
        message_id: "om_killed_own", chat_id: "oc_killed", create_time: "101",
      } }),
    });
    assert.equal(second.status, 0, second.stderr);
    const writes = f.calls().filter((call) => call.argv[1] === "+messages-send");
    assert.equal(writes.length, 2);
    assert.equal(writes[0].idempotency_key, writes[1].idempotency_key);
    if (fs.existsSync(statePath)) assert.doesNotMatch(fs.readFileSync(statePath, "utf8"), new RegExp(body));
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
