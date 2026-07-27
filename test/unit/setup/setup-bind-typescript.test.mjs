import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE = path.join(ROOT, "src/setup/setup-bind.ts");
const BUILT = path.join(ROOT, "dist/setup/setup-bind.mjs");
const ENTRY = path.join(ROOT, "dist/setup/setup-bind.mjs");
const APP = "cli_setupBindA1";

function writeLarkCliStub(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "lark-cli"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "profile" && args[1] === "list") {
  console.log(JSON.stringify([{ name: ${JSON.stringify(APP)}, appId: ${JSON.stringify(APP)}, active: true }]));
} else if (process.env.FAIL_BOT_VERIFY === "1") {
  console.log(JSON.stringify({ ok: false, identity: "bot" }));
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({ ok: true, identity: "bot", data: { chats: [] } }));
}
`, { mode: 0o755 });
}

function runBind(root, extraEnv = {}) {
  const binDir = path.join(root, "bin");
  writeLarkCliStub(binDir);
  return spawnSync(process.execPath, [ENTRY, "--profile", APP, "--agent", APP, "--runtime", "codex", "--yes"], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: path.join(root, "home"),
      LARKIN_CONFIG_DIR: root,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      ...extraEnv,
    },
  });
}

test("setup-bind is strict TypeScript compiled to its direct runtime entry", () => {
  assert.equal(fs.existsSync(SOURCE), true);
  assert.equal(fs.existsSync(BUILT), true);
  const entry = fs.readFileSync(ENTRY, "utf8");
  assert.match(entry, /^#!\/usr\/bin\/env bun/);
  assert.match(entry, /spawnSync|commitSetupConfig|fabricateAttachment|planSingleRootBinding/);
  assert.doesNotMatch(entry, /packages\/larkin-shell|fork\/feishu/);
});

test("failed bot verification preserves config bytes and creates no attachment", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-bind-rollback-"));
  try {
    const configFile = path.join(root, "config.json");
    const before = `${JSON.stringify({ version: 3, serverId: "server-existing", activeAgent: null, agents: {} }, null, 2)}\n`;
    fs.writeFileSync(configFile, before, { mode: 0o600 });
    const result = runBind(root, { FAIL_BOT_VERIFY: "1" });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout + result.stderr, /bot 校验失败|未修改 Agent 配置/);
    assert.equal(fs.readFileSync(configFile, "utf8"), before);
    assert.equal(fs.existsSync(path.join(root, "computer")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("successful binding writes one stable 0600 runner attachment and no workspace symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-bind-attachment-"));
  try {
    const first = runBind(root);
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.equal(stored.version, 4);
    assert.equal(stored.mentionPolicy, "require");
    assert.equal(stored.agents[APP].runtime, "codex");
    assert.equal(stored.agents[APP].model, "default");
    assert.equal(Object.hasOwn(stored.agents[APP], "effort"), false);
    assert.deepEqual(Object.keys(stored.agents), [APP]);
    assert.equal(stored.activeAgent, APP);

    const attachmentFile = path.join(root, "computer", "servers", stored.serverId, "runner.state.json");
    const before = fs.readFileSync(attachmentFile, "utf8");
    const attachment = JSON.parse(before);
    assert.deepEqual(Object.keys(attachment).sort(), [
      "apiKey", "attachedAt", "kind", "machineId", "serverId", "serverMachineId", "serverSlug", "serverUrl",
    ]);
    assert.equal(attachment.kind, "computer-attachment");
    assert.equal(attachment.serverId, stored.serverId);
    assert.equal(attachment.serverSlug, "feishu");
    assert.equal(attachment.serverUrl, "http://127.0.0.1:8787");
    assert.match(attachment.apiKey, /^sk_computer_local_[0-9a-f]{32}$/);
    assert.equal(fs.statSync(attachmentFile).mode & 0o777, 0o600);

    const second = runBind(root);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.equal(fs.readFileSync(attachmentFile, "utf8"), before, "same server must reuse its attachment");
    const workspace = path.join(root, "agents", APP);
    assert.equal(fs.existsSync(workspace) && fs.lstatSync(workspace).isSymbolicLink(), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
