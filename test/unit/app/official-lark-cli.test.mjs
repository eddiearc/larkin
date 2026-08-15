import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  OFFICIAL_LARK_CLI_INSTALL,
  ensureOfficialLarkCliForSetup,
  formatOfficialLarkCliConsent,
  probeOfficialLarkCli,
} from "../../../dist/app/official-lark-cli.mjs";

function officialFixture(version = "1.0.79") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-official-cli-"));
  const packageDir = path.join(root, "node_modules", "@larksuite", "cli");
  const executable = path.join(packageDir, "scripts", "run.sh");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version, bin: { "lark-cli": "scripts/run.sh" },
  }));
  fs.writeFileSync(executable, "#!/bin/sh\n", { mode: 0o700 });
  return { root, executable };
}

function windowsFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-win-cli-"));
  const packageDir = path.join(root, "node_modules", "@larksuite", "cli");
  const native = path.join(packageDir, "bin", "lark-cli.exe");
  fs.mkdirSync(path.dirname(native), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version: "1.0.79", bin: { "lark-cli": "scripts/run.js" },
  }));
  fs.mkdirSync(path.join(packageDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "scripts", "run.js"), "// mock official launcher\n");
  fs.writeFileSync(native, "MZ", { mode: 0o755 });
  const shim = path.join(root, "lark-cli.cmd");
  fs.writeFileSync(shim, "@echo off\n");
  return { root, native, shim };
}

const result = (status, stdout = "", stderr = "") => ({ status, signal: null, stdout, stderr, error: undefined });

function readySpawn(executable) {
  return (_command, args) => {
    if (args?.[0] === "-lc") return result(0, `${executable}\n`);
    if (args?.[0] === "--version") return result(0, "1.0.79\n");
    return result(0, "--source lark-channel --identity bot-only\n");
  };
}

test("official CLI probe distinguishes missing, unknown collision, and the verified package launcher", () => {
  const f = officialFixture();
  try {
    const ready = probeOfficialLarkCli({ env: {}, spawn: readySpawn(f.executable) });
    assert.deepEqual(ready, { state: "ready", command: { command: f.executable, argsPrefix: [], version: "1.0.79" } });
    assert.equal(probeOfficialLarkCli({ env: {}, spawn: () => result(1) }).state, "missing");
    const unknown = path.join(f.root, "unknown-lark-cli");
    fs.writeFileSync(unknown, "#!/bin/sh\n", { mode: 0o700 });
    assert.equal(probeOfficialLarkCli({ env: {}, spawn(_command, args) {
      return args?.[0] === "-lc" ? result(0, `${unknown}\n`) : result(0, "1.0.79\n");
    } }).state, "conflict");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("official 1.0.22 is outdated and refusal shows a truthful upgrade request without npm execution", async () => {
  const f = officialFixture("1.0.22");
  try {
    const spawn = (_command, args) => args?.[0] === "-lc" ? result(0, `${f.executable}\n`) : result(1);
    const probe = probeOfficialLarkCli({ env: {}, spawn });
    assert.equal(probe.state, "outdated");
    assert.match(probe.reason, /1\.0\.22/);
    assert.match(probe.reason, /1\.0\.79/);

    let offered;
    let npmCalls = 0;
    await assert.rejects(ensureOfficialLarkCliForSetup({
      interactive: true,
      env: {},
      confirmInstall(request) { offered = request; return false; },
      spawn(command, args) {
        if (command === "npm") { npmCalls += 1; return result(0); }
        return spawn(command, args);
      },
    }), /未获得明确同意；没有升级官方 lark-cli，也没有写入 Agent 配置/);

    assert.equal(npmCalls, 0);
    assert.equal(offered.action, "upgrade");
    assert.equal(offered.state, "outdated");
    assert.equal(offered.command, OFFICIAL_LARK_CLI_INSTALL);
    assert.match(offered.reason, /1\.0\.22/);
    assert.match(offered.reason, /1\.0\.79/);
    assert.match(offered.nextAction, /升级/);
    assert.match(offered.nextAction, new RegExp(OFFICIAL_LARK_CLI_INSTALL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const copy = formatOfficialLarkCliConsent(offered);
    const visible = copy.lines.join("\n");
    assert.match(visible, /1\.0\.22/);
    assert.match(visible, /1\.0\.79/);
    assert.match(visible, /需要升级/);
    assert.match(visible, new RegExp(OFFICIAL_LARK_CLI_INSTALL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(copy.question, "是否升级？[y/N] ");
    assert.doesNotMatch(visible, /是否安装/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("missing CLI refusal asks to install and executes no npm command", async () => {
  let offered;
  let npmCalls = 0;
  await assert.rejects(ensureOfficialLarkCliForSetup({
    interactive: true,
    env: {},
    confirmInstall(request) { offered = request; return false; },
    spawn(command) { if (command === "npm") npmCalls += 1; return result(1); },
  }), /未获得明确同意；没有安装官方 lark-cli，也没有写入 Agent 配置/);
  assert.equal(npmCalls, 0);
  assert.equal(offered.action, "install");
  assert.equal(offered.state, "missing");
  assert.equal(offered.command, OFFICIAL_LARK_CLI_INSTALL);
  const copy = formatOfficialLarkCliConsent(offered);
  assert.equal(copy.question, "是否安装？[y/N] ");
  assert.match(copy.lines.join("\n"), /需要安装/);
  assert.doesNotMatch(copy.lines.join("\n"), /需要升级/);
});

test("noninteractive setup neither asks consent nor installs or upgrades", async () => {
  let consentCalls = 0;
  let npmCalls = 0;
  await assert.rejects(ensureOfficialLarkCliForSetup({
    interactive: false,
    env: {},
    confirmInstall() { consentCalls += 1; return true; },
    spawn(command) { if (command === "npm") npmCalls += 1; return result(1); },
  }), /非交互 setup 不会安装或升级/);
  assert.equal(consentCalls, 0);
  assert.equal(npmCalls, 0);
});

test("conflicting lark-cli remains fail-closed without asking consent", async () => {
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
      command: { command: f.executable, argsPrefix: [], version: "1.0.79" },
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
        if (args?.[0] === "--version") return result(0, "1.0.79\n");
        return result(0, "--source lark-channel --identity bot-only\n");
      },
    });
    assert.equal(offered.action, "install");
    assert.equal(offered.state, "missing");
    assert.equal(offered.command, OFFICIAL_LARK_CLI_INSTALL);
    assert.deepEqual(npmArgs, ["install", "--global", "@larksuite/cli@1.0.79"]);
    assert.equal(prepared.installed, true);
    assert.equal(prepared.setupAction, "install");
    assert.equal(prepared.command.command, f.executable);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("windows resolution derives the native @larksuite/cli binary from the npm shim", () => {
  const f = windowsFixture();
  try {
    const ready = probeOfficialLarkCli({ env: {}, platform: "win32", spawn(_command, args) {
      const joined = args?.join(" ") || "";
      if (joined.includes("where lark-cli")) return result(0, `${f.shim}\n`);
      if (args?.[0] === "--version") return result(0, "1.0.79\n");
      return result(0, "--source lark-channel --identity bot-only\n");
    } });
    assert.equal(ready.state, "ready");
    assert.equal(ready.command.command, f.native);
    assert.equal(ready.command.version, "1.0.79");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
