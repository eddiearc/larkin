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
const NAMED_APP = "cli_namedProfileA1";

function writeOfficialLarkCliStub(root, profiles = [{ name: APP, appId: APP, active: true }]) {
  const pkg = path.join(root, "official-cli");
  const binDir = path.join(pkg, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({
    name: "@larksuite/cli",
    version: "1.0.87",
    bin: { "lark-cli": "bin/lark-cli" },
  }));
  fs.writeFileSync(path.join(binDir, "lark-cli"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("1.0.87");
  process.exit(0);
}
if (args[0] === "config" && args[1] === "bind" && args[2] === "--help") {
  console.log("Usage: config bind --source lark-channel --identity bot-only");
  process.exit(0);
}
if (args[0] === "profile" && args[1] === "list") {
  console.log(JSON.stringify(${JSON.stringify(profiles)}));
  process.exit(0);
}
if (process.env.FAIL_BOT_VERIFY === "1") {
  console.log(JSON.stringify({ ok: false, identity: "bot" }));
  process.exit(1);
}
console.log(JSON.stringify({ ok: true, identity: "bot", data: { chats: [] } }));
`, { mode: 0o755 });
  return binDir;
}

function writeCredential(root, appId = APP) {
  const botsDir = path.join(root, "bots");
  fs.mkdirSync(botsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(botsDir, 0o700);
  fs.writeFileSync(path.join(botsDir, `${appId}.json`), `${JSON.stringify({
    appId,
    appSecret: "secret-value",
    tenant: "feishu",
  }, null, 2)}\n`, { mode: 0o600 });
}

function runBind(root, extraEnv = {}, args = ["--profile", APP, "--agent", APP, "--runtime", "codex", "--yes"]) {
  const binDir = writeOfficialLarkCliStub(root);
  return spawnSync(process.execPath, [ENTRY, ...args], {
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
  const source = fs.readFileSync(SOURCE, "utf8");
  const entry = fs.readFileSync(ENTRY, "utf8");
  assert.match(entry, /^#!\/usr\/bin\/env bun/);
  assert.match(entry, /spawnSync|commitSetupConfig|fabricateAttachment|planSingleRootBinding/);
  assert.doesNotMatch(entry, /packages\/larkin-shell|fork\/feishu/);
  assert.doesNotMatch(source, /profile\.name !== profile\.appId/);
  assert.match(source, /不要求名字等于 App ID/);
  assert.match(source, /loadValidatedBotCredential/);
  assert.match(source, /preservedEffort/);
});

test("explicit App-ID setup-bind no longer depends on a legacy profile verification", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-bind-rollback-"));
  try {
    const configFile = path.join(root, "config.json");
    const before = `${JSON.stringify({ version: 3, serverId: "server-existing", activeAgent: null, agents: {} }, null, 2)}\n`;
    fs.writeFileSync(configFile, before, { mode: 0o600 });
    writeCredential(root);
    const result = runBind(root, { FAIL_BOT_VERIFY: "1" });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.notEqual(fs.readFileSync(configFile, "utf8"), before);
    assert.equal(fs.existsSync(path.join(root, "computer")), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("named lark-cli profile binds by App ID without requiring name === appId", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-bind-named-profile-"));
  try {
    const configFile = path.join(root, "config.json");
    fs.writeFileSync(configFile, `${JSON.stringify({ version: 3, serverId: "server-existing", activeAgent: null, agents: {} }, null, 2)}\n`, { mode: 0o600 });
    writeCredential(root, NAMED_APP);
    const binDir = writeOfficialLarkCliStub(root, [{ name: "aisa", appId: NAMED_APP, active: true }]);
    const result = spawnSync(process.execPath, [ENTRY, "--profile", "aisa", "--agent", NAMED_APP, "--runtime", "codex", "--yes"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: path.join(root, "home"),
        LARKIN_CONFIG_DIR: root,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /profile aisa → App ID cli_namedProfileA1/);
    const stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(stored.agents[NAMED_APP].runtime, "codex");
    assert.deepEqual(Object.keys(stored.agents), [NAMED_APP]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("named-profile bind fails closed without bots/<appId>.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-bind-missing-cred-"));
  try {
    const configFile = path.join(root, "config.json");
    const before = `${JSON.stringify({ version: 3, serverId: "server-existing", activeAgent: null, agents: {} }, null, 2)}\n`;
    fs.writeFileSync(configFile, before, { mode: 0o600 });
    const binDir = writeOfficialLarkCliStub(root, [{ name: "aisa", appId: NAMED_APP, active: true }]);
    const result = spawnSync(process.execPath, [ENTRY, "--profile", "aisa", "--agent", NAMED_APP, "--runtime", "codex", "--yes"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: path.join(root, "home"),
        LARKIN_CONFIG_DIR: root,
        PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
      },
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(`${result.stdout}\n${result.stderr}`, /没有可用的 bot 凭证/);
    assert.equal(fs.readFileSync(configFile, "utf8"), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi rebind keeps a previously stored effort without spawning pi catalog", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-bind-pi-effort-"));
  try {
    const configFile = path.join(root, "config.json");
    fs.writeFileSync(configFile, `${JSON.stringify({
      version: 4,
      serverId: "server-existing",
      mentionPolicy: "require",
      activeAgent: APP,
      agents: {
        [APP]: { runtime: "pi", model: "openai/gpt-5", effort: "high" },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    writeCredential(root);
    const result = runBind(root, {}, ["--profile", APP, "--agent", APP, "--runtime", "pi", "--yes"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(stored.agents[APP].runtime, "pi");
    assert.equal(stored.agents[APP].effort, "high");
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /--mode rpc|discoverPiModelCatalog/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("switching a Codex agent to Pi does not carry Codex effort into the Pi catalog", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-bind-codex-to-pi-effort-"));
  try {
    const configFile = path.join(root, "config.json");
    fs.writeFileSync(configFile, `${JSON.stringify({
      version: 4,
      serverId: "server-existing",
      mentionPolicy: "require",
      activeAgent: APP,
      agents: {
        [APP]: { runtime: "codex", model: "gpt-5.6-sol", effort: "high" },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    writeCredential(root);
    const result = runBind(root, {}, ["--profile", APP, "--agent", APP, "--runtime", "pi", "--yes"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(stored.agents[APP].runtime, "pi");
    assert.equal(Object.hasOwn(stored.agents[APP], "effort"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("successful binding writes one stable 0600 runner attachment and no workspace symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-bind-attachment-"));
  try {
    writeCredential(root);
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
