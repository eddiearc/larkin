import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const LARK_CLI = path.join(ROOT, "dist/app/lark-cli.mjs");
const PROVIDER = path.join(ROOT, "test/support/runtime-agent-interface-v2-provider.mjs");

function writePrivate(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, value, { mode: 0o600 });
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-soft-freshness-"));
  const agentId = "cli_softFreshnessA1";
  const stateDir = path.join(root, "state", "agents", agentId);
  const callsFile = path.join(root, "provider-calls.ndjson");
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
  return { root, run, calls };
}

test("stale context emits a soft stderr notice after the provider send succeeds", () => {
  const f = fixture();
  try {
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
    assert.match(notice.hint, /Re-read.*lark-cli/);
    assert.deepEqual(f.calls().map((call) => call.argv[1]), ["+messages-send", "GET"]);
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
