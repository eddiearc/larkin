import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { InteractionStateMachine } from "../../../dist/agent/interaction-state-machine.mjs";

const configFor = (root, id, secret = `${id}-secret`) => ({
  agentId: id, name: id, runtime: "codex", model: "gpt-5.6", feishuAppId: id,
  feishuAppSecret: secret, feishuProfile: id, feishuDomain: "https://open.feishu.cn",
  larkConfigDir: path.join(root, "lark-cli-config"), workspaceDir: path.join(root, "agents", id),
  stateDir: path.join(root, "state", "agents", id),
});

const interactionDefinition = {
  schema_version: 1, initial_state: "pending", expires_in_seconds: 3600,
  audience: { open_ids: ["ou_clicker"] },
  states: {
    pending: { title: "Action", markdown: "Ready." },
    processing: { title: "Processing", markdown: "Working." },
    done: { title: "Done", markdown: "Done.", terminal: true },
    failed: { title: "Failed", markdown: "Failed.", terminal: true },
  },
  actions: { act: { from: ["pending"], label: "Run", success_state: "done", failure_state: "failed", processing_state: "processing",
    agent: { instruction: "Finish." }, reflex: { toast: "Accepted." }, result_schema: { properties: {}, required: [], additional_properties: false } } },
};

function cardEvent(root, agentId, eventId) {
  const store = createAgentStateStore(root, agentId);
  const machine = new InteractionStateMachine({ stateStore: store, agentId });
  const created = machine.create({ definition: interactionDefinition, expected_chat_id: "oc_hot" });
  const button = created.card.body.elements.find((item) => item.tag === "button");
  const value = button.behaviors.find((behavior) => behavior.type === "callback").value;
  return {
    event_id: eventId,
    context: { open_message_id: `om_${eventId}`, open_chat_id: "oc_hot" },
    operator: { open_id: "ou_clicker" },
    action: { tag: "button", value },
  };
}

test("HostShell hot attach adds only the target Agent and duplicate upsert is idempotent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-hot-attach-"));
  fs.chmodSync(root, 0o700);
  const existing = configFor(root, "cli_existingA1");
  const added = configFor(root, "cli_addedB2");
  const starts = [];
  const stops = [];
  const subscribers = [];
  const runtimeHost = {
    async start(configs) { starts.push(configs.map(({ agentId }) => agentId)); for (const config of configs) for (const listener of subscribers) listener({ type: "agent-status", agentId: config.agentId, status: "active" }); },
    async stop(agentId) { stops.push(agentId); },
    async shutdown() {}, async deliver() { return { status: "accepted", deliveryId: "delivery" }; },
    subscribe(listener) { subscribers.push(listener); return () => {}; },
    isBusy(agentId) { return agentId === existing.agentId; },
  };
  const channels = new Map();
  const channelPackage = {
    createLarkChannel(options) {
      const channel = {
        options, handlers: null, disconnected: 0, registrations: {}, cardUpdates: [],
        botIdentity: { openId: `ou_${options.appId}`, name: options.appId },
        rawClient: { async request() { return { bot: { open_id: `ou_${options.appId}`, app_name: options.appId } }; } },
        dispatcher: { register: (map) => Object.assign(channel.registrations, map) }, on(handlers) { this.handlers = handlers; },
        async connect() {}, async disconnect() { this.disconnected += 1; }, async updateCard(messageId, card) { this.cardUpdates.push({ messageId, card }); },
      };
      channels.set(options.appId, channel);
      return channel;
    },
  };
  const env = { ...process.env, LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-hot-attach",
    LARKIN_AGENTS_CONFIG: JSON.stringify([existing]), LARKIN_INBOUND_DROUGHT_SEC: "0" };
  const shell = createHostShell({ env, runtimeHost, channelPackage, eventSourceStartDelayMs: 0 });
  try {
    shell.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await assert.rejects(shell.upsertAgent({ ...existing, model: "gpt-5.6-busy-update" }), /正在执行 turn|idle/);
    assert.deepEqual(stops, [], "busy apply refusal must not stop the active Runtime");
    assert.equal(await shell.upsertAgent(added), "added");
    assert.deepEqual(shell.agents.map(({ agentId }) => agentId), ["cli_existingA1", "cli_addedB2"]);
    assert.deepEqual(starts, [["cli_existingA1"], ["cli_addedB2"]]);
    assert.deepEqual(stops, [], "new attach must not stop the existing Agent Runtime");
    assert.equal(channels.get("cli_existingA1").disconnected, 0, "existing channel must stay connected");
    const addedChannel = channels.get("cli_addedB2");
    assert.equal(typeof addedChannel.registrations["card.action.trigger"], "function", "hot add must register card callbacks");
    const addedResponse = await addedChannel.registrations["card.action.trigger"](cardEvent(root, added.agentId, "evt_hot_add"));
    assert.match(JSON.stringify(addedResponse), /Agent 正在处理/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(addedChannel.cardUpdates.length, 1, "hot-added Agent must project its card through the new channel");
    assert.equal(await shell.upsertAgent(added), "unchanged");
    assert.deepEqual(starts, [["cli_existingA1"], ["cli_addedB2"]], "duplicate operation must not create a second Runtime");
  } finally {
    await shell.shutdown("test");
    assert.equal([...channels.values()].every((channel) => channel.disconnected === 1), true, "shutdown must close initial and hot-added channels once");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HostShell hot update switches card projection only after the old channel disconnects", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-hot-update-card-"));
  fs.chmodSync(root, 0o700);
  const target = configFor(root, "cli_updateCardA1");
  const candidate = { ...target, model: "gpt-5.6-updated", feishuAppSecret: "updated-secret" };
  const subscribers = [];
  const runtimeHost = {
    async start(configs) { for (const config of configs) for (const listener of subscribers) listener({ type: "agent-status", agentId: config.agentId, status: "active" }); },
    async stop() {}, async shutdown() {}, async deliver() { return { status: "accepted", deliveryId: "delivery" }; },
    subscribe(listener) { subscribers.push(listener); return () => {}; },
  };
  const attempts = [];
  const channelPackage = { createLarkChannel(options) {
    const channel = {
      options, disconnected: 0, registrations: {}, cardUpdates: [], botIdentity: { openId: `ou_${options.appId}`, name: options.appId },
      rawClient: { async request() { return { bot: { open_id: `ou_${options.appId}`, app_name: options.appId } }; } },
      dispatcher: { register: (map) => Object.assign(channel.registrations, map) }, on() {}, async connect() {},
      async disconnect() { this.disconnected += 1; }, async updateCard(messageId, card) { this.cardUpdates.push({ messageId, card }); },
    };
    attempts.push(channel); return channel;
  } };
  const shell = createHostShell({ env: { ...process.env, LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-hot-update-card",
    LARKIN_AGENTS_CONFIG: JSON.stringify([target]), LARKIN_INBOUND_DROUGHT_SEC: "0" }, runtimeHost, channelPackage, eventSourceStartDelayMs: 0 });
  try {
    shell.start(); await new Promise((resolve) => setTimeout(resolve, 30));
    const oldChannel = attempts[0];
    assert.equal(await shell.upsertAgent(candidate), "updated");
    const nextChannel = attempts[1];
    assert.equal(oldChannel.disconnected, 1);
    assert.equal(typeof nextChannel.registrations["card.action.trigger"], "function");
    const updateResponse = await nextChannel.registrations["card.action.trigger"](cardEvent(root, target.agentId, "evt_hot_update"));
    assert.match(JSON.stringify(updateResponse), /Agent 正在处理/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(oldChannel.cardUpdates.length, 0, "disconnected old channel must not receive projections");
    assert.equal(nextChannel.cardUpdates.length, 1, "committed candidate channel owns projections");
  } finally {
    await shell.shutdown("test");
    assert.equal(attempts.every((channel) => channel.disconnected === 1), true, "shutdown must close the committed candidate without re-closing old channel");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HostShell hot update failure rolls back only the target Agent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-hot-rollback-"));
  fs.chmodSync(root, 0o700);
  const target = configFor(root, "cli_targetA1");
  const unrelated = configFor(root, "cli_unrelatedB2");
  const candidate = { ...target, model: "gpt-5.6-updated", feishuAppSecret: "bad-secret" };
  const starts = [];
  const stops = [];
  const stages = [];
  const rollbacks = [];
  const subscribers = [];
  const runtimeHost = {
    async start(configs) { starts.push(configs.map(({ agentId, model }) => `${agentId}:${model}`)); for (const config of configs) for (const listener of subscribers) listener({ type: "agent-status", agentId: config.agentId, status: "active" }); },
    async stop(agentId) { stops.push(agentId); },
    async stage(config) {
      stages.push(`${config.agentId}:${config.model}`);
      return { readiness: { runtime: config.runtime, state: "ready" },
        async commit() { throw new Error("failed candidate must not commit"); },
        async rollback(reason) { rollbacks.push(reason); } };
    },
    async shutdown() {}, async deliver() { return { status: "accepted", deliveryId: "delivery" }; },
    subscribe(listener) { subscribers.push(listener); return () => {}; },
  };
  const channelAttempts = [];
  const channelPackage = {
    createLarkChannel(options) {
      const channel = {
        options, disconnected: 0, registrations: {}, cardUpdates: [],
        botIdentity: { openId: `ou_${options.appId}`, name: options.appId },
        rawClient: { async request() { return { bot: { open_id: `ou_${options.appId}`, app_name: options.appId } }; } },
        dispatcher: { register: (map) => Object.assign(channel.registrations, map) }, on() {},
        async connect() { if (options.appSecret === "bad-secret") throw new Error("invalid secret"); },
        async disconnect() { this.disconnected += 1; },
        async updateCard(messageId, card) { this.cardUpdates.push({ messageId, card }); },
      };
      channelAttempts.push(channel);
      return channel;
    },
  };
  const env = { ...process.env, LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-hot-rollback",
    LARKIN_AGENTS_CONFIG: JSON.stringify([target, unrelated]), LARKIN_INBOUND_DROUGHT_SEC: "0" };
  const shell = createHostShell({ env, runtimeHost, channelPackage, eventSourceStartDelayMs: 0 });
  try {
    shell.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await assert.rejects(shell.upsertAgent(candidate), /invalid secret/);
    assert.deepEqual(shell.agents.map(({ agentId, model }) => `${agentId}:${model}`), [
      "cli_targetA1:gpt-5.6", "cli_unrelatedB2:gpt-5.6",
    ]);
    assert.deepEqual(stops, [], "failed candidate must not stop the old healthy Runtime");
    assert.deepEqual(starts, [["cli_targetA1:gpt-5.6", "cli_unrelatedB2:gpt-5.6"]]);
    assert.deepEqual(stages, ["cli_targetA1:gpt-5.6-updated"]);
    assert.deepEqual(rollbacks, ["hot attach channel rollback"]);
    assert.equal(channelAttempts[0].disconnected, 0, "old target channel stays connected during rollback");
    assert.equal(channelAttempts[1].disconnected, 0, "unrelated channel must stay connected");
    assert.equal(channelAttempts[2].disconnected, 1, "failed candidate channel must be cleaned up");
    const rollbackResponse = await channelAttempts[0].registrations["card.action.trigger"](cardEvent(root, target.agentId, "evt_hot_rollback"));
    assert.match(JSON.stringify(rollbackResponse), /Agent 正在处理/);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(channelAttempts[0].cardUpdates.length, 1, "rollback must retain the old target channel mapping");
    assert.equal(channelAttempts[2].cardUpdates.length, 0, "failed candidate must never receive card projections");
  } finally {
    await shell.shutdown("test");
    assert.equal(channelAttempts.every((channel) => channel.disconnected === 1), true, "rollback shutdown must close old/unrelated channels and not re-close failed candidate");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
