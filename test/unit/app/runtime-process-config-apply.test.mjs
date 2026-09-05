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
const { loadAndSyncRuntimeAgent, markConfigAppliedAfterRuntimeReady } = await import(
  pathToFileURL(path.join(ROOT, "dist", "app", "runtime-process.mjs")).href
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
      agents: { [agentId]: { runtime: "pi", piDistribution: "builtin", model: "deepseek/deepseek-v4-pro" } },
    })}\n`, { mode: 0o600 });
    const expected = configApi.runtimeConfigSignature(configApi.loadConfig(env).config, agentId);
    configApi.mutateConfig(env, { kind: "set-agent-pi-distribution", agentId, distribution: "external" }, { kind: "user" });
    assert.throws(() => loadAndSyncRuntimeAgent(env, agentId, {
      runOfficialCli: () => { synced = true; throw new Error("profile sync must not run"); },
    }, { expectedSignature: expected }), /配置在 apply 期间发生变化|未热加载/);
    assert.equal(synced, false);
    const current = configApi.loadConfig(env).config.agents[agentId];
    assert.equal(current.runtime, "pi");
    assert.equal(current.piDistribution, "external");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
