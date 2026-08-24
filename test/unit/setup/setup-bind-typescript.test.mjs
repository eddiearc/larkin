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

function writeExternalPiProfile(home, omit) {
  const dir = path.join(home, ".pi", "agent");
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const auth = Buffer.from('{"fixture":{"type":"api_key","key":"PRIVATE_FIXTURE_SECRET"}}\n');
  const models = Buffer.from('{"providers":{"fixture":{"models":[{"id":"pi-fixture","contextWindow":32000}]}}}\n');
  const settings = Buffer.from('{"theme":"dark","packages":{"enabled":true}}\n');
  if (omit !== "auth.json") fs.writeFileSync(path.join(dir, "auth.json"), auth, { mode: 0o600 });
  if (omit !== "models.json") fs.writeFileSync(path.join(dir, "models.json"), models, { mode: 0o644 });
  if (omit !== "settings.json") fs.writeFileSync(path.join(dir, "settings.json"), settings, { mode: 0o644 });
  return { dir, auth, models, settings };
}

function writeFakePi(root, { missingWindow = false } = {}) {
  const command = path.join(root, "fake-pi");
  const marker = path.join(root, "fake-pi-marker.ndjson");
  fs.writeFileSync(marker, "");
  fs.writeFileSync(command, `#!${process.execPath}
import fs from "node:fs";
const marker = ${JSON.stringify(marker)};
const args = process.argv.slice(2);
fs.appendFileSync(marker, JSON.stringify({ args, cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR || null }) + "\\n");
if (args.includes("--version")) { process.stdout.write("0.84.2\\n"); process.exit(0); }
const missingWindow = ${missingWindow ? "true" : "false"};
const effective = { provider: "fixture", id: "pi-fixture", reasoning: false, ...(missingWindow ? {} : { contextWindow: 32000 }) };
const windowed = { provider: "fixture", id: "pi-windowed", reasoning: false, contextWindow: 32000 };
const respond = (request, data) => process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data }) + "\\n");
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString();
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    const request = JSON.parse(line);
    if (request.type === "get_state") respond(request, {
      model: effective, thinkingLevel: "off", isStreaming: false, autoCompactionEnabled: true,
      compactionCapabilities: { reserveTokens: 4800, keepRecentTokens: 20000,
        events: ["compaction_start", "compaction_end", "agent_end", "agent_settled"] },
    });
    else if (request.type === "get_available_models") respond(request, { models: missingWindow ? [effective, windowed] : [effective] });
    else respond(request, {});
  }
});
`, { mode: 0o700 });
  fs.chmodSync(command, 0o700);
  return { command, marker };
}

function writeSentinelPi(root) {
  const command = path.join(root, "sentinel-pi");
  const marker = path.join(root, "sentinel-pi-marker");
  fs.writeFileSync(command, `#!${process.execPath}
import fs from "node:fs";
fs.appendFileSync(${JSON.stringify(marker)}, "spawned\\n");
process.exit(1);
`, { mode: 0o700 });
  fs.chmodSync(command, 0o700);
  return { command, marker };
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
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    LARKIN_CONFIG_DIR: root,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ...extraEnv,
  };
  delete env.PI_CODING_AGENT_DIR;
  return spawnSync(process.execPath, [ENTRY, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env,
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
    const sentinel = writeSentinelPi(root);
    const result = runBind(root, { LARKIN_PI_COMMAND: sentinel.command }, ["--profile", APP, "--agent", APP, "--runtime", "pi", "--yes"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(stored.agents[APP].runtime, "pi");
    assert.equal(stored.agents[APP].effort, "high");
    assert.equal(fs.existsSync(sentinel.marker), false);
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
    const home = path.join(root, "home");
    writeExternalPiProfile(home);
    const fake = writeFakePi(root);
    const result = runBind(root, { LARKIN_PI_COMMAND: fake.command }, ["--profile", APP, "--agent", APP, "--runtime", "pi", "--yes"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(stored.agents[APP].runtime, "pi");
    assert.equal(stored.agents[APP].model, "fixture/pi-fixture");
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

test("external-pi setup imports the official profile and stores the concrete catalog model", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-bind-external-pi-"));
  try {
    const configFile = path.join(root, "config.json");
    fs.writeFileSync(configFile, `${JSON.stringify({ version: 3, serverId: "server-existing", activeAgent: null, agents: {} }, null, 2)}\n`, { mode: 0o600 });
    writeCredential(root);
    const home = path.join(root, "home");
    const profile = writeExternalPiProfile(home);
    const fake = writeFakePi(root);
    const result = runBind(root, { LARKIN_PI_COMMAND: fake.command }, ["--profile", APP, "--agent", APP, "--runtime", "pi", "--yes"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(stored.agents[APP].runtime, "pi");
    assert.equal(stored.agents[APP].model, "fixture/pi-fixture");
    assert.equal(stored.agents[APP].piDistribution, "external");
    const ownedAuth = path.join(root, "providers", "pi", APP, "auth.json");
    const ownedModels = path.join(root, "providers", "pi", APP, "models.json");
    assert.equal(fs.statSync(ownedAuth).mode & 0o777, 0o600);
    assert.deepEqual(fs.readFileSync(ownedAuth), profile.auth);
    assert.deepEqual(fs.readFileSync(ownedModels), profile.models);
    assert.deepEqual(fs.readFileSync(path.join(profile.dir, "auth.json")), profile.auth);
    assert.deepEqual(fs.readFileSync(path.join(profile.dir, "models.json")), profile.models);
    assert.deepEqual(fs.readFileSync(path.join(profile.dir, "settings.json")), profile.settings);
    const ownedSettings = JSON.parse(fs.readFileSync(path.join(root, "providers", "pi", APP, "settings.json"), "utf8"));
    assert.equal(ownedSettings.theme, "dark");
    assert.notEqual(fs.readFileSync(path.join(root, "providers", "pi", APP, "settings.json")), profile.settings);
    const launches = fs.readFileSync(fake.marker, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    const catalog = launches.find((row) => row.args.includes("--mode") && row.args.includes("rpc"));
    assert.ok(catalog, JSON.stringify(launches));
    assert.equal(fs.realpathSync(catalog.cwd), fs.realpathSync(root));
    assert.equal(fs.existsSync(path.join(root, "agents", APP)), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external-pi setup rolls back when the effective model lacks a context window", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-bind-external-pi-window-"));
  try {
    const configFile = path.join(root, "config.json");
    const before = `${JSON.stringify({ version: 3, serverId: "server-existing", activeAgent: null, agents: {} }, null, 2)}\n`;
    fs.writeFileSync(configFile, before, { mode: 0o600 });
    writeCredential(root);
    writeExternalPiProfile(path.join(root, "home"));
    const fake = writeFakePi(root, { missingWindow: true });
    const result = runBind(root, { LARKIN_PI_COMMAND: fake.command }, ["--profile", APP, "--agent", APP, "--runtime", "pi", "--yes"]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(configFile, "utf8"), before);
    assert.equal(fs.existsSync(path.join(root, "providers", "pi", APP)), false);
    assert.equal(fs.existsSync(path.join(root, "bots", `${APP}.json`)), true);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /larkin setup --runtime external-pi/);
    assert.match(output, /fixture\/pi-windowed/);
    assert.doesNotMatch(output, /larkin model/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external-pi setup fails closed without an official auth.json", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-bind-external-pi-auth-"));
  try {
    const configFile = path.join(root, "config.json");
    const before = `${JSON.stringify({ version: 3, serverId: "server-existing", activeAgent: null, agents: {} }, null, 2)}\n`;
    fs.writeFileSync(configFile, before, { mode: 0o600 });
    writeCredential(root);
    writeExternalPiProfile(path.join(root, "home"), "auth.json");
    const fake = writeFakePi(root);
    const result = runBind(root, { LARKIN_PI_COMMAND: fake.command }, ["--profile", APP, "--agent", APP, "--runtime", "pi", "--yes"]);
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(configFile, "utf8"), before);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /official file-backed Pi profile/);
    assert.match(output, /auth\.json/);
    assert.match(output, /settings\.json/);
    assert.match(output, /larkin setup --runtime external-pi/);
    assert.doesNotMatch(output, /larkin model/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external-pi setup fails closed without settings.json or models.json", () => {
  for (const missing of ["settings.json", "models.json"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-setup-bind-external-pi-${missing}-`));
    try {
      const configFile = path.join(root, "config.json");
      const before = `${JSON.stringify({ version: 3, serverId: "server-existing", activeAgent: null, agents: {} }, null, 2)}\n`;
      fs.writeFileSync(configFile, before, { mode: 0o600 });
      writeCredential(root);
      writeExternalPiProfile(path.join(root, "home"), missing);
      const fake = writeFakePi(root);
      const result = runBind(root, { LARKIN_PI_COMMAND: fake.command }, ["--profile", APP, "--agent", APP, "--runtime", "pi", "--yes"]);
      assert.notEqual(result.status, 0, `${missing}: ${result.stdout}\n${result.stderr}`);
      assert.equal(fs.readFileSync(configFile, "utf8"), before);
      const output = `${result.stdout}\n${result.stderr}`;
      assert.match(output, /official file-backed Pi profile/);
      assert.match(output, new RegExp(missing.replace(".", "\\.")));
      assert.match(output, /larkin setup --runtime external-pi/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("external-pi setup repairs a stored model=default without mentioning a brand-new agent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-bind-external-pi-repair-"));
  try {
    const configFile = path.join(root, "config.json");
    fs.writeFileSync(configFile, `${JSON.stringify({
      version: 4,
      serverId: "server-existing",
      mentionPolicy: "require",
      activeAgent: APP,
      agents: {
        [APP]: { runtime: "pi", model: "default", piDistribution: "external" },
      },
    }, null, 2)}\n`, { mode: 0o600 });
    writeCredential(root);
    writeExternalPiProfile(path.join(root, "home"));
    const fake = writeFakePi(root);
    const result = runBind(root, { LARKIN_PI_COMMAND: fake.command }, ["--profile", APP, "--agent", APP, "--runtime", "pi", "--yes"]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(stored.agents[APP].model, "fixture/pi-fixture");
    assert.equal(stored.agents[APP].piDistribution, "external");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
