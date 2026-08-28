import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const APP = "cli_scopePiTxnA1";
const ORIGINAL_AUTH = `${JSON.stringify({ original: { type: "api_key", key: "original-key" } }, null, 2)}\n`;
const ORIGINAL_MODELS = `${JSON.stringify({ providers: { original: { baseUrl: "http://127.0.0.1:1" } } }, null, 2)}\n`;
const SETUP_AUTH = `${JSON.stringify({
  original: { type: "api_key", key: "original-key" },
  setup: { type: "api_key", key: "setup-key" },
}, null, 2)}\n`;
const DENIED_SCOPES = JSON.stringify({ data: { scopes: [{ scope_name: "im:message.group_msg", grant_status: 0 }] } });
const GRANTED_SCOPES = JSON.stringify({ data: { scopes: [{ scope_name: "im:message.group_msg", grant_status: 1 }] } });

function walkQuarantine(root) {
  const hits = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const next = path.join(dir, entry.name);
      if (/quarantine/i.test(entry.name)) hits.push(next);
      if (entry.isDirectory()) walk(next);
    }
  };
  walk(root);
  return hits;
}

function writePiOriginal(root) {
  const dir = path.join(root, "providers", "pi", APP);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  fs.writeFileSync(path.join(dir, "auth.json"), ORIGINAL_AUTH, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "models.json"), ORIGINAL_MODELS, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "models-store.json"), "{}\n", { mode: 0o600 });
}

function writeFixture(temp, scopesStdout, scopesStatus = 0) {
  const fixture = path.join(temp, "fixture.cjs");
  fs.writeFileSync(fixture, `const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
function fakeChild(status, stdout) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.pid = 1;
  queueMicrotask(() => {
    child.stdout.end(stdout || "");
    child.stderr.end("");
    child.emit("exit", status);
  });
  return child;
}
function writeBoundConfig() {
  const root = process.env.LARKIN_CONFIG_DIR;
  fs.mkdirSync(path.join(root, "agents", ${JSON.stringify(APP)}), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    version: 4, serverId: "scope-pi", activeAgent: ${JSON.stringify(APP)}, mentionPolicy: "require",
    agents: { [${JSON.stringify(APP)}]: { runtime: "pi", model: "larkin-custom/fixture-model", piDistribution: "builtin" } },
  }) + "\\n", { mode: 0o600 });
}
module.exports = {
  registerApp: async () => ({ client_id: ${JSON.stringify(APP)}, client_secret: "canary-secret", user_info: { tenant_brand: "feishu", open_id: "ou_owner" } }),
  qrcode: { generate() {} },
  resolveOfficialLarkCli: () => ({ command: "lark-cli", argsPrefix: [], version: "1.0.80" }),
  wait: async () => {},
  spawn(command, args) {
    if (args.includes("+chat-list")) return fakeChild(0, JSON.stringify({ ok: true, identity: "bot" }));
    if (args.some((a) => String(a).includes("application/v6/scopes"))) return fakeChild(${scopesStatus}, ${JSON.stringify(scopesStdout)});
    if (args.includes("setup-bind")) { writeBoundConfig(); return fakeChild(0, ""); }
    return fakeChild(0, "");
  },
  spawnSync(command, args) {
    if (command === "lark-cli" && args.includes("+chat-list")) return { status: 0, stdout: JSON.stringify({ ok: true, identity: "bot" }), stderr: "" };
    if (args.some((a) => String(a).includes("application/v6/scopes"))) {
      return { status: ${scopesStatus}, stdout: ${JSON.stringify(scopesStdout)}, stderr: "" };
    }
    if (args.includes("setup-bind")) { writeBoundConfig(); return { status: 0, stdout: "", stderr: "" }; }
    return { status: 0, stdout: "", stderr: "" };
  },
  syncAgentProfile(agent) {
    const source = path.join(agent.stateDir, "lark-channel-source");
    const workspace = path.join(agent.larkConfigDir, "lark-channel");
    fs.mkdirSync(source, { recursive: true, mode: 0o700 });
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(source, "config.json"), "{}", { mode: 0o600 });
    fs.writeFileSync(path.join(workspace, "config.json"), "{}", { mode: 0o600 });
  },
  async collectSetupAgentChoice() {
    const dir = path.join(process.env.LARKIN_CONFIG_DIR, "providers", "pi", ${JSON.stringify(APP)});
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(path.join(dir, "auth.json"), ${JSON.stringify(SETUP_AUTH)}, { mode: 0o600 });
    fs.writeFileSync(path.join(dir, "models.json"), ${JSON.stringify(SETUP_AUTH)}, { mode: 0o600 });
    return { runtime: "pi", distribution: "builtin", preset: "custom", baseUrl: "http://127.0.0.1:9", model: "fixture-model" };
  },
};
`);
  return fixture;
}

function runRegister(root, temp, fixture, resultFile) {
  return spawnSync(process.execPath, [path.join(ROOT, "dist/setup/bot-register.mjs"), "--auto", "--result-file", resultFile], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: path.join(temp, "home"),
      LARKIN_CONFIG_DIR: root,
      LARKIN_HOME: root,
      LARKSUITE_CLI_CONFIG_DIR: path.join(root, "lark-cli"),
      LARKIN_TEST_BOT_REGISTER_MODULE: fixture,
      LARKIN_TEST_ASYNC_IDENTITY: "1",
    },
  });
}

test("injected agent-choice enters Pi transaction and rolls back on scope failure", { timeout: 20_000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-scope-pi-txn-"));
  const root = path.join(temp, "root");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  writePiOriginal(root);
  const authBefore = fs.readFileSync(path.join(root, "providers", "pi", APP, "auth.json"));
  const modelsBefore = fs.readFileSync(path.join(root, "providers", "pi", APP, "models.json"));
  const configBefore = fs.existsSync(path.join(root, "config.json")) ? fs.readFileSync(path.join(root, "config.json")) : null;
  const resultFile = path.join(root, ".setup-result-123.json");
  const fixture = writeFixture(temp, DENIED_SCOPES);
  try {
    const result = runRegister(root, temp, fixture, resultFile);
    const text = `${result.stderr || ""}\n${result.stdout || ""}`;
    assert.notEqual(result.status, 0, text);
    assert.match(text, /缺 im:message\.group_msg/);
    assert.equal(fs.existsSync(resultFile), false);
    assert.deepEqual(fs.readFileSync(path.join(root, "providers", "pi", APP, "auth.json")), authBefore);
    assert.deepEqual(fs.readFileSync(path.join(root, "providers", "pi", APP, "models.json")), modelsBefore);
    assert.equal(walkQuarantine(root).length, 0);
    const configAfter = fs.readFileSync(path.join(root, "config.json"));
    if (configBefore) assert.notEqual(Buffer.compare(configAfter, configBefore), 0);
    const parsed = JSON.parse(configAfter.toString("utf8"));
    assert.equal(parsed.activeAgent, APP);
    assert.equal(parsed.agents[APP].runtime, "pi");
    assert.equal(JSON.parse(fs.readFileSync(path.join(root, "bots", `${APP}.json`), "utf8")).appSecret, "canary-secret");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("injected agent-choice retries after grant and keeps Pi setup credential", { timeout: 20_000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-scope-pi-retry-"));
  const root = path.join(temp, "root");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  writePiOriginal(root);
  const resultFile = path.join(root, ".setup-result-123.json");
  try {
    const denied = writeFixture(temp, DENIED_SCOPES);
    const first = runRegister(root, temp, denied, resultFile);
    assert.notEqual(first.status, 0, first.stderr || first.stdout);
    assert.equal(fs.existsSync(resultFile), false);
    const granted = writeFixture(temp, GRANTED_SCOPES);
    const second = runRegister(root, temp, granted, resultFile);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(fs.existsSync(resultFile), true);
    const auth = JSON.parse(fs.readFileSync(path.join(root, "providers", "pi", APP, "auth.json"), "utf8"));
    assert.equal(auth.setup.key, "setup-key");
    assert.equal(walkQuarantine(root).length, 0);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
