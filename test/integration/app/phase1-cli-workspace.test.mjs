import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const APP = "cli_a1B2c3";

function strictStoredConfig() {
  return {
    version: 3,
    serverId: "server-v3",
    activeAgent: APP,
    agents: {
      [APP]: {
        runtime: "codex",
        model: "gpt-target",
        effort: "high",
        noMentionChats: ["oc_keep"],
        createdAt: "2026-07-15T00:00:00.000Z",
      },
    },
  };
}

function strictRuntimeAgent(root) {
  return {
    name: APP,
    agentId: APP,
    feishuAppId: APP,
    feishuProfile: APP,
    runtime: "codex",
    model: "gpt-target",
    effort: "high",
    noMentionChats: ["oc_keep"],
    createdAt: "2026-07-15T00:00:00.000Z",
    workspaceDir: path.join(root, "agents", APP),
    stateDir: path.join(root, "state", "agents", APP),
    larkConfigDir: path.join(root, "state", "agents", APP, "lark-cli-config"),
  };
}

function writeRunSpawnPreload(temp) {
  const preload = path.join(temp, "capture-run-spawn.cjs");
  fs.writeFileSync(preload, `
const childProcess = require("node:child_process");
const originalSpawnSync = childProcess.spawnSync;
const fs = require("node:fs");
const { EventEmitter } = require("node:events");
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (String(request).endsWith("config.cjs") && String(parent?.filename || "").endsWith("/dist/app/run.mjs")) {
    return { loadConfig() {
      return {
        configDir: process.env.LARKIN_CONFIG_DIR,
        file: process.env.RUN_CONFIG_FILE,
        config: JSON.parse(process.env.RUN_RUNTIME_CONFIG),
      };
    } };
  }
  return originalLoad.call(this, request, parent, isMain);
};
class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = process.pid + 1000;
    this.exitCode = null;
    this.signalCode = null;
    queueMicrotask(() => { this.exitCode = 0; this.emit("exit", 0, null); });
  }
  kill(signal = "SIGTERM") { this.signalCode = signal; return true; }
}
childProcess.spawn = function capture(command, args, options = {}) {
  const env = options.env || {};
  const isInternalDashboard = args?.[1] === "__internal" && args?.[2] === "dashboard";
  if (String(args?.[0] || "").endsWith("/dist/app/dashboard.mjs") || isInternalDashboard) return new FakeChild();
  fs.writeFileSync(process.env.RUN_CAPTURE_FILE, JSON.stringify({
    command, args,
    larkinHome: env.LARKIN_HOME || null,
    configDir: env.LARKIN_CONFIG_DIR || null,
    agents: JSON.parse(env.LARKIN_AGENTS_CONFIG || "null"),
    larkProfileEntries: fs.readdirSync(env.LARKSUITE_CLI_CONFIG_DIR || ""),
  }));
  return new FakeChild();
};
childProcess.spawnSync = function(command, args, options = {}) {
  const pinned = command === process.execPath && String(args?.[0] || "").includes("@larksuite/cli/scripts/run.js");
  if (!pinned) return originalSpawnSync.apply(this, arguments);
  const cli = args.slice(1), file = require("node:path").join(options.env.LARKSUITE_CLI_CONFIG_DIR, "config.json");
  if (cli[0] === "config" && cli[1] === "init") {
    const appId = cli[cli.indexOf("--app-id") + 1], name = cli[cli.indexOf("--name") + 1];
    fs.writeFileSync(file, JSON.stringify({ apps: [{ appId, name, appSecret: options.input, brand: "feishu", defaultAs: "auto", strictMode: "off", users: [] }] }), { mode: 0o600 });
  } else {
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    if (cli.includes("default-as")) value.apps[0].defaultAs = "bot";
    if (cli.includes("strict-mode")) value.apps[0].strictMode = "bot";
    fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  }
  return { status: 0, stdout: "", stderr: "" };
};
Module.syncBuiltinESMExports();
`);
  return preload;
}

test("real run.mjs spawn gives host one root and canonical hydrated Agent paths", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-run-boundary-"));
  try {
    const root = path.join(temp, "root");
    fs.mkdirSync(root, { recursive: true });
    fs.chmodSync(root, 0o700);
    const configFile = path.join(root, "config.json");
    fs.writeFileSync(configFile, JSON.stringify(strictStoredConfig(), null, 2) + "\n");
    fs.chmodSync(configFile, 0o600);
    fs.mkdirSync(path.join(root, "bots"), { recursive: true, mode: 0o700 });
    fs.chmodSync(path.join(root, "bots"), 0o700);
    fs.writeFileSync(path.join(root, "bots", `${APP}.json`), JSON.stringify({ appId: APP, appSecret: "fixture-secret", tenant: "feishu" }), { mode: 0o600 });
    fs.mkdirSync(path.join(root, "lark-cli-config"), { mode: 0o700 });
    fs.writeFileSync(path.join(root, "lark-cli-config", "user-profile-token"), "must-not-survive");
    const runtimeConfig = {
      version: 3,
      serverId: "server-v3",
      configDir: root,
      larkinHome: root,
      larkConfigDir: path.join(root, "lark-cli-config"),
      activeAgent: APP,
      agents: { [APP]: strictRuntimeAgent(root) },
    };
    const capture = path.join(temp, "capture.json");
    const preload = writeRunSpawnPreload(temp);
    const result = spawnSync(process.execPath, [path.join(ROOT, "dist/app/run.mjs"), "--agent", APP, "--dry-run"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: path.join(temp, "isolated-home"),
        LARKIN_CONFIG_DIR: root,
        RUN_CAPTURE_FILE: capture,
        RUN_CONFIG_FILE: configFile,
        RUN_RUNTIME_CONFIG: JSON.stringify(runtimeConfig),
        BUN_OPTIONS: [process.env.BUN_OPTIONS, `--preload=${preload}`].filter(Boolean).join(" "),
      },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1, result.stderr || result.stdout || result.error?.message);
    assert.match(result.stderr, /daemon 异常退出/);
    const observed = JSON.parse(fs.readFileSync(capture, "utf8"));
    assert.equal(observed.command, process.execPath);
    assert.deepEqual(observed.args, [path.join(ROOT, "dist/app/binary-entry.mjs"), "__internal", "runtime-process"]);
    assert.doesNotMatch(JSON.stringify(observed.args), /runtime-process\.mjs|fork\/dist\/larkin\.cjs|fork\/feishu\/host\.cjs/);
    assert.equal(observed.larkinHome, root);
    assert.equal(observed.configDir, root);
    assert.equal(observed.larkProfileEntries.includes("user-profile-token"), true, "target-only profile sync must not rebuild the shared profile directory");
    assert.equal(fs.readdirSync(root).some((entry) => entry.startsWith(".lark-cli-config.quarantine-")), false);
    assert.equal(observed.agents.length, 1);
    assert.deepEqual(observed.agents[0], {
      ...strictRuntimeAgent(root),
      chatMentionPolicies: { oc_keep: "free" },
      feishuAppSecret: "fixture-secret",
      feishuDomain: "https://open.feishu.cn",
    });
    assert.equal(fs.existsSync(path.join(root, "agents", APP, "AGENTS.md")), false, "launcher must not calibrate workspace");
    assert.equal(fs.existsSync(path.join(root, "agents", APP, "CLAUDE.md")), false, "launcher must not calibrate workspace");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

function writeHostModulePreload(temp) {
  const preload = path.join(temp, "host-module-preload.cjs");
  fs.writeFileSync(preload, `
module.exports = {
  reconcileAgentWorkspaceImpl(options) {
      if (process.env.HOST_SEAM_MARKER) {
        require("node:fs").appendFileSync(process.env.HOST_SEAM_MARKER, JSON.stringify(options) + "\\n");
      }
      if (process.env.HOST_SERVICE_THROW === "1") {
        throw new Error(process.env.HOST_SERVICE_SENTINEL || "INJECTED_WORKSPACE_SENTINEL");
      }
      return { changed: [], options };
  }
};
`);
  return preload;
}

function hostEnv(root, preload) {
  return {
    ...process.env,
    HOME: path.join(root, "isolated-home"),
    LARKIN_HOME: root,
    LARKIN_CONFIG_DIR: root,
    LARKIN_SERVER_ID: "server-test",
    LARKIN_AGENTS_CONFIG: JSON.stringify([{ ...strictRuntimeAgent(root), feishuAppSecret: "fixture-secret", feishuDomain: "https://open.feishu.cn" }]),
    LARKIN_FEISHU_MAP: path.join(root, "state", "map.json"),
    LARKIN_FEISHU_INBOX: path.join(root, "state", "inbox.ndjson"),
    LARKIN_FEISHU_REPLYCTX: path.join(root, "state", "replyctx.json"),
    HOST_SEAM_MARKER: path.join(root, "host-seam.ndjson"),
    LARKIN_TEST_HOST_MODULE: preload,
  };
}

function runHost(env, timeout = 1500) {
  return spawnSync(process.execPath, ["--eval", `require(${JSON.stringify(path.join(ROOT, "test/support/host-shell-test-harness.cjs"))})`], {
    cwd: ROOT,
    env,
    encoding: "utf8",
    timeout,
  });
}

test("real host child propagates WorkspaceService failure before status or prompt writes", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-throw-"));
  try {
    const root = path.join(temp, "root");
    fs.mkdirSync(root, { recursive: true });
    const preload = writeHostModulePreload(temp);
    const env = {
      ...hostEnv(root, preload),
      HOST_SERVICE_THROW: "1",
      HOST_SERVICE_SENTINEL: "VALID_CONFIG_CONTROL_SENTINEL",
    };
    const result = runHost(env);
    assert.equal(result.error?.code, undefined, `host did not fail fast: ${result.error?.message || ""}`);
    assert.notEqual(result.status, 0, "host must propagate calibration failure");
    assert.match(result.stderr, /VALID_CONFIG_CONTROL_SENTINEL/);
    const calls = fs.readFileSync(env.HOST_SEAM_MARKER, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(calls.length, 1, "valid host startup must calibrate exactly once");
    assert.equal(calls[0].workspaceDir, path.join(root, "agents", APP));
    assert.equal(calls[0].trustedWorkspaceRoot, path.join(root, "agents"));
    assert.equal(calls[0].lockDir, path.join(root, "state", "agents", APP));
    assert.equal(calls[0].agentId, APP);
    assert.equal(fs.existsSync(path.join(root, "daemon-status.json")), false);
    assert.equal(fs.existsSync(path.join(root, "agents", APP, "AGENTS.md")), false);
    assert.equal(fs.existsSync(path.join(root, "agents", APP, "CLAUDE.md")), false);
    assert.equal(fs.existsSync(path.join(root, "state", "agents", APP, "agent-state.json")), false,
      "host must calibrate before writing Agent state");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

const invalidHostCases = [
  { name: "missing root", reason: /LARKIN_(?:HOME|CONFIG_DIR)|root|根目录/i, mutate(env) { delete env.LARKIN_HOME; delete env.LARKIN_CONFIG_DIR; } },
  { name: "missing agents", reason: /LARKIN_AGENTS_CONFIG[\s\S]*(?:missing|required|缺少|必须)/i, mutate(env) { delete env.LARKIN_AGENTS_CONFIG; } },
  { name: "malformed agents", reason: /LARKIN_AGENTS_CONFIG[\s\S]*(?:JSON|parse|解析|invalid|malformed)/i, mutate(env) { env.LARKIN_AGENTS_CONFIG = "{"; } },
  { name: "empty agents", reason: /LARKIN_AGENTS_CONFIG[\s\S]*(?:empty|非空|至少|Agent)/i, mutate(env) { env.LARKIN_AGENTS_CONFIG = "[]"; } },
  { name: "missing runtime", reason: /Agent[\s\S]*runtime[\s\S]*(?:required|non-empty|缺少|必须|非空)/i, mutate(env) { const [agent] = JSON.parse(env.LARKIN_AGENTS_CONFIG); delete agent.runtime; env.LARKIN_AGENTS_CONFIG = JSON.stringify([agent]); } },
  { name: "missing model", reason: /Agent[\s\S]*model[\s\S]*(?:required|non-empty|缺少|必须|非空)/i, mutate(env) { const [agent] = JSON.parse(env.LARKIN_AGENTS_CONFIG); delete agent.model; env.LARKIN_AGENTS_CONFIG = JSON.stringify([agent]); } },
  { name: "missing server id", reason: /LARKIN_SERVER_ID[\s\S]*(?:required|必需|必须|identity)/i, mutate(env) { delete env.LARKIN_SERVER_ID; } },
  { name: "empty server id", reason: /LARKIN_SERVER_ID[\s\S]*(?:required|必需|必须|identity)/i, mutate(env) { env.LARKIN_SERVER_ID = ""; } },
];

for (const item of invalidHostCases) {
  test(`host rejects invalid configuration: ${item.name}`, () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-invalid-"));
    try {
      const root = path.join(temp, "root");
      fs.mkdirSync(root, { recursive: true });
      const preload = writeHostModulePreload(temp);
      const env = hostEnv(root, preload);
      item.mutate(env);
      env.LARKIN_AGENT_STATE = path.join(root, "state", "unexpected-default-agent.json");
      const result = runHost(env, 1000);
      assert.equal(result.error?.code, undefined, `${item.name} timed out instead of failing fast`);
      assert.notEqual(result.status, 0, `${item.name} must fail closed`);
      assert.match(result.stderr, item.reason, `${item.name} must report its specific config error`);
      assert.equal(fs.existsSync(env.HOST_SEAM_MARKER), false, `${item.name} reached WorkspaceService before config validation`);
      assert.equal(fs.existsSync(env.LARKIN_AGENT_STATE), false, `${item.name} created a random default Agent state`);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  });
}
