import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "bun:test";
import { SpanKind } from "@opentelemetry/api";
import { createAgentStateStore } from "../../dist/agent/agent-state-store.mjs";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { createTelemetryRuntime } from "../../dist/platform/telemetry-tracing.mjs";
import { TelemetrySpool } from "../../dist/platform/telemetry-spool.mjs";
import { createNativeRuntimeAdapter } from "../../dist/runtime/runtime-adapters.mjs";
import { PiCompactionBreaker } from "../../dist/runtime/pi-compaction-recovery.mjs";
import { createRuntimeHost } from "../../dist/runtime/runtime-host.mjs";

class PreflightPiProcess extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  promptCount = 0;
  killed = [];
  constructor(options = {}) { super(); this.acceptPrompt = options.acceptPrompt !== false; }
  stdin = {
    destroyed: false,
    write: (line, callback) => {
      const request = JSON.parse(line);
      callback?.();
      if (request.type === "get_state") this.respond(request, { sessionId: "PRIVATE_SESSION",
        model: { provider: "fixture", id: "fixture-model" }, thinkingLevel: "medium" });
      else if (request.type === "get_available_models") this.respond(request,
        { models: [{ provider: "fixture", id: "fixture-model" }] });
      else if (request.type === "prompt") {
        this.promptCount += 1;
        setTimeout(() => this.event({ type: "compaction_start", reason: "threshold" }), this.acceptPrompt ? 10 : 8);
        setTimeout(() => this.event({ type: "summarization_retry_scheduled", attempt: 1, maxAttempts: 3,
          delayMs: 10, errorMessage: "PRIVATE_PROVIDER_DETAIL" }), this.acceptPrompt ? 35 : 22);
        if (this.acceptPrompt) {
          setTimeout(() => this.event({ type: "compaction_end", reason: "threshold", aborted: false, willRetry: false,
            result: { summary: "PRIVATE_SUMMARY" } }), 60);
          setTimeout(() => this.respond(request), 65);
        }
      }
      return true;
    },
    end() {},
  };
  respond(request, data) {
    queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id: request.id, type: "response", command: request.type,
      success: true, ...(data === undefined ? {} : { data }) })}\n`));
  }
  event(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  kill(signal) { this.killed.push(signal); queueMicrotask(() => this.emit("exit", null, signal)); return true; }
}

test("production-order Pi preflight progress preserves one durable Inbox delivery until delayed acceptance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-preflight-e2e-"));
  const agentId = "cli_piPreflightA1"; const messageId = "om_PRIVATE_MESSAGE";
  const stateDir = path.join(root, "state", "agents", agentId); const workspaceDir = path.join(root, "workspace");
  const store = createAgentStateStore(root, agentId); const child = new PreflightPiProcess(); let spawnCount = 0;
  const previousConfigDir = process.env.LARKIN_CONFIG_DIR;
  process.env.LARKIN_CONFIG_DIR = path.join(root, "config");
  const telemetryConfig = { spoolDir: path.join(root, "telemetry", "spool"), headers: {}, maxBytes: 1024 * 1024,
    maxFiles: 100, maxAgeMs: 60_000, uploadIntervalMs: 60_000, requestTimeoutMs: 2_000 };
  const telemetry = createTelemetryRuntime(telemetryConfig, { stateDirFor: () => stateDir });
  const native = createNativeRuntimeAdapter("pi", {
    env: { LARKIN_PI_DISTRIBUTION: "builtin", LARKIN_CONFIG_DIR: path.join(root, "config") },
    spawn: () => { spawnCount += 1; return child; },
    piRpcClientOptions: { requestTimeoutMs: 5, inputTimeoutMs: 20, inputProgressTimeoutMs: 40, inputMaxTimeoutMs: 100 },
  });
  const adapter = { id: native.id, capabilities: native.capabilities,
    probe: async () => ({ runtime: "pi", state: "ready" }), createSession: (input) => native.createSession(input) };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: () => store, telemetry, retryPolicy: { baseDelayMs: 2, maxDelayMs: 2, maxAttempts: 2 },
    assertOfficialCliReady: () => {} });
  const target = "chat:oc_private_target";
  const envelope = { message_id: messageId, target, content: "PRIVATE_PROMPT_BODY", wake: true };
  try {
    fs.mkdirSync(workspaceDir, { recursive: true });
    await host.start([{ agentId, name: agentId, runtime: "pi", model: "default", piDistribution: "builtin",
      workspaceDir, stateDir, env: { LARKIN_PI_DISTRIBUTION: "builtin", LARKIN_CONFIG_DIR: path.join(root, "config") } }]);
    store.prepareInboxDelivery(envelope); telemetry.beginMessage(agentId, messageId);
    const delivery = telemetry.phase(messageId, "runtime.deliver", SpanKind.PRODUCER, () => host.deliver(agentId, envelope));
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "submitting");
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), [messageId]);
    const receipt = await delivery; telemetry.delivery(agentId, messageId, receipt.status);
    assert.equal(receipt.status, "accepted");
    assert.equal(child.promptCount, 1);
    assert.equal(spawnCount, 1, "progressing preflight must not trigger Runtime recreation");
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "accepted");
    child.event({ type: "turn_start", turnIndex: 0 });
    assert.deepEqual(store.pollInbox({ target }).envelopes.map((row) => row.message_id), [messageId]);
    child.event({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop" }] });
    child.event({ type: "agent_settled" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "consumed");
    await host.shutdown("mock preflight complete"); await telemetry.shutdown();

    const records = new TelemetrySpool(telemetryConfig).list();
    const spans = records.flatMap(({ payload }) => payload.resourceSpans)
      .flatMap((resource) => resource.scopeSpans).flatMap((scope) => scope.spans);
    const names = spans.map((span) => span.name);
    assert.equal(names.filter((name) => name === "pi.prompt.wait").length, 1);
    assert.equal(names.filter((name) => name === "pi.compaction").length, 1);
    assert.equal(names.filter((name) => name === "agent.turn").length, 1);
    const serialized = JSON.stringify(records.map(({ payload }) => payload));
    for (const forbidden of [agentId, messageId, target, "PRIVATE_PROMPT_BODY", "PRIVATE_PROVIDER_DETAIL", "PRIVATE_SUMMARY",
      "PRIVATE_SESSION", root]) assert.equal(serialized.includes(forbidden), false, forbidden);
  } finally {
    await host.shutdown("test cleanup").catch(() => {}); await telemetry.shutdown().catch(() => {});
    if (previousConfigDir === undefined) delete process.env.LARKIN_CONFIG_DIR;
    else process.env.LARKIN_CONFIG_DIR = previousConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production-shaped Pi RPC Mock proves native retry lifecycle is correlated and does not duplicate compact or input", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-native-retry-e2e-"));
  const agentId = "cli_nativeRetryA1"; const messageId = "om_native_retry";
  const stateDir = path.join(root, "state", "agents", agentId); const workspaceDir = path.join(root, "workspace");
  const store = createAgentStateStore(root, agentId); let compactCount = 0; let promptCount = 0;
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.killed = [];
  child.kill = (signal) => { child.killed.push(signal); queueMicrotask(() => child.emit("exit", null, signal)); return true; };
  child.stdin = { destroyed: false, write(line, callback) {
    const request = JSON.parse(line); callback?.();
    if (request.type === "get_state") queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, type: "response", command: request.type, success: true,
      data: { sessionId: "native-session", model: { provider: "fixture", id: "fixture-model", contextWindow: 272000 }, thinkingLevel: "off", autoCompactionEnabled: true } })}\n`));
    else if (request.type === "get_available_models") queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, type: "response", command: request.type, success: true,
      data: { models: [{ provider: "fixture", id: "fixture-model" }] } })}\n`));
    else if (request.type === "prompt") {
      promptCount += 1;
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ id: request.id, type: "response", command: request.type, success: true, data: {} })}\n`));
      setTimeout(() => child.stdout.write(`${JSON.stringify({ type: "turn_start", turnIndex: 0 })}\n`), 2);
      setTimeout(() => child.stdout.write(`${JSON.stringify({ type: "compaction_start", reason: "overflow" })}\n`), 4);
      setTimeout(() => child.stdout.write(`${JSON.stringify({ type: "compaction_end", reason: "overflow", aborted: false, willRetry: true, result: {} })}\n`), 6);
      setTimeout(() => child.stdout.write(`${JSON.stringify({ type: "agent_end", willRetry: true, messages: [{ role: "assistant", stopReason: "error", errorMessage: "Your input exceeds the context window of this model. Please adjust your input and try again." }] })}\n`), 8);
      setTimeout(() => child.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`), 10);
    } else if (request.type === "compact") compactCount += 1;
    return true;
  }, end() {} };
  const native = createNativeRuntimeAdapter("pi", { env: { LARKIN_PI_DISTRIBUTION: "builtin" }, spawn: () => child });
  const adapter = { id: native.id, capabilities: native.capabilities, probe: async () => ({ runtime: "pi", state: "ready" }), createSession: (input) => native.createSession(input) };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store,
    assertOfficialCliReady: () => {}, retryPolicy: { baseDelayMs: 2, maxDelayMs: 2, maxAttempts: 1 } });
  const target = "chat:oc_native_retry";
  try {
    fs.mkdirSync(workspaceDir, { recursive: true });
    await host.start([{ agentId, name: agentId, runtime: "pi", model: "default", piDistribution: "builtin", workspaceDir, stateDir }]);
    store.prepareInboxDelivery({ message_id: messageId, target, content: "native retry", wake: true });
    const receipt = await host.deliver(agentId, { message_id: messageId, target, content: "native retry", wake: true });
    assert.equal(receipt.status, "accepted");
    await new Promise((resolve) => setTimeout(resolve, 35));
    store.pollInbox({ target });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(promptCount, 1); assert.equal(compactCount, 0);
    const breaker = JSON.parse(fs.readFileSync(path.join(stateDir, "piCompactionRecovery.json"), "utf8"));
    assert.equal(breaker.records[0].state, "closed");
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "consumed");
  } finally {
    await host.shutdown("native retry mock complete").catch(() => {}); fs.rmSync(root, { recursive: true, force: true });
  }
});

class RecoveryPiProcess extends EventEmitter {
  stdout = new PassThrough(); stderr = new PassThrough(); killed = [];
  promptCount = 0; compactCount = 0; turnCount = 0; replyCount = 0;
  constructor(index, scenario, onSuccessfulTurn) { super(); this.index = index; this.scenario = scenario; this.onSuccessfulTurn = onSuccessfulTurn; this.sessionId = `recovery-session-${scenario}-${index}`; }
  stdin = { destroyed: false, write: (line, callback) => {
    const request = JSON.parse(line); callback?.();
    if (request.type === "get_state") return this.respond(request, { sessionId: this.sessionId,
      model: { provider: "fixture", id: "fixture-model", contextWindow: 272000 }, thinkingLevel: "off", autoCompactionEnabled: true });
    if (request.type === "get_available_models") return this.respond(request, { models: [{ provider: "fixture", id: "fixture-model" }] });
    if (request.type === "compact") {
      this.compactCount += 1; this.respond(request);
      return setTimeout(() => this.event({ type: "compaction_end", reason: "manual", aborted: false, willRetry: false,
        result: { summary: "MANUAL_SUMMARY" } }), 2);
    }
    if (request.type !== "prompt") return true;
    this.promptCount += 1; this.respond(request);
    setTimeout(() => { this.turnCount += 1; this.event({ type: "turn_start", turnIndex: this.turnCount }); }, 2);
    setTimeout(() => this.emitTurn(), 4);
    return true;
  }, end() {} };
  respond(request, data) { queueMicrotask(() => this.stdout.write(`${JSON.stringify({ id: request.id, type: "response", command: request.type,
    success: true, ...(data === undefined ? {} : { data }) })}\n`)); }
  emitTurn() {
    const nativeFailure = this.scenario === "native-failure" && this.index === 0;
    const manualSecond = this.scenario === "manual-second" && this.index === 1;
    const manualInitial = this.scenario === "manual-second" && this.index === 0;
    if (nativeFailure) {
      this.event({ type: "compaction_start", reason: "overflow" });
      this.event({ type: "compaction_end", reason: "overflow", aborted: true, willRetry: false });
    }
    const overflow = nativeFailure || manualInitial || manualSecond;
    this.replyCount += 1;
    if (!overflow) this.onSuccessfulTurn?.();
    this.event({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: overflow ? "error" : "stop",
      ...(overflow ? { errorMessage: "Your input exceeds the context window of this model. Please adjust your input and try again." } : {}) }] });
    setTimeout(() => this.event({ type: "agent_settled" }), 2);
  }
  event(value) { this.stdout.write(`${JSON.stringify(value)}\n`); }
  kill(signal) { this.killed.push(signal); queueMicrotask(() => this.emit("exit", null, signal)); return true; }
}

function recoveryHost(root, scenario, sessions, store, target = `chat:oc_${scenario}`) {
  const workspaceDir = path.join(root, "workspace"); fs.mkdirSync(workspaceDir, { recursive: true });
  const native = createNativeRuntimeAdapter("pi", { env: { LARKIN_PI_DISTRIBUTION: "builtin" }, spawn: () => {
    const child = new RecoveryPiProcess(sessions.length, scenario, () => store.pollInbox({ target })); sessions.push(child); return child;
  }, piRpcClientOptions: { requestTimeoutMs: 50, inputTimeoutMs: 100, inputProgressTimeoutMs: 100, inputMaxTimeoutMs: 500 } });
  const adapter = { id: native.id, capabilities: native.capabilities, probe: async () => ({ runtime: "pi", state: "ready" }),
    createSession: (input) => native.createSession(input) };
  return createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store,
    assertOfficialCliReady: () => {}, retryPolicy: { baseDelayMs: 2, maxDelayMs: 2, maxAttempts: 1 } });
}

async function waitUntil(read, label, timeoutMs = 1500) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (read()) return; await new Promise((resolve) => setTimeout(resolve, 5)); }
  throw new Error(`timed out waiting for ${label}`);
}

async function runRecoveryScenario(scenario, expectedSessions, expectedCompacts, expectedPrompts = expectedSessions,
  expectedTurns = expectedPrompts, expectedReplies = expectedPrompts) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-pi-${scenario}-e2e-`));
  const agentId = `cli_${scenario.replace(/[^A-Za-z0-9]/g, "")}A1`; const messageId = `om_${scenario}`;
  const target = `chat:oc_${scenario}`; const stateDir = path.join(root, "state", "agents", agentId);
  const store = createAgentStateStore(root, agentId); const sessions = []; const host = recoveryHost(root, scenario, sessions, store);
  const envelope = { message_id: messageId, target, content: `recovery ${scenario}`, wake: true };
  try {
    await host.start([{ agentId, name: agentId, runtime: "pi", model: "default", piDistribution: "builtin",
      workspaceDir: path.join(root, "workspace"), stateDir }]);
    store.prepareInboxDelivery(envelope);
    const receipt = await host.deliver(agentId, envelope); assert.equal(receipt.status, "accepted");
    try { await waitUntil(() => sessions.length >= expectedSessions
      && sessions.reduce((count, session) => count + session.replyCount, 0) >= expectedReplies, "fresh recovery session"); }
    catch (error) { throw new Error(`${error.message}; sessions=${JSON.stringify(sessions.map((session) => ({ id: session.sessionId, prompt: session.promptCount, compact: session.compactCount, turns: session.turnCount, replies: session.replyCount })))}; records=${JSON.stringify(store.readJson("runtimeDeliveries", { records: [] }).records)}`); }
    store.pollInbox({ target }); await new Promise((resolve) => setImmediate(resolve));
    const delivery = store.readJson("runtimeDeliveries", { records: [] }).records.find((record) => record.messageId === messageId);
    assert.equal(delivery.status, "consumed");
    assert.equal(sessions[0].sessionId.startsWith("recovery-session-"), true);
    assert.equal(new Set(sessions.map((session) => session.sessionId)).size, expectedSessions);
    assert.equal(sessions.reduce((count, session) => count + session.promptCount, 0), expectedPrompts);
    assert.equal(sessions.reduce((count, session) => count + session.compactCount, 0), expectedCompacts);
    assert.equal(sessions.reduce((count, session) => count + session.turnCount, 0), expectedTurns);
    assert.equal(sessions.reduce((count, session) => count + session.replyCount, 0), expectedReplies);
  } finally { await host.shutdown("recovery scenario complete").catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); }
}

test("production RuntimeHost RPC events native compaction failure perform one canonical fresh-session fallback", async () => {
  await runRecoveryScenario("native-failure", 2, 0);
});

test("production RuntimeHost RPC events manual success plus exact second overflow fallback once without duplicate delivery", async () => {
  await runRecoveryScenario("manual-second", 2, 1, 3, 3, 3);
});

test("production RuntimeHost restart table deterministically falls back durable manual/native states without compact", async () => {
  for (const state of ["manual_sent", "manual_ambiguous", "native_failed"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-pi-restart-${state}-e2e-`));
    const agentId = `cli_restart${state.replace(/[^A-Za-z0-9]/g, "")}A1`; const messageId = `om_restart_${state}`;
    const deliveryId = `delivery_restart_${state}`; const inputId = `input_restart_${state}`; const target = `chat:oc_restart_${state}`;
    const stateDir = path.join(root, "state", "agents", agentId); const store = createAgentStateStore(root, agentId); const sessions = [];
    const breaker = new PiCompactionBreaker(stateDir, { withLock: (operation) => store.withInboxTransaction(operation) });
    const record = { key: `${deliveryId}:${inputId}`, messageId, deliveryId, inputId, sessionGeneration: 1, state,
      manualAttempt: state === "native_failed" ? 0 : 1, compactSentAt: null, compactDeadlineAt: null, compactFinishedAt: null,
      retrySubmittedAt: null, fallbackReason: "restart fixture", updatedAt: new Date().toISOString() };
    try {
      store.appendNdjson("inbox", { message_id: messageId, target, content: `restart ${state}`, wake: true });
      store.writeJson("runtimeDeliveries", { version: 1, records: [{ deliveryId, messageId, status: "error", retryable: false, errorCategory: "context_window",
        input: { inputId, deliveryId, kind: "wake", text: `restart ${state}`, attempt: 1 }, reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", updatedAt: new Date().toISOString() }] });
      breaker.save(record);
      const host = recoveryHost(root, "restart", sessions, store, target);
      await host.start([{ agentId, name: agentId, runtime: "pi", model: "default", piDistribution: "builtin",
        workspaceDir: path.join(root, "workspace"), stateDir }]);
      await waitUntil(() => sessions.length >= 2 && sessions.at(-1).promptCount > 0, `${state} restart fallback`);
      store.pollInbox({ target }); await new Promise((resolve) => setImmediate(resolve));
      assert.equal(sessions.reduce((count, session) => count + session.compactCount, 0), 0);
      assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "consumed");
      const durable = JSON.parse(fs.readFileSync(path.join(stateDir, "piCompactionRecovery.json"), "utf8"));
      assert.ok(["fallback_committed", "closed"].includes(durable.records[0].state));
      assert.equal(new Set(sessions.map((session) => session.sessionId)).size, 2);
      await host.shutdown(`restart ${state} complete`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("external Pi production-order preflight timeout stays bounded, pending, observable, and turn-free", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-external-pi-timeout-e2e-"));
  const agentId = "cli_externalTimeoutA1"; const messageId = "om_PRIVATE_TIMEOUT";
  const stateDir = path.join(root, "state", "agents", agentId); const workspaceDir = path.join(root, "workspace");
  const store = createAgentStateStore(root, agentId); const child = new PreflightPiProcess({ acceptPrompt: false }); let spawnCount = 0;
  const telemetryConfig = { spoolDir: path.join(root, "telemetry", "spool"), headers: {}, maxBytes: 1024 * 1024,
    maxFiles: 100, maxAgeMs: 60_000, uploadIntervalMs: 60_000, requestTimeoutMs: 2_000 };
  const telemetry = createTelemetryRuntime(telemetryConfig, { stateDirFor: () => stateDir });
  const native = createNativeRuntimeAdapter("pi", {
    spawn: () => { spawnCount += 1; return child; },
    piRpcClientOptions: { requestTimeoutMs: 5, inputTimeoutMs: 15, inputProgressTimeoutMs: 25, inputMaxTimeoutMs: 50 },
  });
  const adapter = { id: native.id, capabilities: native.capabilities,
    probe: async () => ({ runtime: "pi", state: "ready" }), createSession: (input) => native.createSession(input) };
  const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: () => store, telemetry, retryPolicy: { baseDelayMs: 2, maxDelayMs: 2, maxAttempts: 0 },
    assertOfficialCliReady: () => {} });
  const target = "chat:oc_private_timeout_target";
  const envelope = { message_id: messageId, target, content: "PRIVATE_TIMEOUT_BODY", wake: true };
  try {
    fs.mkdirSync(workspaceDir, { recursive: true });
    await host.start([{ agentId, name: agentId, runtime: "pi", model: "default", piDistribution: "external",
      workspaceDir, stateDir }]);
    store.prepareInboxDelivery(envelope); telemetry.beginMessage(agentId, messageId);
    const receipt = await telemetry.phase(messageId, "runtime.deliver", SpanKind.PRODUCER, () => host.deliver(agentId, envelope));
    assert.equal(receipt.status, "deferred");
    assert.match(receipt.reason, /runtime session replaced before input result/);
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "pending");
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), [messageId]);
    assert.equal(child.promptCount, 1); assert.equal(spawnCount, 1);
    await host.shutdown("mock timeout complete"); await telemetry.shutdown();
    const records = new TelemetrySpool(telemetryConfig).list();
    const spans = records.flatMap(({ payload }) => payload.resourceSpans)
      .flatMap((resource) => resource.scopeSpans).flatMap((scope) => scope.spans);
    const wait = spans.find((span) => span.name === "pi.prompt.wait");
    const compaction = spans.find((span) => span.name === "pi.compaction");
    assert.ok(wait); assert.ok(compaction);
    assert.equal(spans.some((span) => span.name === "agent.turn"), false);
    assert.equal(wait.status.code, 2); assert.equal(compaction.status.code, 2);
    assert.equal(wait.attributes.find((attribute) => attribute.key === "larkin.runtime.distribution")?.value?.stringValue, "external");
    assert.equal(wait.attributes.find((attribute) => attribute.key === "larkin.pi.preflight.outcome")?.value?.stringValue, "timeout");
    const serialized = JSON.stringify(records.map(({ payload }) => payload));
    for (const forbidden of [agentId, messageId, target, "PRIVATE_TIMEOUT_BODY", "PRIVATE_PROVIDER_DETAIL", root]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  } finally {
    await host.shutdown("test cleanup").catch(() => {}); await telemetry.shutdown().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
