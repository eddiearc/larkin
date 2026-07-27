import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { loadAndSyncRuntimeAgent } from "../../../dist/app/runtime-process.mjs";

process.env.LARKIN_BUN_TEST_RUNNER = "1";

test("runtime-process profile seam restores only the target after init succeeds and verify fails", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-profile-rollback-"));
  fs.chmodSync(root, 0o700);
  const target = "cli_targetProfileA1";
  const other = "cli_otherProfileB2";
  const profileDir = path.join(root, "lark-cli-config");
  const botsDir = path.join(root, "bots");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(profileDir, { mode: 0o700 });
  fs.mkdirSync(botsDir, { mode: 0o700 });
  fs.mkdirSync(binDir, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 3, serverId: "server-profile-rollback", activeAgent: target,
    agents: { [target]: { runtime: "codex", model: "gpt" }, [other]: { runtime: "codex", model: "gpt" } },
  }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(botsDir, `${target}.json`), JSON.stringify({
    appId: target, appSecret: "new-target-secret", tenant: "feishu",
  }), { mode: 0o600 });
  const priorTarget = { appId: target, appSecret: "known-good-target", brand: "feishu", marker: "target-before" };
  const priorOther = { appId: other, appSecret: "other-secret", brand: "lark", marker: "other-before" };
  const unrelated = { feature: "preserve-me" };
  const profileFile = path.join(profileDir, "config.json");
  fs.writeFileSync(profileFile, `${JSON.stringify({ apps: [priorTarget, priorOther], unrelated }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(binDir, "lark-cli"), `#!/usr/bin/env bun
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), file = path.join(process.env.LARKSUITE_CLI_CONFIG_DIR, "config.json");
if (args[0] === "config" && args[1] === "init") {
  const appId = args[args.indexOf("--app-id") + 1];
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.apps = value.apps.filter((entry) => entry.appId !== appId);
  value.apps.push({ appId, appSecret: "broken-new-target", brand: "feishu", marker: "mutated" });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\\n", { mode: 0o600 });
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: false, identity: "bot" }) + "\\n");
process.exit(1);
`, { mode: 0o755 });
  try {
    assert.throws(() => loadAndSyncRuntimeAgent({
      ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_HOME: root,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    }, target), /verify failed.*恢复此前 target profile/);
    const restored = JSON.parse(fs.readFileSync(profileFile, "utf8"));
    assert.deepEqual(restored.unrelated, unrelated);
    assert.deepEqual(restored.apps.find((entry) => entry.appId === target), priorTarget);
    assert.deepEqual(restored.apps.find((entry) => entry.appId === other), priorOther);
    assert.equal(fs.existsSync(path.join(profileDir, ".larkin-profile-sync.lock.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("runtime-process profile seam restores target after config init partially writes then exits nonzero", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-profile-partial-"));
  fs.chmodSync(root, 0o700);
  const target = "cli_partialTargetA1";
  const other = "cli_partialOtherB2";
  const profileDir = path.join(root, "lark-cli-config");
  const botsDir = path.join(root, "bots");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(profileDir, { mode: 0o700 });
  fs.mkdirSync(botsDir, { mode: 0o700 });
  fs.mkdirSync(binDir, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    version: 3, serverId: "server-profile-partial", activeAgent: target,
    agents: { [target]: { runtime: "codex", model: "gpt" }, [other]: { runtime: "codex", model: "gpt" } },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(botsDir, `${target}.json`), JSON.stringify({
    appId: target, appSecret: "new-target-secret", tenant: "feishu",
  }), { mode: 0o600 });
  const priorTarget = { appId: target, appSecret: "known-good", marker: "target-before" };
  const priorOther = { appId: other, appSecret: "other-secret", marker: "other-before" };
  const profileFile = path.join(profileDir, "config.json");
  fs.writeFileSync(profileFile, JSON.stringify({ apps: [priorTarget, priorOther], settings: { keep: true } }), { mode: 0o600 });
  fs.writeFileSync(path.join(binDir, "lark-cli"), `#!/usr/bin/env bun
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), file = path.join(process.env.LARKSUITE_CLI_CONFIG_DIR, "config.json");
if (args[0] === "config" && args[1] === "init") {
  const appId = args[args.indexOf("--app-id") + 1], value = JSON.parse(fs.readFileSync(file, "utf8"));
  value.apps = value.apps.filter((entry) => entry.appId !== appId);
  value.apps.push({ appId, appSecret: "partial-broken", marker: "partial-write" });
  value.settings.concurrentUnrelated = "preserve-current";
  fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  process.exit(1);
}
process.exit(99);
`, { mode: 0o755 });
  try {
    assert.throws(() => loadAndSyncRuntimeAgent({
      ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_HOME: root,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    }, target), /sync failed.*恢复此前 target profile/);
    const restored = JSON.parse(fs.readFileSync(profileFile, "utf8"));
    assert.deepEqual(restored.apps.find((entry) => entry.appId === target), priorTarget);
    assert.deepEqual(restored.apps.find((entry) => entry.appId === other), priorOther);
    assert.deepEqual(restored.settings, { keep: true, concurrentUnrelated: "preserve-current" });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const mode of ["sync-truncated", "sync-malformed", "verify-truncated"]) {
  test(`runtime-process restores exact prior profile bytes after ${mode}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-profile-${mode}-`));
    fs.chmodSync(root, 0o700);
    const target = "cli_corruptTargetA1";
    const other = "cli_corruptOtherB2";
    const profileDir = path.join(root, "lark-cli-config");
    const botsDir = path.join(root, "bots");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(profileDir, { mode: 0o700 });
    fs.mkdirSync(botsDir, { mode: 0o700 });
    fs.mkdirSync(binDir, { mode: 0o700 });
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
      version: 3, serverId: "server-profile-corrupt", activeAgent: target,
      agents: { [target]: { runtime: "codex", model: "gpt" }, [other]: { runtime: "codex", model: "gpt" } },
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(botsDir, `${target}.json`), JSON.stringify({
      appId: target, appSecret: "new-target-secret", tenant: "feishu",
    }), { mode: 0o600 });
    const profileFile = path.join(profileDir, "config.json");
    const priorBytes = Buffer.from(`{\n  "unrelated": { "exactSpacing": true },\n  "apps": [\n    {"appId":"${target}","marker":"target-before"},\n    {"appId":"${other}","marker":"other-before"}\n  ]\n}\n`);
    fs.writeFileSync(profileFile, priorBytes, { mode: 0o600 });
    fs.writeFileSync(path.join(binDir, "lark-cli"), `#!/usr/bin/env bun
const fs = require("node:fs"), path = require("node:path");
const args = process.argv.slice(2), file = path.join(process.env.LARKSUITE_CLI_CONFIG_DIR, "config.json");
const mode = ${JSON.stringify(mode)};
if (args[0] === "config" && args[1] === "init") {
  if (mode === "sync-truncated") fs.writeFileSync(file, '{"apps":[');
  else if (mode === "sync-malformed") fs.writeFileSync(file, JSON.stringify({apps:"not-an-array",mutated:true}));
  process.exit(mode === "verify-truncated" ? 0 : 1);
}
if (mode === "verify-truncated") fs.writeFileSync(file, '{"apps":[');
process.stdout.write(JSON.stringify({ok:false,identity:"bot"}) + "\\n");
process.exit(1);
`, { mode: 0o755 });
    try {
      assert.throws(() => loadAndSyncRuntimeAgent({
        ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_HOME: root,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      }, target), /(sync|verify) failed.*恢复此前 target profile/);
      assert.deepEqual(fs.readFileSync(profileFile), priorBytes, "corrupt current file must restore exact pre-mutation bytes");
      assert.equal(fs.existsSync(path.join(profileDir, ".larkin-profile-sync.lock.json")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("invalid prior profile fails before lark-cli mutation and releases the profile lock", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-profile-invalid-before-"));
  fs.chmodSync(root, 0o700);
  const target = "cli_invalidBeforeA1";
  const profileDir = path.join(root, "lark-cli-config");
  const botsDir = path.join(root, "bots");
  const binDir = path.join(root, "bin");
  fs.mkdirSync(profileDir, { mode: 0o700 });
  fs.mkdirSync(botsDir, { mode: 0o700 });
  fs.mkdirSync(binDir, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    version: 3, serverId: "server-invalid-before", activeAgent: target,
    agents: { [target]: { runtime: "codex", model: "gpt" } },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(botsDir, `${target}.json`), JSON.stringify({
    appId: target, appSecret: "secret", tenant: "feishu",
  }), { mode: 0o600 });
  const profileFile = path.join(profileDir, "config.json");
  const invalidBefore = Buffer.from('{"apps":[');
  fs.writeFileSync(profileFile, invalidBefore, { mode: 0o600 });
  const marker = path.join(root, "lark-called");
  fs.writeFileSync(path.join(binDir, "lark-cli"), `#!/usr/bin/env bun
require("node:fs").writeFileSync(${JSON.stringify(marker)}, "called");
`, { mode: 0o755 });
  try {
    assert.throws(() => loadAndSyncRuntimeAgent({
      ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_HOME: root,
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    }, target), /JSON|Unexpected|position|end/i);
    assert.equal(fs.existsSync(marker), false, "invalid prior bytes must fail before invoking lark-cli");
    assert.deepEqual(fs.readFileSync(profileFile), invalidBefore);
    assert.equal(fs.existsSync(path.join(profileDir, ".larkin-profile-sync.lock.json")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const nonempty of [false, true]) {
  test(`profile rollback ${nonempty ? "fails closed and preserves recovery bytes for a nonempty" : "replaces an owned empty"} config directory`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-profile-directory-${nonempty ? "nonempty" : "empty"}-`));
    fs.chmodSync(root, 0o700);
    const target = "cli_directoryTargetA1";
    const profileDir = path.join(root, "lark-cli-config");
    const botsDir = path.join(root, "bots");
    const binDir = path.join(root, "bin");
    fs.mkdirSync(profileDir, { mode: 0o700 });
    fs.mkdirSync(botsDir, { mode: 0o700 });
    fs.mkdirSync(binDir, { mode: 0o700 });
    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
      version: 3, serverId: "server-profile-directory", activeAgent: target,
      agents: { [target]: { runtime: "codex", model: "gpt" } },
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(botsDir, `${target}.json`), JSON.stringify({
      appId: target, appSecret: "secret", tenant: "feishu",
    }), { mode: 0o600 });
    const profileFile = path.join(profileDir, "config.json");
    const before = Buffer.from(`{\n "apps": [{"appId":"${target}","marker":"exact-before"}],\n "keep": true\n}\n`);
    fs.writeFileSync(profileFile, before, { mode: 0o600 });
    fs.writeFileSync(path.join(binDir, "lark-cli"), `#!/usr/bin/env bun
const fs = require("node:fs"), path = require("node:path");
const file = path.join(process.env.LARKSUITE_CLI_CONFIG_DIR, "config.json");
fs.unlinkSync(file);
fs.mkdirSync(file);
${nonempty ? 'fs.writeFileSync(path.join(file, "owner-data"), "do-not-delete");' : ""}
process.exit(1);
`, { mode: 0o755 });
    try {
      const invoke = () => loadAndSyncRuntimeAgent({
        ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_HOME: root,
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
      }, target);
      if (!nonempty) {
        assert.throws(invoke, /sync failed.*恢复此前 target profile/);
        assert.deepEqual(fs.readFileSync(profileFile), before);
        assert.equal(fs.readdirSync(profileDir).some((name) => name.includes("rollback-recovery")), false);
      } else {
        assert.throws(invoke, /profile 恢复失败.*非空目录.*原始恢复快照保留/);
        assert.equal(fs.readFileSync(path.join(profileFile, "owner-data"), "utf8"), "do-not-delete");
        const recovery = fs.readdirSync(profileDir).filter((name) => name.includes("rollback-recovery"));
        assert.equal(recovery.length, 1);
        const recoveryFile = path.join(profileDir, recovery[0]);
        assert.deepEqual(fs.readFileSync(recoveryFile), before);
        assert.equal(fs.lstatSync(recoveryFile).mode & 0o077, 0);
      }
      assert.equal(fs.existsSync(path.join(profileDir, ".larkin-profile-sync.lock.json")), false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
