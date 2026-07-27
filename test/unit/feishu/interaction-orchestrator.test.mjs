import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const stateModule = await import(pathToFileURL(path.join(ROOT, "dist/agent/agent-state-store.mjs")).href);
const machineModule = await import(pathToFileURL(path.join(ROOT, "dist/agent/interaction-state-machine.mjs")).href);
const orchestratorModule = await import(pathToFileURL(path.join(ROOT, "dist/feishu/interaction-orchestrator.mjs")).href);
const runtimeModule = await import(pathToFileURL(path.join(ROOT, "dist/runtime/runtime-host.mjs")).href);
const promptModule = await import(pathToFileURL(path.join(ROOT, "dist/agent/context-prompt.mjs")).href);

function callbackValue(card, index = 0) {
  const button = card.body.elements.filter((item) => item.tag === "button")[index];
  return button.behaviors.find((behavior) => behavior.type === "callback").value;
}

function definition(effect) {
  return {
    schema_version: 1, initial_state: "pending", expires_in_seconds: 3600,
    audience: { open_ids: ["ou_clicker"] },
    states: {
      pending: { title: "Action", markdown: "Ready." },
      processing: { title: "Processing", markdown: "Agent is processing." },
      done: { title: "Done", markdown: "Done.", terminal: true },
      failed: { title: "Failed", markdown: "Failed.", terminal: true },
    },
    actions: {
      act: {
        from: ["pending"], label: "Run", success_state: "done", failure_state: "failed", processing_state: "processing",
        agent: { instruction: "Inspect the Reflex result and finish." },
        reflex: { toast: "Accepted. Agent is processing.", ...(effect ? { effect } : {}) },
        result_schema: { properties: {}, required: [], additional_properties: false },
      },
    },
  };
}

function fixture(effect) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-interaction-host-"));
  const agent = { agentId: "cli_hostInteractionA1", name: "host", stateDir: path.join(root, "state", "agents", "cli_hostInteractionA1") };
  const stateStore = stateModule.createAgentStateStore(root, agent.agentId);
  const machine = new machineModule.InteractionStateMachine({ stateStore, agentId: agent.agentId });
  const created = machine.create({ definition: definition(effect), expected_chat_id: "oc_interaction" });
  const actionValue = callbackValue(created.card);
  const deliveries = [];
  const updates = [];
  const orchestrator = new orchestratorModule.HostInteractionOrchestrator({
    agents: [agent], stateStore: () => stateStore,
    deliveryTarget: { async deliver(agentId, envelope) { deliveries.push({ agentId, envelope }); return { status: "accepted" }; } },
    channelFor: () => ({ async updateCard(messageId, card) { updates.push({ messageId, card }); } }),
  });
  const click = (eventId = "evt_1") => orchestrator.handleCardAction(agent, {
    messageId: "om_card", chatId: "oc_interaction", operator: { openId: "ou_clicker", name: "Clicker" },
    action: { tag: "button", value: actionValue }, raw: { header: { event_id: eventId } },
  });
  return { root, agent, stateStore, machine, created, orchestrator, deliveries, updates, click };
}

test("idle interaction sync remains read-only and cannot self-trigger its file watcher", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-interaction-idle-sync-"));
  try {
    const agent = { agentId: "cli_idleInteractionA1", name: "idle", stateDir: path.join(root, "state", "agents", "cli_idleInteractionA1") };
    const stateStore = stateModule.createAgentStateStore(root, agent.agentId);
    fs.mkdirSync(agent.stateDir, { recursive: true });
    let intervalTick;
    let watcherCallback;
    const orchestrator = new orchestratorModule.HostInteractionOrchestrator({
      agents: [agent], stateStore: () => stateStore,
      deliveryTarget: { async deliver() { throw new Error("idle sync must not deliver"); } },
      channelFor: () => undefined,
      watch(_directory, callback) { watcherCallback = callback; return { close() {} }; },
      setInterval(callback) {
        intervalTick = callback;
        return { unref() {} };
      },
    });
    orchestrator.startSync();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(stateStore.paths.interactions), false, "startup scan must not create an empty state file");
    intervalTick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fs.existsSync(stateStore.paths.interactions), false, "periodic idle scan must remain read-only");
    assert.equal(typeof watcherCallback, "function");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("dynamic Agent sync installs an immediate watcher and shutdown closes every watcher", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-interaction-dynamic-sync-"));
  try {
    const initial = { agentId: "cli_initialSyncA1", name: "initial", stateDir: path.join(root, "state", "agents", "cli_initialSyncA1") };
    const added = { agentId: "cli_addedSyncB2", name: "added", stateDir: path.join(root, "state", "agents", "cli_addedSyncB2") };
    const stores = new Map([initial, added].map((agent) => [agent.agentId, stateModule.createAgentStateStore(root, agent.agentId)]));
    for (const agent of [initial, added]) fs.mkdirSync(agent.stateDir, { recursive: true });
    const watched = [];
    const closed = [];
    const orchestrator = new orchestratorModule.HostInteractionOrchestrator({
      agents: [initial], stateStore: (agent) => stores.get(agent.agentId),
      deliveryTarget: { async deliver() { return { status: "accepted" }; } }, channelFor: () => undefined,
      watch(directory, callback) { watched.push({ directory, callback }); return { close() { closed.push(directory); } }; },
      setInterval() { return { unref() {} }; },
    });
    orchestrator.startSync();
    orchestrator.syncAgent(added);
    await orchestrator.flushPending(added);
    assert.deepEqual(watched.map(({ directory }) => directory), [initial.stateDir, added.stateDir]);
    orchestrator.syncAgent(added);
    assert.equal(watched.length, 2, "repeated hot update must not duplicate the Agent watcher");
    orchestrator.stopSync();
    assert.deepEqual(closed, [initial.stateDir, added.stateDir]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("card callback durably accepts, returns truthful processing feedback, and wakes Agent exactly once", async () => {
  const f = fixture();
  try {
    const response = await f.click();
    await f.orchestrator.flushPending(f.agent);
    assert.deepEqual(response.toast, { type: "info", content: "已受理，Agent 正在处理，完成后会更新卡片。" });
    assert.equal(response.card.type, "raw");
    assert.match(JSON.stringify(response.card.data), /Agent 正在处理/);
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].envelope.wake, true);
    assert.equal(f.deliveries[0].envelope.sender_id, "ou_clicker");
    assert.equal(f.deliveries[0].envelope.side_effect_status, "succeeded");
    assert.match(f.deliveries[0].envelope.content, /interaction resolve/);
    assert.equal(f.stateStore.readNdjson("inbox").length, 1);
    assert.equal(f.updates.length, 1);

    await f.click();
    await f.orchestrator.flushPending(f.agent);
    assert.equal(f.machine.snapshot().runs.length, 1);
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.stateStore.readNdjson("inbox").length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("reminder.schedule Reflex is idempotent and its structured result still wakes Agent", async () => {
  const f = fixture({ id: "reminder.schedule", args: { title: "Follow up", delay_seconds: 120 } });
  try {
    await f.click("evt_reminder");
    await f.orchestrator.flushPending(f.agent);
    await f.click("evt_reminder");
    await f.orchestrator.flushPending(f.agent);
    const reminders = f.stateStore.readJson("reminders", { reminders: [] }).reminders;
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].payload.run_id, f.machine.snapshot().runs[0].run_id);
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].envelope.reflex.data.reminder_id, reminders[0].reminderId);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("reminder.schedule initializes only inside the canonical ReminderStore mutation", async () => {
  const f = fixture({ id: "reminder.schedule", args: { title: "Follow up", delay_seconds: 120 } });
  try {
    const guardedStore = new Proxy(f.stateStore, {
      get(target, key) {
        if (key === "writeJson") return (stateKey, value) => {
          if (stateKey === "reminders") throw new Error("unlocked reminder initialization attempted");
          return target.writeJson(stateKey, value);
        };
        const value = target[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const orchestrator = new orchestratorModule.HostInteractionOrchestrator({
      agents: [f.agent], stateStore: () => guardedStore,
      deliveryTarget: { async deliver() { return { status: "accepted" }; } },
      channelFor: () => ({ async updateCard() {} }),
    });
    const value = callbackValue(f.created.card);
    const response = await orchestrator.handleCardAction(f.agent, {
      messageId: "om_card", chatId: "oc_interaction", operator: { openId: "ou_clicker" },
      action: { tag: "button", value }, raw: { event_id: "evt_guarded_reminder" },
    });
    await orchestrator.flushPending(f.agent);
    assert.equal(response.toast.type, "info");
    assert.equal(f.stateStore.readJson("reminders", { reminders: [] }).reminders.length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("append-deliver-mark crash resumes from consumed Runtime ledger without re-appending the wake", async () => {
  const f = fixture();
  try {
    const value = callbackValue(f.created.card);
    const claimed = f.machine.claim({ interaction_ref: value.interaction_ref, expected_version: value.interaction_version,
      callback_id: "card:evt_delivery_crash", operator_open_id: "ou_clicker", chat_id: "oc_interaction", message_id: "om_card" });
    f.machine.recordReflex(claimed.run.run_id, { status: "succeeded", summary: "accepted" });
    let deliveries = 0;
    const crashing = new orchestratorModule.HostInteractionOrchestrator({
      agents: [f.agent], stateStore: () => f.stateStore,
      deliveryTarget: { async deliver(_agentId, envelope) {
        deliveries += 1;
        f.stateStore.writeJson("runtimeDeliveries", { version: 1, records: [{ deliveryId: "d-crash", messageId: envelope.message_id, status: "consumed", input: {}, updatedAt: new Date().toISOString() }] });
        f.stateStore.drainInbox();
        return { status: "accepted" };
      } },
      channelFor: () => ({ async updateCard() {} }),
      afterRuntimeDelivery() { throw new Error("simulated crash before outbox mark"); },
    });
    await crashing.flushPending(f.agent);
    assert.equal(f.stateStore.readNdjson("inbox").length, 0);
    assert.equal(f.machine.pendingOutbox("agent_wake").length, 1);

    const restarted = new orchestratorModule.HostInteractionOrchestrator({
      agents: [f.agent], stateStore: () => f.stateStore,
      deliveryTarget: { async deliver() { deliveries += 1; return { status: "accepted" }; } },
      channelFor: () => ({ async updateCard() {} }),
    });
    await restarted.flushPending(f.agent);
    assert.equal(deliveries, 1, "consumed delivery ledger suppresses a second Runtime submission");
    assert.equal(f.stateStore.readNdjson("inbox").length, 0, "consumed synthetic wake is not resurrected");
    assert.equal(f.machine.pendingOutbox("agent_wake").length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("terminal Runtime rejection keeps the mandatory wake pending and a restarted Host explicitly recovers it", async () => {
  const f = fixture();
  try {
    const value = callbackValue(f.created.card);
    const claimed = f.machine.claim({ interaction_ref: value.interaction_ref, expected_version: value.interaction_version,
      callback_id: "card:evt_terminal_runtime", operator_open_id: "ou_clicker", chat_id: "oc_interaction", message_id: "om_card" });
    f.machine.recordReflex(claimed.run.run_id, { status: "succeeded", summary: "accepted" });
    const sessions = [];
    const session = (result) => ({
      sessionId: `session-${sessions.length + 1}`, prompts: [], listeners: new Set(),
      subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
      async prompt(input) { this.prompts.push(input); return { ...result, inputId: input.inputId }; },
      async busyInput(input) { return this.prompt(input); }, async cancel() {}, async close() {},
    });
    const config = { agentId: f.agent.agentId, name: f.agent.name, runtime: "codex", model: "test", workspaceDir: f.root, stateDir: f.agent.stateDir };
    const firstRuntime = runtimeModule.createRuntimeHost({
      adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() {
        const created = session({ status: "rejected", retryable: false, reason: "terminal fixture rejection" }); sessions.push(created); return created;
      } }),
      promptBuilder: new promptModule.ContextPromptBuilder(), stateStoreFor: () => f.stateStore,
    });
    await firstRuntime.start([config]);
    const firstOrchestrator = new orchestratorModule.HostInteractionOrchestrator({
      agents: [f.agent], stateStore: () => f.stateStore, deliveryTarget: firstRuntime,
      channelFor: () => ({ async updateCard() {} }),
    });
    await firstOrchestrator.flushPending(f.agent);
    assert.equal(sessions[0].prompts.length, 1);
    assert.equal(f.machine.pendingOutbox("agent_wake").length, 1, "terminal rejection must not acknowledge the mandatory wake");
    assert.equal(f.machine.get({ run_id: claimed.run.run_id }).run.agent_delivery_status, "pending");
    const rejectedLedger = f.stateStore.readJson("runtimeDeliveries", { records: [] }).records.find((item) => item.messageId === `interaction_${claimed.run.run_id}`);
    assert.equal(rejectedLedger.status, "error");
    assert.equal(rejectedLedger.reason, "terminal fixture rejection");
    assert.equal(rejectedLedger.retryable, false);
    const deliveryId = rejectedLedger.deliveryId;
    await firstRuntime.shutdown("simulate Host restart after terminal rejection");

    const secondRuntime = runtimeModule.createRuntimeHost({
      adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() {
        const created = session({ status: "accepted" }); sessions.push(created); return created;
      } }),
      promptBuilder: new promptModule.ContextPromptBuilder(), stateStoreFor: () => f.stateStore,
    });
    await secondRuntime.start([config]);
    const restarted = new orchestratorModule.HostInteractionOrchestrator({
      agents: [f.agent], stateStore: () => f.stateStore, deliveryTarget: secondRuntime,
      channelFor: () => ({ async updateCard() {} }),
    });
    await restarted.flushPending(f.agent);
    assert.equal(sessions[1].prompts.length, 1, "restart flush explicitly resubmits the rejected mandatory wake");
    assert.equal(sessions[1].prompts[0].inputId, deliveryId, "recovery preserves stable Runtime delivery ownership");
    assert.equal(sessions[1].prompts[0].attempt, 1);
    assert.equal(f.machine.pendingOutbox("agent_wake").length, 0);
    assert.equal(f.machine.get({ run_id: claimed.run.run_id }).run.agent_delivery_status, "delivered");
    await secondRuntime.shutdown("terminal rejection recovery test complete");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("resolve racing an in-flight projection converges to the newest exact card version", async () => {
  const f = fixture();
  try {
    const value = callbackValue(f.created.card);
    const claimed = f.machine.claim({ interaction_ref: value.interaction_ref, expected_version: value.interaction_version,
      callback_id: "card:evt_projection_race", operator_open_id: "ou_clicker", chat_id: "oc_interaction", message_id: "om_card" });
    f.machine.recordReflex(claimed.run.run_id, { status: "succeeded", summary: "accepted" });
    let releaseFirst;
    let firstStarted;
    const started = new Promise((resolve) => { firstStarted = resolve; });
    const remote = [];
    const orchestrator = new orchestratorModule.HostInteractionOrchestrator({
      agents: [f.agent], stateStore: () => f.stateStore,
      deliveryTarget: { async deliver() { return { status: "accepted" }; } },
      channelFor: () => ({ async updateCard(_messageId, card) {
        if (remote.length === 0) { firstStarted(); await new Promise((resolve) => { releaseFirst = resolve; }); }
        remote.push(card);
      } }),
    });
    const flushing = orchestrator.flushPending(f.agent);
    await started;
    f.machine.resolve({ run_id: claimed.run.run_id, expected_version: 2, status: "succeeded", summary: "newest terminal", agent_id: f.agent.agentId });
    releaseFirst();
    await flushing;
    assert.equal(remote.length, 2);
    assert.match(JSON.stringify(remote.at(-1)), /newest terminal/);
    const instance = f.machine.get({ run_id: claimed.run.run_id }).instance;
    assert.equal(instance.projected_version, instance.desired_projection_version);
    assert.equal(instance.projected_version, 3);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("resolve-to-projection crash leaves a retryable exact terminal projection", async () => {
  const f = fixture();
  try {
    const value = callbackValue(f.created.card);
    const claimed = f.machine.claim({ interaction_ref: value.interaction_ref, expected_version: value.interaction_version,
      callback_id: "card:evt_projection_crash", operator_open_id: "ou_clicker", chat_id: "oc_interaction", message_id: "om_card" });
    f.machine.recordReflex(claimed.run.run_id, { status: "succeeded", summary: "accepted" });
    f.machine.resolve({ run_id: claimed.run.run_id, expected_version: 2, status: "succeeded", summary: "terminal after restart", agent_id: f.agent.agentId });
    const crashing = new orchestratorModule.HostInteractionOrchestrator({
      agents: [f.agent], stateStore: () => f.stateStore,
      deliveryTarget: { async deliver() { return { status: "accepted" }; } },
      channelFor: () => ({ async updateCard() { throw new Error("simulated projection transport crash"); } }),
    });
    await crashing.flushPending(f.agent);
    assert.ok(f.machine.pendingOutbox("card_projection").length >= 1);
    const remote = [];
    const restarted = new orchestratorModule.HostInteractionOrchestrator({
      agents: [f.agent], stateStore: () => f.stateStore,
      deliveryTarget: { async deliver() { return { status: "accepted" }; } },
      channelFor: () => ({ async updateCard(_messageId, card) { remote.push(card); } }),
    });
    await restarted.flushPending(f.agent);
    assert.match(JSON.stringify(remote.at(-1)), /terminal after restart/);
    assert.equal(f.machine.pendingOutbox("card_projection").length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("unauthorized and callback-without-event-id fail closed without a run or success claim", async () => {
  const f = fixture();
  try {
    const unauthorized = await f.orchestrator.handleCardAction(f.agent, {
      messageId: "om_card", chatId: "oc_interaction", operator: { openId: "ou_attacker" },
      action: { tag: "button", value: callbackValue(f.created.card) },
      raw: { header: { event_id: "evt_attacker" } },
    });
    assert.equal(unauthorized.toast.type, "error");
    const noId = await f.orchestrator.handleCardAction(f.agent, {
      messageId: "om_card", chatId: "oc_interaction", operator: { openId: "ou_clicker" },
      action: { tag: "button", value: callbackValue(f.created.card) },
    });
    assert.equal(noId.toast.type, "error");
    assert.equal(f.machine.snapshot().runs.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
