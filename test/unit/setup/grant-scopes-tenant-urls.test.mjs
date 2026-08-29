import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRY = path.join(ROOT, "dist/setup/grant-scopes.mjs");

function runGrant({ tenant = "feishu", extraArgs = [], extraEnv = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-grant-tenant-"));
  const root = path.join(temp, "root");
  const app = "cli_grantTenantA1";
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    version: 3, serverId: "server-grant-tenant", activeAgent: app,
    agents: { [app]: { runtime: "codex", model: "gpt" } },
  }), { mode: 0o600 });
  fs.mkdirSync(path.join(root, "bots"), { mode: 0o700 });
  fs.writeFileSync(path.join(root, "bots", `${app}.json`), JSON.stringify({
    appId: app, appSecret: "fixture-secret", tenant,
  }), { mode: 0o600 });
  const marker = path.join(temp, "register.json");
  const fixture = path.join(temp, "fixture.cjs");
  fs.writeFileSync(fixture, `const fs = require("node:fs");
module.exports = {
  registerApp: async (opts) => {
    fs.writeFileSync(process.env.REGISTER_MARKER, JSON.stringify({
      appId: opts.appId,
      domain: opts.domain,
    }));
    opts.onQRCodeReady({ url: process.env.GRANT_READY_URL || ("https://" + opts.domain + "/oauth/grant"), expireIn: 60 });
    return { client_id: opts.appId };
  },
  qrcode: { generate() {} },
  managedOfficialCli: () => ({ command: { command: "/verified/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} }),
  spawnSync() { return { status: 0, stdout: "{}", stderr: "" }; },
};
`);
  const result = spawnSync(process.execPath, [ENTRY, "--wait-min", "1", ...extraArgs], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: path.join(temp, "home"),
      LARKIN_HOME: root,
      LARKIN_CONFIG_DIR: root,
      LARKSUITE_CLI_CONFIG_DIR: path.join(temp, "lark-cli"),
      LARKIN_TEST_GRANT_SCOPES_MODULE: fixture,
      REGISTER_MARKER: marker,
      LARKIN_AGENT_ID: undefined,
      ...extraEnv,
    },
  });
  return { temp, marker, result };
}

test("stored Lark credential without --tenant uses accounts.larksuite.com, not brand token lark", () => {
  const { temp, marker, result } = runGrant({ tenant: "lark" });
  try {
    assert.equal(result.status, 0, result.stderr);
    const opts = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(opts.domain, "accounts.larksuite.com");
    assert.notEqual(opts.domain, "lark");
    assert.notEqual(opts.domain, "accounts.feishu.cn");
    assert.doesNotMatch(JSON.stringify(opts), /feishu\.cn/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("explicit --tenant lark uses the official Lark accounts host", () => {
  const { temp, marker, result } = runGrant({ tenant: "feishu", extraArgs: ["--tenant", "lark"] });
  try {
    assert.equal(result.status, 0, result.stderr);
    const opts = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(opts.domain, "accounts.larksuite.com");
    assert.doesNotMatch(JSON.stringify(opts), /feishu\.cn/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("--tenant lark rewrites launcher to /page/cli and keeps addons", () => {
  const urlFile = path.join(os.tmpdir(), `larkin-grant-url-${process.pid}.txt`);
  const { temp, result } = runGrant({
    tenant: "lark",
    extraArgs: ["--tenant", "lark", "--url-file", urlFile],
    extraEnv: {
      GRANT_READY_URL: "https://open.larksuite.com/page/launcher?user_code=YKDY-TZ7Q&from=sdk&addons=H4sI",
    },
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    const presented = fs.readFileSync(urlFile, "utf8");
    assert.match(presented, /^https:\/\/open\.larksuite\.com\/page\/cli\?/);
    assert.match(presented, /user_code=YKDY-TZ7Q/);
    assert.match(presented, /[?&]addons=H4sI/);
    assert.doesNotMatch(presented, /\/page\/launcher/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    try { fs.rmSync(urlFile, { force: true }); } catch { /* ignore */ }
  }
});

test("Feishu credential / default still uses accounts.feishu.cn", () => {
  const { temp, marker, result } = runGrant({ tenant: "feishu" });
  try {
    assert.equal(result.status, 0, result.stderr);
    const opts = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(opts.domain, "accounts.feishu.cn");
    assert.doesNotMatch(JSON.stringify(opts), /larksuite\.com/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
