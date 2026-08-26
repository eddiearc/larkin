import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BIND = path.join(ROOT, "dist/setup/setup-bind.mjs");
const APP = "cli_extPiHotA1";

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
if (args[0] === "--version") { console.log("1.0.87"); process.exit(0); }
if (args[0] === "config" && args[1] === "bind" && args[2] === "--help") {
  console.log("Usage: config bind --source lark-channel --identity bot-only");
  process.exit(0);
}
if (args[0] === "profile" && args[1] === "list") {
  console.log(JSON.stringify(${JSON.stringify(profiles)}));
  process.exit(0);
}
console.log(JSON.stringify({ ok: true, identity: "bot", data: { chats: [] } }));
`, { mode: 0o755 });
  return binDir;
}

function writeCredential(root, appId = APP) {
  const botsDir = path.join(root, "bots");
  fs.mkdirSync(botsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(botsDir, 0o700);
  const file = path.join(botsDir, `${appId}.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    appId,
    appSecret: "secret-value",
    tenant: "feishu",
  }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function writeExternalPiProfile(home) {
  const dir = path.join(home, ".pi", "agent");
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const auth = Buffer.from('{"fixture":{"type":"api_key","key":"PRIVATE_FIXTURE_SECRET"}}\n');
  const models = Buffer.from('{"providers":{"fixture":{"models":[{"id":"pi-fixture","contextWindow":32000}]}}}\n');
  const settings = Buffer.from('{"theme":"dark","packages":{"enabled":true}}\n');
  fs.writeFileSync(path.join(dir, "auth.json"), auth, { mode: 0o600 });
  fs.writeFileSync(path.join(dir, "models.json"), models, { mode: 0o644 });
  fs.writeFileSync(path.join(dir, "settings.json"), settings, { mode: 0o644 });
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
fs.appendFileSync(marker, JSON.stringify({
  args, cwd: process.cwd(), agentDir: process.env.PI_CODING_AGENT_DIR || null,
  packageDir: process.env.PI_PACKAGE_DIR || null,
}) + "\\n");
if (process.env.PI_PACKAGE_DIR) {
  const theme = process.env.PI_PACKAGE_DIR + "/dist/modes/interactive/theme/dark.json";
  if (!fs.existsSync(theme)) {
    process.stderr.write("ENOENT: no such file or directory, open " + theme + "\\n");
    process.exit(1);
  }
}
if (args.includes("--version")) { process.stdout.write("0.84.2\\n"); process.exit(0); }
const missingWindow = ${missingWindow ? "true" : "false"};
const effective = { provider: "fixture", id: "pi-fixture", reasoning: false, ...(missingWindow ? {} : { contextWindow: 32000 }) };
const windowed = { provider: "fixture", id: "pi-windowed", reasoning: false, contextWindow: 32000 };
const respond = (request, data) => process.stdout.write(JSON.stringify({
  type: "response", id: request.id, command: request.type, success: true, data,
}) + "\\n");
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
      sessionId: "fixture-session",
      model: effective,
      thinkingLevel: "off",
      isStreaming: false,
      autoCompactionEnabled: true,
      compactionCapabilities: {
        reserveTokens: 4800,
        keepRecentTokens: 20000,
        events: ["compaction_start", "compaction_end", "agent_end", "agent_settled"],
      },
    });
    else if (request.type === "get_available_models") respond(request, {
      models: missingWindow ? [effective, windowed] : [effective],
    });
    else respond(request, {});
  }
});
`, { mode: 0o700 });
  fs.chmodSync(command, 0o700);
  return { command, marker };
}

function readLaunches(marker) {
  return fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function runBind(root, extraEnv = {}, args = ["--profile", APP, "--agent", APP, "--runtime", "pi", "--yes"]) {
  const binDir = writeOfficialLarkCliStub(root);
  const env = {
    ...process.env,
    HOME: path.join(root, "home"),
    LARKIN_CONFIG_DIR: root,
    PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    ...extraEnv,
  };
  delete env.PI_CODING_AGENT_DIR;
  return spawnSync(process.execPath, [BIND, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env,
  });
}

function resultFiles(root) {
  return fs.readdirSync(root).filter((name) => /^\.setup-result-\d+\.json$/.test(name));
}

test("external-pi setup failure keeps the bot credential, leaves config untouched, and does not upsert", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-external-pi-hot-fail-"));
  try {
    const configFile = path.join(root, "config.json");
    const before = `${JSON.stringify({ version: 3, serverId: "server-existing", activeAgent: null, agents: {} }, null, 2)}\n`;
    fs.writeFileSync(configFile, before, { mode: 0o600 });
    const botFile = writeCredential(root);
    const botBefore = fs.readFileSync(botFile);
    writeExternalPiProfile(path.join(root, "home"));
    const fake = writeFakePi(root, { missingWindow: true });
    const result = runBind(root, { LARKIN_PI_COMMAND: fake.command });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(configFile, "utf8"), before);
    assert.deepEqual(fs.readFileSync(botFile), botBefore);
    assert.equal(fs.existsSync(path.join(root, "providers", "pi", APP)), false);
    assert.deepEqual(resultFiles(root), []);
    assert.equal(fs.existsSync(path.join(root, "control")), false);
    assert.match(`${result.stdout}\n${result.stderr}`, /larkin setup --runtime external-pi/);
    assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /larkin model/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rerunning external-pi setup repairs model=default and hot-attach uses the imported owned profile", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-external-pi-hot-attach-"));
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
    const profile = writeExternalPiProfile(path.join(root, "home"));
    const fake = writeFakePi(root);
    const result = runBind(root, { LARKIN_PI_COMMAND: fake.command });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(stored.agents[APP].model, "fixture/pi-fixture");
    assert.deepEqual(resultFiles(root), []);
    const ownedDir = path.join(root, "providers", "pi", APP);
    assert.deepEqual(fs.readFileSync(path.join(ownedDir, "auth.json")), profile.auth);
    assert.deepEqual(fs.readFileSync(path.join(profile.dir, "auth.json")), profile.auth);

    const adapters = await import(pathToFileURL(path.join(ROOT, "dist/runtime/runtime-adapters.mjs")).href);
    const compaction = await import(pathToFileURL(path.join(ROOT, "dist/runtime/pi-compaction-recovery.mjs")).href);
    const workspaceDir = path.join(root, "workspace");
    const stateDir = path.join(root, "state");
    fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(fake.marker, "");
    const adapter = adapters.createNativeRuntimeAdapter("pi", {
      piCommand: fake.command,
      env: {
        LARKIN_CONFIG_DIR: root,
        LARKIN_PI_COMMAND: fake.command,
        LARKIN_PI_DISTRIBUTION: "external",
        HOME: path.join(root, "home"),
      },
      resolvePiProcessExtensionArgs: () => [],
      piRpcClientOptions: { requestTimeoutMs: 3_000, shutdownGraceMs: 100 },
    });
    const session = await adapter.createSession({
      agentId: APP,
      workspaceDir,
      stateDir,
      model: stored.agents[APP].model,
      standingPrompt: { version: "fixture", content: "standing", hash: "fixture" },
      env: { LARKIN_CONFIG_DIR: root, LARKIN_PI_DISTRIBUTION: "external" },
    });
    try {
      const launches = readLaunches(fake.marker);
      assert.equal(launches.some((row) => row.args.includes("--version")), true, JSON.stringify(launches));
      const isolated = launches.find((row) => row.args.includes("--no-session") && row.args.includes("--no-extensions"));
      assert.ok(isolated, JSON.stringify(launches));
      assert.equal(isolated.args.includes("--model"), true);
      assert.equal(isolated.args[isolated.args.indexOf("--model") + 1], "fixture/pi-fixture");
      const sessionLaunch = launches.find((row) => row.args.includes("--session-dir"));
      assert.ok(sessionLaunch, JSON.stringify(launches));
      assert.equal(sessionLaunch.args.includes("--model"), true);
      assert.equal(sessionLaunch.args[sessionLaunch.args.indexOf("--model") + 1], "fixture/pi-fixture");
      assert.equal(sessionLaunch.agentDir, ownedDir);
      assert.equal(isolated.agentDir, ownedDir);
      assert.equal(fs.existsSync(path.join(ownedDir, "auth.json")), true);
      const expected = compaction.calculatePiCompactionSettings(32_000);
      const ownedSettings = JSON.parse(fs.readFileSync(path.join(ownedDir, "settings.json"), "utf8"));
      assert.deepEqual(ownedSettings.compaction, {
        enabled: true,
        reserveTokens: expected.reserveTokens,
        keepRecentTokens: expected.keepRecentTokens,
      });
    } finally {
      await session.close("external-pi hot-attach test complete").catch(() => {});
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("builtin host + minimal PI_PACKAGE_DIR rolls back imported artifacts after catalog failure", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-external-pi-host-builtin-fail-"));
  try {
    const configFile = path.join(root, "config.json");
    const before = `${JSON.stringify({
      version: 4,
      serverId: "server-existing",
      mentionPolicy: "require",
      activeAgent: APP,
      agents: {
        [APP]: { runtime: "pi", model: "default", piDistribution: "external" },
      },
    }, null, 2)}\n`;
    fs.writeFileSync(configFile, before, { mode: 0o600 });
    const botFile = writeCredential(root);
    const botBefore = fs.readFileSync(botFile);
    const profile = writeExternalPiProfile(path.join(root, "home"));
    const fake = writeFakePi(root, { missingWindow: true });
    const packageDir = path.join(root, ".larkin-official-pi-package");
    fs.mkdirSync(path.join(packageDir, "theme"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), "{\"name\":\"fixture-builtin-pi\"}\n");
    fs.writeFileSync(path.join(packageDir, "theme", "dark.json"), "{}\n");
    const result = runBind(root, {
      LARKIN_PI_COMMAND: fake.command,
      LARKIN_PI_DISTRIBUTION: "builtin",
      PI_PACKAGE_DIR: packageDir,
    });
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.readFileSync(configFile, "utf8"), before);
    assert.deepEqual(fs.readFileSync(botFile), botBefore);
    assert.deepEqual(fs.readFileSync(path.join(profile.dir, "auth.json")), profile.auth);
    assert.equal(fs.existsSync(path.join(root, "providers", "pi", APP)), false);
    assert.equal(fs.existsSync(path.join(root, "providers", "pi", `${APP}.larkin-pi-import.lock`)), false);
    assert.equal(fs.existsSync(path.join(root, "providers", "pi", APP, "auth.json")), false);
    const launches = readLaunches(fake.marker);
    assert.equal(launches.every((row) => row.packageDir == null), true, JSON.stringify(launches));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("external-pi setup from a builtin host with minimal PI_PACKAGE_DIR still resolves models", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-external-pi-host-builtin-"));
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
    const packageDir = path.join(root, ".larkin-official-pi-package");
    fs.mkdirSync(path.join(packageDir, "theme"), { recursive: true });
    fs.writeFileSync(path.join(packageDir, "package.json"), "{\"name\":\"fixture-builtin-pi\"}\n");
    fs.writeFileSync(path.join(packageDir, "theme", "dark.json"), "{}\n");
    const result = runBind(root, {
      LARKIN_PI_COMMAND: fake.command,
      LARKIN_PI_DISTRIBUTION: "builtin",
      PI_PACKAGE_DIR: packageDir,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    const stored = JSON.parse(fs.readFileSync(configFile, "utf8"));
    assert.equal(stored.agents[APP].model, "fixture/pi-fixture");
    const launches = readLaunches(fake.marker);
    assert.equal(launches.every((row) => row.packageDir == null), true, JSON.stringify(launches));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
