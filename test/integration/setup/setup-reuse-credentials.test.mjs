import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const APP = "cli_reuseCredsA1";
const SECRET = "reuse-canary-secret";
const DENIED_SCOPES = JSON.stringify({ data: { scopes: [{ scope_name: "im:message.group_msg", grant_status: 0 }] } });

function writeConfig(root) {
  fs.mkdirSync(path.join(root, "agents", APP), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "reuse-creds", activeAgent: APP, mentionPolicy: "require",
    agents: { [APP]: { runtime: "claude", model: "default" } },
  })}\n`, { mode: 0o600 });
}

function writeStoredCredential(root, tenant = "lark") {
  const bots = path.join(root, "bots");
  fs.mkdirSync(bots, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(bots, `${APP}.json`), `${JSON.stringify({
    appId: APP, appSecret: SECRET, tenant, ownerOpenId: "ou_owner",
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  }, null, 2)}\n`, { mode: 0o600 });
}

function writeFixture(temp) {
  const fixture = path.join(temp, "fixture.cjs");
  const qrMarker = path.join(temp, "qr-called.marker");
  fs.writeFileSync(fixture, `const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const qrMarker = ${JSON.stringify(qrMarker)};
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
module.exports = {
  registerApp: async () => { throw new Error("QR authorization must not run in --reuse-credentials mode"); },
  qrcode: { generate() { fs.writeFileSync(qrMarker, "called"); } },
  resolveOfficialLarkCli: () => ({ command: "lark-cli", argsPrefix: [], version: "1.0.80" }),
  wait: async () => {},
  spawn(command, args, options) {
    if (args.includes("+chat-list")) return fakeChild(0, JSON.stringify({ ok: true, identity: "bot" }));
    if (args.some((a) => String(a).includes("application/v6/scopes"))) return fakeChild(0, ${JSON.stringify(DENIED_SCOPES)});
    return fakeChild(0, "");
  },
  spawnSync(command, args) {
    if (args.includes("+chat-list")) return { status: 0, stdout: JSON.stringify({ ok: true, identity: "bot" }), stderr: "" };
    if (args.some((a) => String(a).includes("application/v6/scopes"))) return { status: 0, stdout: ${JSON.stringify(DENIED_SCOPES)}, stderr: "" };
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
};
`);
  return { fixture, qrMarker };
}

function runRegister(root, temp, fixture, resultFile, extraArgs = []) {
  return spawnSync(process.execPath, [
    path.join(ROOT, "dist/setup/bot-register.mjs"), "--auto", "--runtime", "claude",
    "--reuse-credentials", "--result-file", resultFile, ...extraArgs,
  ], {
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

test("reuse uses the stored credential, skips the authorization page, and still fails closed on missing scopes", { timeout: 20_000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reuse-creds-"));
  const root = path.join(temp, "root");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  writeConfig(root);
  writeStoredCredential(root, "lark");
  const { fixture, qrMarker } = writeFixture(temp);
  const resultFile = path.join(root, ".setup-result-123.json");
  try {
    const result = runRegister(root, temp, fixture, resultFile);
    const text = `${result.stderr || ""}\n${result.stdout || ""}`;
    assert.notEqual(result.status, 0, text);
    assert.match(text, /复用既有凭证 cli_reuseCredsA1/);
    assert.match(text, /缺 im:message\.group_msg/);
    assert.equal(fs.existsSync(qrMarker), false, "the authorization QR must not be requested");
    assert.doesNotMatch(text, new RegExp(SECRET));
    assert.equal(fs.existsSync(resultFile), false);
    const stored = JSON.parse(fs.readFileSync(path.join(root, "bots", `${APP}.json`), "utf8"));
    assert.equal(stored.appSecret, SECRET);
    assert.equal(stored.tenant, "lark", "the stored tenant must be preserved");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("reuse without a stored credential fails with a clear message before any authorization", { timeout: 20_000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reuse-missing-"));
  const root = path.join(temp, "root");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  writeConfig(root);
  const { fixture, qrMarker } = writeFixture(temp);
  try {
    const result = runRegister(root, temp, fixture, path.join(root, ".setup-result-123.json"));
    const text = `${result.stderr || ""}\n${result.stdout || ""}`;
    assert.notEqual(result.status, 0, text);
    assert.match(text, /未找到 cli_reuseCredsA1 的可用既有凭证/);
    assert.equal(fs.existsSync(qrMarker), false);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("reuse rejects an explicit tenant that contradicts the stored credential", { timeout: 20_000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reuse-tenant-"));
  const root = path.join(temp, "root");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  writeConfig(root);
  writeStoredCredential(root, "lark");
  const credentialBefore = fs.readFileSync(path.join(root, "bots", `${APP}.json`));
  const { fixture, qrMarker } = writeFixture(temp);
  try {
    const result = runRegister(root, temp, fixture, path.join(root, ".setup-result-123.json"), ["--tenant", "feishu"]);
    const text = `${result.stderr || ""}\n${result.stdout || ""}`;
    assert.notEqual(result.status, 0, text);
    assert.match(text, /与 --tenant feishu 不一致/);
    assert.equal(fs.existsSync(qrMarker), false);
    assert.deepEqual(fs.readFileSync(path.join(root, "bots", `${APP}.json`)), credentialBefore, "nothing may be written before the tenant check");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
