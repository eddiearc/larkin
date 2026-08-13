import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  OFFICIAL_LARK_CLI_INSTALL,
  ensureOfficialLarkCliForSetup,
  probeOfficialLarkCli,
} from "../../../dist/app/official-lark-cli.mjs";

function officialFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-official-cli-"));
  const packageDir = path.join(root, "node_modules", "@larksuite", "cli");
  const executable = path.join(packageDir, "scripts", "run.sh");
  fs.mkdirSync(path.dirname(executable), { recursive: true });
  fs.writeFileSync(path.join(packageDir, "package.json"), JSON.stringify({
    name: "@larksuite/cli", version: "1.0.79", bin: { "lark-cli": "scripts/run.sh" },
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
  fs.writeFileSync(path.join(packageDir, "scripts", "run.js"), "#!/usr/bin/env node\n");
  fs.writeFileSync(native, "MZ", { mode: 0o755 });
  const shim = path.join(root, "lark-cli.cmd");
  fs.writeFileSync(shim, "@echo off\n");
  return { root, native, shim };
}

const result = (status, stdout = "", stderr = "") => ({ status, signal: null, stdout, stderr, error: undefined });

test("official CLI probe distinguishes missing, unknown collision, and the verified package launcher", () => {
  const f = officialFixture();
  try {
    const ready = probeOfficialLarkCli({ env: {}, spawn(command, args) {
      if (args?.[0] === "-lc") return result(0, `${f.executable}\n`);
      if (args?.[0] === "--version") return result(0, "1.0.79\n");
      return result(0, "--source lark-channel --identity bot-only\n");
    } });
    assert.deepEqual(ready, { state: "ready", command: { command: f.executable, argsPrefix: [], version: "1.0.79" } });
    fs.writeFileSync(path.join(path.dirname(path.dirname(f.executable)), "package.json"), JSON.stringify({
      name: "@larksuite/cli", version: "1.0.77", bin: { "lark-cli": "scripts/run.sh" },
    }));
    assert.equal(probeOfficialLarkCli({ env: {}, spawn(command, args) {
      return args?.[0] === "-lc" ? result(0, `${f.executable}\n`) : result(0, "1.0.77\n");
    } }).state, "outdated");
    assert.equal(probeOfficialLarkCli({ env: {}, spawn: () => result(1) }).state, "missing");
    const unknown = path.join(f.root, "unknown-lark-cli");
    fs.writeFileSync(unknown, "#!/bin/sh\n", { mode: 0o700 });
    assert.equal(probeOfficialLarkCli({ env: {}, spawn(command, args) {
      return args?.[0] === "-lc" ? result(0, `${unknown}\n`) : result(0, "1.0.79\n");
    } }).state, "conflict");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("windows resolution derives the native @larksuite/cli binary from the npm shim", () => {
  const f = windowsFixture();
  try {
    const ready = probeOfficialLarkCli({ env: {}, platform: "win32", spawn(command, args) {
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

test("setup installs only after explicit interactive consent and reprobes the official launcher", async () => {
  const f = officialFixture();
  try {
    for (const [interactive, consent, expected] of [[false, true, /非交互 setup 不会安装/], [true, false, /未获得明确同意/]]) {
      let npmCalls = 0;
      await assert.rejects(ensureOfficialLarkCliForSetup({ interactive, env: {}, confirmInstall: () => consent,
        spawn(command, args) { if (command === "npm") npmCalls += 1; return result(1); } }), expected);
      assert.equal(npmCalls, 0);
    }
    let installed = false;
    let offered = "";
    const prepared = await ensureOfficialLarkCliForSetup({ interactive: true, env: {}, confirmInstall(command) {
      offered = command; return true;
    }, spawn(command, args) {
      if (command === "npm") { installed = true; return result(0); }
      if (args?.[0] === "-lc") return installed ? result(0, `${f.executable}\n`) : result(1);
      if (args?.[0] === "--version") return result(0, "1.0.79\n");
      return result(0, "--source lark-channel --identity bot-only\n");
    } });
    assert.equal(offered, OFFICIAL_LARK_CLI_INSTALL);
    assert.equal(prepared.installed, true);
    assert.equal(prepared.command.command, f.executable);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
