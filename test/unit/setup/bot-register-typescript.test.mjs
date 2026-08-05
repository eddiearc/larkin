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

test("registration publishes the credential before binding, then verifies the bound Bot workspace", () => {
  const source = fs.readFileSync(SOURCE, "utf8");
  const publish = source.indexOf("fs.writeFileSync(stagedBotFile");
  const bind = source.indexOf("runBindProcess(bindSpec.command, bindSpec.args");
  const sync = source.indexOf("synchronizeAgentProfile(agent");
  const verify = source.indexOf("runIdentityProcess(official.command");
  const resultPublish = source.indexOf("fs.writeFileSync(resultFile");
  const authCommit = source.indexOf("pendingPiAuthTransaction?.commit()");
  const preResolve = source.indexOf("resolvedSetupOfficialCli = resolveOfficialCli({ env: process.env })");
  const authBegin = source.indexOf("pendingPiAuthTransaction = beginBuiltinPiCredentialTransaction");
  assert.equal([publish, bind, sync, verify, resultPublish, authCommit].every((index) => index >= 0), true);
  assert.equal(publish < bind && bind < sync && sync < verify, true);
  assert.equal(verify < resultPublish && resultPublish < authCommit, true,
    "credential transaction must commit only after identity and result publication");
  assert.equal(preResolve >= 0 && preResolve < authBegin, true,
    "the synchronous official CLI probe must complete before the credential transaction lock");
  const transactionInterval = source.slice(authBegin, authCommit);
  assert.doesNotMatch(transactionInterval, /resolveOfficialLarkCli\s*\(/,
    "the active credential transaction must reuse the pre-resolved official CLI");
  assert.doesNotMatch(transactionInterval, /spawnSync\s*\(/,
    "production work while the credential transaction is active must remain asynchronous");
  assert.match(source, /synchronizeAgentProfile\([\s\S]*\{ forceRebind: true \}\)/,
    "new setup credentials must explicitly force one authoritative rebind");
  assert.doesNotMatch(source, /config["', ]+init/);
  assert.match(source, /mode: 0o700/);
  assert.match(source, /mode: 0o600, flag: "wx"/);
  assert.match(source, /callbacks:\s*\{ items: \["card\.action\.trigger"\] \}/);
  assert.match(source, /systemSpawn\(command, args, \{ stdio: "ignore", shell: false \}\)/,
    "browser launch must be non-blocking and shell-free");
  assert.match(source, /child\.once\("error", \(\) => say\(`\[setup\].*\$\{url\}`\)\)/,
    "browser spawn errors must retain a complete manual URL fallback");
  assert.doesNotMatch(source.slice(source.indexOf("function openBrowser"), source.indexOf("async function runBindProcess")), /spawnSync/);
  assert.match(source, /"drive:drive"/);
  assert.match(source, /"drive\.notice\.comment_add_v1"/);
  assert.match(source, /documentCommentEvent/);
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
  assert.match(authored, /const selected = larkinConfig\.selectAgent/);
  assert.match(authored, /explicitAppId !== selected\.feishuAppId/);
  assert.match(authored, /resolveManagedOfficialCli\(selected, process\.env\)/);
  assert.doesNotMatch(authored, /defaultChatId|LARKIN_FEISHU_DEFAULT_CHAT_ID/);
  assert.match(authored, /callbacks:\s*\{ items: \["card\.action\.trigger"\] \}/);
  assert.match(authored, /"drive:drive"/);
  assert.match(authored, /"drive\.notice\.comment_add_v1"/);
});
