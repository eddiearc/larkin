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
