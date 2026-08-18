import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";
import { createRuntimeHost as createProductionRuntimeHost } from "../../../dist/runtime/runtime-host.mjs";
import { RuntimePrerequisiteError } from "../../../dist/runtime/runtime-readiness.mjs";
import { calculatePiCompactionSettings } from "../../../dist/runtime/pi-compaction-recovery.mjs";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { ProcessingEyeOrchestrator } from "../../../dist/feishu/host-processing-eye.mjs";

// Unrelated RuntimeHost scenarios use a producer-valid canonical chat locator. The dedicated
// runtime-inbox-target contract invokes the unwrapped production host for rejection coverage.
function createRuntimeHost(options) {
  const host = createProductionRuntimeHost(options);
  const deliver = host.deliver.bind(host);
  host.deliver = (agentId, envelope) => {
    const messageId = typeof envelope?.message_id === "string" ? envelope.message_id : "";
    const alreadyLocatable = typeof envelope?.target === "string" || typeof envelope?.chat_id === "string"
      || (envelope?.kind === "reminder" && /^rem_[A-Za-z0-9_-]+$/.test(messageId))
      || (envelope?.kind === "redelivery" && /^redeliver_[A-Za-z0-9_-]+$/.test(messageId));
    return deliver(agentId, alreadyLocatable ? envelope : { ...envelope, chat_id: "oc_runtime_host_fixture" });
  };
  return host;
}

class FakeSession {
  sessionId = "session-1";
  listeners = new Set();
  prompts = [];
  steers = [];
  cancels = [];
  closes = [];
  nextBusy = null;
  subscribeFailure = null;
  unsubscribeFailure = null;
  subscribe(fn) {
    if (this.subscribeFailure) throw new Error(this.subscribeFailure);
    this.listeners.add(fn);
    return () => {
      if (this.unsubscribeFailure) throw new Error(this.unsubscribeFailure);
      this.listeners.delete(fn);
    };
  }
  emit(event) { for (const fn of this.listeners) fn(event); }
  async prompt(input) { this.prompts.push(input); return { status: "accepted", inputId: input.inputId }; }
  async busyInput(input) {
    this.steers.push(input);
    return this.nextBusy ?? { status: "accepted", inputId: input.inputId };
  }
  async cancel(reason) { this.cancels.push(reason); }
  async close(reason) { this.closes.push(reason); }
}

test("RuntimeHost manually compacts one exact overflow and retries the same stable input once", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-manual-compaction-"));
  const agentId = "cli_piManualA1";
  const store = createAgentStateStore(root, agentId);
  let releaseCompact;
  class CompactingSession extends FakeSession {
    compactCalls = 0;
    async compact() { this.compactCalls += 1; await new Promise((resolve) => { releaseCompact = resolve; }); return {}; }
  }
  const session = new CompactingSession();
  const adapter = { id: "pi", capabilities: {}, async createSession() { return session; } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    await host.start([{ agentId, name: "manual", runtime: "pi", model: "model", workspaceDir: "/tmp", stateDir: root }]);
    store.appendNdjson("inbox", { message_id: "om_pi_manual", chat_id: "oc_pi_manual", content: "stable" });
    const first = await host.deliver(agentId, { message_id: "om_pi_manual", chat_id: "oc_pi_manual", content: "stable" });
    assert.equal(first.status, "accepted");
    const inputId = session.prompts[0].inputId;
    session.emit({ type: "input-error", inputId, retryable: false, willRetry: false,
      message: "Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.compactCalls, 1);
    const breaker = JSON.parse(fs.readFileSync(path.join(root, "piCompactionRecovery.json"), "utf8"));
    assert.equal(breaker.records[0].manualAttempt, 1);
    session.emit({ type: "runtime-observation", runtime: "pi", distribution: "external", phase: "compaction_end",
      reason: "manual", success: true, willRetry: false });
    releaseCompact();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(session.prompts.length, 2, `compact=${session.compactCalls} breaker=${fs.readFileSync(path.join(root, "piCompactionRecovery.json"), "utf8")}`);
    assert.equal(session.prompts[1].inputId, inputId);
    assert.equal(session.prompts[1].deliveryId, session.prompts[0].deliveryId);
    assert.equal(session.compactCalls, 1);
  } finally {
    await host.shutdown("done");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RuntimeHost refuses overflow retry when the Pi policy drifts before compact", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-overflow-policy-drift-"));
  const agentId = "cli_piDriftA1";
  const store = createAgentStateStore(root, agentId);
  let createCalls = 0;
  class DriftingSession extends FakeSession {
    compactCalls = 0;
    async compact() {
      this.compactCalls += 1;
      throw new Error("Pi model or context window changed after startup; compaction policy is no longer safe");
    }
  }
  const session = new DriftingSession();
  const adapter = {
    id: "pi", capabilities: {},
    async createSession() {
      createCalls += 1;
      if (createCalls > 1) throw new Error("Pi model or context window changed between the isolated probe and runtime startup");
      return session;
    },
  };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    await host.start([{ agentId, name: "drift", runtime: "pi", model: "model", workspaceDir: "/tmp", stateDir: root }]);
    store.appendNdjson("inbox", { message_id: "om_pi_overflow_drift", chat_id: "oc_pi_overflow_drift", content: "stable" });
    const first = await host.deliver(agentId, { message_id: "om_pi_overflow_drift", chat_id: "oc_pi_overflow_drift", content: "stable" });
    assert.equal(first.status, "accepted");
    const inputId = session.prompts[0].inputId;
    session.emit({ type: "input-error", inputId, retryable: false, willRetry: false,
      message: "Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window" });
    const deadline = Date.now() + 1_000;
    while (session.compactCalls < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(session.compactCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(session.prompts.length, 1, "policy drift must prevent the retry prompt submission");
    const durable = store.readJson("runtimeDeliveries", { records: [] });
    assert.equal(durable.records.some((record) => record.status === "consumed"), false);
    assert.ok(durable.records.some((record) => record.status === "error" || record.status === "pending"));
  } finally {
    await host.shutdown("done");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RuntimeHost proactively compacts only above each session's verified dynamic threshold", async () => {
  for (const contextWindow of [272_000, 500_000]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-proactive-"));
    const policy = calculatePiCompactionSettings(contextWindow);
    class ProactiveSession extends FakeSession {
      usage = { tokens: policy.threshold, contextWindow };
      compactCalls = 0;
      async getContextUsage() { return { ...this.usage }; }
      async compact() { this.compactCalls += 1; this.usage.tokens = 100; }
    }
    const session = new ProactiveSession();
    const adapter = { id: "pi", capabilities: {}, async createSession() { return session; } };
    const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
    try {
      await host.start([{ agentId: `cli_piProactive${contextWindow}`, name: "proactive", runtime: "pi", model: "model", workspaceDir: "/tmp", stateDir: root }]);
      session.usage.tokens = policy.threshold + 1;
      session.emit({ type: "turn-start" });
      await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(session.compactCalls, 0, "busy turns must not trigger idle proactive compaction");
      session.emit({ type: "turn-end" });
      session.emit({ type: "turn-end" });
      const deadline = Date.now() + 1_000;
      while (session.compactCalls < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(session.compactCalls, 1);
      assert.equal(session.usage.tokens, 100);
      session.usage.tokens = policy.threshold + 1;
      session.emit({ type: "turn-end" });
      const secondDeadline = Date.now() + 1_000;
      while (session.compactCalls < 2 && Date.now() < secondDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(session.compactCalls, 2, "a later idle turn may compact again after verified success");
    } finally {
      await host.shutdown("done");
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("RuntimeHost does not proactively compact at the strict threshold", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-proactive-equal-"));
  const contextWindow = 500_000;
  const policy = calculatePiCompactionSettings(contextWindow);
  class EqualSession extends FakeSession {
    compactCalls = 0;
    async getContextUsage() { return { tokens: policy.threshold, contextWindow }; }
    async compact() { this.compactCalls += 1; }
  }
  const session = new EqualSession();
  const adapter = { id: "pi", capabilities: {}, async createSession() { return session; } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  try {
    await host.start([{ agentId: "cli_piProactiveEqualA1", name: "equal", runtime: "pi", model: "model", workspaceDir: "/tmp", stateDir: root }]);
    session.emit({ type: "turn-end" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(session.compactCalls, 0);
  } finally {
    await host.shutdown("done");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RuntimeHost bounds proactive compact failure without retry or session reset", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-proactive-failure-"));
  const policy = calculatePiCompactionSettings(272_000);
  class FailingSession extends FakeSession {
    compactCalls = 0;
    async getContextUsage() { return { tokens: policy.threshold + 1, contextWindow: 272_000 }; }
    async compact() { this.compactCalls += 1; throw new Error("fixture proactive compact failure"); }
  }
  const session = new FailingSession();
  const store = createAgentStateStore(root, "cli_piProactiveFailureA1");
  store.appendNdjson("inbox", { message_id: "om_pi_proactive_failure", chat_id: "oc_pi_proactive_failure", content: "pending" });
  const adapter = { id: "pi", capabilities: {}, async createSession() { return session; } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    await host.start([{ agentId: "cli_piProactiveFailureA1", name: "failure", runtime: "pi", model: "model", workspaceDir: "/tmp", stateDir: root }]);
    session.emit({ type: "turn-end" });
    session.emit({ type: "turn-end" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(session.compactCalls, 1);
    assert.equal(session.closes.length, 0, "proactive failure must not reset the session");
    const receipt = await host.deliver("cli_piProactiveFailureA1", {
      message_id: "om_pi_proactive_failure", chat_id: "oc_pi_proactive_failure", content: "pending",
    });
    assert.equal(receipt.status, "deferred");
    assert.equal(session.prompts.length, 0, "degraded generation must not submit pending work");
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "pending");
  } finally {
    await host.shutdown("done");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RuntimeHost gates startup replay behind high-water proactive compaction", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-proactive-startup-"));
  const agentId = "cli_piProactiveStartupA1";
  const store = createAgentStateStore(root, agentId);
  const policy = calculatePiCompactionSettings(500_000);
  store.appendNdjson("inbox", { message_id: "om_pi_proactive_startup", chat_id: "oc_pi_proactive_startup", content: "startup" });
  store.writeJson("runtimeDeliveries", { version: 1, records: [{
    deliveryId: "startup-delivery", messageId: "om_pi_proactive_startup", status: "pending",
    input: { inputId: "startup-input", deliveryId: "startup-delivery", kind: "wake", text: "startup", attempt: 0 },
    updatedAt: "before",
  }] });
  const order = [];
  let releaseCompact;
  class StartupSession extends FakeSession {
    usage = { tokens: policy.threshold + 1, contextWindow: 500_000 };
    compactCalls = 0;
    async getContextUsage() { return { ...this.usage }; }
    async compact() {
      order.push("compact"); this.compactCalls += 1;
      await new Promise((resolve) => { releaseCompact = resolve; });
      this.usage.tokens = 100;
    }
    async prompt(input) { order.push("prompt"); return super.prompt(input); }
  }
  const session = new StartupSession();
  const adapter = { id: "pi", capabilities: {}, async createSession() { return session; } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    const starting = host.start([{ agentId, name: "startup", runtime: "pi", model: "model", workspaceDir: "/tmp", stateDir: root }]);
    const deadline = Date.now() + 1_000;
    while (session.compactCalls < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(session.compactCalls, 1);
    session.emit({ type: "turn-end" });
    session.emit({ type: "turn-end" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(order, ["compact"]);
    releaseCompact();
    await starting;
    assert.deepEqual(order, ["compact", "prompt"]);
  } finally {
    await host.shutdown("done");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RuntimeHost treats a failed manual compact as an internal fresh-session fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-fallback-"));
  const agentId = "cli_piFallbackA1";
  const store = createAgentStateStore(root, agentId);
  const sessions = [];
  class FailingCompactionSession extends FakeSession {
    async compact() { throw new Error("compact RPC unavailable after send"); }
  }
  const adapter = { id: "pi", capabilities: {}, async createSession(input) {
    const session = new FailingCompactionSession(); session.sessionId = `pi-session-${sessions.length + 1}`;
    sessions.push({ session, input }); return session;
  } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    await host.start([{ agentId, name: "fallback", runtime: "pi", model: "model", workspaceDir: "/tmp", stateDir: root }]);
    store.appendNdjson("inbox", { message_id: "om_pi_fallback", chat_id: "oc_pi_fallback", content: "stable" });
    await host.deliver(agentId, { message_id: "om_pi_fallback", chat_id: "oc_pi_fallback", content: "stable" });
    const oldInput = sessions[0].session.prompts[0];
    sessions[0].session.emit({ type: "input-error", inputId: oldInput.inputId, retryable: false, willRetry: false,
      message: "Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window" });
    const deadline = Date.now() + 1_000;
    while (sessions.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sessions.length, 2);
    assert.equal(sessions[1].input.resumeSessionId, null);
    const retryDeadline = Date.now() + 1_000;
    while (sessions[1].session.prompts.length < 1 && Date.now() < retryDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(sessions[1].session.prompts[0].inputId, oldInput.inputId);
    assert.equal(sessions[1].session.prompts[0].deliveryId, oldInput.deliveryId);
    assert.match(sessions[0].session.closes.join(" "), /fallback/);
  } finally {
    await host.shutdown("done");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RuntimeHost honors Pi-owned willRetry without manual compact or duplicate input", async () => {
  const session = new FakeSession();
  let host;
  const adapter = { id: "pi", capabilities: {}, async createSession() { return session; } };
  host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  await host.start([{ agentId: "cli_piNativeA1", name: "native", runtime: "pi", model: "model", workspaceDir: "/tmp" }]);
  const first = await host.deliver("cli_piNativeA1", { message_id: "om_pi_native", chat_id: "oc_pi_native", content: "stable" });
  const input = session.prompts[0];
  session.emit({ type: "input-error", inputId: input.inputId, retryable: true, willRetry: true,
    message: "Pi owns the context-overflow retry", errorCategory: "context_window" });
  assert.equal(first.status, "accepted");
  assert.equal(session.prompts.length, 1);
  await host.shutdown("done");
});

test("RuntimeHost stages a candidate session without stopping the old healthy Agent", async () => {
  const oldSession = new FakeSession();
  oldSession.sessionId = "old-session";
  const nextSession = new FakeSession();
  nextSession.sessionId = "next-session";
  const adapter = { id: "pi", capabilities: {}, async createSession(input) {
    if (input.model === "broken") throw new Error("candidate handshake failed");
    return input.model === "next" ? nextSession : oldSession;
  } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  const base = { agentId: "cli_stageA1", name: "stage", runtime: "pi", workspaceDir: "/tmp" };
  await host.start([{ ...base, model: "old" }]);
  await assert.rejects(host.stage({ ...base, model: "broken" }), /candidate handshake failed/);
  assert.deepEqual(oldSession.closes, []);
  assert.equal((await host.deliver(base.agentId, { message_id: "om_old_still_usable" })).status, "accepted");
  oldSession.emit({ type: "turn-end" });
  const staged = await host.stage({ ...base, model: "next" });
  assert.deepEqual(oldSession.closes, []);
  await staged.commit();
  assert.deepEqual(oldSession.closes, ["runtime candidate committed"]);
  assert.equal((await host.deliver(base.agentId, { message_id: "om_next_usable" })).status, "accepted");
  assert.equal(nextSession.prompts.length, 1);
  await host.shutdown("done");
});

test("RuntimeHost fresh reset replaces only an idle zero-backlog Agent and is generation-isolated", async () => {
  const sessions = [];
  const adapter = { id: "pi", capabilities: {}, async createSession(input) {
    const session = new FakeSession();
    session.sessionId = `session-${sessions.length + 1}`;
    sessions.push({ session, input });
    return session;
  } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  const base = { name: "reset", runtime: "pi", model: "model", workspaceDir: "/tmp" };
  await host.start([
    { ...base, agentId: "cli_resetA1", sessionId: "resume-old" },
    { ...base, agentId: "cli_otherA1", sessionId: "other-old" },
  ]);
  const result = await host.resetSession("cli_resetA1");
  assert.equal(result.generationChanged, true);
  assert.equal(result.sessionChanged, true);
  assert.equal(result.turns, 0);
  assert.equal(result.runtimeReady, true);
  assert.equal(sessions[2].input.resumeSessionId, null);
  assert.deepEqual(sessions[0].session.closes, ["fresh session reset committed"]);
  assert.deepEqual(sessions[1].session.closes, []);
  await host.shutdown("done");
});

test("RuntimeHost fresh reset refuses busy and canonical Inbox backlog without mutation", async () => {
  const session = new FakeSession();
  const store = {
    readJson(_key, fallback) { return fallback; },
    readNdjson() { return [{ message_id: "om_pending" }]; },
    writeJson() {},
    withInboxTransaction(operation) { return operation(); },
  };
  const host = createRuntimeHost({
    adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store,
  });
  await host.start([{ agentId: "cli_resetBlockedA1", name: "blocked", runtime: "codex", model: "model", workspaceDir: "/tmp" }]);
  await assert.rejects(host.resetSession("cli_resetBlockedA1"), (error) => error.code === "inbox_backlog" && error.pendingCount === 1);
  assert.deepEqual(session.closes, []);
  session.emit({ type: "turn-start" });
  store.readNdjson = () => [];
  await assert.rejects(host.resetSession("cli_resetBlockedA1"), (error) => error.code === "agent_busy");
  assert.deepEqual(session.closes, []);
  await host.shutdown("done");
});

test("RuntimeHost aborts a staged reset when Inbox arrival or turn start races creation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reset-race-"));
  const agentId = "cli_resetRaceA1";
  const store = createAgentStateStore(root, agentId);
  const old = new FakeSession(); old.sessionId = "old-race";
  let creates = 0, release;
  const adapter = { id: "codex", capabilities: {}, async createSession() {
    creates += 1;
    if (creates === 1) return old;
    const fresh = new FakeSession(); fresh.sessionId = `fresh-race-${creates}`;
    await new Promise((resolve) => { release = resolve; });
    return fresh;
  } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    await host.start([{ agentId, name: "race", runtime: "codex", model: "model", workspaceDir: "/tmp" }]);
    const inboxRace = host.resetSession(agentId);
    await new Promise((resolve) => setImmediate(resolve));
    store.appendNdjson("inbox", { message_id: "om_raced", target: "chat:oc_race" });
    release();
    await assert.rejects(inboxRace, (error) => error.code === "inbox_backlog");
    assert.deepEqual(old.closes, []);
    store.pollInbox();

    const turnRace = host.resetSession(agentId);
    await new Promise((resolve) => setImmediate(resolve));
    old.emit({ type: "turn-start" });
    release();
    await assert.rejects(turnRace, (error) => error.code === "agent_busy");
    assert.deepEqual(old.closes, []);
    old.emit({ type: "turn-end" });
  } finally {
    await host.shutdown("done");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("RuntimeHost context-overflow recovery stages no-resume, rearms exact records, and schedules normal retry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-context-runtime-recovery-"));
  const agentId = "cli_contextRuntimeA1";
  const store = createAgentStateStore(root, agentId);
  const messages = ["om_runtime_overflow_1", "om_runtime_overflow_2", "om_runtime_overflow_3", "om_runtime_overflow_4"];
  for (const messageId of messages) store.appendNdjson("inbox", { message_id: messageId, chat_id: "oc_runtime_overflow", content: "synthetic" });
  store.writeJson("runtimeDeliveries", { version: 1, records: messages.map((messageId, index) => ({
    deliveryId: `runtime-delivery-${index}`, messageId, status: "error", retryable: false,
    reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window",
    input: { inputId: `runtime-input-${index}`, deliveryId: `runtime-delivery-${index}`, kind: "wake", text: "redacted", attempt: 0 }, updatedAt: "before",
  })) });
  const sessions = [];
  try {
    const adapter = { id: "pi", capabilities: {}, async createSession(input) {
      const session = new FakeSession(); session.sessionId = sessions.length === 0 ? "old-context-session" : `fresh-context-${sessions.length}`;
      sessions.push({ session, input }); return session;
    } };
    const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
    await host.start([{ agentId, name: "context", runtime: "pi", model: "model", workspaceDir: "/tmp", sessionId: "resume-old" }]);
    const result = await host.recoverSession(agentId, "context-overflow");
    assert.equal(result.rearmedCount, 4);
    assert.equal(result.replayStatus, "pending", "the Inbox remains durable until the normal Runtime poll consumes it");
    assert.equal(sessions[1].input.resumeSessionId, null);
    assert.deepEqual(sessions[0].session.closes, ["context-window recovery committed"]);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const ledger = store.readJson("runtimeDeliveries", { records: [] });
    assert.equal(ledger.records.filter((record) => record.messageId.startsWith("om_runtime_overflow_")).length, 4);
    assert.equal(new Set(ledger.records.map((record) => record.deliveryId)).size, 4);
    assert.equal(ledger.records.filter((record) => record.status === "accepted").length, 1, "retry uses the existing delivery identity");
    const sessionsBeforeRepeat = sessions.length;
    const repeatDeadline = Date.now() + 1_000;
    while (host.isBusy?.(agentId) && Date.now() < repeatDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    await assert.rejects(host.recoverSession(agentId, "context-overflow"), (error) => ["agent_busy", "recovery_refused"].includes(error.code));
    assert.equal(sessions.length, sessionsBeforeRepeat, "repeating recovery does not stage another Runtime session");
    await host.shutdown("done");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("RuntimeHost context-overflow recovery closes the staged session and preserves the old session on commit race", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-context-runtime-race-"));
  const agentId = "cli_contextRaceA1";
  const store = createAgentStateStore(root, agentId);
  store.appendNdjson("inbox", { message_id: "om_context_race", chat_id: "oc_context_race", content: "synthetic" });
  store.writeJson("runtimeDeliveries", { version: 1, records: [{ deliveryId: "delivery-context-race", messageId: "om_context_race",
    status: "error", retryable: false, reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window", input: { inputId: "input-context-race", deliveryId: "delivery-context-race", kind: "wake", text: "redacted", attempt: 0 }, updatedAt: "before" }] });
  const sessions = [];
  try {
    const adapter = { id: "pi", capabilities: {}, async createSession(input) {
      const session = new FakeSession(); session.sessionId = sessions.length === 0 ? "old-race-session" : "fresh-race-session";
      sessions.push({ session, input }); return session;
    } };
    const racingStore = { readJson: store.readJson.bind(store), readNdjson: store.readNdjson.bind(store),
      writeJson: store.writeJson.bind(store), withInboxTransaction: store.withInboxTransaction.bind(store),
      resolveInboxDeliverySource: store.resolveInboxDeliverySource.bind(store), rearmContextOverflow(callback) {
      store.appendNdjson("inbox", { message_id: "om_context_arrived_during_stage", chat_id: "oc_context_race", content: "synthetic" });
      return store.rearmContextOverflow(callback);
    } };
    const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => racingStore });
    await host.start([{ agentId, name: "race", runtime: "pi", model: "model", workspaceDir: "/tmp" }]);
    await assert.rejects(host.recoverSession(agentId, "context-overflow"), /canonical Inbox row has no Runtime delivery record/);
    assert.deepEqual(sessions[0].session.closes, []);
    assert.deepEqual(sessions[1].session.closes, ["context-window recovery not committed"]);
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "error");
    await host.shutdown("done");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("RuntimeHost context-overflow recovery rolls back durable rearm when fresh subscription fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-context-subscribe-failure-"));
  const agentId = "cli_contextSubscribeA1";
  const store = createAgentStateStore(root, agentId);
  store.appendNdjson("inbox", { message_id: "om_context_subscribe", chat_id: "oc_context_subscribe", content: "synthetic" });
  store.writeJson("runtimeDeliveries", { version: 1, records: [{ deliveryId: "d-subscribe", messageId: "om_context_subscribe", status: "error", retryable: false, reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window", input: { inputId: "i-subscribe", deliveryId: "d-subscribe" }, updatedAt: "before" }] });
  const sessions = [];
  try {
    const adapter = { id: "pi", capabilities: {}, async createSession(input) {
      const session = new FakeSession(); session.sessionId = sessions.length === 0 ? "old-subscribe" : "fresh-subscribe";
      if (sessions.length > 0) session.subscribeFailure = "injected subscription failure";
      sessions.push({ session, input }); return session;
    } };
    const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
    await host.start([{ agentId, name: "subscribe", runtime: "pi", model: "model", workspaceDir: "/tmp" }]);
    await assert.rejects(host.recoverSession(agentId, "context-overflow"), /subscription failed/);
    assert.deepEqual(sessions[0].session.closes, []);
    assert.deepEqual(sessions[1].session.closes, ["context-window recovery subscription failed"]);
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "error");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("RuntimeHost context-overflow recovery rolls back durable rearm when commit emission fails", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-context-emission-failure-"));
  const agentId = "cli_contextEmissionA1";
  const store = createAgentStateStore(root, agentId);
  store.appendNdjson("inbox", { message_id: "om_context_emission", chat_id: "oc_context_emission", content: "synthetic" });
  store.writeJson("runtimeDeliveries", { version: 1, records: [{ deliveryId: "d-emission", messageId: "om_context_emission", status: "error", retryable: false, reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window", input: { inputId: "i-emission", deliveryId: "d-emission" }, updatedAt: "before" }] });
  const sessions = [];
  let failEmission = false;
  try {
    const adapter = { id: "pi", capabilities: {}, async createSession(input) {
      const session = new FakeSession(); session.sessionId = sessions.length === 0 ? "old-emission" : "fresh-emission";
      if (sessions.length > 0) session.unsubscribeFailure = "injected unsubscribe failure";
      sessions.push({ session, input }); return session;
    } };
    const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
    host.subscribe((event) => { if (failEmission && event.type === "session") throw new Error("injected commit emission failure"); });
    await host.start([{ agentId, name: "emission", runtime: "pi", model: "model", workspaceDir: "/tmp" }]);
    failEmission = true;
    await assert.rejects(host.recoverSession(agentId, "context-overflow"), /not committed/);
    assert.deepEqual(sessions[0].session.closes, []);
    assert.deepEqual(sessions[1].session.closes, ["context-window recovery not committed"]);
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "error");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("RuntimeHost isolates a missing runtime and keeps healthy agents active", async () => {
  const healthy = new FakeSession();
  const events = [];
  const host = createRuntimeHost({
    adapterFor(runtime) {
      return runtime === "pi"
        ? { id: "pi", capabilities: {}, async createSession() { throw new RuntimePrerequisiteError({ runtime: "pi", state: "missing", reason: "pi not found", nextAction: "install pi" }); } }
        : { id: "codex", capabilities: {}, async createSession() { return healthy; } };
    },
    promptBuilder: new ContextPromptBuilder(),
  });
  host.subscribe((event) => events.push(event));
  await host.start([
    { agentId: "cli_badPiA1", name: "bad", runtime: "pi", model: "default", workspaceDir: "/tmp" },
    { agentId: "cli_goodCodexA1", name: "good", runtime: "codex", model: "default", workspaceDir: "/tmp" },
  ]);
  assert.ok(events.some((event) => event.type === "agent-status" && event.agentId === "cli_badPiA1" && event.readiness?.state === "missing"));
  assert.ok(events.some((event) => event.type === "agent-status" && event.agentId === "cli_goodCodexA1" && event.status === "active"));
  await host.shutdown("done");
});

test("RuntimeHost retries unavailable readiness through bounded recreate instead of disabling the Agent", async () => {
  const session = new FakeSession();
  let probes = 0;
  const adapter = { id: "pi", capabilities: {}, async probe() {
    probes += 1;
    return probes === 1 ? { runtime: "pi", state: "unavailable", reason: "get_state timeout", nextAction: "retry" }
      : { runtime: "pi", state: "ready" };
  }, async createSession() { return session; } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    retryPolicy: { baseDelayMs: 2, maxDelayMs: 2, maxAttempts: 2 } });
  await host.start([{ agentId: "cli_transientPiA1", name: "transient", runtime: "pi", model: "model", workspaceDir: "/tmp" }]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(probes, 2);
  assert.equal((await host.deliver("cli_transientPiA1", { message_id: "om_after_retry" })).status, "accepted");
  await host.shutdown("done");
});

test("RuntimeHost stops recreate when the latest probe changes from unavailable to fatal", async () => {
  let probes = 0;
  const events = [];
  const adapter = { id: "pi", capabilities: {}, async probe() {
    probes += 1;
    return probes === 1 ? { runtime: "pi", state: "unavailable", reason: "network timeout", nextAction: "retry" }
      : { runtime: "pi", state: "unauthenticated", reason: "login required", nextAction: "login" };
  }, async createSession() { throw new Error("must not create"); } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    retryPolicy: { baseDelayMs: 2, maxDelayMs: 2, maxAttempts: 5 } });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_transitionPiA1", name: "transition", runtime: "pi", model: "model", workspaceDir: "/tmp" }]);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(probes, 2);
  assert.ok(events.some((event) => event.type === "agent-status" && event.readiness?.state === "unauthenticated"));
  await host.shutdown("done");
});

for (const [runtime, intermediates] of [
  ["codex", ["thinking", "text"]],
  ["claude", ["thinking", "text", "tool"]],
  ["pi", ["thinking", "text", "tool"]],
]) {
  test(`RuntimeHost projects ${runtime} normalized boundaries through the shared processing-eye contract`, async () => {
    const session = new FakeSession();
    const adapter = { id: runtime, capabilities: {}, async createSession() { return session; } };
    const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
    const timers = [], calls = [];
    const eye = new ProcessingEyeOrchestrator({
      cliForAgent: () => ({ command: "/test/official-lark-cli", argsPrefix: [], env: {} }),
      execFile(_command, args, _options, callback) {
        calls.push(args);
        callback(null, JSON.stringify(args.includes("POST") ? { data: { reaction_id: `react-${runtime}` } } : { ok: true }), "");
        return {};
      },
      writePending() {},
      setTimer(callback, delay) {
        const timer = { callback, delay, cancelled: false };
        timers.push(timer);
        return timer;
      },
      clearTimer(timer) { timer.cancelled = true; },
    });
    host.subscribe((event) => {
      if (event.type === "activity") eye.observeActivity({ agentId: "cli_eyeContractA1", name: "eye", feishuProfile: "eye" }, event.activity);
    });
    await host.start([{ agentId: "cli_eyeContractA1", name: "cli_eyeContractA1", runtime, model: "model", workspaceDir: "/tmp" }]);
    eye.add({ agentId: "cli_eyeContractA1", name: "eye", feishuProfile: "eye" }, `om_${runtime}_contract`);
    session.emit({ type: "turn-start" });
    for (const activity of intermediates) session.emit({ type: "activity", activity });
    session.emit({ type: "turn-end" });
    assert.equal(calls.filter((args) => args.includes("DELETE")).length, 0);
    const completion = timers.find((timer) => timer.delay === 1_000 && !timer.cancelled);
    assert.ok(completion);
    completion.callback();
    assert.equal(calls.filter((args) => args.includes("DELETE")).length, 1);
    await host.shutdown("processing-eye contract test complete");
  });
}

test("Runtime Host owns duplicate suppression, busy delivery and turn-boundary retry without cancel", async () => {
  const session = new FakeSession();
  const adapter = { id: "codex", capabilities: { standingPrompt: "append", sessionResume: true, busyInput: "direct", cancel: true }, async createSession(input) {
    assert.match(input.standingPrompt.content, /inbox check/);
    assert.match(input.standingPrompt.content, /larkin inbox poll/);
    assert.match(input.standingPrompt.content, /larkin im \+messages-send/);
    assert.doesNotMatch(input.standingPrompt.content, /(?:^|\s)lark-cli im /m);
    assert.equal(input.resumeSessionId, "old-session");
    return session;
  } };
  const events = [];
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_hostA1", name: "cli_hostA1", runtime: "codex", model: "gpt", workspaceDir: "/tmp", sessionId: "old-session" }]);

  const first = await host.deliver("cli_hostA1", { message_id: "om_1", seq: 1 });
  assert.equal(first.status, "accepted");
  assert.equal(session.prompts.length, 1);
  assert.match(session.prompts[0].text, /Inbox changed/);
  assert.match(session.prompts[0].text, /Poll that target/);
  assert.doesNotMatch(session.prompts[0].text, /larkin message check/);
  assert.deepEqual(await host.deliver("cli_hostA1", { message_id: "om_1", seq: 1 }), { status: "duplicate", deliveryId: first.deliveryId });

  session.emit({ type: "turn-start", turnId: "turn-1" });
  session.nextBusy = { status: "deferred", inputId: "ignored", reason: "turn raced" };
  const deferred = await host.deliver("cli_hostA1", { message_id: "om_2", seq: 2 });
  assert.equal(deferred.status, "deferred");
  assert.equal(session.steers.length, 1);
  assert.deepEqual(session.cancels, []);
  session.nextBusy = null;
  session.emit({ type: "turn-end", turnId: "turn-1" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 2, "deferred input is retried after the safe turn boundary");
  assert.ok(events.some((event) => event.type === "session" && event.sessionId === "session-1"));
  assert.ok(events.some((event) => event.type === "delivery" && event.deliveryId === first.deliveryId
    && event.status === "deferred" && /before Inbox consumption/.test(event.reason)),
  "an accepted-but-undrained delivery is visible when the runtime turn ends");
  await host.shutdown("test complete");
});

test("issue 122 injected former prompt-builder target omission retries while the corrected exact-target path is terminal", async () => {
  const run = async (formerPromptOmission) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), formerPromptOmission ? "larkin-issue122-former-prompt-" : "larkin-issue122-current-"));
    const agentId = formerPromptOmission ? "cli_issue122FormerA1" : "cli_issue122CurrentA1";
    const store = createAgentStateStore(root, agentId);
    const session = new FakeSession();
    const canonicalBuilder = new ContextPromptBuilder();
    const promptBuilder = formerPromptOmission ? {
      build(input) { return canonicalBuilder.build(input); },
      buildInboxNotice(input) { return canonicalBuilder.buildInboxNotice({ ...input, target: undefined }); },
    } : canonicalBuilder;
    const host = createRuntimeHost({
      adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
      promptBuilder, stateStoreFor: () => store,
    });
    try {
      await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root }]);
      const source = { kind: "reminder", message_id: formerPromptOmission ? "rem_issue122_former" : "rem_issue122_current",
        target: "runtime:reminder", channel_type: "dm", channel_name: "system", wake: true };
      store.appendNdjson("inbox", source);
      assert.equal(store.readNdjson("inbox")[0].target, "runtime:reminder");
      await host.deliver(agentId, source);
      if (formerPromptOmission) {
        assert.doesNotMatch(session.prompts[0].text, /Inbox changed for /, "injected former prompt-builder omission produces a targetless final payload");
      } else {
        assert.match(session.prompts[0].text, /Inbox changed for runtime:reminder/, "new final payload names the exact poll target");
        const polled = store.pollInbox({ target: "runtime:reminder", limit: 1 });
        assert.deepEqual(polled.envelopes.map((row) => row.message_id), [source.message_id]);
      }
      session.emit({ type: "turn-start", turnId: formerPromptOmission ? "former-turn" : "current-turn" });
      session.emit({ type: "turn-end", turnId: formerPromptOmission ? "former-turn" : "current-turn" });
      await new Promise((resolve) => setImmediate(resolve));
      return { prompts: session.prompts.length, inbox: store.readNdjson("inbox"),
        statuses: store.readJson("runtimeDeliveries", { records: [] }).records.map((record) => record.status) };
    } finally {
      await host.shutdown("issue 122 counterfactual complete");
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
  const oldResult = await run(true);
  const newResult = await run(false);
  assert.equal(oldResult.prompts, 2, "the injected former prompt-builder target omission leaves the valid durable row and retries at turn end");
  assert.equal(oldResult.inbox.length, 1);
  assert.deepEqual(oldResult.statuses, ["accepted"]);
  assert.equal(newResult.prompts, 1, "exact-target durable poll prevents turn-end retry");
  assert.deepEqual(newResult.inbox, []);
  assert.deepEqual(newResult.statuses, ["consumed"]);
});

test("Codex compatibility recovery closes, updates once, recreates, and retries the owned delivery", async () => {
  const sessions = [];
  let recoveries = 0;
  const adapter = {
    id: "codex", capabilities: {},
    async createSession() {
      const session = new FakeSession();
      session.sessionId = `compat-${sessions.length + 1}`;
      sessions.push(session);
      return session;
    },
    async recoverConfigurationError(message) {
      recoveries += 1;
      assert.match(message, /requires a newer version of Codex/);
      return recoveries === 1
        ? { recovered: true, reason: "Codex update succeeded: upgraded" }
        : { recovered: false, reason: "Codex update was already attempted during this runtime startup" };
    },
  };
  const events = [];
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    retryPolicy: { baseDelayMs: 3, maxDelayMs: 3, maxAttempts: 2 } });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_compatA1", name: "cli_compatA1", runtime: "codex", model: "new-model", workspaceDir: "/tmp" }]);
  const receipt = await host.deliver("cli_compatA1", { message_id: "om_compat" });
  sessions[0].emit({ type: "configuration-error", message: "selected model requires a newer version of Codex" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recoveries, 1);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].prompts.length, 1);
  assert.equal(sessions[1].prompts[0].inputId, receipt.deliveryId, "recovery retains and retries the original delivery ownership");
  assert.ok(events.some((event) => event.type === "delivery" && event.deliveryId === receipt.deliveryId && event.status === "deferred"));
  sessions[1].emit({ type: "configuration-error", message: "selected model requires a newer version of Codex" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(recoveries, 2);
  assert.equal(sessions.length, 2, "a completed update attempt cannot create an infinite recovery loop");
  const later = await host.deliver("cli_compatA1", { message_id: "om_after_attempt" });
  assert.equal(later.status, "deferred");
  assert.match(later.reason, /already attempted/);
  await host.shutdown("test complete");
});

test("Runtime Host reserves a turn before prompt yields so the second delivery steers", async () => {
  let release;
  const session = new FakeSession();
  session.prompt = async (input) => { session.prompts.push(input); await new Promise((resolve) => { release = resolve; }); return { status: "accepted", inputId: input.inputId }; };
  const adapter = { id: "codex", capabilities: {}, async createSession() { return session; } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  await host.start([{ agentId: "cli_raceA1", name: "cli_raceA1", runtime: "codex", model: "gpt", workspaceDir: "/tmp" }]);
  const first = host.deliver("cli_raceA1", { message_id: "om_first" });
  const second = await host.deliver("cli_raceA1", { message_id: "om_second" });
  assert.equal(session.prompts.length, 1);
  assert.equal(session.steers.length, 1);
  assert.equal(second.status, "accepted");
  release();
  assert.equal((await first).status, "accepted");
  await host.shutdown("test complete");
});

test("delivery ownership, dedupe and correlation survive recreation and reach consumed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-persist-"));
  const agentId = "cli_persistA1";
  const store = createAgentStateStore(root, agentId);
  const sessions = [];
  const adapter = { id: "codex", capabilities: {}, async createSession() { const session = new FakeSession(); session.sessionId = `session-${sessions.length + 1}`; sessions.push(session); return session; } };
  const config = { agentId, name: agentId, runtime: "codex", model: "gpt", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root };
  try {
    const persistedEnvelope = { message_id: "om_persist", target: "chat:oc_persist", chat_id: "oc_persist", content: "canonical" };
    store.appendNdjson("inbox", persistedEnvelope);
    const host1 = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
    await host1.start([config]);
    const accepted = await host1.deliver(agentId, persistedEnvelope);
    await host1.shutdown("simulated process exit");

    const events = [];
    const host2 = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
    host2.subscribe((event) => events.push(event));
    await host2.start([config]);
    assert.equal(sessions[1].prompts[0].inputId, accepted.deliveryId, "pending reconstruction preserves deliveryId");
    assert.deepEqual(await host2.deliver(agentId, persistedEnvelope), { status: "duplicate", deliveryId: accepted.deliveryId });
    store.drainInbox();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.ok(events.some((event) => event.type === "delivery" && event.status === "consumed" && event.deliveryId === accepted.deliveryId));
    const persisted = store.readJson("runtimeDeliveries", { records: [] });
    assert.equal(persisted.records.find((record) => record.deliveryId === accepted.deliveryId).status, "consumed");
    await host2.shutdown("test complete");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("turn end re-wakes only accepted canonical rows left by a partial poll, including arrivals during the turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-partial-rewake-"));
  const agentId = "cli_partialRewakeA1";
  const store = createAgentStateStore(root, agentId);
  const session = new FakeSession();
  const telemetryOrder = [];
  const host = createRuntimeHost({
    adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: () => store,
    telemetry: {
      async phase(_messageId, _name, _kind, operation) { return operation(); },
      delivery(_agentId, _messageId, status) { if (status === "consumed") telemetryOrder.push("consumed"); },
      runtimeEvent(_agentId, event) { if (event.type === "turn-end") telemetryOrder.push("turn-end"); },
    },
  });
  const config = { agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root };
  try {
    await host.start([config]);
    const target = "chat:oc_partial";
    const receipts = [];
    for (const messageId of ["om_partial_1", "om_partial_2", "om_partial_3"]) {
      store.appendNdjson("inbox", { message_id: messageId, target, content: messageId });
      receipts.push(await host.deliver(agentId, { message_id: messageId, target }));
    }
    session.emit({ type: "turn-start", turnId: "turn-partial" });
    const first = store.pollInbox({ target, limit: 1 });
    assert.deepEqual(first.envelopes.map((row) => row.message_id), ["om_partial_1"]);
    assert.equal(first.pendingCount, 2);

    store.appendNdjson("inbox", { message_id: "om_partial_4", target, content: "arrived during turn" });
    receipts.push(await host.deliver(agentId, { message_id: "om_partial_4", target }));
    session.emit({ type: "turn-end", turnId: "turn-partial" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(telemetryOrder.slice(0, 2), ["consumed", "turn-end"],
      "turn-end closes telemetry only after authoritative Inbox reconciliation observes direct consumption");

    assert.equal(session.prompts.length, 2, "remaining canonical rows schedule one replacement wake at the safe boundary");
    assert.equal(session.prompts[1].inputId, receipts[1].deliveryId, "retry preserves the oldest unconsumed delivery identity");
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), ["om_partial_2", "om_partial_3", "om_partial_4"]);
    const statusesAfterRetry = Object.fromEntries(store.readJson("runtimeDeliveries", { records: [] }).records
      .map((record) => [record.messageId, record.status]));
    assert.deepEqual(statusesAfterRetry, {
      om_partial_1: "consumed",
      om_partial_2: "accepted",
      om_partial_3: "pending",
      om_partial_4: "pending",
    });

    const drained = store.pollInbox({ target });
    assert.deepEqual(drained.envelopes.map((row) => row.message_id), ["om_partial_2", "om_partial_3", "om_partial_4"]);
    assert.equal(drained.pendingCount, 0);
    assert.equal(drained.envelopes.some((row) => row.message_id === "om_partial_1"), false, "the direct-acked body is never replayed");
    session.emit({ type: "turn-start", turnId: "turn-drained" });
    session.emit({ type: "turn-end", turnId: "turn-drained" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.prompts.length, 2, "a fully drained target produces no replacement wake");
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records.every((record) => record.status === "consumed"), true);
  } finally {
    await host.shutdown("partial re-wake test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("turn end retries an accepted wake when the Agent never polls without advancing the Inbox cursor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-no-poll-rewake-"));
  const agentId = "cli_noPollRewakeA1";
  const store = createAgentStateStore(root, agentId);
  const session = new FakeSession();
  const events = [];
  const host = createRuntimeHost({
    adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: () => store,
  });
  host.subscribe((event) => events.push(event));
  try {
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root }]);
    const target = "chat:oc_no_poll";
    store.appendNdjson("inbox", { message_id: "om_no_poll", target, content: "still pending" });
    const receipt = await host.deliver(agentId, { message_id: "om_no_poll", target });
    const stateBefore = store.readJson("inboxState", {});
    session.emit({ type: "turn-start", turnId: "turn-no-poll" });
    session.emit({ type: "turn-end", turnId: "turn-no-poll" });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(session.prompts.length, 2);
    assert.equal(session.prompts[1].inputId, receipt.deliveryId);
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), ["om_no_poll"]);
    assert.deepEqual(store.readJson("inboxState", {}), stateBefore, "re-waking alone must not advance model-seen state");
    assert.ok(events.some((event) => event.type === "delivery" && event.deliveryId === receipt.deliveryId
      && event.status === "deferred" && /before Inbox consumption/.test(event.reason)));
  } finally {
    await host.shutdown("no-poll re-wake test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("startup migration consumes orphan synthetic active deliveries and quarantines a real message without canonical Inbox evidence", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-synthetic-migration-"));
  const agentId = "cli_migrateA1";
  const store = createAgentStateStore(root, agentId);
  const session = new FakeSession();
  const record = (deliveryId, messageId) => ({ deliveryId, messageId, status: "accepted",
    input: { inputId: deliveryId, deliveryId, kind: "wake", text: "check", attempt: 0 }, updatedAt: "2026-07-19T00:00:00.000Z" });
  store.writeJson("runtimeDeliveries", { version: 1, records: [
    record("delivery-redeliver", "redeliver_509c"), record("delivery-reminder", "rem_legacy"),
    record("delivery-interaction", "interaction_run_missing"), record("delivery-real", "om_real_missing"),
  ] });
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root }]);
    assert.deepEqual(session.prompts, [], "a real message without canonical Inbox evidence is never resubmitted from stale text");
    const records = Object.fromEntries(store.readJson("runtimeDeliveries", { records: [] }).records
      .map((item) => [item.messageId, item]));
    assert.equal(records.redeliver_509c.status, "consumed");
    assert.equal(records.rem_legacy.status, "consumed");
    assert.equal(records.interaction_run_missing.status, "consumed");
    assert.equal(records.om_real_missing.status, "error");
    assert.equal(records.om_real_missing.retryable, false);
    assert.match(records.om_real_missing.reason, /canonical_inbox_row_missing/);
    assert.notEqual(records.om_real_missing.input.text, "check", "quarantine scrubs the stale targetless Runtime input");
  } finally {
    await host.shutdown("test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a canonical drain that wins before the current deliver call atomically closes the newly-created generic ledger", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-post-delivery-reconcile-"));
  const agentId = "cli_postDrainA1";
  const store = createAgentStateStore(root, agentId);
  const session = new FakeSession();
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    store.appendNdjson("inbox", { message_id: "om_drain_won", target: "chat:oc_drain_won", wake: true });
    store.drainInbox();
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root }]);
    const receipt = await host.deliver(agentId, { message_id: "om_drain_won", wake: true });
    assert.equal(receipt.status, "accepted");
    const record = store.readJson("runtimeDeliveries", { records: [] }).records
      .find((candidate) => candidate.deliveryId === receipt.deliveryId);
    assert.equal(record.status, "consumed");
    assert.equal(store.readNdjson("inbox").length, 0);
  } finally {
    await host.shutdown("test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("closed runtime is discarded and recreated; late stale events are ignored", async () => {
  const sessions = [];
  const adapter = { id: "claude", capabilities: {}, async createSession() { const session = new FakeSession(); session.sessionId = `s-${sessions.length + 1}`; sessions.push(session); return session; } };
  const events = [];
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    retryPolicy: { baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 3 } });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_crashA1", name: "cli_crashA1", runtime: "claude", model: "claude", workspaceDir: "/tmp" }]);
  await host.deliver("cli_crashA1", { message_id: "om_crash" });
  sessions[0].emit({ type: "closed", code: 1, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].prompts[0].inputId, sessions[0].prompts[0].inputId);
  const before = events.length;
  sessions[0].emit({ type: "turn-start" });
  assert.equal(events.length, before, "replaced session cannot mutate current state");
  await host.shutdown("test complete");
});

test("async retryable input-error returns an accepted Pi delivery to pending and retries it", async () => {
  const session = new FakeSession();
  const adapter = { id: "pi", capabilities: {}, async createSession() { return session; } };
  const events = [];
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_piRejectA1", name: "cli_piRejectA1", runtime: "pi", model: "pi", workspaceDir: "/tmp" }]);
  const receipt = await host.deliver("cli_piRejectA1", { message_id: "om_pi_reject" });
  assert.equal(receipt.status, "accepted");
  session.emit({ type: "input-error", inputId: receipt.deliveryId, retryable: true, message: "provider queue rejected" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 2);
  assert.equal(session.prompts[1].inputId, receipt.deliveryId, "retry preserves delivery/input correlation");
  assert.ok(events.some((event) => event.type === "delivery" && event.status === "deferred" && event.deliveryId === receipt.deliveryId));
  await host.shutdown("test complete");
});

test("non-retryable input-error produces a terminal delivery error without resubmission", async () => {
  const session = new FakeSession();
  const adapter = { id: "pi", capabilities: {}, async createSession() { return session; } };
  const events = [];
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder() });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_piTerminalA1", name: "cli_piTerminalA1", runtime: "pi", model: "pi", workspaceDir: "/tmp" }]);
  const receipt = await host.deliver("cli_piTerminalA1", { message_id: "om_pi_terminal" });
  session.emit({ type: "input-error", inputId: receipt.deliveryId, retryable: false, message: "invalid request" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 1);
  assert.ok(events.some((event) => event.type === "delivery" && event.status === "error" && event.reason === "invalid request"));
  await host.shutdown("test complete");
});

test("RuntimeHost ingestion uses the shared strict classifier for a legacy Codex context error", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-legacy-classifier-"));
  const session = new FakeSession();
  const agentId = "cli_codexLegacyClassifierA1";
  const store = createAgentStateStore(root, agentId);
  store.appendNdjson("inbox", { message_id: "om_codex_legacy_classifier", target: "chat:oc_codex_legacy_classifier", content: "synthetic" });
  const adapter = { id: "codex", capabilities: {}, async createSession() { return session; } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  try {
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "codex", workspaceDir: "/tmp" }]);
    const receipt = await host.deliver(agentId, { message_id: "om_codex_legacy_classifier", target: "chat:oc_codex_legacy_classifier" });
    session.emit({ type: "input-error", inputId: receipt.deliveryId, retryable: false,
      message: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again." });
    await new Promise((resolve) => setImmediate(resolve));
    const record = store.readJson("runtimeDeliveries", { records: [] }).records[0];
    assert.equal(record.status, "error");
    assert.equal(record.retryable, false);
    assert.equal(record.errorCategory, "context_window");
  } finally {
    await host.shutdown("legacy classifier test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("terminal provider auth failure downgrades only its Agent and a later successful turn restores readiness", async () => {
  const failedSession = new FakeSession();
  const stagedSession = new FakeSession();
  stagedSession.sessionId = "session-staged";
  const healthySession = new FakeSession();
  const events = [];
  const host = createRuntimeHost({
    adapterFor: () => ({
      id: "pi", capabilities: {},
      async createSession(input) {
        if (input.agentId !== "cli_authFailedA1") return healthySession;
        return input.model === "bigmodel-anthropic/glm-5.2-updated" ? stagedSession : failedSession;
      },
    }),
    promptBuilder: new ContextPromptBuilder(),
  });
  host.subscribe((event) => events.push(event));
  await host.start([
    { agentId: "cli_authFailedA1", name: "failed", runtime: "pi", model: "bigmodel-anthropic/glm-5.2", workspaceDir: "/tmp" },
    { agentId: "cli_authHealthyB2", name: "healthy", runtime: "pi", model: "fixture/healthy", workspaceDir: "/tmp" },
  ]);
  const failedReceipt = await host.deliver("cli_authFailedA1", { message_id: "om_auth_failed" });
  failedSession.emit({ type: "turn-start", turnId: "turn-auth-failed" });
  failedSession.emit({
    type: "input-error", inputId: failedReceipt.deliveryId, retryable: false, willRetry: false,
    message: "API key auth failed at /Users/example/.pi/agent/bin/cc-switch-token; api_key=fixture-secret",
    errorCategory: "auth", nextAction: "unsafe raw action", upstream: { provider: "bigmodel-anthropic", message: "unsafe" },
  });
  failedSession.emit({ type: "turn-end", turnId: "turn-auth-failed" });
  await new Promise((resolve) => setImmediate(resolve));

  const downgraded = events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").at(-1);
  assert.equal(downgraded.status, "error");
  assert.equal(downgraded.readiness.state, "unauthenticated");
  assert.match(downgraded.readiness.reason, /bigmodel-anthropic.*authentication failed/i);
  assert.match(downgraded.readiness.nextAction, /login|API-key resolver/i);
  assert.doesNotMatch(JSON.stringify(downgraded), /Users\/example|cc-switch-token|fixture-secret|unsafe raw action/);
  assert.equal(events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authHealthyB2").at(-1).status, "active");
  assert.equal((await host.deliver("cli_authHealthyB2", { message_id: "om_healthy" })).status, "accepted");

  const authStatusCount = events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").length;
  const staged = await host.stage({ agentId: "cli_authFailedA1", name: "failed", runtime: "pi",
    model: "bigmodel-anthropic/glm-5.2-updated", workspaceDir: "/tmp" });
  assert.equal(staged.readiness.state, "ready", "candidate prerequisite probe remains independently ready");
  await staged.commit();
  assert.equal(events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").length,
    authStatusCount, "hot commit must not replace projected unauthenticated readiness with an error/ready status");
  assert.equal(events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").at(-1).readiness.state,
    "unauthenticated");

  const retry = await host.deliver("cli_authFailedA1", { message_id: "om_auth_failed" });
  stagedSession.emit({ type: "turn-start", turnId: "turn-auth-empty" });
  stagedSession.emit({ type: "turn-end", turnId: "turn-auth-empty" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(retry.status, "accepted");
  assert.equal(events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").at(-1).readiness.state,
    "unauthenticated", "an empty/aborted turn is not authenticated evidence");

  stagedSession.emit({ type: "turn-start", turnId: "turn-auth-aborted" });
  stagedSession.emit({ type: "activity", activity: "text" });
  stagedSession.emit({ type: "input-error", inputId: retry.deliveryId, retryable: true, willRetry: false,
    message: "Pi assistant turn aborted" });
  stagedSession.emit({ type: "turn-end", turnId: "turn-auth-aborted" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").at(-1).readiness.state,
    "unauthenticated", "partial output from an aborted turn is not authenticated success");

  stagedSession.emit({ type: "turn-start", turnId: "turn-auth-recovered" });
  stagedSession.emit({ type: "activity", activity: "text" });
  stagedSession.emit({ type: "turn-end", turnId: "turn-auth-recovered" });
  await new Promise((resolve) => setImmediate(resolve));
  const recovered = events.filter((event) => event.type === "agent-status" && event.agentId === "cli_authFailedA1").at(-1);
  assert.equal(recovered.status, "active");
  assert.equal(recovered.readiness.state, "ready");
  await host.shutdown("provider auth readiness test complete");
});

test("synchronous terminal rejection returns an explicit error receipt and a later explicit delivery retries the same ownership", async () => {
  const session = new FakeSession();
  let reject = true;
  session.prompt = async function(input) {
    this.prompts.push(input);
    return reject
      ? { status: "rejected", inputId: input.inputId, retryable: false, reason: "invalid fixture request" }
      : { status: "accepted", inputId: input.inputId };
  };
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder() });
  await host.start([{ agentId: "cli_terminalReceiptA1", name: "terminal", runtime: "codex", model: "g", workspaceDir: "/tmp" }]);
  const first = await host.deliver("cli_terminalReceiptA1", { message_id: "interaction_terminal_receipt" });
  assert.deepEqual(first, { status: "error", deliveryId: first.deliveryId, reason: "invalid fixture request", retryable: false });
  reject = false;
  const recovered = await host.deliver("cli_terminalReceiptA1", { message_id: "interaction_terminal_receipt" });
  assert.equal(recovered.status, "accepted");
  assert.equal(recovered.deliveryId, first.deliveryId);
  assert.equal(session.prompts[1].inputId, first.deliveryId);
  assert.equal(session.prompts[1].attempt, 1);
  await host.shutdown("terminal receipt contract test complete");
});

test("retryable busy-input error waits for the real turn boundary before retrying", async () => {
  const session = new FakeSession();
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder() });
  await host.start([{ agentId: "cli_busyErrorA1", name: "cli_busyErrorA1", runtime: "codex", model: "g", workspaceDir: "/tmp" }]);
  await host.deliver("cli_busyErrorA1", { message_id: "om_turn_owner" });
  session.emit({ type: "turn-start", turnId: "turn-owner" });
  const busyReceipt = await host.deliver("cli_busyErrorA1", { message_id: "om_failed_steer" });
  session.emit({ type: "input-error", inputId: busyReceipt.deliveryId, retryable: true, message: "steer rejected" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 1, "active turn is not mistaken for an idle boundary");
  session.emit({ type: "turn-end", turnId: "turn-owner" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 2);
  assert.equal(session.prompts[1].inputId, busyReceipt.deliveryId);
  await host.shutdown("test complete");
});

test("aborted prompt plus busy steer retries one owner per real terminal boundary", async () => {
  const session = new FakeSession();
  const calls = [];
  session.prompt = async function(input) {
    this.prompts.push(input); calls.push(`prompt:${input.inputId}`);
    return { status: "accepted", inputId: input.inputId };
  };
  session.busyInput = async function(input) {
    this.steers.push(input); calls.push(`steer:${input.inputId}`);
    return { status: "accepted", inputId: input.inputId };
  };
  const host = createRuntimeHost({ adapterFor: () => ({ id: "pi", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder() });
  await host.start([{ agentId: "cli_abortOwnedA1", name: "abort-owned", runtime: "pi", model: "fixture/pi", workspaceDir: "/tmp" }]);
  const prompt = await host.deliver("cli_abortOwnedA1", { message_id: "om_abort_owner_a" });
  session.emit({ type: "turn-start", turnId: "turn-abort-owned" });
  const steer = await host.deliver("cli_abortOwnedA1", { message_id: "om_abort_owner_b" });
  session.emit({ type: "activity", activity: "text" });
  session.emit({ type: "input-error", inputId: prompt.deliveryId, retryable: true, willRetry: false, message: "Pi assistant turn aborted" });
  session.emit({ type: "input-error", inputId: steer.deliveryId, retryable: true, willRetry: false, message: "Pi assistant turn aborted" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [`prompt:${prompt.deliveryId}`, `steer:${steer.deliveryId}`], "no retry may start before turn-end");

  session.emit({ type: "turn-end", turnId: "turn-abort-owned" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [`prompt:${prompt.deliveryId}`, `steer:${steer.deliveryId}`, `prompt:${prompt.deliveryId}`]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 3, "only one serialized prompt starts after the aborted boundary");

  session.emit({ type: "turn-start", turnId: "turn-abort-retry-a" });
  session.emit({ type: "turn-end", turnId: "turn-abort-retry-a" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [`prompt:${prompt.deliveryId}`, `steer:${steer.deliveryId}`, `prompt:${prompt.deliveryId}`, `prompt:${steer.deliveryId}`]);
  await host.shutdown("aborted ownership test complete");
});

test("a failed Codex turn closes both prompt and steer deliveries instead of leaving accepted ownership", async () => {
  let stored = { version: 1, records: [] };
  const stateStore = {
    withInboxTransaction(operation) { return operation(); },
    readJson(_key, fallback) { return structuredClone(stored ?? fallback); },
    writeJson(_key, value) { stored = structuredClone(value); },
  };
  const session = new FakeSession();
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => stateStore });
  await host.start([{ agentId: "cli_turnOwnA1", name: "cli_turnOwnA1", runtime: "codex", model: "g", workspaceDir: "/tmp" }]);
  const prompt = await host.deliver("cli_turnOwnA1", { message_id: "om_owned_A" });
  session.emit({ type: "turn-start", turnId: "turn-owned" });
  const steer = await host.deliver("cli_turnOwnA1", { message_id: "om_owned_B" });
  session.emit({ type: "input-error", inputId: prompt.deliveryId, retryable: false, willRetry: false, message: "turn failed" });
  session.emit({ type: "input-error", inputId: steer.deliveryId, retryable: false, willRetry: false, message: "turn failed" });
  session.emit({ type: "turn-end", turnId: "turn-owned" });
  await new Promise((resolve) => setImmediate(resolve));
  const owned = stored.records.filter((record) => [prompt.deliveryId, steer.deliveryId].includes(record.deliveryId));
  assert.deepEqual(owned.map((record) => record.status).sort(), ["error", "error"]);
  assert.equal(owned.some((record) => record.status === "accepted"), false);
  await host.shutdown("test complete");
});

test("terminal input events during a busy submission coalesce one retry after submit without spinning", async () => {
  let stored = { version: 1, records: [] };
  const stateStore = {
    withInboxTransaction(operation) { return operation(); },
    readJson(_key, fallback) { return structuredClone(stored ?? fallback); },
    writeJson(_key, value) { stored = structuredClone(value); },
  };
  const session = new FakeSession();
  let releaseBusy;
  session.busyInput = async (input) => {
    session.steers.push(input);
    return new Promise((resolve) => { releaseBusy = resolve; });
  };
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => stateStore });
  await host.start([{ agentId: "cli_coalesceA1", name: "cli_coalesceA1", runtime: "codex", model: "g", workspaceDir: "/tmp" }]);
  const prompt = await host.deliver("cli_coalesceA1", { message_id: "om_coalesce_A" });
  session.emit({ type: "turn-start", turnId: "turn-coalesce" });
  const busyDelivery = host.deliver("cli_coalesceA1", { message_id: "om_coalesce_B" });
  await new Promise((resolve) => setImmediate(resolve));
  const busyInputId = session.steers[0].inputId;
  session.emit({ type: "input-error", inputId: prompt.deliveryId, retryable: true, willRetry: false, message: "interrupted" });
  session.emit({ type: "input-error", inputId: busyInputId, retryable: true, willRetry: false, message: "interrupted" });
  session.emit({ type: "turn-end", turnId: "turn-coalesce" });
  releaseBusy({ status: "rejected", inputId: busyInputId, retryable: true, reason: "interrupted" });
  assert.equal((await busyDelivery).status, "deferred");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 2, "one coalesced retry runs after the busy submit settles");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(session.prompts.length, 2, "coalescing does not create an immediate retry spin");
  session.emit({ type: "turn-start", turnId: "turn-coalesced-retry" });
  session.emit({ type: "turn-end", turnId: "turn-coalesced-retry" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(session.prompts.length, 3, "the second pending input retries at the next real boundary");
  assert.equal(stored.records.some((record) => record.status === "pending" || record.status === "submitting"), false);
  await host.shutdown("test complete");
});

test("session recreation uses bounded exponential retries, reports exhaustion, and stop cancels timers", async () => {
  const first = new FakeSession();
  let creates = 0;
  const errors = [];
  const adapter = { id: "claude", capabilities: {}, async createSession() {
    creates += 1;
    if (creates === 1) return first;
    throw new Error(`launch-${creates}-failed`);
  } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    retryPolicy: { baseDelayMs: 4, maxDelayMs: 8, maxAttempts: 2 } });
  host.subscribe((event) => { if (event.type === "agent-status" && event.status === "error") errors.push(event.error); });
  await host.start([{ agentId: "cli_backoffA1", name: "cli_backoffA1", runtime: "claude", model: "c", workspaceDir: "/tmp" }]);
  first.emit({ type: "closed", code: 1, signal: null });
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(creates, 3, "initial session plus exactly two bounded recreation attempts");
  assert.ok(errors.some((message) => /attempt 1\/2 in 4ms/.test(message)));
  assert.ok(errors.some((message) => /attempt 2\/2 in 8ms/.test(message)));
  assert.ok(errors.some((message) => /recreation exhausted after 2 attempts/.test(message)));
  await host.shutdown("test complete");

  const delayed = new FakeSession();
  let delayedCreates = 0;
  const delayedHost = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() {
    delayedCreates += 1; return delayed;
  } }), promptBuilder: new ContextPromptBuilder(), retryPolicy: { baseDelayMs: 40, maxDelayMs: 40, maxAttempts: 2 } });
  await delayedHost.start([{ agentId: "cli_cancelRetryA1", name: "cli_cancelRetryA1", runtime: "codex", model: "g", workspaceDir: "/tmp" }]);
  delayed.emit({ type: "closed", code: 1, signal: null });
  await delayedHost.shutdown("stop before retry");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(delayedCreates, 1, "stop cancels a scheduled recreation");
});

test("accepted persistence racing CLI consumption emits consumed exactly once and not stale accepted", async () => {
  let stored = { version: 1, records: [] };
  let consumeInputId = null;
  const stateStore = {
    withInboxTransaction(operation) { return operation(); },
    readJson(_key, fallback) {
      if (!stored) return fallback;
      if (consumeInputId) stored = { ...stored, records: stored.records.map((record) =>
        record.deliveryId === consumeInputId ? { ...record, status: "consumed" } : record) };
      return structuredClone(stored);
    },
    writeJson(_key, value) { stored = structuredClone(value); },
  };
  const session = new FakeSession();
  session.prompt = async (input) => { session.prompts.push(input); consumeInputId = input.inputId; return { status: "accepted", inputId: input.inputId }; };
  const events = [];
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => stateStore });
  host.subscribe((event) => events.push(event));
  await host.start([{ agentId: "cli_consumeRaceA1", name: "cli_consumeRaceA1", runtime: "codex", model: "g", workspaceDir: "/tmp" }]);
  const receipt = await host.deliver("cli_consumeRaceA1", { message_id: "om_consume_race" });
  const deliveryEvents = events.filter((event) => event.type === "delivery" && event.deliveryId === receipt.deliveryId);
  assert.deepEqual(deliveryEvents.map((event) => event.status), ["consumed"]);
  await host.shutdown("test complete");
});

test("session closed in the subscription microtask is recreated after starting settles", async () => {
  const sessions = [];
  const adapter = { id: "claude", capabilities: {}, async createSession() {
    const session = new FakeSession();
    session.sessionId = `microtask-${sessions.length + 1}`;
    if (sessions.length === 0) {
      const baseSubscribe = session.subscribe.bind(session);
      session.subscribe = (listener) => {
        const unsubscribe = baseSubscribe(listener);
        queueMicrotask(() => session.emit({ type: "closed", code: 1, signal: null }));
        return unsubscribe;
      };
    }
    sessions.push(session);
    return session;
  } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    retryPolicy: { baseDelayMs: 3, maxDelayMs: 3, maxAttempts: 2, stableWindowMs: 20 } });
  await host.start([{ agentId: "cli_microCloseA1", name: "cli_microCloseA1", runtime: "claude", model: "c", workspaceDir: "/tmp" }]);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sessions.length, 2, "starting settlement schedules the recreate that close could not schedule synchronously");
  await host.shutdown("test complete");
});

test("short-lived successful creations share one crash epoch and reach bounded exhaustion", async () => {
  let creates = 0;
  const errors = [];
  const adapter = { id: "pi", capabilities: {}, async createSession() {
    creates += 1;
    const session = new FakeSession();
    session.sessionId = `short-${creates}`;
    const baseSubscribe = session.subscribe.bind(session);
    session.subscribe = (listener) => {
      const unsubscribe = baseSubscribe(listener);
      setTimeout(() => session.emit({ type: "closed", code: 1, signal: null }), 2);
      return unsubscribe;
    };
    return session;
  } };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    retryPolicy: { baseDelayMs: 2, maxDelayMs: 4, maxAttempts: 2, stableWindowMs: 20 } });
  host.subscribe((event) => { if (event.type === "agent-status" && event.status === "error") errors.push(event.error); });
  await host.start([{ agentId: "cli_crashEpochA1", name: "cli_crashEpochA1", runtime: "pi", model: "p", workspaceDir: "/tmp" }]);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(creates, 3, "initial session plus two recreation attempts remain bounded");
  assert.ok(errors.some((message) => /recreation exhausted after 2 attempts/.test(message)), errors.join("\n"));
  await host.shutdown("test complete");
});

const waitForCondition = async (predicate, timeout = 1_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(Boolean(predicate()), true, "condition was not reached before timeout");
};

test("issue 138: inbox_update accepted after turn_ended while submitting stays true is promoted to a wake", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue138-promote-"));
  const agentId = "cli_issue138PromoteA1";
  const store = createAgentStateStore(root, agentId);
  const session = new FakeSession();
  let releasePrompt;
  session.prompt = async (input) => {
    session.prompts.push(input);
    if (session.prompts.length === 1) await new Promise((resolve) => { releasePrompt = resolve; });
    return { status: "accepted", inputId: input.inputId };
  };
  const events = [];
  const host = createRuntimeHost({
    adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: () => store,
  });
  host.subscribe((event) => events.push(event));
  try {
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root }]);
    const target = "chat:oc_issue138";
    store.appendNdjson("inbox", { message_id: "om_issue138_first", target, content: "first" });
    const first = host.deliver(agentId, { message_id: "om_issue138_first", target });
    await waitForCondition(() => session.prompts.length === 1);
    session.emit({ type: "turn-start", turnId: "turn-issue138" });
    const polled = store.pollInbox({ target, limit: 1 });
    assert.deepEqual(polled.envelopes.map((row) => row.message_id), ["om_issue138_first"]);
    session.emit({ type: "turn-end", turnId: "turn-issue138" });
    store.appendNdjson("inbox", { message_id: "om_issue138_late", target, content: "late after turn_ended" });
    const late = await host.deliver(agentId, { message_id: "om_issue138_late", target });
    assert.equal(late.status, "accepted");
    assert.equal(session.steers.length, 1, "late arrival while submitting must take the busy inbox_update path");
    assert.equal(session.steers[0].kind, "inbox_update");
    assert.equal(session.prompts.length, 1, "no replacement wake can exist until submitting/busy clears");
    releasePrompt();
    assert.equal((await first).status, "accepted");
    await waitForCondition(() => session.prompts.some((input) => input.inputId === late.deliveryId && input.kind === "wake"));
    const promoted = session.prompts.find((input) => input.inputId === late.deliveryId);
    assert.equal(promoted.kind, "wake");
    assert.ok(events.some((event) => event.type === "delivery" && event.deliveryId === late.deliveryId
      && event.status === "deferred" && /promoted after Agent became idle/.test(event.reason)));
    const lateRecord = store.readJson("runtimeDeliveries", { records: [] }).records
      .find((record) => record.messageId === "om_issue138_late");
    assert.notEqual(lateRecord?.input?.kind, "inbox_update", "idle Agent must not keep an accepted inbox_update without a wake");
  } finally {
    await host.shutdown("issue 138 promote test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("issue 138: idle scan does not emit an extra wake when no accepted inbox_update remains", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue138-no-extra-"));
  const agentId = "cli_issue138NoExtraA1";
  const store = createAgentStateStore(root, agentId);
  const session = new FakeSession();
  const host = createRuntimeHost({
    adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: () => store,
  });
  try {
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root }]);
    const target = "chat:oc_issue138_idle";
    store.appendNdjson("inbox", { message_id: "om_issue138_consumed", target, content: "only wake" });
    const receipt = await host.deliver(agentId, { message_id: "om_issue138_consumed", target });
    assert.equal(receipt.status, "accepted");
    assert.equal(session.prompts.length, 1);
    assert.equal(session.prompts[0].kind, "wake");
    store.pollInbox({ target, limit: 1 });
    session.emit({ type: "turn-start", turnId: "turn-consumed" });
    session.emit({ type: "turn-end", turnId: "turn-consumed" });
    await new Promise((resolve) => setImmediate(resolve));
    await host.scanPendingInboxUpdates(agentId);
    await host.scanPendingInboxUpdates(agentId);
    assert.equal(session.prompts.length, 1, "drained Inbox must not synthesize a replacement wake");
    assert.equal(session.steers.length, 0);
  } finally {
    await host.shutdown("issue 138 no-extra-wake test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("issue 138: the same accepted inbox_update is not re-woken in a loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue138-noloop-"));
  const agentId = "cli_issue138NoLoopA1";
  const store = createAgentStateStore(root, agentId);
  const session = new FakeSession();
  let releasePrompt;
  session.prompt = async (input) => {
    session.prompts.push(input);
    if (session.prompts.length === 1) await new Promise((resolve) => { releasePrompt = resolve; });
    return { status: "accepted", inputId: input.inputId };
  };
  const host = createRuntimeHost({
    adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: () => store,
  });
  try {
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root }]);
    const target = "chat:oc_issue138_noloop";
    store.appendNdjson("inbox", { message_id: "om_issue138_owner", target, content: "owner" });
    const first = host.deliver(agentId, { message_id: "om_issue138_owner", target });
    await waitForCondition(() => session.prompts.length === 1);
    session.emit({ type: "turn-start", turnId: "turn-noloop" });
    store.pollInbox({ target, limit: 1 });
    session.emit({ type: "turn-end", turnId: "turn-noloop" });
    store.appendNdjson("inbox", { message_id: "om_issue138_stuck", target, content: "stuck update" });
    const late = await host.deliver(agentId, { message_id: "om_issue138_stuck", target });
    releasePrompt();
    await first;
    await waitForCondition(() => session.prompts.filter((input) => input.inputId === late.deliveryId).length === 1);
    await host.scanPendingInboxUpdates(agentId);
    await host.scanPendingInboxUpdates();
    await host.scanPendingInboxUpdates(agentId);
    const wakesForLate = session.prompts.filter((input) => input.inputId === late.deliveryId && input.kind === "wake");
    assert.equal(wakesForLate.length, 1, "the same delivery id must be promoted to wake only once");
    assert.equal(session.steers.filter((input) => input.inputId === late.deliveryId).length, 1);
  } finally {
    await host.shutdown("issue 138 no-loop test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
