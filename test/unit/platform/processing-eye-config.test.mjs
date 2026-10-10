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

function fixture(extra = {}) {
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
    ...extra,
  }, null, 2)}\n`, { mode: 0o600 });
  return { root, env: { LARKIN_CONFIG_DIR: root } };
}

test("leftover processingEye keys are ignored and dropped on the next write", () => {
  const { root, env } = fixture({
    processingEye: { enabled: false },
    agents: {
      [APP]: { runtime: "codex", model: "gpt-5.6-sol", processingEye: { enabled: true } },
      [OTHER]: { runtime: "claude", model: "sonnet" },
    },
  });
  try {
    const { config } = configApi.loadConfig(env);
    assert.equal(config.processingEye, undefined);
    assert.equal("processingEye" in config.agents[APP], false);
    const view = configApi.safeConfigView(config, APP);
    assert.equal("processingEye" in view, false);
    assert.equal("processingEye" in view.agents[0], false);
    assert.equal(typeof configApi.resolveProcessingEye, "undefined");
    assert.equal(typeof configApi.processingEyeMutationFromCli, "undefined");

    configApi.mutateConfig(env, { kind: "set-global-mention", value: "free" }, { kind: "user" });
    const stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.equal("processingEye" in stored, false);
    assert.equal("processingEye" in stored.agents[APP], false);
    assert.equal(stored.mentionPolicy, "free");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("larkin config processing-eye is removed from the CLI surface", () => {
  const { root, env } = fixture();
  try {
    const help = spawnSync(process.execPath, [CLI_ENTRY, "help", "config"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.doesNotMatch(help.stdout, /processing-eye/);
    const spawnEnv = { ...process.env, ...env };
    delete spawnEnv.LARKIN_AGENT_ID;
    const rejected = spawnSync(process.execPath, [CONFIG_ENTRY, "config", "processing-eye", "global", "on"], {
      encoding: "utf8", env: spawnEnv,
    });
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /只支持|不支持|用法/);
    const stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.equal("processingEye" in stored, false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
