import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ENTRY = path.join(ROOT, "dist/setup/bot-register.mjs");
const EXPECTED_TENANT_EVENTS = ["im.message.receive_v1", "im.message.message_read_v1", "drive.notice.comment_add_v1"];
const EXPECTED_CALLBACKS = ["card.action.trigger"];

function assertLarkinRegisterAddons(addons) {
  assert.equal(addons == null, false);
  assert.deepEqual(addons.events.items.tenant, EXPECTED_TENANT_EVENTS);
  assert.deepEqual(addons.callbacks.items, EXPECTED_CALLBACKS);
  for (const scope of ["im:message", "im:message:send_as_bot", "im:message.group_msg", "drive:drive", "docs:document.comment:create", "docs:document.comment:read"]) {
    assert.equal(addons.scopes.tenant.includes(scope), true, `missing tenant scope ${scope}`);
  }
}

function runRegister({
  tenantArgs = [],
  userInfo = { tenant_brand: "feishu" },
  clientId = "not-an-app-id",
  extraEnv = {},
  fixtureExtra = "",
} = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-bot-register-tenant-"));
  const configDir = path.join(temp, "config");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const marker = path.join(temp, "register.json");
  const qrMarker = path.join(temp, "qr.txt");
  const initMarker = path.join(temp, "init.json");
  const fixture = path.join(temp, "fixture.cjs");
  fs.writeFileSync(fixture, `const fs = require("node:fs");
const { EventEmitter } = require("node:events");
module.exports = {
  registerApp: async (opts) => {
    fs.writeFileSync(process.env.REGISTER_MARKER, JSON.stringify({
      domain: opts.domain,
      larkDomain: opts.larkDomain,
      addons: opts.addons ?? null,
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
  resolveOfficialLarkCli() { throw new Error("official cli blocked in tenant url test"); },
  spawnSync() { return { status: 1, stdout: "", stderr: "blocked" }; },
  ${fixtureExtra}
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
      INIT_MARKER: initMarker,
      ...extraEnv,
    },
  });
  return { temp, configDir, marker, qrMarker, initMarker, result };
}

test("--tenant lark bootstraps Feishu accounts and presents /page/cli, not launcher", () => {
  const fixtureExtra = `
  resolveOfficialLarkCli() { return { command: "lark-cli", argsPrefix: [], version: "1.0.87" }; },
  registerApp: async (opts) => {
    fs.writeFileSync(process.env.REGISTER_MARKER, JSON.stringify({
      domain: opts.domain,
      larkDomain: opts.larkDomain,
      addons: opts.addons ?? null,
    }));
    const url = "https://open.feishu.cn/page/launcher?user_code=YKDY-TZ7Q&from=sdk&addons=H4sI";
    fs.writeFileSync(process.env.QR_MARKER, url);
    opts.onQRCodeReady({ url, expireIn: 60 });
    return {
      client_id: "cli_aa0e2efcc0b89e14",
      client_secret: "fixture-secret",
      user_info: { tenant_brand: "lark" },
    };
  },
`;
  const { temp, marker, result } = runRegister({
    tenantArgs: ["--tenant", "lark"],
    userInfo: { tenant_brand: "lark" },
    fixtureExtra,
  });
  try {
    assert.notEqual(result.status, 0, result.stderr);
    const opts = JSON.parse(fs.readFileSync(marker, "utf8"));
    assert.equal(opts.domain, "accounts.feishu.cn");
    assert.equal(opts.larkDomain, "accounts.larksuite.com");
    assertLarkinRegisterAddons(opts.addons);
    const text = `${result.stdout}\n${result.stderr}`;
    assert.match(text, /https:\/\/open\.larksuite\.com\/page\/cli\?user_code=YKDY-TZ7Q/);
    assert.match(text, /from=cli/);
    assert.match(text, /[?&]addons=H4sI/);
    assert.doesNotMatch(text, /open\.larksuite\.com\/page\/launcher/);
    assert.doesNotMatch(text, /LARKIN_SETUP_APP_SECRET/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test("--from-cli-profile binds without opening /page/launcher", () => {
  const fixtureExtra = `
  resolveOfficialLarkCli() { return { command: "lark-cli", argsPrefix: [], version: "1.0.87" }; },
  spawnSync(command, args) {
    if (args.includes("profile") && args.includes("list")) {
      return { status: 0, stdout: JSON.stringify([{ name: "aisa", appId: "cli_aa0e2efcc0b89e14", brand: "lark" }]), stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "blocked" };
  },
`;
  const { temp, configDir, marker, qrMarker, result } = runRegister({
    tenantArgs: ["--tenant", "lark", "--from-cli-profile", "aisa"],
    extraEnv: { LARKIN_SETUP_APP_SECRET: "fixture-from-profile-secret" },
    fixtureExtra,
  });
  try {
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(fs.existsSync(qrMarker), false);
    const text = `${result.stdout}\n${result.stderr}`;
    assert.match(text, /复用官方 lark-cli profile aisa/);
    assert.doesNotMatch(text, /page\/launcher|page\/cli/);
    assert.equal(fs.existsSync(path.join(configDir, "bots", "cli_aa0e2efcc0b89e14.json")), true);
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
      assertLarkinRegisterAddons(opts.addons);
      const url = fs.readFileSync(qrMarker, "utf8");
      assert.match(url, /accounts\.feishu\.cn/);
      assert.doesNotMatch(url, /larksuite\.com/);
    } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  }
});

test("conflicting user_info.tenant_brand fails closed without writing credentials", () => {
  const { temp, configDir, result } = runRegister({
    tenantArgs: ["--tenant", "feishu"],
    userInfo: { tenant_brand: "lark", open_id: "ou_conflict" },
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
