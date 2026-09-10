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
      addons: opts.addons ?? null,
    }));
    opts.onQRCodeReady({ url: process.env.GRANT_READY_URL || ("https://" + opts.domain + "/oauth/grant?clientID=" + opts.appId), expireIn: 60 });
    return { client_id: process.env.GRANT_RETURN_APP_ID ?? opts.appId };
  },
  qrcode: { generate() {} },
  managedOfficialCli: () => ({ command: { command: "/verified/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: { GRANT_BOT_ONLY: "1" } }),
  spawnSync(command, args, options) {
    if (args.includes("/open-apis/application/v6/scopes")) {
      if (args.at(-2) !== "--as" || args.at(-1) !== "bot") throw new Error("explicit bot identity missing");
      if (options.env.GRANT_BOT_ONLY !== "1") throw new Error("managed identity lost");
      fs.writeFileSync(process.env.REGISTER_MARKER + ".scope-read", JSON.stringify(args));
      return { status: Number(process.env.GRANT_SCOPE_STATUS || 0), stdout: process.env.GRANT_SCOPES || JSON.stringify({ data: { scopes: [{ scope_name: "im:message.group_msg", grant_status: 1 }] } }), stderr: "" };
    }
    return { status: 0, stdout: "{}", stderr: "" };
  },
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
      GRANT_READY_URL: "https://open.larksuite.com/page/launcher?user_code=YKDY-TZ7Q&from=sdk&addons=H4sI&clientID=cli_grantTenantA1",
    },
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    const presented = fs.readFileSync(urlFile, "utf8");
    assert.match(presented, /^https:\/\/open\.larksuite\.com\/page\/cli\?/);
    assert.match(presented, /user_code=YKDY-TZ7Q/);
    assert.match(presented, /[?&]addons=H4sI/);
    assert.equal(new URL(presented).searchParams.get("clientID"), "cli_grantTenantA1");
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

test("grant-scopes tenant scopes include search:message", () => {
  const { temp, marker, result } = runGrant({ tenant: "feishu" });
  try {
    assert.equal(result.status, 0, result.stderr);
    const opts = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(opts.addons.scopes.tenant.includes("search:message"), true);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

for (const appId of ["cli_other", ""]) {
  test(`existing-app update rejects returned target ${appId || "missing"}`, () => {
    const { temp, marker, result } = runGrant({ extraEnv: { GRANT_RETURN_APP_ID: appId } });
    try {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /App ID.*不匹配/);
      assert.doesNotMatch(result.stdout, /GRANTED_APP_ID/);
      assert.equal(fs.existsSync(marker + ".scope-read"), false);
      const credential = JSON.parse(fs.readFileSync(path.join(temp, "root/bots/cli_grantTenantA1.json"), "utf8"));
      assert.equal(credential.capabilities, undefined);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  });
}

test("existing-app credential return is not a grant; missing required scope fails with same-app recovery", () => {
  const { temp, marker, result } = runGrant({ tenant: "lark", extraEnv: { GRANT_SCOPES: '{"data":{"scopes":[]}}' } });
  try {
    assert.notEqual(result.status, 0);
    assert.equal(fs.existsSync(marker + ".scope-read"), true);
    assert.match(result.stderr, /缺 im:message.group_msg/);
    assert.match(result.stderr, /open.larksuite.com\/app\/cli_grantTenantA1\/auth/);
    assert.doesNotMatch(result.stdout, /GRANTED_APP_ID/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("failed authoritative read does not prescribe permission changes", () => {
  const { temp, result } = runGrant({ extraEnv: { GRANT_SCOPE_STATUS: "1" } });
  try {
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /未验证/);
    assert.doesNotMatch(result.stderr, /\/auth\?q=/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
