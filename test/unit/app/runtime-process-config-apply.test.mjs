import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(import.meta.url);
const configApi = require(path.join(ROOT, "dist", "platform", "config.cjs"));
const { applyRuntimeAgentUpsert, loadAndSyncRuntimeAgent, markConfigAppliedAfterRuntimeReady } = await import(
  pathToFileURL(path.join(ROOT, "dist", "app", "runtime-process.mjs")).href
);
const runtimeAgentConfig = await import(
  pathToFileURL(path.join(ROOT, "dist", "app", "runtime-agent-config.mjs")).href
);

test("runtime startup projects applied only after initialization resolves successfully", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-ready-"));
  const agentId = "cli_runtimeReadyA1";
  const env = { LARKIN_CONFIG_DIR: root };
  try {
    fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
      version: 3, serverId: "server-runtime-ready", activeAgent: agentId,
      agents: { [agentId]: { runtime: "codex", model: "gpt-5.6-sol", effort: "high" } },
    })}\n`, { mode: 0o600 });
    const mutation = configApi.mutateConfig(env, {
      kind: "set-agent-model", agentId, model: "default",
    }, { kind: "user" });
    const running = [{ agentId, runtime: "codex", model: "default", effort: null }];
    assert.equal(configApi.configApplyState(env, mutation.config).agents[agentId].applyState, "pending");

    await assert.rejects(
      markConfigAppliedAfterRuntimeReady(env, running, Promise.reject(new Error("late runtime initialization failure"))),
      /late runtime initialization failure/,
    );
    let loaded = configApi.loadConfig(env).config;
    assert.equal(configApi.configApplyState(env, loaded).agents[agentId].applyState, "pending",
      "failed runtime initialization must not publish applied state");

    await markConfigAppliedAfterRuntimeReady(env, running, Promise.resolve());
    loaded = configApi.loadConfig(env).config;
    assert.equal(configApi.configApplyState(env, loaded).agents[agentId].applyState, "applied",
      "successful runtime readiness may publish the matching config signature");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("expected-signature mismatch refuses load before hydrate or profile sync", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-upsert-cas-"));
  const agentId = "cli_runtimeCasA1";
  const env = { ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_HOME: root };
  let synced = false;
  try {
    fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-runtime-cas", mentionPolicy: "require", activeAgent: agentId,
      agents: { [agentId]: { runtime: "pi", model: "deepseek/deepseek-v4-pro" } },
    })}\n`, { mode: 0o600 });
    const expected = configApi.runtimeConfigSignature(configApi.loadConfig(env).config, agentId);
    configApi.mutateConfig(env, { kind: "set-agent-model", agentId, model: "kimi/kimi-k2.6" }, { kind: "user" });
    assert.throws(() => loadAndSyncRuntimeAgent(env, agentId, {
      runOfficialCli: () => { synced = true; throw new Error("profile sync must not run"); },
    }, { expectedSignature: expected }), /配置在 apply 期间发生变化|未热加载/);
    assert.equal(synced, false);
    const current = configApi.loadConfig(env).config.agents[agentId];
    assert.equal(current.runtime, "pi");
    assert.equal(current.model, "kimi/kimi-k2.6");
    assert.equal(Object.hasOwn(current, "piDistribution"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

function seedBuiltinApplyHome(label, agentId, otherId) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-runtime-upsert-${label}-`));
  fs.chmodSync(root, 0o700);
  const env = { ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_HOME: root };
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: `server-runtime-${label}`, mentionPolicy: "require", activeAgent: agentId,
    agents: {
      [agentId]: { runtime: "pi", model: "deepseek/deepseek-v4-pro" },
      [otherId]: { runtime: "pi", model: "kimi/kimi-k2.6" },
    },
  })}\n`, { mode: 0o600 });
  const botsDir = path.join(root, "bots");
  fs.mkdirSync(botsDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(botsDir, 0o700);
  for (const id of [agentId, otherId]) {
    fs.writeFileSync(path.join(botsDir, `${id}.json`), JSON.stringify({
      appId: id, appSecret: "fixture-secret", tenant: "feishu", updatedAt: "2026-09-05T00:00:00.000Z",
    }), { mode: 0o600 });
    fs.mkdirSync(path.join(root, "providers", "pi", id), { recursive: true, mode: 0o700 });
  }
  return { root, agentId, otherId, env };
}

function seedValidSignedProfile(env, agentId) {
  const loaded = configApi.loadConfig(env);
  const hydrated = runtimeAgentConfig.hydrateRuntimeAgent(loaded.configDir, loaded.config.agents[agentId]);
  for (const directory of [
    hydrated.larkConfigDir,
    path.join(hydrated.larkConfigDir, "lark-channel"),
    path.dirname(path.join(hydrated.stateDir, "lark-channel-source", "config.json")),
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.chmodSync(directory, 0o700);
  }
  const sourceFile = path.join(hydrated.stateDir, "lark-channel-source", "config.json");
  const workspaceFile = path.join(hydrated.larkConfigDir, "lark-channel", "config.json");
  fs.writeFileSync(sourceFile, `${JSON.stringify(runtimeAgentConfig.sourceProjection(hydrated, env), null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(workspaceFile, `${JSON.stringify({ apps: [{
    appId: agentId,
    appSecret: { source: "keychain", id: `appsecret:${agentId}` },
    defaultAs: "bot",
    strictMode: "bot",
    users: [],
  }] }, null, 2)}\n`, { mode: 0o600 });
  runtimeAgentConfig.installRuntimeCommandShims(hydrated);
  runtimeAgentConfig.validateAgentProfile(hydrated);
  return { lockFile: path.join(loaded.configDir, "config.json.lock") };
}

test("a switch after signature validation cannot profile-sync or Host-upsert the stale Agent", async () => {
  const { root, agentId, otherId, env } = seedBuiltinApplyHome("race-20260905", "cli_runtimeRaceA1", "cli_runtimeRaceB2");
  let synced = false;
  const hostUpserts = [];
  try {
    const expected = configApi.runtimeConfigSignature(configApi.loadConfig(env).config, agentId);
    await assert.rejects(() => applyRuntimeAgentUpsert(env, agentId, {
      runOfficialCli: () => {
        synced = true;
        throw new Error("profile sync must not run after a post-validation switch");
      },
    }, {
      expectedSignature: expected,
      afterCanonicalValidate: () => {
        configApi.mutateConfig(env, { kind: "set-agent-model", agentId, model: "kimi/kimi-k2.6" }, { kind: "user" });
      },
    }, (agent) => {
      hostUpserts.push({ runtime: agent.runtime, model: agent.model, agentId: agent.agentId });
    }), /配置在 apply 期间发生变化|未热加载/);
    assert.equal(synced, false);
    assert.deepEqual(hostUpserts, []);
    const current = configApi.loadConfig(env).config;
    assert.equal(current.agents[agentId].runtime, "pi");
    assert.equal(Object.hasOwn(current.agents[agentId], "piDistribution"), false);
    assert.equal(current.agents[agentId].model, "kimi/kimi-k2.6");
    assert.equal(current.agents[otherId].model, "kimi/kimi-k2.6");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("signed applyRuntimeAgentUpsert holds the config lock through one Host upsert then releases it", async () => {
  const { root, agentId, env } = seedBuiltinApplyHome("success-20260905", "cli_runtimeOkA1", "cli_runtimeOkB2");
  const hostUpserts = [];
  let synced = false;
  let lockHeldDuringUpsert = false;
  try {
    const { lockFile } = seedValidSignedProfile(env, agentId);
    const expected = configApi.runtimeConfigSignature(configApi.loadConfig(env).config, agentId);
    assert.equal(fs.existsSync(lockFile), false, "fixture setup must not leave the config lock held");
    const agent = await applyRuntimeAgentUpsert(env, agentId, {
      runOfficialCli: () => {
        synced = true;
        throw new Error("valid profile must not rebind during signed Host upsert");
      },
    }, { expectedSignature: expected }, (candidate) => {
      lockHeldDuringUpsert = true;
      assert.equal(fs.existsSync(lockFile), true, "config lock must span the Host upsert");
      assert.throws(() => fs.openSync(lockFile, "wx", 0o600), { code: "EEXIST" });
      hostUpserts.push({
        agentId: candidate.agentId,
        runtime: candidate.runtime,
      });
    });
    assert.equal(synced, false);
    assert.equal(lockHeldDuringUpsert, true);
    assert.equal(hostUpserts.length, 1);
    assert.deepEqual(hostUpserts[0], { agentId, runtime: "pi" });
    assert.equal(agent.runtime, "pi");
    assert.equal(Object.hasOwn(agent, "piDistribution"), false);
    assert.equal(fs.existsSync(lockFile), false, "config lock must be released after Host upsert");
    const after = configApi.mutateConfig(env, { kind: "set-agent-model", agentId, model: "deepseek/deepseek-v4-pro" }, { kind: "user" });
    assert.equal(after.persisted, true);
    assert.equal(fs.existsSync(lockFile), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
