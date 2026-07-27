import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { defaultModelFor, normalizeConfig, resolveConfigDir, selectAgent, toStored } = require("../../../dist/platform/config.cjs");
const APP = "cli_a1B2c3";
const OTHER = "cli_d4E5f6";

function rawConfig(overrides = {}) {
  return {
    version: 3,
    serverId: "server-v3",
    activeAgent: APP,
    agents: {
      [APP]: {
        runtime: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        noMentionChats: ["oc_keep"],
        createdAt: "2026-07-15T00:00:00.000Z",
      },
    },
    ...overrides,
  };
}

test("fresh schema v4 runtime view has one exact derived root and exact stored schema", () => {
  const root = path.join(os.tmpdir(), "larkin-config-v3-fresh");
  assert.equal(resolveConfigDir({ LARKIN_CONFIG_DIR: root }), root);
  const fresh = normalizeConfig(null, root, { mint: () => "server-v3" });
  assert.deepEqual(fresh, {
    version: 4,
    serverId: "server-v3",
    mentionPolicy: "require",
    configDir: root,
    larkinHome: root,
    larkConfigDir: path.join(root, "lark-cli-config"),
    activeAgent: null,
    agents: {},
  });
  assert.deepEqual(toStored(fresh, root), {
    version: 4,
    serverId: "server-v3",
    mentionPolicy: "require",
    activeAgent: null,
    agents: {},
  });
});

test("schema v3 runtime agent migrates to an exact v4 App-ID-derived view", () => {
  const root = path.join(os.tmpdir(), "larkin-config-v3-derived");
  const config = normalizeConfig(rawConfig(), root);
  assert.deepEqual(config, {
    version: 4,
    serverId: "server-v3",
    mentionPolicy: "require",
    configDir: root,
    larkinHome: root,
    larkConfigDir: path.join(root, "lark-cli-config"),
    activeAgent: APP,
    agents: {
      [APP]: {
        name: APP,
        agentId: APP,
        feishuAppId: APP,
        feishuProfile: APP,
        runtime: "codex",
        model: "gpt-5.6-sol",
        effort: "high",
        noMentionChats: ["oc_keep"],
        chatMentionPolicies: { oc_keep: "free" },
        createdAt: "2026-07-15T00:00:00.000Z",
        workspaceDir: path.join(root, "agents", APP),
        stateDir: path.join(root, "state", "agents", APP),
        larkConfigDir: path.join(root, "state", "agents", APP, "lark-cli-config"),
      },
    },
  });
});

test("stored v4 top-level and Agent objects use exact allowlists", () => {
  const root = path.join(os.tmpdir(), "larkin-config-v3-store");
  const config = normalizeConfig(rawConfig(), root);
  config.unknownRuntimeOnly = "must-strip";
  Object.assign(config.agents[APP], {
    unknownRuntimeOnly: true,
    defaultChatId: "oc_old",
  });
  assert.deepEqual(toStored(config, root), {
    version: 4, serverId: "server-v3", mentionPolicy: "require", activeAgent: APP,
    agents: { [APP]: { runtime: "codex", model: "gpt-5.6-sol", effort: "high", chatMentionPolicies: { oc_keep: "free" }, createdAt: "2026-07-15T00:00:00.000Z" } },
  });
  assert.deepEqual(Object.keys(toStored(config, root)).sort(), ["activeAgent", "agents", "mentionPolicy", "serverId", "version"]);
  assert.deepEqual(Object.keys(toStored(config, root).agents[APP]).sort(), ["chatMentionPolicies", "createdAt", "effort", "model", "runtime"]);
});

test("schema v3 rejects unknown, derived, legacy and path override fields", () => {
  const root = path.join(os.tmpdir(), "larkin-config-v3-fields");
  assert.doesNotThrow(() => normalizeConfig(rawConfig(), root), "valid v3 must be accepted before rejection cases are meaningful");
  const topFields = ["configDir", "larkinHome", "larkConfigDir", "slockHome", "unknown"];
  for (const field of topFields) {
    assert.throws(() => normalizeConfig(rawConfig({ [field]: root }), root), /field|字段|unknown|derived|派生|不支持/i, `top.${field}`);
  }
  const agentFields = ["name", "agentId", "feishuAppId", "feishuProfile", "workspaceDir", "stateDir", "larkConfigDir", "defaultChatId", "slockHome", "unknown"];
  for (const field of agentFields) {
    const raw = rawConfig();
    raw.agents[APP][field] = field.endsWith("Dir") ? root : "override";
    assert.throws(() => normalizeConfig(raw, root), /field|字段|unknown|derived|派生|不支持/i, `agent.${field}`);
  }
  assert.throws(() => normalizeConfig({ version: 2, agents: {} }, root), /version.?3|不支持/i);
  assert.throws(() => normalizeConfig({ feishuProfile: "flat" }, root), /version.?3|不支持/i);
});

test("schema v3 validates all container and scalar field types", () => {
  const root = path.join(os.tmpdir(), "larkin-config-v3-types");
  assert.doesNotThrow(() => normalizeConfig(rawConfig(), root), "valid v3 must be accepted before type rejection cases are meaningful");
  const nullProtoConfig = Object.assign(Object.create(null), rawConfig());
  const nullProtoAgents = Object.assign(Object.create(null), rawConfig().agents);
  const nullProtoAgent = Object.assign(Object.create(null), rawConfig().agents[APP]);
  const invalid = [
    [],
    nullProtoConfig,
    { ...rawConfig(), version: "3" },
    { ...rawConfig(), serverId: 3 },
    { ...rawConfig(), serverId: "" },
    { ...rawConfig(), activeAgent: 3 },
    { ...rawConfig(), agents: [] },
    { ...rawConfig(), agents: nullProtoAgents },
    { ...rawConfig(), agents: { [APP]: [] } },
    { ...rawConfig(), agents: { [APP]: nullProtoAgent } },
    { ...rawConfig(), agents: { [APP]: new Date() } },
  ];
  for (const raw of invalid) assert.throws(() => normalizeConfig(raw, root), /config|version|server|active|agents|object|类型|格式/i);
  for (const field of ["version", "serverId", "activeAgent", "agents"]) {
    const raw = rawConfig();
    delete raw[field];
    assert.throws(() => normalizeConfig(raw, root), /config|version|server|active|agents|required|缺少|格式/i, `missing ${field}`);
  }

  const wrongAgentValues = {
    runtime: [null, 1, ""],
    model: [null, 1, ""],
    effort: [null, 1, [], ""],
    noMentionChats: [null, "oc_keep", [1], [""]],
    createdAt: [null, 1, "not-a-date"],
  };
  for (const [field, values] of Object.entries(wrongAgentValues)) {
    for (const value of values) {
      const raw = rawConfig();
      raw.agents[APP][field] = value;
      assert.throws(() => normalizeConfig(raw, root), /runtime|model|effort|chat|created|type|类型|格式/i, `${field}=${JSON.stringify(value)}`);
    }
  }
});

test("minimal stored Agent is valid and an empty noMentionChats list is valid", () => {
  const root = path.join(os.tmpdir(), "larkin-config-v3-minimal");
  const minimal = {
    version: 3,
    serverId: "server-v3",
    activeAgent: APP,
    agents: { [APP]: { runtime: "codex", model: "gpt-target" } },
  };
  const config = normalizeConfig(minimal, root);
  assert.deepEqual(toStored(config, root), { ...minimal, version: 4, mentionPolicy: "require" });

  const withEmptyChats = structuredClone(minimal);
  withEmptyChats.agents[APP].noMentionChats = [];
  const hydrated = normalizeConfig(withEmptyChats, root);
  assert.deepEqual(hydrated.agents[APP].noMentionChats ?? [], []);
});

test("activeAgent is null or references an existing App-ID key", () => {
  const root = path.join(os.tmpdir(), "larkin-config-v3-active");
  const empty = normalizeConfig({ version: 3, serverId: "server-v3", activeAgent: null, agents: {} }, root);
  assert.equal(empty.activeAgent, null);
  assert.equal(normalizeConfig({ ...rawConfig(), activeAgent: null }, root).activeAgent, null);
  assert.throws(() => normalizeConfig(rawConfig({ activeAgent: OTHER }), root), /activeAgent|存在|agent/i);
});

test("Agent keys must be safe real Feishu App IDs and cannot escape a path segment", () => {
  const root = path.join(os.tmpdir(), "larkin-config-v3-app-id");
  assert.doesNotThrow(() => normalizeConfig(rawConfig(), root), "a real safe App ID must be accepted");
  for (const key of ["friendly", "cli_", "cli_a/b", "cli_a\\b", "../cli_a", "cli_../a", "/cli_a", "cli_a.b", "cli_a\0b", " cli_a"] ) {
    assert.throws(
      () => normalizeConfig({ version: 3, serverId: "server-v3", activeAgent: key, agents: { [key]: { runtime: "codex", model: "gpt" } } }, root),
      /App ID|agent|key|path|安全|格式/i,
      JSON.stringify(key),
    );
  }
});

test("selectAgent fails closed and only explicit ID or valid activeAgent can select", () => {
  const root = path.join(os.tmpdir(), "larkin-config-v3-select");
  const raw = rawConfig({
    agents: {
      ...rawConfig().agents,
      [OTHER]: { runtime: "claude", model: "sonnet" },
    },
  });
  const config = normalizeConfig(raw, root);
  assert.equal(selectAgent(config, { LARKIN_AGENT_ID: OTHER }), config.agents[OTHER]);
  assert.throws(() => selectAgent(config, { LARKIN_AGENT_ID: "cli_unknown" }), /Agent|unknown|不存在|未配置/i);
  assert.equal(
    selectAgent(config, { LARKIN_AGENT_NAME: OTHER, LARKIN_HOME: path.join(root, "agents", OTHER) }),
    config.agents[APP],
    "legacy selectors must not participate",
  );
  assert.throws(() => selectAgent({ ...config, activeAgent: null }, {}), /activeAgent|Agent|未配置/i);
  assert.throws(() => selectAgent({ ...config, activeAgent: "cli_missing" }, {}), /activeAgent|Agent|不存在/i);
});

test("authored runtime model catalog contains exactly the native adapters", () => {
  const catalog = require("../../../dist/platform/config.cjs").loadRuntimeModels();
  assert.deepEqual(Object.keys(catalog).sort(), ["claude", "codex", "pi"]);
  assert.equal(catalog.codex[0].id, "default");
  assert.equal(catalog.claude[0].id, "default");
  assert.equal(catalog.codex[0].label, "default");
  assert.equal(catalog.claude[0].label, "default");
  assert.ok(catalog.codex.slice(1).every((item) => item.verified === "authored-compatibility"), "Codex authored entries are explicitly a compatibility fallback, not the live catalog");
  assert.ok(catalog.claude.slice(1).every((item) => item.verified === "authored-candidate"), "Claude entries are explicitly authored candidates because Claude exposes no list command");
  assert.deepEqual(catalog.pi, [{ id: "default", label: "default", verified: "dynamic" }]);
  assert.throws(() => defaultModelFor("unknown-runtime"), /unknown-runtime|runtime|模型|目录|不存在/i);
});
