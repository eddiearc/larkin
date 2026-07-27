import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE = path.join(ROOT, "src/setup/bot-register.ts");
const BUILT = path.join(ROOT, "dist/setup/bot-register.mjs");
const ENTRY = path.join(ROOT, "dist/setup/bot-register.mjs");

test("bot-register is strict TypeScript compiled to its direct runtime entry", () => {
  assert.equal(fs.existsSync(SOURCE), true);
  assert.equal(fs.existsSync(BUILT), true);
  const entry = fs.readFileSync(ENTRY, "utf8");
  assert.match(entry, /^#!\/usr\/bin\/env bun/);
  assert.match(entry, /registerApp|spawnSync|client_secret|ensureSecureBotsDir/);
  assert.doesNotMatch(entry, /packages\/larkin-shell|fork\/feishu/);
});

test("registration keeps verify-before-publish-before-bind ordering in the authored source", () => {
  const source = fs.readFileSync(SOURCE, "utf8");
  const sync = source.indexOf('spawnSync("lark-cli", ["config", "init"');
  const verify = source.indexOf('spawnSync("lark-cli", ["--profile", id, "im", "+chat-list", "--as", "bot"]');
  const publish = source.indexOf("fs.writeFileSync(stagedBotFile");
  const bind = source.indexOf("spawnSync(bindSpec.command, bindSpec.args");
  assert.equal([sync, verify, publish, bind].every((index) => index >= 0), true);
  assert.equal(sync < verify && verify < publish && publish < bind, true);
  assert.match(source, /mode: 0o700/);
  assert.match(source, /mode: 0o600, flag: "wx"/);
  assert.match(source, /callbacks:\s*\{ items: \["card\.action\.trigger"\] \}/);
});

test("help does not create credentials or expose a browser-selection bypass", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-bot-register-help-"));
  try {
    const result = spawnSync(process.execPath, [ENTRY, "--help"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, HOME: path.join(root, "home"), LARKIN_CONFIG_DIR: path.join(root, "config") },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stderr, /网页|原子写|绑定 Agent/);
    assert.equal(fs.existsSync(path.join(root, "config", "bots")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("grant-scopes is strict TypeScript compiled to its direct runtime entry", () => {
  const source = path.join(ROOT, "src/setup/grant-scopes.ts");
  const built = path.join(ROOT, "dist/setup/grant-scopes.mjs");
  const entryFile = path.join(ROOT, "dist/setup/grant-scopes.mjs");
  assert.equal(fs.existsSync(source), true);
  assert.equal(fs.existsSync(built), true);
  const entry = fs.readFileSync(entryFile, "utf8");
  assert.match(entry, /^#!\/usr\/bin\/env bun/);
  assert.match(entry, /registerApp|spawnSync|TENANT_SCOPES|selectAgent/);
  assert.doesNotMatch(entry, /packages\/larkin-shell|fork\/feishu/);
  const authored = fs.readFileSync(source, "utf8");
  assert.match(authored, /explicitAppId \? null : larkinConfig\.selectAgent/);
  assert.doesNotMatch(authored, /defaultChatId|LARKIN_FEISHU_DEFAULT_CHAT_ID/);
  assert.match(authored, /callbacks:\s*\{ items: \["card\.action\.trigger"\] \}/);
});
