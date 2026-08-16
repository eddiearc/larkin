import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createRequire } from "node:module";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const configApi = require("../../../dist/platform/config.cjs");
const CONFIG_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/platform/config.cjs");
const APP = "cli_configPolicyA1";
const OTHER = "cli_configPolicyB2";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-config-management-"));
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, `${JSON.stringify({
    version: 3,
    serverId: "server-policy",
    activeAgent: APP,
    agents: {
      [APP]: { runtime: "codex", model: "gpt-5.6-sol", effort: "high", noMentionChats: ["oc_free"] },
      [OTHER]: { runtime: "claude", model: "sonnet" },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return { root, file };
}

test("Pi distribution mutation is locked, snapshotted, and atomically rollbackable", () => {
  const { root, file } = fixture();
  const env = { LARKIN_CONFIG_DIR: root };
  const snapshot = path.join(root, "pi-distribution.snapshot.json");
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.agents[APP].runtime = "pi";
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    const before = fs.readFileSync(file);
    const result = configApi.mutateConfig(env, {
      kind: "set-agent-pi-distribution", agentId: APP, distribution: "builtin",
    }, { kind: "user" }, { snapshotFile: snapshot });
    assert.equal(result.config.agents[APP].piDistribution, "builtin");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).agents[APP].piDistribution, "builtin");
    assert.equal(fs.statSync(snapshot).mode & 0o777, 0o600);
    const rollback = configApi.rollbackConfig(env, snapshot);
    assert.equal(rollback.agentId, APP);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).agents[APP].piDistribution, undefined);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Pi distribution snapshot rejects symlink and insecure paths without changing config", () => {
  const { root, file } = fixture();
  const env = { LARKIN_CONFIG_DIR: root };
  const outside = path.join(os.tmpdir(), `larkin-snapshot-target-${process.pid}`);
  const link = path.join(root, "snapshot-link.json");
  const insecure = path.join(root, "insecure");
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.agents[APP].runtime = "pi";
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(outside, "do-not-touch\n", { mode: 0o600 });
    fs.symlinkSync(outside, link);
    const before = fs.readFileSync(file);
    assert.throws(() => configApi.mutateConfig(env, {
      kind: "set-agent-pi-distribution", agentId: APP, distribution: "builtin",
    }, { kind: "user" }, { snapshotFile: link }), /unsafe|symlink/i);
    assert.deepEqual(fs.readFileSync(file), before);
    fs.unlinkSync(link);
    const realParent = path.join(root, "real-snapshot-parent");
    const ancestorLink = path.join(root, "snapshot-parent-link");
    fs.mkdirSync(realParent, { mode: 0o700 });
    fs.symlinkSync(realParent, ancestorLink);
    assert.throws(() => configApi.mutateConfig(env, {
      kind: "set-agent-pi-distribution", agentId: APP, distribution: "builtin",
    }, { kind: "user" }, { snapshotFile: path.join(ancestorLink, "snapshot.json") }), /symlink|ancestor/i);
    fs.unlinkSync(ancestorLink);
    fs.rmSync(realParent, { recursive: true, force: true });
    fs.mkdirSync(insecure, { mode: 0o755 });
    if (process.platform !== "win32") fs.chmodSync(insecure, 0o755);
    assert.throws(() => configApi.mutateConfig(env, {
      kind: "set-agent-pi-distribution", agentId: APP, distribution: "builtin",
    }, { kind: "user" }, { snapshotFile: path.join(insecure, "snapshot.json") }), /0700|unsafe/i);
    assert.deepEqual(fs.readFileSync(file), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); try { fs.unlinkSync(outside); } catch {} }
});

test("rollback refuses a post-snapshot configuration change", () => {
  const { root, file } = fixture();
  const env = { LARKIN_CONFIG_DIR: root };
  const snapshot = path.join(root, "pi-distribution.snapshot.json");
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.agents[APP].runtime = "pi";
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    configApi.mutateConfig(env, { kind: "set-agent-pi-distribution", agentId: APP, distribution: "builtin" }, { kind: "user" }, { snapshotFile: snapshot });
    fs.appendFileSync(file, "\n");
    assert.throws(() => configApi.rollbackConfig(env, snapshot), /changed after the snapshot/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("snapshot rollback rejects tampered payloads and destinations outside the config root", () => {
  const { root, file } = fixture();
  const env = { LARKIN_CONFIG_DIR: root };
  const snapshot = path.join(root, "pi-distribution.snapshot.json");
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-snapshot-outside-"));
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.agents[APP].runtime = "pi";
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    const before = fs.readFileSync(file);
    assert.throws(() => configApi.mutateConfig(env, {
      kind: "set-agent-pi-distribution", agentId: APP, distribution: "builtin",
    }, { kind: "user" }, { snapshotFile: path.join(outside, "snapshot.json") }), /canonical config root|inside/i);
    assert.deepEqual(fs.readFileSync(file), before);
    configApi.mutateConfig(env, { kind: "set-agent-pi-distribution", agentId: APP, distribution: "builtin" }, { kind: "user" }, { snapshotFile: snapshot });
    const tampered = JSON.parse(fs.readFileSync(snapshot, "utf8"));
    tampered.beforeConfig = { version: 4, serverId: "forged", mentionPolicy: "require", activeAgent: APP, agents: {} };
    fs.writeFileSync(snapshot, `${JSON.stringify(tampered, null, 2)}\n`, { mode: 0o600 });
    assert.throws(() => configApi.rollbackConfig(env, snapshot), /does not match|invalid/i);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).agents[APP].piDistribution, "builtin");
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
});

test("rollback restores only the target Agent apply state", () => {
  const { root, file } = fixture();
  const env = { LARKIN_CONFIG_DIR: root };
  const snapshot = path.join(root, "pi-distribution.snapshot.json");
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.version = 4; stored.mentionPolicy = "require"; stored.agents[APP].runtime = "pi";
    delete stored.agents[APP].noMentionChats; delete stored.agents[OTHER].noMentionChats;
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    const changed = configApi.mutateConfig(env, { kind: "set-agent-pi-distribution", agentId: APP, distribution: "builtin" }, { kind: "user" }, { snapshotFile: snapshot });
    const current = configApi.loadConfig(env).config;
    configApi.markConfigApplied(env, OTHER, configApi.runtimeConfigSignature(current, OTHER));
    configApi.rollbackConfig(env, snapshot);
    const apply = configApi.configApplyState(env, configApi.loadConfig(env).config);
    assert.equal(apply.agents[OTHER].applyState, "applied");
    assert.equal(apply.agents[APP].applyState, "unknown");
    assert.notEqual(changed.revision, configApi.loadConfig(env).revision);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("rollback journal recovery completes apply-state restoration after config replacement", () => {
  const { root, file } = fixture();
  const env = { LARKIN_CONFIG_DIR: root };
  const snapshot = path.join(root, "pi-distribution.snapshot.json");
  const journalFile = path.join(root, ".config-rollback-journal.json");
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.version = 4; stored.mentionPolicy = "require"; stored.agents[APP].runtime = "pi";
    delete stored.agents[APP].noMentionChats; delete stored.agents[OTHER].noMentionChats;
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    configApi.mutateConfig(env, { kind: "set-agent-pi-distribution", agentId: APP, distribution: "builtin" }, { kind: "user" }, { snapshotFile: snapshot });
    const current = configApi.loadConfig(env).config;
    configApi.markConfigApplied(env, APP, configApi.runtimeConfigSignature(current, APP));
    const payload = JSON.parse(fs.readFileSync(snapshot, "utf8"));
    fs.writeFileSync(journalFile, `${JSON.stringify({
      version: 1, targetAgentId: APP, expectedAfterRevision: payload.afterRevision,
      beforeRevision: payload.beforeRevision, beforeConfigBytes: payload.beforeConfigBytes,
      beforeApplyState: payload.beforeApplyState,
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(file, Buffer.from(payload.beforeConfigBytes, "base64"), { mode: 0o600 });
    assert.throws(() => configApi.rollbackConfig(env, snapshot), /changed after the snapshot/i);
    const restored = configApi.configApplyState(env, configApi.loadConfig(env).config);
    assert.equal(restored.agents[APP].applyState, "unknown");
    assert.equal(fs.existsSync(journalFile), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("switching a Pi Agent to a non-Pi runtime removes piDistribution before persistence", () => {
  const { root, file } = fixture();
  try {
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    stored.version = 4;
    stored.mentionPolicy = "require";
    stored.agents[APP] = { runtime: "pi", model: "default", piDistribution: "builtin" };
    fs.writeFileSync(file, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
    configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, { kind: "set-agent-runtime", agentId: APP, runtime: "codex", model: "default" }, { kind: "user" });
    const after = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(after.agents[APP].runtime, "codex");
    assert.equal(Object.hasOwn(after.agents[APP], "piDistribution"), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("v3 loads as a v4 view and legacy noMentionChats becomes an Agent x chat override", () => {
  const { root } = fixture();
  try {
    const { config } = configApi.loadConfig({ LARKIN_CONFIG_DIR: root });
    assert.equal(config.version, 4);
    assert.equal(config.mentionPolicy, "require");
    assert.deepEqual(config.agents[APP].chatMentionPolicies, { oc_free: "free" });
    assert.deepEqual(configApi.resolveMentionPolicy(config, APP, "oc_free"), { effective: "free", source: "chat" });
    assert.deepEqual(configApi.resolveMentionPolicy(config, APP, "oc_other"), { effective: "require", source: "global" });
    assert.deepEqual(configApi.resolveAgentGlobalMentionPolicy(config, APP), { effective: "require", source: "global" });
    config.mentionPolicy = "free";
    config.agents[APP].mentionPolicy = "require";
    assert.deepEqual(configApi.resolveAgentGlobalMentionPolicy(config, APP), { effective: "require", source: "agent" });
    delete config.agents[APP].mentionPolicy;
    assert.deepEqual(configApi.resolveAgentGlobalMentionPolicy(config, APP), { effective: "free", source: "global" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("validated mutation persists strict v4, clears effort, and allows explicit Agent configuration targets", () => {
  const { root, file } = fixture();
  try {
    const userResult = configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, {
      kind: "set-agent-model", agentId: APP, model: "default",
    }, { kind: "user" });
    assert.equal(userResult.applyState, "saved_not_applied");
    let applyState = configApi.configApplyState({ LARKIN_CONFIG_DIR: root }, userResult.config);
    assert.equal(applyState.agents[APP].applyState, "pending");
    configApi.markConfigApplied({ LARKIN_CONFIG_DIR: root }, APP, configApi.runtimeConfigSignature(userResult.config, APP));
    applyState = configApi.configApplyState({ LARKIN_CONFIG_DIR: root }, configApi.loadConfig({ LARKIN_CONFIG_DIR: root }).config);
    assert.equal(applyState.agents[APP].applyState, "applied");
    let stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(stored.version, 4);
    assert.equal(stored.agents[APP].model, "default");
    assert.equal("effort" in stored.agents[APP], false);
    assert.deepEqual(stored.agents[APP].chatMentionPolicies, { oc_free: "free" });
    assert.equal("noMentionChats" in stored.agents[APP], false);

    const selfResult = configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, {
      kind: "set-chat-mention", agentId: APP, chatId: "oc_self", value: "free",
    }, { kind: "agent", agentId: APP });
    assert.equal(selfResult.applyState, "saved_not_applied");
    stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(stored.agents[APP].chatMentionPolicies.oc_self, "free");

    const crossAgentResult = configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, {
      kind: "set-agent-mention", agentId: OTHER, value: "free",
    }, { kind: "agent", agentId: APP });
    assert.equal(crossAgentResult.changedScope, "agent");
    const globalResult = configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, {
      kind: "set-global-mention", value: "free",
    }, { kind: "agent", agentId: APP });
    assert.equal(globalResult.changedScope, "global");
    stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(stored.mentionPolicy, "free");
    assert.equal(stored.agents[OTHER].mentionPolicy, "free");

    const before = fs.readFileSync(file, "utf8");
    assert.throws(() => configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, {
      kind: "set-agent-model", agentId: OTHER, model: "unsafe/model;not-authored",
    }, { kind: "user" }), /安全|格式|model/i);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("safe dynamic runtime models and runtime effort enums survive persistence reloads", () => {
  const { root, file } = fixture();
  try {
    configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, {
      kind: "set-agent-model", agentId: APP, model: "gpt-evaluator-dynamic-1",
    }, { kind: "user" });
    configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, {
      kind: "set-agent-effort", agentId: APP, effort: "high",
    }, { kind: "user" });
    configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, {
      kind: "set-agent-model", agentId: OTHER, model: "claude-evaluator-9",
    }, { kind: "user" });
    configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, {
      kind: "set-agent-effort", agentId: OTHER, effort: "medium",
    }, { kind: "user" });

    const reloaded = configApi.loadConfig({ LARKIN_CONFIG_DIR: root }).config;
    assert.deepEqual(
      { model: reloaded.agents[APP].model, effort: reloaded.agents[APP].effort },
      { model: "gpt-evaluator-dynamic-1", effort: "high" },
    );
    assert.deepEqual(
      { model: reloaded.agents[OTHER].model, effort: reloaded.agents[OTHER].effort },
      { model: "claude-evaluator-9", effort: "medium" },
    );

    const before = fs.readFileSync(file, "utf8");
    for (const mutation of [
      { kind: "set-agent-model", agentId: APP, model: "gpt-safe/../../escape" },
      { kind: "set-agent-model", agentId: OTHER, model: "claude-safe;touch-pwned" },
      { kind: "set-agent-effort", agentId: APP, effort: "off" },
      { kind: "set-agent-effort", agentId: OTHER, effort: "ultra" },
    ]) {
      assert.throws(() => configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, mutation, { kind: "user" }), /model|effort|安全|格式/i);
      assert.equal(fs.readFileSync(file, "utf8"), before);
    }

    // pi 模型 ID 允许带斜杠（openrouter 风格）与不带斜杠（内置 provider 隐式模型）两种形式。
    configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, {
      kind: "set-agent-runtime", agentId: APP, runtime: "pi", model: "deepseek-v4-pro",
    }, { kind: "user" });
    const piReloaded = configApi.loadConfig({ LARKIN_CONFIG_DIR: root }).config;
    assert.equal(piReloaded.agents[APP].model, "deepseek-v4-pro");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("cross-process mutations serialize without losing either Agent update", async () => {
  const { root, file } = fixture();
  const script = `const config=require(process.argv[1]);config.mutateConfig({LARKIN_CONFIG_DIR:process.argv[2]},JSON.parse(process.argv[3]),{kind:"user"});`;
  const run = (mutation) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", script, CONFIG_MODULE, root, JSON.stringify(mutation)], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`mutation exited ${code}: ${stderr}`)));
  });
  try {
    await Promise.all([
      run({ kind: "set-agent-mention", agentId: APP, value: "free" }),
      run({ kind: "set-agent-mention", agentId: OTHER, value: "require" }),
    ]);
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(stored.agents[APP].mentionPolicy, "free");
    assert.equal(stored.agents[OTHER].mentionPolicy, "require");
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("setup CAS refuses to overwrite a concurrent CLI mutation and invalid setup bytes", () => {
  const { root, file } = fixture();
  try {
    const loaded = configApi.loadConfig({ LARKIN_CONFIG_DIR: root });
    const candidate = configApi.toStored(loaded.config);
    configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, { kind: "set-global-mention", value: "free" }, { kind: "user" });
    const afterMutation = fs.readFileSync(file, "utf8");
    const setupScript = `const c=require(process.argv[1]);try{c.commitSetupConfig({LARKIN_CONFIG_DIR:process.argv[2]},process.argv[3],JSON.parse(process.argv[4]));process.exit(0)}catch(e){process.stderr.write(e.message);process.exit(9)}`;
    const setup = spawnSync(process.execPath, ["-e", setupScript, CONFIG_MODULE, root, loaded.revision, JSON.stringify(candidate)], { encoding: "utf8" });
    assert.equal(setup.status, 9);
    assert.match(setup.stderr, /并发|重试|修改/);
    assert.equal(fs.readFileSync(file, "utf8"), afterMutation);
    assert.throws(() => configApi.commitSetupConfig({ LARKIN_CONFIG_DIR: root }, configApi.loadConfig({ LARKIN_CONFIG_DIR: root }).revision, { version: 4 }), /缺少|config|字段/i);
    assert.equal(fs.readFileSync(file, "utf8"), afterMutation);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("private config reads reject weak mode, wrong owner metadata, and final symlinks", () => {
  const { root, file } = fixture();
  const target = `${file}.target`;
  try {
    fs.chmodSync(file, 0o644);
    assert.throws(() => configApi.loadConfig({ LARKIN_CONFIG_DIR: root }), /0600/);
    fs.chmodSync(file, 0o600);
    assert.throws(() => configApi.assertPrivateConfigMetadata({ regularFile: true, uid: (process.getuid?.() ?? 0) + 1, mode: 0o600 }), /owner/);
    fs.renameSync(file, target);
    fs.symlinkSync(target, file);
    assert.throws(() => configApi.loadConfig({ LARKIN_CONFIG_DIR: root }), /symlink|ELOOP/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a crashed config lock and orphan reclaim guard are recovered without losing the mutation", async () => {
  const { root, file } = fixture();
  const lock = `${file}.lock`;
  const guard = `${lock}.reclaim`;
  const inspectModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/platform/process-inspect.cjs");
  const script = `const fs=require("node:fs"),p=require(process.argv[1]);const i=p.inspectProcess(process.pid),record={pid:process.pid,processStartToken:i.startToken,nonce:"crash-owner",createdAt:new Date().toISOString()};for(const file of process.argv.slice(2))fs.writeFileSync(file,JSON.stringify(record)+"\\n",{mode:384,flag:"wx"});process.stdout.write("READY\\n");setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ["-e", script, inspectModule, lock, guard], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
      child.once("exit", (code) => reject(new Error(`lock owner exited early: ${code}`)));
    });
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const result = configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, { kind: "set-global-mention", value: "free" }, { kind: "user" });
    assert.equal(result.persisted, true);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).mentionPolicy, "free");
    assert.equal(fs.existsSync(lock), false);
    assert.equal(fs.existsSync(guard), false);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a live reclaim guard is never stolen while its owner protects stale-lock recovery", () => {
  const { root, file } = fixture();
  const lock = `${file}.lock`;
  const guard = `${lock}.reclaim`;
  const processInspect = require("../../../dist/platform/process-inspect.cjs");
  const identity = processInspect.inspectProcess(process.pid);
  const live = { pid: process.pid, processStartToken: identity.startToken, nonce: "live-reclaim-owner", createdAt: new Date().toISOString() };
  const dead = { pid: 2147483647, processStartToken: "dead", nonce: "dead-lock-owner", createdAt: new Date(0).toISOString() };
  fs.writeFileSync(lock, `${JSON.stringify(dead)}\n`, { mode: 0o600, flag: "wx" });
  fs.writeFileSync(guard, `${JSON.stringify(live)}\n`, { mode: 0o600, flag: "wx" });
  const before = fs.readFileSync(file);
  try {
    assert.throws(() => configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, { kind: "set-global-mention", value: "free" }, { kind: "user" }), /正被其他进程修改/);
    assert.deepEqual(fs.readFileSync(file), before);
    assert.equal(JSON.parse(fs.readFileSync(guard, "utf8")).nonce, live.nonce);
    assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).nonce, dead.nonce);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}, 10_000);

test("mention persistence is applied only while an owned daemon serves the Agent", async () => {
  const { root } = fixture();
  const appDir = path.join(root, "app");
  const daemonScript = path.join(appDir, "runtime-process.mjs");
  const inspectModule = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../dist/platform/process-inspect.cjs");
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(daemonScript, `import {createRequire} from "node:module";import fs from "node:fs";import path from "node:path";const require=createRequire(import.meta.url),p=require(process.env.INSPECT);const i=p.inspectProcess(process.pid);fs.writeFileSync(path.join(process.env.ROOT,"daemon-status.json"),JSON.stringify({pid:process.pid,commandToken:"app/runtime-process.mjs",processStartToken:i.startToken,agents:[process.env.APP]})+"\\n",{mode:384});process.stdout.write("READY\\n");setInterval(()=>{},1000);`);
  const child = spawn(process.execPath, [daemonScript], { env: { ...process.env, ROOT: root, APP, INSPECT: inspectModule }, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise((resolve, reject) => { child.stdout.once("data", resolve); child.once("error", reject); });
    const live = configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, { kind: "set-agent-mention", agentId: APP, value: "free" }, { kind: "user" });
    assert.equal(live.applyState, "applied");
    assert.equal(configApi.configApplyState({ LARKIN_CONFIG_DIR: root }, live.config).agents[APP].applyState, "applied");
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    const offline = configApi.mutateConfig({ LARKIN_CONFIG_DIR: root }, { kind: "set-chat-mention", agentId: APP, chatId: "oc_offline", value: "free" }, { kind: "user" });
    assert.equal(offline.applyState, "saved_not_applied");
    assert.equal(configApi.configApplyState({ LARKIN_CONFIG_DIR: root }, offline.config).agents[APP].applyState, "pending");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
