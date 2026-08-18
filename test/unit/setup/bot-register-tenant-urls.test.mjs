import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRY = path.join(ROOT, "dist/setup/bot-register.mjs");

function runRegister({ tenantArgs = [], userInfo = { tenant_brand: "feishu" }, clientId = "not-an-app-id" } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-bot-register-tenant-"));
  const configDir = path.join(temp, "config");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const marker = path.join(temp, "register.json");
  const qrMarker = path.join(temp, "qr.txt");
  const fixture = path.join(temp, "fixture.cjs");
  fs.writeFileSync(fixture, `const fs = require("node:fs");
module.exports = {
  registerApp: async (opts) => {
    fs.writeFileSync(process.env.REGISTER_MARKER, JSON.stringify({
      domain: opts.domain,
      larkDomain: opts.larkDomain,
    }));
    const url = "https://" + opts.domain + "/oauth/v1/app/registration?code=fixture";
    fs.writeFileSync(process.env.QR_MARKER, url);
    opts.onQRCodeReady({ url, expireIn: 60 });
    return {
      client_id: ${JSON.stringify(clientId)},
      client_secret: "fixture-secret",
      user_info: ${JSON.stringify(userInfo)},
    };
  },
  qrcode: { generate() {} },
  spawnSync() { return { status: 1, stdout: "", stderr: "blocked" }; },
};
`);
  const result = spawnSync(process.execPath, [ENTRY, "--auto", ...tenantArgs], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: path.join(temp, "home"),
      LARKIN_HOME: configDir,
      LARKIN_CONFIG_DIR: configDir,
      LARKSUITE_CLI_CONFIG_DIR: path.join(temp, "lark-cli"),
      LARKIN_TEST_BOT_REGISTER_MODULE: fixture,
      REGISTER_MARKER: marker,
      QR_MARKER: qrMarker,
    },
  });
  return { temp, configDir, marker, qrMarker, result };
}

test("--tenant lark passes official Lark accounts hosts and the QR URL has no feishu.cn", () => {
  const { temp, marker, qrMarker, result } = runRegister({
    tenantArgs: ["--tenant", "lark"],
    userInfo: { tenant_brand: "lark" },
  });
  try {
    assert.notEqual(result.status, 0);
    const opts = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(opts.domain, "accounts.larksuite.com");
    assert.equal(opts.larkDomain, "accounts.larksuite.com");
    const url = fs.readFileSync(qrMarker, "utf8");
    assert.match(url, /accounts\.larksuite\.com/);
    assert.doesNotMatch(url, /feishu\.cn/);
    assert.doesNotMatch(JSON.stringify(opts), /feishu\.cn/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("default and --tenant feishu stay on official China accounts hosts", () => {
  for (const tenantArgs of [[], ["--tenant", "feishu"]]) {
    const { temp, marker, qrMarker, result } = runRegister({ tenantArgs });
    try {
      assert.notEqual(result.status, 0);
      const opts = JSON.parse(fs.readFileSync(marker, "utf8"));
      assert.equal(opts.domain, "accounts.feishu.cn");
      assert.equal(opts.larkDomain, "accounts.larksuite.com");
      const url = fs.readFileSync(qrMarker, "utf8");
      assert.match(url, /accounts\.feishu\.cn/);
      assert.doesNotMatch(url, /larksuite\.com/);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
});

test("conflicting user_info.tenant_brand fails closed without writing credentials", () => {
  const { temp, configDir, result } = runRegister({
    tenantArgs: ["--tenant", "lark"],
    userInfo: { tenant_brand: "feishu", open_id: "ou_conflict" },
    clientId: "cli_conflictTenantA1",
  });
  try {
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /不一致|未执行凭证/);
    assert.equal(fs.existsSync(path.join(configDir, "bots", "cli_conflictTenantA1.json")), false);
    const botsDir = path.join(configDir, "bots");
    if (fs.existsSync(botsDir)) {
      assert.deepEqual(fs.readdirSync(botsDir).filter((name) => name.endsWith(".json")), []);
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
