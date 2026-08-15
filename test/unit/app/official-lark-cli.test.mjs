import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  OFFICIAL_LARK_CLI_INSTALL,
  OFFICIAL_LARK_CLI_VERSION,
  ensureOfficialLarkCliForSetup,
  formatOfficialLarkCliConsent,
  probeOfficialLarkCli,
  resolveOfficialLarkCli,
} from "../../../dist/app/official-lark-cli.mjs";

function officialFixture(version = "1.0.80") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-official-cli-"));
  const packageDir = path.join(root, "node_modules", "@larksuite", "cli");
  const executable = path.join(packageDir, "scripts", "run.sh");
  const manifest = path.join(packageDir, "package.json");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(manifest, JSON.stringify({
    name: "@larksuite/cli", version, bin: { "lark-cli": "scripts/run.sh" },
  }));
  fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
  return { root, packageDir, executable, manifest };
}

function setFixtureVersion(fixture, version) {
  fs.writeFileSync(fixture.manifest, JSON.stringify({
    name: "@larksuite/cli", version, bin: { "lark-cli": "scripts/run.sh" },
  }));
}

function windowsFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-win-cli-"));
  const packageDir = path.join(root, "node_modules", "@larksuite", "cli");
  const native = path.join(packageDir, "bin", "lark-cli.exe");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version: "1.0.80", bin: { "lark-cli": "scripts/run.js" },
  }));
  fs.mkdirSync(path.join(packageDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "scripts", "run.js"), "// mock official launcher\n");
  fs.writeFileSync(native, "MZ", { mode: 0o755 });
  const shim = path.join(root, "lark-cli.cmd");
  fs.writeFileSync(shim, "@echo off\n");
  return { root, native, shim };
}

const result = (status, stdout = "", stderr = "") => ({ status, signal: null, stdout, stderr, error: undefined });
const capabilityHelp = "Usage: config bind --source lark-channel --identity bot-only\n";

function readySpawn(executable, version = "1.0.80", calls = []) {
  return (command, args) => {
    calls.push({ command, args });
    if (args?.[0] === "-lc") return result(0, `${executable}\n`);
    if (args?.[0] === "--version") return result(0, `${version}\n`);
    if (args?.join(" ") === "config bind --help") return result(0, capabilityHelp);
    return result(1);
  };
}

const escapedInstall = new RegExp(OFFICIAL_LARK_CLI_INSTALL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));

test("official CLI policy pins 1.0.80 and its fixed npm action", () => {
  assert.equal(OFFICIAL_LARK_CLI_VERSION, "1.0.80");
  assert.equal(OFFICIAL_LARK_CLI_INSTALL, "npm install --global @larksuite/cli@1.0.80");
});

test("official 1.0.22 and 1.0.79 fixtures are outdated before command capability probing", () => {
  for (const detected of ["1.0.22", "1.0.79"]) {
    const f = officialFixture(detected);
    try {
      const commandCalls = [];
      const probe = probeOfficialLarkCli({ env: {}, spawn(command, args) {
        if (args?.[0] === "-lc") return result(0, `${f.executable}\n`);
        commandCalls.push({ command, args });
        return result(1);
      } });
      assert.equal(probe.state, "outdated");
      assert.match(probe.reason, new RegExp(detected.replaceAll(".", "\\.")));
      assert.match(probe.reason, /1\.0\.80/);
      assert.match(probe.nextAction, escapedInstall);
      assert.deepEqual(commandCalls, []);
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test("official 1.0.80 is ready only after exact version and bind capability probes", () => {
  const f = officialFixture("1.0.80");
  try {
    const calls = [];
    const ready = probeOfficialLarkCli({ env: {}, spawn: readySpawn(f.executable, "1.0.80", calls) });
    assert.deepEqual(ready, { state: "ready", command: { command: f.executable, argsPrefix: [], version: "1.0.80" } });
    assert.deepEqual(calls.map((call) => call.args), [
      ["-lc", "command -v lark-cli 2>/dev/null"],
      ["--version"],
      ["config", "bind", "--help"],
    ]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("a higher official version still fails closed when the exact bind capability is absent", () => {
  const f = officialFixture("1.4.0");
  try {
    const calls = [];
    const probe = probeOfficialLarkCli({ env: {}, spawn(command, args) {
      calls.push(args);
      if (args?.[0] === "-lc") return result(0, `${f.executable}\n`);
      if (args?.[0] === "--version") return result(0, "1.4.0\n");
      return result(0, "Usage: config bind --source other-channel --identity bot-only\n");
    } });
    assert.equal(probe.state, "conflict");
    assert.match(probe.reason, /缺少 lark-channel bot-only bind 能力/);
    assert.deepEqual(calls, [
      ["-lc", "command -v lark-cli 2>/dev/null"],
      ["--version"],
      ["config", "bind", "--help"],
    ]);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("missing, malformed official manifest, and unknown collisions remain deterministic", () => {
  assert.equal(probeOfficialLarkCli({ env: {}, spawn: () => result(1) }).state, "missing");

  const malformed = officialFixture("1.0.x");
  const unknown = path.join(malformed.root, "unknown-lark-cli");
  fs.writeFileSync(unknown, "#!/bin/sh\n", { mode: 0o700 });
  try {
    const malformedProbe = probeOfficialLarkCli({ env: {}, spawn(_command, args) {
      return args?.[0] === "-lc" ? result(0, `${malformed.executable}\n`) : result(1);
    } });
    assert.equal(malformedProbe.state, "conflict");
    assert.match(malformedProbe.reason, /不是兼容的官方/);

    const collision = probeOfficialLarkCli({ env: {}, spawn(_command, args) {
      return args?.[0] === "-lc" ? result(0, `${unknown}\n`) : result(1);
    } });
    assert.equal(collision.state, "conflict");
  } finally { fs.rmSync(malformed.root, { recursive: true, force: true }); }
});

test("outdated runtime and noninteractive setup fail with detected/minimum versions and fixed action", async () => {
  const f = officialFixture("1.0.79");
  try {
    const spawn = (_command, args) => args?.[0] === "-lc" ? result(0, `${f.executable}\n`) : result(1);
    assert.throws(() => resolveOfficialLarkCli({ env: {}, spawn }), (error) => {
      assert.match(error.message, /1\.0\.79/);
      assert.match(error.message, /1\.0\.80/);
      assert.match(error.message, escapedInstall);
      return true;
    });

    let consentCalls = 0;
    let npmCalls = 0;
    await assert.rejects(ensureOfficialLarkCliForSetup({
      interactive: false,
      env: {},
      confirmInstall() { consentCalls += 1; return true; },
      spawn(command, args) {
        if (command === "npm") npmCalls += 1;
        return spawn(command, args);
      },
    }), (error) => {
      assert.match(error.message, /1\.0\.79/);
      assert.match(error.message, /1\.0\.80/);
      assert.match(error.message, /非交互 setup 不会安装或升级/);
      assert.match(error.message, escapedInstall);
      return true;
    });
    assert.equal(consentCalls, 0);
    assert.equal(npmCalls, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("outdated refusal exposes truthful upgrade formatter output and executes zero npm calls", async () => {
  const f = officialFixture("1.0.79");
  try {
    let offered;
    let npmCalls = 0;
    await assert.rejects(ensureOfficialLarkCliForSetup({
      interactive: true,
      env: {},
      confirmInstall(request) { offered = request; return false; },
      spawn(command, args) {
        if (command === "npm") { npmCalls += 1; return result(0); }
        return args?.[0] === "-lc" ? result(0, `${f.executable}\n`) : result(1);
      },
    }), /未获得明确同意；没有升级官方 lark-cli，也没有写入 Agent 配置/);

    assert.equal(npmCalls, 0);
    assert.deepEqual(offered, {
      action: "upgrade",
      command: "npm install --global @larksuite/cli@1.0.80",
      state: "outdated",
      reason: `真实 login shell 的官方 @larksuite/cli 1.0.79 低于产品策略最低版本 1.0.80`,
      nextAction: "升级：npm install --global @larksuite/cli@1.0.80",
    });
    assert.deepEqual(formatOfficialLarkCliConsent(offered), {
      lines: [
        "[setup 0/5] 检测到官方 lark-cli 需要升级：真实 login shell 的官方 @larksuite/cli 1.0.79 低于产品策略最低版本 1.0.80",
        "将执行：npm install --global @larksuite/cli@1.0.80",
      ],
      question: "是否升级？[y/N] ",
    });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("missing refusal exposes install formatter output and executes zero npm calls", async () => {
  let offered;
  let npmCalls = 0;
  await assert.rejects(ensureOfficialLarkCliForSetup({
    interactive: true,
    env: {},
    confirmInstall(request) { offered = request; return false; },
    spawn(command) { if (command === "npm") npmCalls += 1; return result(1); },
  }), /未获得明确同意；没有安装官方 lark-cli，也没有写入 Agent 配置/);
  assert.equal(npmCalls, 0);
  assert.deepEqual(formatOfficialLarkCliConsent(offered), {
    lines: [
      "[setup 0/5] 真实 login shell 找不到官方 lark-cli。Larkin 需要安装未修改的官方 lark-cli 作为 Feishu (Lark) 命令下游。",
      "将执行：npm install --global @larksuite/cli@1.0.80",
    ],
    question: "是否安装？[y/N] ",
  });
});

test("conflicting lark-cli remains fail-closed without consent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-conflicting-cli-"));
  const unknown = path.join(root, "lark-cli");
  fs.writeFileSync(unknown, "#!/bin/sh\n", { mode: 0o700 });
  try {
    let consentCalls = 0;
    let npmCalls = 0;
    await assert.rejects(ensureOfficialLarkCliForSetup({
      interactive: true,
      env: {},
      confirmInstall() { consentCalls += 1; return true; },
      spawn(command, args) {
        if (command === "npm") npmCalls += 1;
        return args?.[0] === "-lc" ? result(0, `${unknown}\n`) : result(1);
      },
    }), /不是兼容的官方/);
    assert.equal(consentCalls, 0);
    assert.equal(npmCalls, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("ready official CLI remains unchanged without consent or npm", async () => {
  const f = officialFixture();
  try {
    let consentCalls = 0;
    let npmCalls = 0;
    const prepared = await ensureOfficialLarkCliForSetup({
      interactive: true,
      env: {},
      confirmInstall() { consentCalls += 1; return true; },
      spawn(command, args) {
        if (command === "npm") npmCalls += 1;
        return readySpawn(f.executable)(command, args);
      },
    });
    assert.deepEqual(prepared, {
      command: { command: f.executable, argsPrefix: [], version: "1.0.80" },
      installed: false,
    });
    assert.equal(consentCalls, 0);
    assert.equal(npmCalls, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("missing CLI installs only after structured interactive consent and reprobes", async () => {
  const f = officialFixture();
  try {
    let installed = false;
    let offered;
    let npmArgs;
    const prepared = await ensureOfficialLarkCliForSetup({
      interactive: true,
      env: {},
      confirmInstall(request) { offered = request; return true; },
      spawn(command, args) {
        if (command === "npm") { installed = true; npmArgs = args; return result(0); }
        if (args?.[0] === "-lc") return installed ? result(0, `${f.executable}\n`) : result(1);
        if (args?.[0] === "--version") return result(0, "1.0.80\n");
        return result(0, capabilityHelp);
      },
    });
    assert.equal(offered.action, "install");
    assert.deepEqual(npmArgs, ["install", "--global", "@larksuite/cli@1.0.80"]);
    assert.deepEqual(prepared, {
      command: { command: f.executable, argsPrefix: [], version: "1.0.80" },
      installed: true,
      setupAction: "install",
    });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("outdated CLI upgrades only after consent and reprobes at 1.0.80", async () => {
  const f = officialFixture("1.0.79");
  try {
    let npmCalls = 0;
    const prepared = await ensureOfficialLarkCliForSetup({
      interactive: true,
      env: {},
      confirmInstall(request) { assert.equal(request.action, "upgrade"); return true; },
      spawn(command, args) {
        if (command === "npm") { npmCalls += 1; setFixtureVersion(f, "1.0.80"); return result(0); }
        if (args?.[0] === "-lc") return result(0, `${f.executable}\n`);
        if (args?.[0] === "--version") return result(0, "1.0.80\n");
        return result(0, capabilityHelp);
      },
    });
    assert.equal(npmCalls, 1);
    assert.equal(prepared.command.version, "1.0.80");
    assert.equal(prepared.setupAction, "upgrade");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("windows resolution derives the native @larksuite/cli binary from the npm shim", () => {
  const f = windowsFixture();
  try {
    const ready = probeOfficialLarkCli({ env: {}, platform: "win32", spawn(_command, args) {
      const joined = args?.join(" ") || "";
      if (joined.includes("where lark-cli")) return result(0, `${f.shim}\n`);
      if (args?.[0] === "--version") return result(0, "1.0.80\n");
      return result(0, capabilityHelp);
    } });
    assert.equal(ready.state, "ready");
    assert.equal(ready.command.command, f.native);
    assert.equal(ready.command.version, "1.0.80");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
