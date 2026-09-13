import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const APP = "cli_optScopeReportA1";
// Only the blocking freshness scope is granted; every optional scope is missing.
const REQUIRED_ONLY_SCOPES = JSON.stringify({ data: { scopes: [{ scope_name: "im:message.group_msg", grant_status: 1 }] } });

function writeConfig(root) {
  fs.mkdirSync(path.join(root, "agents", APP), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "opt-scope-report", activeAgent: APP, mentionPolicy: "require",
    agents: { [APP]: { runtime: "claude", model: "default" } },
  })}\n`, { mode: 0o600 });
}

function writeFixture(temp) {
  const fixture = path.join(temp, "fixture.cjs");
  fs.writeFileSync(fixture, `const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
globalThis.fetch = async (url) => {
  const target = String(url);
  if (target.includes("/auth/v3/tenant_access_token/internal")) return { json: async () => ({ code: 0, tenant_access_token: "t-fake" }) };
  if (target.includes("/bot/v3/info")) return { json: async () => ({ code: 0, bot: { open_id: "ou_probe", app_name: "ProbeBot" } }) };
  throw new Error("unexpected fetch: " + target);
};
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
  registerApp: async () => ({ client_id: ${JSON.stringify(APP)}, client_secret: "canary-secret", user_info: { tenant_brand: "feishu", open_id: "ou_owner" } }),
  qrcode: { generate() {} },
  resolveOfficialLarkCli: () => ({ command: "lark-cli", argsPrefix: [], version: "1.0.80" }),
  wait: async () => {},
  spawn(command, args) {
    if (args.includes("+chat-list")) return fakeChild(0, JSON.stringify({ ok: true, identity: "bot" }));
    if (args.some((a) => String(a).includes("application/v6/scopes"))) return fakeChild(0, ${JSON.stringify(REQUIRED_ONLY_SCOPES)});
    return fakeChild(0, "");
  },
  spawnSync(command, args) {
    if (args.includes("+chat-list")) return { status: 0, stdout: JSON.stringify({ ok: true, identity: "bot" }), stderr: "" };
    if (args.some((a) => String(a).includes("application/v6/scopes"))) return { status: 0, stdout: ${JSON.stringify(REQUIRED_ONLY_SCOPES)}, stderr: "" };
    if (args.includes("visibility")) return { status: 0, stdout: JSON.stringify({ ok: true }), stderr: "" };
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
  return fixture;
}

test("setup reports optional-scope impacts and still completes when only optional scopes are missing", { timeout: 20_000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-opt-scope-report-"));
  const root = path.join(temp, "root");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  writeConfig(root);
  const fixture = writeFixture(temp);
  const resultFile = path.join(root, ".setup-result-123.json");
  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "dist/setup/bot-register.mjs"),
      "--auto", "--tenant", "feishu", "--runtime", "claude", "--result-file", resultFile,
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
    const text = `${result.stdout || ""}\n${result.stderr || ""}`;
    assert.equal(result.status, 0, text);
    assert.match(text, /可选权限未授予，setup 可继续/);
    assert.match(text, /- 群与成员信息（成员姓名\/群名解析）：im:chat:readonly, im:chat\.group_info:readonly, im:chat\.members:read/);
    assert.match(text, /- 云文档评论事件与回复：drive:drive, docs:document\.comment:read, docs:document\.comment:create/);
    assert.match(text, /- 应用可用范围自动设为全员可见：admin:app\.visibility/);
    assert.match(text, /其他权限：application:application:self_manage/);
    assert.match(text, /op_from=openapi/, "the console recovery link must accompany the report");
    assert.equal(fs.existsSync(resultFile), true, "setup must still complete");
    assert.doesNotMatch(text, /canary-secret/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
