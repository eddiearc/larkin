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
const APP = "cli_inboxAuditA1";
const OTHER = "cli_inboxAuditB2";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-config-"));
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4,
    serverId: "server-inbox-audit",
    mentionPolicy: "require",
    activeAgent: APP,
    agents: {
      [APP]: { runtime: "codex", model: "gpt-5.6-sol" },
      [OTHER]: { runtime: "claude", model: "sonnet" },
    },
  }, null, 2)}\n`, { mode: 0o600 });
  return { root, env: { LARKIN_CONFIG_DIR: root } };
}

test("inbox audit defaults off and inherits global cadence until an Agent override", () => {
  const { root, env } = fixture();
  try {
    const { config } = configApi.loadConfig(env);
    assert.equal(config.inboxAudit, undefined);
    assert.deepEqual(configApi.resolveInboxAuditSchedule(config, APP), {
      enabled: false,
      intervalMs: configApi.DEFAULT_INBOX_AUDIT_INTERVAL_MS,
      enabledSource: "default",
      intervalSource: "default",
    });
    const view = configApi.safeConfigView(config, APP);
    assert.equal(view.inboxAudit.enabled, false);
    assert.equal(view.inboxAudit.intervalMs, configApi.DEFAULT_INBOX_AUDIT_INTERVAL_MS);
    assert.equal(view.agents[0].inboxAudit.override.enabled, "inherit");
    assert.equal(view.agents[0].inboxAudit.effective.enabled, false);

    configApi.mutateConfig(env, configApi.inboxAuditMutationFromCli({
      scope: "global", enabled: "on", interval: "30m", agentId: APP,
    }), { kind: "user" });
    let stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.deepEqual(stored.inboxAudit, { enabled: true, intervalMs: 30 * 60_000 });
    assert.equal("inboxAudit" in stored.agents[APP], false);

    configApi.mutateConfig(env, configApi.inboxAuditMutationFromCli({
      scope: "agent", enabled: "off", interval: "1h", agentId: APP,
    }), { kind: "user" });
    const after = configApi.loadConfig(env).config;
    assert.deepEqual(configApi.resolveInboxAuditSchedule(after, APP), {
      enabled: false, intervalMs: 60 * 60_000, enabledSource: "agent", intervalSource: "agent",
    });
    assert.deepEqual(configApi.resolveInboxAuditSchedule(after, OTHER), {
      enabled: true, intervalMs: 30 * 60_000, enabledSource: "global", intervalSource: "global",
    });

    configApi.mutateConfig(env, configApi.inboxAuditMutationFromCli({
      scope: "agent", enabled: "inherit", interval: "inherit", agentId: APP,
    }), { kind: "user" });
    stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.equal("inboxAudit" in stored.agents[APP], false);
    assert.equal(configApi.parseInboxAuditInterval("15m"), configApi.DEFAULT_INBOX_AUDIT_INTERVAL_MS);
    assert.throws(() => configApi.parseInboxAuditInterval("1s"), /15m\/1h|毫秒/);
    assert.throws(() => configApi.inboxAuditMutationFromCli({
      scope: "global", enabled: "on", interval: "inherit", agentId: APP,
    }), /不支持 interval=inherit/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("larkin config inbox-audit CLI persists per-Agent cadence without editing config.json by hand", () => {
  const { root, env } = fixture();
  try {
    const help = spawnSync(process.execPath, [CLI_ENTRY, "help", "config"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /config inbox-audit global/);
    assert.match(help.stdout, /config inbox-audit agent/);
    assert.match(help.stdout, /--interval/);
    const run = (...args) => {
      const spawnEnv = { ...process.env, ...env };
      delete spawnEnv.LARKIN_AGENT_ID;
      return spawnSync(process.execPath, [CONFIG_ENTRY, "config", ...args], { encoding: "utf8", env: spawnEnv });
    };
    const enabled = run("inbox-audit", "global", "on", "--interval", "15m");
    assert.equal(enabled.status, 0, enabled.stderr);
    const stored = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.deepEqual(stored.inboxAudit, { enabled: true, intervalMs: 15 * 60_000 });
    const agentOff = run("inbox-audit", "agent", "off", "--agent", APP, "--interval", "1h");
    assert.equal(agentOff.status, 0, agentOff.stderr);
    const after = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
    assert.deepEqual(after.agents[APP].inboxAudit, { enabled: false, intervalMs: 60 * 60_000 });
    assert.equal("inboxAudit" in after.agents[OTHER], false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
