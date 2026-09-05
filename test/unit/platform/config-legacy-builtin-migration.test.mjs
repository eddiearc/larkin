import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { test } from "bun:test";

const require = createRequire(import.meta.url);
const configApi = require("../../../dist/platform/config.cjs");

const BUILTIN = "cli_legacyBuiltinA1";
const CODEX = "cli_legacyCodexB2";

function writeConfig(root, agents) {
  const file = path.join(root, "config.json");
  fs.writeFileSync(file, `${JSON.stringify({
    version: 4,
    serverId: "server-legacy-builtin",
    mentionPolicy: "require",
    activeAgent: BUILTIN,
    agents,
  }, null, 2)}\n`, { mode: 0o600 });
  return file;
}

function currentRuntimeSignature(config, agentId) {
  const agent = config.agents[agentId];
  const chats = Object.fromEntries(Object.entries(agent.chatMentionPolicies || {}).sort(([left], [right]) => left.localeCompare(right)));
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify({
    schema: 2,
    runtime: agent.runtime, model: agent.model, effort: agent.effort ?? null,
    globalMentionPolicy: config.mentionPolicy, agentMentionPolicy: agent.mentionPolicy ?? null, chatMentionPolicies: chats,
  })).digest("hex")}`;
}

function legacyBuiltinSignature(config, agentId) {
  const agent = config.agents[agentId];
  const chats = Object.fromEntries(Object.entries(agent.chatMentionPolicies || {}).sort(([left], [right]) => left.localeCompare(right)));
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify({
    runtime: agent.runtime, model: agent.model, piDistribution: "builtin", effort: agent.effort ?? null,
    globalMentionPolicy: config.mentionPolicy, agentMentionPolicy: agent.mentionPolicy ?? null, chatMentionPolicies: chats,
  })).digest("hex")}`;
}

function seedOwnedDir(root, agentId) {
  const directory = path.join(root, "providers", "pi", agentId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(directory, 0o700);
  fs.writeFileSync(path.join(directory, "auth.json"), `${JSON.stringify({ fixture: { key: "SECRET" } })}\n`, { mode: 0o600 });
  return directory;
}

test("loadConfig rewrites a builtin Agent once, preserves model, and deletes the owned directory", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-builtin-"));
  try {
    const file = writeConfig(root, {
      [BUILTIN]: { runtime: "pi", model: "zai-coding-cn/glm-5.2", piDistribution: "builtin", effort: "high", mentionPolicy: "free" },
      [CODEX]: { runtime: "codex", model: "gpt-5.6-sol", effort: "medium" },
    });
    const owned = seedOwnedDir(root, BUILTIN);
    const beforeCodex = JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")).agents[CODEX]);
    const first = configApi.loadConfig({ LARKIN_CONFIG_DIR: root });
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(stored.agents[BUILTIN].runtime, "pi");
    assert.equal(stored.agents[BUILTIN].model, "zai-coding-cn/glm-5.2");
    assert.equal(stored.agents[BUILTIN].effort, "high");
    assert.equal(stored.agents[BUILTIN].mentionPolicy, "free");
    assert.equal(Object.hasOwn(stored.agents[BUILTIN], "piDistribution"), false);
    assert.equal(JSON.stringify(stored.agents[CODEX]), beforeCodex);
    assert.equal(fs.existsSync(owned), false);
    assert.equal(first.config.agents[BUILTIN].runtime, "pi");
    assert.equal(Object.hasOwn(first.config.agents[BUILTIN], "piDistribution"), false);
    const secondBytes = fs.readFileSync(file);
    const second = configApi.loadConfig({ LARKIN_CONFIG_DIR: root });
    assert.deepEqual(fs.readFileSync(file), secondBytes);
    assert.equal(second.revision, first.revision);
    assert.notEqual(
      configApi.runtimeConfigSignature(first.config, BUILTIN),
      legacyBuiltinSignature(first.config, BUILTIN),
    );
    assert.equal(
      configApi.runtimeConfigSignature(first.config, BUILTIN),
      currentRuntimeSignature(first.config, BUILTIN),
    );
    assert.equal(
      configApi.runtimeConfigSignature(first.config, CODEX),
      currentRuntimeSignature(first.config, CODEX),
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtimeOption builtin-pi is rewritten to runtime pi", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-runtime-option-"));
  try {
    writeConfig(root, {
      [BUILTIN]: { runtime: "pi", model: "kimi/kimi-k2.6", runtimeOption: "builtin-pi" },
      [CODEX]: { runtime: "codex", model: "gpt-5.6-sol" },
    });
    const loaded = configApi.loadConfig({ LARKIN_CONFIG_DIR: root });
    assert.equal(loaded.config.agents[BUILTIN].runtime, "pi");
    assert.equal(loaded.config.agents[BUILTIN].model, "kimi/kimi-k2.6");
    const stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.equal(Object.hasOwn(stored.agents[BUILTIN], "runtimeOption"), false);
    assert.equal(Object.hasOwn(stored.agents[BUILTIN], "piDistribution"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy external distribution is dropped without deleting a sibling Agent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-external-"));
  try {
    const file = writeConfig(root, {
      [BUILTIN]: { runtime: "pi", model: "default", piDistribution: "external" },
      [CODEX]: { runtime: "codex", model: "gpt-5.6-sol" },
    });
    const beforeCodex = JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")).agents[CODEX]);
    const loaded = configApi.loadConfig({ LARKIN_CONFIG_DIR: root });
    assert.equal(loaded.config.agents[BUILTIN].runtime, "pi");
    assert.equal(Object.hasOwn(loaded.config.agents[BUILTIN], "piDistribution"), false);
    assert.equal(JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")).agents[CODEX]), beforeCodex);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("owned provider symlink is refused and does not block startup", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-symlink-"));
  try {
    writeConfig(root, {
      [BUILTIN]: { runtime: "pi", model: "default", piDistribution: "builtin" },
    });
    const parent = path.join(root, "providers", "pi");
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-symlink-target-"));
    fs.writeFileSync(path.join(outside, "auth.json"), "{}\n", { mode: 0o600 });
    fs.symlinkSync(outside, path.join(parent, BUILTIN));
    const loaded = configApi.loadConfig({ LARKIN_CONFIG_DIR: root });
    assert.equal(loaded.config.agents[BUILTIN].runtime, "pi");
    assert.equal(fs.lstatSync(path.join(parent, BUILTIN)).isSymbolicLink(), true);
    fs.rmSync(outside, { recursive: true, force: true });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("migrated Agent signature changes so a running daemon can reload it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-signature-"));
  try {
    writeConfig(root, {
      [BUILTIN]: { runtime: "pi", model: "default", piDistribution: "builtin" },
      [CODEX]: { runtime: "codex", model: "gpt-5.6-sol" },
    });
    const after = configApi.loadConfig({ LARKIN_CONFIG_DIR: root }).config;
    assert.notEqual(configApi.runtimeConfigSignature(after, BUILTIN), legacyBuiltinSignature(after, BUILTIN));
    assert.equal(configApi.runtimeConfigSignature(after, BUILTIN), currentRuntimeSignature(after, BUILTIN));
    assert.equal(after.agents[CODEX].runtime, "codex");
    assert.equal(after.agents[CODEX].model, "gpt-5.6-sol");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("legacy-external sibling stays byte-identical when a builtin Agent is migrated", () => {
  const EXTERNAL = "cli_legacyExternalC3";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-mixed-sibling-"));
  try {
    const file = writeConfig(root, {
      [BUILTIN]: { runtime: "pi", model: "default", piDistribution: "builtin" },
      [EXTERNAL]: { runtime: "pi", model: "default", piDistribution: "external", createdAt: "2026-07-01T00:00:00.000Z" },
    });
    const beforeExternal = JSON.stringify(JSON.parse(fs.readFileSync(file, "utf8")).agents[EXTERNAL]);
    const loaded = configApi.loadConfig({ LARKIN_CONFIG_DIR: root, HOME: path.join(root, "home") });
    const stored = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(JSON.stringify(stored.agents[EXTERNAL]), beforeExternal);
    assert.equal(stored.agents[EXTERNAL].piDistribution, "external");
    assert.equal(Object.hasOwn(stored.agents[BUILTIN], "piDistribution"), false);
    assert.equal(Object.hasOwn(loaded.config.agents[EXTERNAL], "piDistribution"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("LARKIN_CONFIG_DIR=$HOME/.pi refuses to delete owned Pi directories", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-user-home-"));
  try {
    const userPi = path.join(home, ".pi");
    fs.mkdirSync(userPi, { recursive: true, mode: 0o700 });
    const file = writeConfig(userPi, {
      [BUILTIN]: { runtime: "pi", model: "default", piDistribution: "builtin" },
    });
    const owned = seedOwnedDir(userPi, BUILTIN);
    const marker = path.join(owned, "auth.json");
    const before = fs.readFileSync(marker);
    configApi.loadConfig({ HOME: home, LARKIN_CONFIG_DIR: userPi });
    assert.equal(fs.existsSync(owned), true);
    assert.deepEqual(fs.readFileSync(marker), before);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).agents[BUILTIN].runtime, "pi");
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(file, "utf8")).agents[BUILTIN], "piDistribution"), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("absent providers/pi parent is a silent no-op during builtin migration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-absent-parent-"));
  const writes = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, encoding, callback) => {
    writes.push(String(chunk));
    return original(chunk, encoding, callback);
  };
  try {
    writeConfig(root, {
      [BUILTIN]: { runtime: "pi", model: "default", piDistribution: "builtin" },
    });
    configApi.loadConfig({ LARKIN_CONFIG_DIR: root, HOME: path.join(root, "home") });
    assert.equal(writes.some((line) => line.includes("failed to delete leftover")), false);
    assert.equal(fs.existsSync(path.join(root, "providers", "pi")), false);
  } finally {
    process.stderr.write = original;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
