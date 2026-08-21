import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";
import { HostReminderOrchestrator } from "../../../dist/agent/host-reminder-orchestrator.mjs";
import { createRuntimeHost } from "../../../dist/runtime/runtime-host.mjs";

const agent = { agentId: "cli_rem", name: "cli_rem", stateDir: "/state/cli_rem" };
const deterministicProcessInspect = (pid) => ({ ok: true, dead: false, startToken: `test-process-${pid}` });
const deterministicStateStore = (root, agentId) => createAgentStateStore(root, agentId, {
  inspectProcess: deterministicProcessInspect,
});

async function waitFor(condition, label, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${label} did not settle within ${timeoutMs}ms`);
}

function fixture(reminders) {
  const deliveries = [], inbox = [];
  const state = { paths: { reminders: "/state/reminders.json", inbox: "/state/inbox.ndjson" }, appendNdjson(_key, value) { inbox.push(value); } };
  const api = {
    load: () => ({ reminders }),
    mutate(_file, fn) { return fn({ reminders }); },
    parseRepeat: () => null,
    nowIso: (ms) => new Date(ms).toISOString(),
    appendEvent(reminder, eventType, _actorType, _actorId, _nextFireAt, _ms, metadata) {
      if (!Array.isArray(reminder.events)) reminder.events = [];
      reminder.events.push({ eventType, metadata: metadata ?? null });
    },
  };
  const projector = {
    createReminderEnvelope(_agentId, reminder) { return { kind: "reminder", message_id: `rem_${reminder.reminderId}`, seq: 1, wake: true, target: "runtime:reminder" }; },
    createRedeliveryEnvelope(_agentId, count) { return { kind: "redelivery", message_id: `redeliver_${count}`, seq: 2, target: "runtime:redelivery" }; },
  };
  return { deliveries, inbox, state, api, projector };
}

test("reminder schedules deduplicate unless forced", () => {
  const scheduled = { reminderId: "r1", version: 3, ownerAgentId: "cli_rem", fireAt: "2026-07-16T03:00:00Z", status: "scheduled" };
  const f = fixture([scheduled, { ...scheduled, reminderId: "done", status: "fired" }]);
  const scheduledDelays = [];
  const cleared = [];
  const orchestrator = new HostReminderOrchestrator({
    agents: [agent], stateStore: () => f.state, envelopeProjector: f.projector, reminderStore: f.api,
    now: () => Date.parse("2026-07-16T02:00:00Z"),
    setTimer(_fn, delay) { scheduledDelays.push(delay); return { unref() {} }; },
    clearTimer(timer) { cleared.push(timer); },
  });
  orchestrator.pushSnapshot(agent, "test");
  orchestrator.pushSnapshot(agent, "duplicate");
  orchestrator.pushSnapshot(agent, "forced", true);
  assert.deepEqual(scheduledDelays, [3_600_000, 3_600_000]);
  assert.equal(cleared.length, 1);
});

test("due fire persists before delivery, updates record, then forces snapshot", () => {
  const reminder = { reminderId: "123456789", version: 1, ownerAgentId: "cli_rem", fireAt: "2026-07-16T02:00:00Z", createdAt: "2026-07-15T00:00:00Z", title: "due", status: "scheduled", deliveryTarget: "chat:oc_due", deliveryAnchor: "om_due" };
  const f = fixture([reminder]);
  f.projector.createReminderEnvelope = (_agentId, value) => ({
    kind: "reminder", message_id: `rem_${value.reminderId}`, seq: 1, wake: true, target: "runtime:reminder",
    channel_type: "dm", channel_name: "system",
  });
  const order = [];
  f.state.appendNdjson = (_key, value) => { order.push("persist"); f.inbox.push(value); };
  const target = { deliver(_agentId, envelope) { order.push("deliver"); f.deliveries.push(envelope); } };
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state, envelopeProjector: f.projector, deliveryTarget: target, reminderStore: f.api, now: () => Date.parse("2026-07-16T03:00:00Z") });
  orchestrator.handleFire({ agentId: "cli_rem", reminderId: reminder.reminderId });
  assert.deepEqual(order, ["persist", "deliver"]);
  assert.equal(reminder.status, "fired");
  assert.equal(reminder.version, 2);
  assert.equal(f.inbox[0].target, "runtime:reminder");
  assert.equal(f.deliveries[0].target, "runtime:reminder");
  assert.equal(f.deliveries[0].deliveryTarget, "chat:oc_due");
  assert.equal(f.deliveries[0].deliveryAnchor, "om_due");
  assert.equal(reminder.events.at(-1).eventType, "delivery_succeeded");
  assert.deepEqual(reminder.events.at(-1).metadata, { outcome: "accepted", deliveryTarget: "chat:oc_due" });
  assert.strictEqual(f.inbox[0], f.deliveries[0], "the same target-complete envelope is persisted and delivered");
  orchestrator.handleFire({ agentId: "cli_rem", reminderId: reminder.reminderId });
  assert.equal(f.deliveries.length, 1, "duplicate fire attempts do not duplicate the user-visible delivery");
});

test("thread reminder fire carries the thread target and remains exactly-once", () => {
  const reminder = { reminderId: "thread-reminder", version: 1, ownerAgentId: "cli_rem", fireAt: "2026-07-16T02:00:00Z",
    createdAt: "2026-07-15T00:00:00Z", title: "thread due", status: "scheduled", deliveryTarget: "thread:oc_thread:omt_topic", deliveryAnchor: "om_thread" };
  const f = fixture([reminder]);
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state,
    envelopeProjector: f.projector, deliveryTarget: { deliver(_id, envelope) { f.deliveries.push(envelope); } }, reminderStore: f.api,
    now: () => Date.parse("2026-07-16T03:00:00Z") });
  orchestrator.handleFire({ agentId: agent.agentId, reminderId: reminder.reminderId });
  orchestrator.handleFire({ agentId: agent.agentId, reminderId: reminder.reminderId });
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].deliveryTarget, "thread:oc_thread:omt_topic");
  assert.equal(f.deliveries[0].deliveryAnchor, "om_thread");
});

// Native Windows exposed both slow process inspection and async ledger races. This test is not
// about CIM/lock ownership, so it injects stable process identity and waits on durable states.
test("due reminder and startup redelivery reach final Runtime input with source-specific runtime targets", {
  timeout: 30_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reminder-target-runtime-"));
  const agentId = "cli_reminderTargetA1";
  const realAgent = { agentId, name: agentId, stateDir: path.join(root, "state", "agents", agentId) };
  const reminder = { reminderId: "target-reminder", version: 1, ownerAgentId: agentId,
    fireAt: "2026-07-16T02:00:00Z", createdAt: "2026-07-15T00:00:00Z", title: "target", status: "scheduled" };
  const f = fixture([reminder]);
  const store = deterministicStateStore(root, agentId);
  const session = {
    sessionId: "reminder-target-session", listeners: new Set(), prompts: [], steers: [],
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
    emit(event) { for (const listener of this.listeners) listener(event); },
    async prompt(input) { this.prompts.push(input); return { status: "accepted", inputId: input.inputId }; },
    async busyInput(input) { this.steers.push(input); return { status: "accepted", inputId: input.inputId }; },
    async cancel() {}, async close() {},
  };
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  const delivered = [];
  const projector = {
    createReminderEnvelope(_id, value) { return { kind: "reminder", message_id: `rem_${value.reminderId}`, seq: 1, wake: true,
      target: "runtime:reminder", channel_type: "dm", channel_name: "system" }; },
    createRedeliveryEnvelope() { return { kind: "redelivery", message_id: "redeliver_target", seq: 2,
      target: "runtime:redelivery", channel_type: "dm", channel_name: "system" }; },
  };
  const orchestrator = new HostReminderOrchestrator({ agents: [realAgent], stateStore: () => store,
    envelopeProjector: projector, deliveryTarget: { deliver(id, envelope) { delivered.push(envelope); return host.deliver(id, envelope); } },
    reminderStore: f.api, now: () => Date.parse("2026-07-16T03:00:00Z") });
  try {
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root }]);
    orchestrator.handleFire({ agentId, reminderId: reminder.reminderId });
    await waitFor(() => session.prompts.length === 1
      && store.readJson("runtimeDeliveries", { records: [] }).records
        .some((record) => record.messageId === `rem_${reminder.reminderId}` && record.status === "accepted"),
    "reminder Runtime acceptance");
    const persistedReminder = store.readNdjson("inbox")[0];
    assert.equal(persistedReminder.target, "runtime:reminder");
    assert.equal(delivered[0].target, persistedReminder.target);
    assert.match(session.prompts[0].text, /Inbox changed for runtime:reminder/);
    store.pollInbox({ target: "runtime:reminder", limit: 1 });
    session.emit({ type: "turn-start", turnId: "reminder-turn" });
    session.emit({ type: "turn-end", turnId: "reminder-turn" });
    await waitFor(() => store.readJson("runtimeDeliveries", { records: [] }).records
      .some((record) => record.messageId === `rem_${reminder.reminderId}` && record.status === "consumed"),
    "reminder Runtime consumption");

    store.appendNdjson("inbox", { message_id: "om_startup_orphan", target: "chat:oc_orphan", wake: true });
    await orchestrator.redeliverUnread(realAgent);
    const persistedRedelivery = store.readNdjson("inbox").find((row) => row.message_id === "redeliver_target");
    assert.equal(persistedRedelivery.target, "runtime:redelivery");
    assert.equal(delivered[1].target, persistedRedelivery.target);
    assert.match(session.prompts[1].text, /Inbox changed for runtime:redelivery/);
  } finally {
    await host.shutdown("reminder target test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restart redelivery counts only wake=true and delivers once", async () => {
  const f = fixture([]);
  f.projector.createRedeliveryEnvelope = (_agentId, count) => ({
    kind: "redelivery", message_id: `redeliver_${count}`, seq: 2, target: "runtime:redelivery",
    channel_type: "dm", channel_name: "system",
  });
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state, envelopeProjector: f.projector, deliveryTarget: { deliver(_id, envelope) { f.deliveries.push(envelope); } }, reminderStore: f.api, readFile: () => '{"wake":true}\n{"wake":false}\n{"wake":true}\n' });
  await orchestrator.redeliverUnread(agent);
  await orchestrator.redeliverUnread(agent);
  assert.deepEqual(f.deliveries, [{ kind: "redelivery", message_id: "redeliver_2", seq: 2,
    target: "runtime:redelivery", channel_type: "dm", channel_name: "system" }]);
  assert.deepEqual(f.inbox, f.deliveries);
  assert.strictEqual(f.inbox[0], f.deliveries[0], "new startup redelivery persists and delivers one target-complete object");
});

test("authoritative empty startup Inbox consumes redelivery without capturing a later inbound message", async () => {
  const f = fixture([]);
  let inbox = "";
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state,
    envelopeProjector: f.projector, deliveryTarget: { deliver(_id, envelope) { f.deliveries.push(envelope); } },
    reminderStore: f.api, readFile: () => inbox });
  await orchestrator.redeliverUnread(agent);
  inbox = `${JSON.stringify({ message_id: "om_after_startup", wake: true })}\n`;
  await orchestrator.redeliverUnread(agent);
  assert.deepEqual(f.inbox, []);
  assert.deepEqual(f.deliveries, []);
});

test("missing startup Inbox is authoritative empty and consumes redelivery", async () => {
  const f = fixture([]);
  let reads = 0;
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state,
    envelopeProjector: f.projector, deliveryTarget: { deliver(_id, envelope) { f.deliveries.push(envelope); } },
    reminderStore: f.api, readFile() {
      reads += 1;
      if (reads === 1) throw Object.assign(new Error("missing Inbox"), { code: "ENOENT" });
      return `${JSON.stringify({ message_id: "om_after_missing_startup", wake: true })}\n`;
    } });
  await orchestrator.redeliverUnread(agent);
  await orchestrator.redeliverUnread(agent);
  assert.equal(reads, 1);
  assert.deepEqual(f.inbox, []);
  assert.deepEqual(f.deliveries, []);
});

test("transient startup Inbox read failure does not burn redelivery", async () => {
  const f = fixture([]);
  let reads = 0;
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state,
    envelopeProjector: f.projector, deliveryTarget: { deliver(_id, envelope) { f.deliveries.push(envelope); } },
    reminderStore: f.api, readFile() {
      reads += 1;
      if (reads === 1) throw new Error("temporary read failure");
      return `${JSON.stringify({ message_id: "om_read_retry", wake: true })}\n`;
    } });
  await orchestrator.redeliverUnread(agent);
  await orchestrator.redeliverUnread(agent);
  await orchestrator.redeliverUnread(agent);
  assert.equal(reads, 2);
  assert.deepEqual(f.inbox, [{ kind: "redelivery", message_id: "redeliver_1", seq: 2, target: "runtime:redelivery" }]);
  assert.deepEqual(f.deliveries, f.inbox);
});

test("malformed startup Inbox does not burn redelivery after the file is repaired", async () => {
  const f = fixture([]);
  let inbox = "not-json\n";
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state,
    envelopeProjector: f.projector, deliveryTarget: { deliver(_id, envelope) { f.deliveries.push(envelope); } },
    reminderStore: f.api, readFile: () => inbox });
  await orchestrator.redeliverUnread(agent);
  inbox = `${JSON.stringify({ message_id: "om_after_repair", wake: true })}\n`;
  await orchestrator.redeliverUnread(agent);
  await orchestrator.redeliverUnread(agent);
  assert.deepEqual(f.inbox, [{ kind: "redelivery", message_id: "redeliver_1", seq: 2, target: "runtime:redelivery" }]);
  assert.deepEqual(f.deliveries, f.inbox);
});

test("zero unread without a Runtime delivery target does not burn redelivery", async () => {
  const f = fixture([]);
  let inbox = "";
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state,
    envelopeProjector: f.projector, reminderStore: f.api, readFile: () => inbox });
  await orchestrator.redeliverUnread(agent);
  inbox = `${JSON.stringify({ message_id: "om_after_targetless_startup", wake: true })}\n`;
  await orchestrator.redeliverUnread(agent);
  assert.deepEqual(f.inbox, [{ kind: "redelivery", message_id: "redeliver_1", seq: 2, target: "runtime:redelivery" }]);
});

test("restart redelivery reuses an existing canonical synthetic envelope instead of appending a duplicate", async () => {
  const f = fixture([]);
  const logs = [];
  const existing = { kind: "redelivery", message_id: "redeliver_existing", seq: 7, wake: true,
    content: "already durable", target: "runtime:redelivery" };
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state,
    envelopeProjector: f.projector, deliveryTarget: { deliver(_agentId, envelope) { f.deliveries.push(envelope); } },
    reminderStore: f.api, log: (...parts) => logs.push(parts.join(" ")),
    readFile: () => `${JSON.stringify({ message_id: "om_orphan", wake: true })}\n${JSON.stringify(existing)}\n` });
  await orchestrator.redeliverUnread(agent);
  assert.deepEqual(f.inbox, []);
  assert.deepEqual(f.deliveries, [existing]);
  assert.equal(f.deliveries[0].target, "runtime:redelivery", "an existing source-specific target is preserved without normalization");
  assert.match(logs.join("\n"), /滞留 wake 消息 1 条/, "existing redeliver_ rows are excluded from wakeCount");
});

test("restart redelivery rejects a targetless old redelivery row without append or delivery", async () => {
  const f = fixture([]);
  const oldRow = { message_id: "redeliver_old", seq: 8, channel_type: "dm", channel_name: "system", content: "old" };
  const bytes = `${JSON.stringify(oldRow)}\n`;
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state,
    envelopeProjector: f.projector, deliveryTarget: { deliver(_agentId, envelope) { f.deliveries.push(envelope); } },
    reminderStore: f.api, readFile: () => bytes });
  await assert.rejects(orchestrator.redeliverUnread(agent), /matching kind and message_id/);
  assert.deepEqual(f.inbox, [], "invalid existing row causes no append");
  assert.deepEqual(f.deliveries, [], "invalid existing row causes no Runtime delivery");
  assert.equal(bytes, `${JSON.stringify(oldRow)}\n`, "the persisted fixture remains byte-for-byte unchanged");
});

test("transient append failure does not burn the once-per-host redelivery opportunity", async () => {
  const f = fixture([]);
  let attempts = 0;
  f.state.appendNdjson = (_key, value) => {
    attempts += 1;
    if (attempts === 1) throw new Error("temporary disk error");
    f.inbox.push(value);
  };
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state,
    envelopeProjector: f.projector, deliveryTarget: { deliver(_id, envelope) { f.deliveries.push(envelope); } },
    reminderStore: f.api, readFile: () => `${JSON.stringify({ message_id: "om_retry", wake: true })}\n` });
  await orchestrator.redeliverUnread(agent);
  await orchestrator.redeliverUnread(agent);
  assert.equal(attempts, 2);
  assert.equal(f.deliveries.length, 1);
});

test("delivery failure keeps the durable synthetic envelope retryable without appending it twice", async () => {
  const f = fixture([]);
  let deliveryAttempts = 0;
  const original = { message_id: "om_delivery_retry", wake: true };
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state,
    envelopeProjector: f.projector, deliveryTarget: { deliver(_id, envelope) {
      deliveryAttempts += 1;
      if (deliveryAttempts === 1) throw new Error("runtime unavailable");
      f.deliveries.push(envelope);
    } }, reminderStore: f.api,
    readFile: () => [original, ...f.inbox].map((row) => JSON.stringify(row)).join("\n") + "\n" });
  await assert.rejects(orchestrator.redeliverUnread(agent), /runtime unavailable/);
  await orchestrator.redeliverUnread(agent);
  await orchestrator.redeliverUnread(agent);
  assert.equal(f.inbox.length, 1, "retry reuses the first durable synthetic row");
  assert.equal(deliveryAttempts, 2);
  assert.equal(f.deliveries.length, 1);
});

test("concurrent redelivery timers share one in-flight append and delivery attempt", async () => {
  const f = fixture([]);
  let release;
  const delivered = new Promise((resolve) => { release = resolve; });
  let deliveryCalls = 0;
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state,
    envelopeProjector: f.projector, deliveryTarget: { async deliver(_id, envelope) {
      deliveryCalls += 1;
      await delivered;
      f.deliveries.push(envelope);
    } }, reminderStore: f.api, readFile: () => `${JSON.stringify({ message_id: "om_concurrent", wake: true })}\n` });
  const first = orchestrator.redeliverUnread(agent);
  const second = orchestrator.redeliverUnread(agent);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.inbox.length, 1);
  assert.equal(deliveryCalls, 1);
  release();
  await Promise.all([first, second]);
  assert.equal(f.deliveries.length, 1);
});

test("Inbox append failure prevents reminder and restart delivery", async () => {
  const reminder = { reminderId: "append-fail", version: 1, ownerAgentId: "cli_rem", fireAt: "2026-07-16T02:00:00Z",
    createdAt: "2026-07-15T00:00:00Z", title: "due", status: "scheduled" };
  const f = fixture([reminder]);
  f.state.appendNdjson = () => { throw new Error("disk full"); };
  const target = { deliver(_agentId, envelope) { f.deliveries.push(envelope); } };
  const orchestrator = new HostReminderOrchestrator({ agents: [agent], stateStore: () => f.state,
    envelopeProjector: f.projector, deliveryTarget: target, reminderStore: f.api,
    now: () => Date.parse("2026-07-16T03:00:00Z"), readFile: () => `${JSON.stringify({ message_id: "om_orphan", wake: true })}\n` });
  orchestrator.handleFire({ agentId: agent.agentId, reminderId: reminder.reminderId });
  await orchestrator.redeliverUnread(agent);
  assert.deepEqual(f.deliveries, []);
});

test("orphan startup Inbox appends a durable redelivery envelope and one drain consumes its Runtime ledger", {
  timeout: 15_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-redelivery-orphan-"));
  const agentId = "cli_orphanA1";
  const realAgent = { agentId, name: agentId, stateDir: path.join(root, "state", "agents", agentId) };
  const store = deterministicStateStore(root, agentId);
  const session = {
    sessionId: "orphan-session", listeners: new Set(), prompts: [], steers: [],
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
    async prompt(input) { this.prompts.push(input); return { status: "accepted", inputId: input.inputId }; },
    async busyInput(input) { this.steers.push(input); return { status: "accepted", inputId: input.inputId }; },
    async cancel() {}, async close() {},
  };
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    store.appendNdjson("inbox", { message_id: "om_orphan", target: "chat:oc_orphan", wake: true, content: "orphan" });
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root }]);
    const orchestrator = new HostReminderOrchestrator({ agents: [realAgent], stateStore: () => store,
      envelopeProjector: {
        createReminderEnvelope() { throw new Error("unused"); },
        createRedeliveryEnvelope() { return { kind: "redelivery", message_id: "redeliver_orphan", seq: 9,
          target: "runtime:redelivery", wake: true, content: "drain" }; },
      }, deliveryTarget: host, reminderStore: fixture([]).api });
    await orchestrator.redeliverUnread(realAgent);
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), ["om_orphan", "redeliver_orphan"]);
    const drained = store.drainInbox();
    assert.deepEqual(drained.map((row) => row.message_id), ["om_orphan", "redeliver_orphan"]);
    const ledger = store.readJson("runtimeDeliveries", { records: [] });
    assert.equal(ledger.records.find((record) => record.messageId === "redeliver_orphan").status, "consumed");
    assert.equal(ledger.records.some((record) => record.status === "accepted"), false);
  } finally {
    await host.shutdown("test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an existing pending Runtime delivery and its durable startup redelivery are both consumed by one drain", {
  timeout: 15_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-redelivery-pending-"));
  const agentId = "cli_pendingRedeliveryA1";
  const realAgent = { agentId, name: agentId, stateDir: path.join(root, "state", "agents", agentId) };
  const store = deterministicStateStore(root, agentId);
  const session = {
    sessionId: "pending-session", listeners: new Set(), prompts: [], steers: [],
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); },
    async prompt(input) { this.prompts.push(input); return { status: "accepted", inputId: input.inputId }; },
    async busyInput(input) { this.steers.push(input); return { status: "accepted", inputId: input.inputId }; },
    async cancel() {}, async close() {},
  };
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    store.appendNdjson("inbox", { message_id: "om_existing", target: "chat:oc_existing", wake: true, content: "existing" });
    store.writeJson("runtimeDeliveries", { version: 1, records: [{
      deliveryId: "delivery-existing", messageId: "om_existing", status: "accepted", updatedAt: "2026-07-19T00:00:00.000Z",
      input: { inputId: "delivery-existing", deliveryId: "delivery-existing", kind: "wake", text: "check", attempt: 0 },
    }] });
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root }]);
    const orchestrator = new HostReminderOrchestrator({ agents: [realAgent], stateStore: () => store,
      envelopeProjector: {
        createReminderEnvelope() { throw new Error("unused"); },
        createRedeliveryEnvelope() { return { kind: "redelivery", message_id: "redeliver_existing_pending", seq: 10,
          target: "runtime:redelivery", wake: true, content: "drain" }; },
      }, deliveryTarget: host, reminderStore: fixture([]).api });
    await orchestrator.redeliverUnread(realAgent);
    assert.equal(session.prompts.length, 1);
    assert.equal(session.steers.length, 1, "the synthetic notice joins the active turn without losing canonical Inbox data");
    store.drainInbox();
    const statuses = Object.fromEntries(store.readJson("runtimeDeliveries", { records: [] }).records
      .map((record) => [record.messageId, record.status]));
    assert.deepEqual(statuses, { om_existing: "consumed", redeliver_existing_pending: "consumed" });
  } finally {
    await host.shutdown("test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Native Windows process startup can exceed Bun's default 5s test envelope; this is only a runner bound.
test("startup redelivery append shares the Inbox lock and cannot be erased by a concurrent drain", {
  timeout: 20_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-redelivery-lock-"));
  const agentId = "cli_redeliveryLockA1";
  const store = createAgentStateStore(root, agentId);
  const ready = path.join(root, "append-ready");
  const delivered = path.join(root, "delivered.json");
  let child;
  try {
    store.appendNdjson("inbox", { message_id: "om_lock", target: "chat:oc_lock", wake: true });
    const script = `
import fs from "node:fs";
import { createAgentStateStore } from ${JSON.stringify(new URL("../../../dist/agent/agent-state-store.mjs", import.meta.url).href)};
import { HostReminderOrchestrator } from ${JSON.stringify(new URL("../../../dist/agent/host-reminder-orchestrator.mjs", import.meta.url).href)};
const store=createAgentStateStore(process.env.TEST_ROOT, process.env.TEST_AGENT);
const agent={agentId:process.env.TEST_AGENT,name:process.env.TEST_AGENT,stateDir:store.paths.root};
const wrapped={paths:store.paths,appendNdjson(key,value){fs.writeFileSync(process.env.TEST_READY,"ready");store.appendNdjson(key,value)}};
const orchestrator=new HostReminderOrchestrator({agents:[agent],stateStore:()=>wrapped,envelopeProjector:{
 createReminderEnvelope(){throw new Error("unused")},
 createRedeliveryEnvelope(){return {kind:"redelivery",message_id:"redeliver_lock",target:"runtime:redelivery",seq:11,wake:true}}
},deliveryTarget:{deliver(_id,envelope){fs.writeFileSync(process.env.TEST_DELIVERED,JSON.stringify(envelope))}}});
await orchestrator.redeliverUnread(agent);
`;
    const drained = store.drainInbox({ afterRead() {
      child = spawn(process.execPath, ["--input-type=module", "--eval", script], { env: { ...process.env,
        TEST_ROOT: root, TEST_AGENT: agentId, TEST_READY: ready, TEST_DELIVERED: delivered } });
      const deadline = Date.now() + 10_000;
      while (!fs.existsSync(ready) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      assert.equal(fs.existsSync(ready), true, "child reached the locked append before drain released it");
    } });
    assert.deepEqual(drained.map((row) => row.message_id), ["om_lock"]);
    if (child.exitCode === null) await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`redelivery child exited ${code}`)));
    });
    else assert.equal(child.exitCode, 0);
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), ["redeliver_lock"]);
    assert.equal(JSON.parse(fs.readFileSync(delivered, "utf8")).message_id, "redeliver_lock");
  } finally {
    child?.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
