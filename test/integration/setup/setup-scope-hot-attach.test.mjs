import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const APP = "cli_setupHotA1";
const STUB = `{
  ensureOfficialLarkCliForSetup: async () => ({ command: { command: "lark-cli", argsPrefix: [], version: "1.0.80" }, installed: false }),
  OFFICIAL_LARK_CLI_VERSION: "1.0.80",
  OFFICIAL_LARK_CLI_INSTALL: "npm install --global @larksuite/cli@1.0.80",
  formatOfficialLarkCliConsent: () => ({ lines: [], question: "" }),
  probeOfficialLarkCli: () => ({ state: "ready", command: { command: "lark-cli", argsPrefix: [], version: "1.0.80" } }),
}`;

function writePreload(temp) {
  const preload = path.join(temp, "preload.cjs");
  fs.writeFileSync(preload, `
const Module = require("node:module");
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const originalLoad = Module._load;
const originalSpawn = cp.spawn;
function fakeChild(code) {
  const child = new EventEmitter();
  child.pid = 42;
  child.kill = () => true;
  child.stdout = null;
  child.stderr = null;
  queueMicrotask(() => child.emit("exit", code, null));
  return child;
}
Module._load = function(request, parent, isMain) {
  if (String(request).includes("official-lark-cli")) {
    return ${STUB};
  }
  return originalLoad.call(this, request, parent, isMain);
};
if (typeof Bun !== "undefined" && typeof Bun.plugin === "function") {
  Bun.plugin({
    name: "setup-scope-hot-attach-stubs",
    setup(build) {
      build.onLoad({ filter: /official-lark-cli/ }, () => ({
        contents: ${JSON.stringify(`
export async function ensureOfficialLarkCliForSetup() {
  return { command: { command: "lark-cli", argsPrefix: [], version: "1.0.80" }, installed: false };
}
export const OFFICIAL_LARK_CLI_VERSION = "1.0.80";
export const OFFICIAL_LARK_CLI_INSTALL = "npm install --global @larksuite/cli@1.0.80";
export function formatOfficialLarkCliConsent() { return { lines: [], question: "" }; }
export function probeOfficialLarkCli() {
  return { state: "ready", command: { command: "lark-cli", argsPrefix: [], version: "1.0.80" } };
}
`)},
        loader: "js",
      }));
      build.onLoad({ filter: /setup-dashboard/ }, () => ({
        contents: ${JSON.stringify(`
export async function waitForOwnedDashboard() { return { state: "timeout" }; }
export function openBrowser() { return false; }
export async function openOwnedDashboardWhenReady() {
  return { readiness: { state: "timeout" }, opened: false };
}
`)},
        loader: "js",
      }));
    },
  });
}
cp.spawn = function(command, args = [], options = {}) {
  const list = Array.isArray(args) ? args : [];
  fs.appendFileSync(process.env.SPAWN_LOG, JSON.stringify({ command, args: list }) + "\\n");
  if (list.includes("bot-register")) {
    if (process.env.FAKE_REGISTER_FAIL === "1") return fakeChild(1);
    const idx = list.indexOf("--result-file");
    const resultFile = list[idx + 1];
    const root = process.env.LARKIN_CONFIG_DIR;
    const configPath = path.join(root, "config.json");
    fs.mkdirSync(path.join(root, "agents", ${JSON.stringify(APP)}), { recursive: true, mode: 0o700 });
    fs.writeFileSync(configPath, JSON.stringify({
      version: 4, serverId: "hot", mentionPolicy: "require", activeAgent: ${JSON.stringify(APP)},
      agents: { [${JSON.stringify(APP)}]: { runtime: "pi", model: "fixture", piDistribution: "builtin" } },
    }) + "\\n", { mode: 0o600 });
    fs.chmodSync(configPath, 0o600);
    fs.writeFileSync(resultFile, JSON.stringify({ agentId: ${JSON.stringify(APP)} }) + "\\n", { mode: 0o600 });
    return fakeChild(0);
  }
  if (list.includes("run")) {
    fs.appendFileSync(process.env.ATTACH_LOG, "run\\n");
    return fakeChild(0);
  }
  return originalSpawn.call(this, command, args, options);
};
require("node:module").syncBuiltinESMExports();
`);
  return preload;
}

function runSetup(root, temp, fail) {
  const preload = writePreload(temp);
  return spawnSync(process.execPath, ["--preload", preload, path.join(ROOT, "dist/app/setup.mjs"), "--provider", "openai", "--api-key", "k", "--model", "gpt-4o"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      HOME: path.join(temp, "home"),
      LARKIN_CONFIG_DIR: root,
      LARKIN_HOME: root,
      LARKIN_INTERNAL_DISPATCH: "0",
      LARKIN_BUN_TEST_RUNNER: "1",
      SPAWN_LOG: path.join(temp, "spawn.ndjson"),
      ATTACH_LOG: path.join(temp, "attach.log"),
      FAKE_REGISTER_FAIL: fail ? "1" : "0",
      BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" "),
    },
  });
}

test("public setup does not hot-attach on bot-register failure and attaches once after retry", { timeout: 20_000 }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-hot-"));
  const root = path.join(temp, "root");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const configPath = path.join(root, "config.json");
  try {
    const first = runSetup(root, temp, true);
    assert.notEqual(first.status, 0, first.stderr || first.stdout);
    assert.equal(fs.existsSync(configPath), false);
    assert.equal(fs.existsSync(path.join(temp, "attach.log")), false);
    const second = runSetup(root, temp, false);
    assert.equal(second.status, 0, second.stderr || second.stdout);
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
    assert.equal(parsed.activeAgent, APP);
    const attach = fs.existsSync(path.join(temp, "attach.log")) ? fs.readFileSync(path.join(temp, "attach.log"), "utf8") : "";
    assert.equal(attach.trim().split("\n").filter(Boolean).length, 1);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
