import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE = path.join(ROOT, "src/setup/setup-binding.ts");
const BUILT = path.join(ROOT, "dist/setup/setup-binding.mjs");
const APP = "cli_a1B2c3";
const OTHER = "cli_d4E5f6";
const require = createRequire(import.meta.url);
const larkinConfig = require("../../../dist/platform/config.cjs");

function twoAgentConfig() {
  return {
    version: 3,
    serverId: "server-v3",
    activeAgent: OTHER,
    agents: {
      [APP]: {
        runtime: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        noMentionChats: ["oc_keep"],
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      [OTHER]: {
        runtime: "codex",
        model: "gpt-5.6-terra",
        effort: "medium",
        noMentionChats: ["oc_other"],
        createdAt: "2026-07-02T00:00:00.000Z",
      },
    },
  };
}

async function loadPlanner() {
  let artifact = BUILT;
  if (!fs.existsSync(artifact) && fs.existsSync(SOURCE)) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-binding-scenario-build-"));
    onTestFinished(() => fs.rmSync(temp, { recursive: true, force: true }));
    const outDir = path.join(temp, "dist");
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/build.mjs"), "--out-dir", outDir], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    artifact = path.join(outDir, "setup", "setup-binding.mjs");
  }
  assert.equal(fs.existsSync(artifact), true, "setup-binding.mjs build artifact is required");
  const module = await import(`${pathToFileURL(artifact).href}?case=${Date.now()}-${Math.random()}`);
  assert.equal(typeof module.planSingleRootBinding, "function", "planSingleRootBinding export is required");
  return module.planSingleRootBinding;
}

test("authored setup binding seam exists outside fork", () => {
  assert.equal(fs.existsSync(SOURCE), true, "missing src/setup/setup-binding.ts");
});

test("a clean shell build emits loadable setup-binding.mjs with the pure planning export", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-binding-build-"));
  try {
    const outDir = path.join(temp, "dist");
    const result = spawnSync(process.execPath, [path.join(ROOT, "scripts/build.mjs"), "--out-dir", outDir], {
      cwd: ROOT,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const artifact = path.join(outDir, "setup", "setup-binding.mjs");
    assert.equal(fs.existsSync(artifact), true, "clean build did not emit setup-binding.mjs");
    const module = await import(pathToFileURL(artifact).href);
    assert.equal(typeof module.planSingleRootBinding, "function");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("same App ID preserves useful settings while migrating the exact other Agent/active selection to v4", async () => {
  const planSingleRootBinding = await loadPlanner();
  const before = twoAgentConfig();
  const next = planSingleRootBinding({
    config: before,
    profile: { name: APP, appId: APP },
    requestedAgent: APP,
    runtime: undefined,
    defaultModel: larkinConfig.defaultModelFor("codex"),
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    now: "2026-07-15T00:00:00.000Z",
  });
  assert.deepEqual(next, {
    version: 4, serverId: before.serverId, mentionPolicy: "require", activeAgent: before.activeAgent,
    agents: Object.fromEntries(Object.entries(before.agents).map(([id, agent]) => [id, {
      runtime: agent.runtime, model: agent.model, effort: agent.effort,
      chatMentionPolicies: Object.fromEntries(agent.noMentionChats.map((chatId) => [chatId, "free"])), createdAt: agent.createdAt,
    }])),
  });
});

test("requested Agent mismatch is independently reachable and fail closed", async () => {
  const planSingleRootBinding = await loadPlanner();
  const before = twoAgentConfig();
  assert.throws(
    () => planSingleRootBinding({
      config: before,
      profile: { name: APP, appId: APP },
      requestedAgent: OTHER,
      runtime: undefined,
      defaultModel: larkinConfig.defaultModelFor("codex"),
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      now: "2026-07-15T00:00:00.000Z",
    }),
    /requestedAgent|--agent|App ID|appId|一致|match/i,
  );
  assert.deepEqual(before, twoAgentConfig(), "mismatch must not mutate config");
});

test("new codex App uses default sentinel supplied by setup", async () => {
  const planSingleRootBinding = await loadPlanner();
  const appId = "cli_newCodex7";
  const catalogDefault = larkinConfig.defaultModelFor("codex");
  const next = planSingleRootBinding({
    config: twoAgentConfig(),
    profile: { appId },
    requestedAgent: appId,
    runtime: "codex",
    defaultModel: catalogDefault,
    supportedReasoningEfforts: larkinConfig.loadRuntimeModels().codex[0].supportedReasoningEfforts || [],
    now: "2026-07-15T01:00:00.000Z",
  });
  assert.equal(next.agents[appId].model, catalogDefault);
  assert.equal(next.agents[appId].createdAt, "2026-07-15T01:00:00.000Z");
});

test("new Agent product default is pi/default with no effort", async () => {
  const planSingleRootBinding = await loadPlanner();
  const appId = "cli_newPiDefault7";
  const next = planSingleRootBinding({
    config: twoAgentConfig(), profile: { appId }, requestedAgent: appId,
    runtime: undefined, defaultModel: "default", supportedReasoningEfforts: [], now: "2026-07-15T01:30:00.000Z",
  });
  assert.deepEqual(next.agents[appId], { runtime: "pi", model: "default", createdAt: "2026-07-15T01:30:00.000Z" });
});

test("runtime switches use the injected catalog default and preserve non-model settings", async () => {
  const planSingleRootBinding = await loadPlanner();
  for (const runtime of ["pi", "claude"]) {
    const before = twoAgentConfig();
    const catalogDefault = larkinConfig.defaultModelFor(runtime);
    const targetModel = larkinConfig.loadRuntimeModels()[runtime].find((model) => model.id === catalogDefault);
    const supportedReasoningEfforts = targetModel.supportedReasoningEfforts || [];
    const next = planSingleRootBinding({
      config: before,
      profile: { appId: APP },
      requestedAgent: APP,
      runtime,
      defaultModel: catalogDefault,
      supportedReasoningEfforts,
      now: "2026-07-15T02:00:00.000Z",
    });
    assert.equal(next.agents[APP].runtime, runtime);
    assert.equal(next.agents[APP].model, catalogDefault, runtime);
    assert.equal(next.agents[APP].effort, supportedReasoningEfforts.includes(before.agents[APP].effort) ? before.agents[APP].effort : undefined, runtime);
    assert.deepEqual(next.agents[APP].chatMentionPolicies, { oc_keep: "free" }, runtime);
    assert.equal(next.agents[APP].createdAt, before.agents[APP].createdAt, runtime);
  }
});

function writeStubLarkCli(binDir) {
  fs.mkdirSync(binDir, { recursive: true });
  const stub = path.join(binDir, "lark-cli");
  fs.writeFileSync(stub, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "profile" && args[1] === "list") console.log(JSON.stringify([{ name: ${JSON.stringify(APP)}, appId: ${JSON.stringify(APP)}, active: true }]));
else console.log(JSON.stringify({ ok: true, identity: "bot", data: { chats: [] } }));
`, { mode: 0o755 });
}

function runFreshSetupWithRuntime(runtime) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-runtime-"));
  const binDir = path.join(root, "bin");
  writeStubLarkCli(binDir);
  const result = spawnSync(process.execPath, [
    path.join(ROOT, "dist/setup/setup-bind.mjs"), "--profile", APP, "--agent", APP, "--runtime", runtime, "--yes",
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOME: path.join(root, "isolated-home"),
      LARKIN_CONFIG_DIR: root,
      PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
    },
    encoding: "utf8",
  });
  return { root, result, configFile: path.join(root, "config.json") };
}

test("setup rejects a runtime without a native adapter before config write", () => {
  const attempt = runFreshSetupWithRuntime("unknown-runtime");
  try {
    assert.notEqual(attempt.result.status, 0, "unknown runtime unexpectedly succeeded");
    assert.equal(fs.existsSync(attempt.configFile), false, "unknown runtime wrote config");
    assert.match(attempt.result.stderr, /runtime|模型|catalog|目录|unknown/i);
  } finally {
    fs.rmSync(attempt.root, { recursive: true, force: true });
  }
});

test("real setup-bind integration rewrites v3 config without a workspace symlink", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-v3-integration-"));
  try {
    assert.equal(fs.existsSync(BUILT), true, "setup-binding build artifact must exist before integration");
    const binDir = path.join(root, "bin");
    writeStubLarkCli(binDir);
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify(twoAgentConfig(), null, 2) + "\n", { mode: 0o600 });
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "dist/setup/setup-bind.mjs"), "--profile", APP, "--agent", APP, "--yes",
    ], {
      cwd: ROOT,
      env: { ...process.env, HOME: path.join(root, "isolated-home"), LARKIN_CONFIG_DIR: root, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8")), {
      version: 4, serverId: "server-v3", mentionPolicy: "require", activeAgent: OTHER,
      agents: {
        [APP]: { runtime: "codex", model: "gpt-5.6-sol", effort: "high", chatMentionPolicies: { oc_keep: "free" }, createdAt: "2026-07-01T00:00:00.000Z" },
        [OTHER]: { runtime: "codex", model: "gpt-5.6-terra", effort: "medium", chatMentionPolicies: { oc_other: "free" }, createdAt: "2026-07-02T00:00:00.000Z" },
      },
    });
    assert.equal(fs.statSync(path.join(root, "config.json")).mode & 0o777, 0o600, "setup-bind must keep config.json at 0600");
    const workspace = path.join(root, "agents", APP);
    assert.equal(fs.existsSync(workspace) && fs.lstatSync(workspace).isSymbolicLink(), false);

    const switched = spawnSync(process.execPath, [
      path.join(ROOT, "dist/setup/setup-bind.mjs"), "--profile", APP, "--agent", APP, "--runtime", "claude", "--yes",
    ], {
      cwd: ROOT,
      env: { ...process.env, HOME: path.join(root, "isolated-home"), LARKIN_CONFIG_DIR: root, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      encoding: "utf8",
    });
    assert.equal(switched.status, 0, switched.stderr || switched.stdout);
    const switchedStored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.equal(switchedStored.agents[APP].runtime, "claude");
    assert.equal(switchedStored.agents[APP].model, larkinConfig.defaultModelFor("claude"));
    assert.equal(Object.hasOwn(switchedStored.agents[APP], "effort"), false);
    assert.doesNotThrow(() => larkinConfig.normalizeConfig(switchedStored, root));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
