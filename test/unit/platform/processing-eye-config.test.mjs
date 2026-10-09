import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const configApi = require("../../../dist/platform/config.cjs");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CONFIG_ENTRY = path.join(ROOT, "dist", "app", "agent-config.mjs");
const CLI_ENTRY = path.join(ROOT, "dist", "app", "cli.mjs");
const APP = "cli_processingEyeA1";
const OTHER = "cli_processingEyeB2";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-processing-eye-config-"));
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4,
    serverId: "server-processing-eye",
    mentionPolicy: "require",
    activeAgent: APP,
    agents: {
      [APP]: { runtime: "codex", model: "gpt-5.6-sol" },
      [OTHER]: { runtime: "claude", model: "sonnet" },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return { root, env: { LARKIN_CONFIG_DIR: root } };
}

test("processing eye defaults off when the key is omitted", () => {
  const { root, env } = fixture();
  try {
    const { config } = configApi.loadConfig(env);
    assert.equal(config.processingEye, undefined);
    assert.deepEqual(configApi.resolveProcessingEye(config, APP), {
      enabled: false,
      enabledSource: "default",
    });
    const view = configApi.safeConfigView(config, APP);
    assert.equal(view.processingEye.enabled, false);
    assert.equal(view.agents[0].processingEye.override.enabled, "inherit");
    assert.equal(view.agents[0].processingEye.effective.enabled, false);
    assert.equal(view.agents[0].processingEye.source.enabled, "default");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("explicit global and agent processing-eye overrides persist without a migration prompt", () => {
  const { root, env } = fixture();
  try {
    configApi.mutateConfig(env, configApi.processingEyeMutationFromCli({
      scope: "global", enabled: "on", agentId: APP,
    }), { kind: "user" });
    let stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.deepEqual(stored.processingEye, { enabled: true });
    assert.equal("processingEye" in stored.agents[APP], false);

    configApi.mutateConfig(env, configApi.processingEyeMutationFromCli({
      scope: "agent", enabled: "off", agentId: APP,
    }), { kind: "user" });
    const after = configApi.loadConfig(env).config;
    assert.deepEqual(configApi.resolveProcessingEye(after, APP), {
      enabled: false, enabledSource: "agent",
    });
    assert.deepEqual(configApi.resolveProcessingEye(after, OTHER), {
      enabled: true, enabledSource: "global",
    });

    configApi.mutateConfig(env, configApi.processingEyeMutationFromCli({
      scope: "agent", enabled: "inherit", agentId: APP,
    }), { kind: "user" });
    stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.equal("processingEye" in stored.agents[APP], false);
    assert.throws(() => configApi.processingEyeMutationFromCli({
      scope: "global", enabled: "inherit", agentId: APP,
    }), /on\|off/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("larkin config processing-eye CLI persists the opt-in without editing config.json by hand", () => {
  const { root, env } = fixture();
  try {
    const help = spawnSync(process.execPath, [CLI_ENTRY, "help", "config"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /config processing-eye global/);
    assert.match(help.stdout, /config processing-eye agent/);
    const run = (...args) => {
      const spawnEnv = { ...process.env, ...env };
      delete spawnEnv.LARKIN_AGENT_ID;
      return spawnSync(process.execPath, [CONFIG_ENTRY, "config", ...args], { encoding: "utf8", env: spawnEnv });
    };
    const enabled = run("processing-eye", "global", "on");
    assert.equal(enabled.status, 0, enabled.stderr);
    const stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.deepEqual(stored.processingEye, { enabled: true });
    const agentOff = run("processing-eye", "agent", "off", "--agent", APP);
    assert.equal(agentOff.status, 0, agentOff.stderr);
    const after = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.deepEqual(after.agents[APP].processingEye, { enabled: false });
    assert.equal("processingEye" in after.agents[OTHER], false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
