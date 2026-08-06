import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../dist/agent/agent-state-store.mjs";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { createNativeRuntimeAdapter } from "../../dist/runtime/runtime-adapters.mjs";
import { createRuntimeHost } from "../../dist/runtime/runtime-host.mjs";
import { createTelemetryRuntime } from "../../dist/platform/telemetry-tracing.mjs";
import { TelemetrySpool } from "../../dist/platform/telemetry-spool.mjs";

test("bundled Pi production adapter and RuntimeHost emit one content-free RPC waterfall", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-bundled-pi-otel-e2e-"));
  const agentId = "cli_bundledPiTraceA1";
  const stateDir = path.join(root, "state", "agents", agentId);
  const workspaceDir = path.join(root, "agents", agentId);
  const store = createAgentStateStore(root, agentId);
  const telemetryConfig = { spoolDir: path.join(root, "telemetry", "spool"), headers: {},
    maxBytes: 1024 * 1024, maxFiles: 100, maxAgeMs: 60_000, uploadIntervalMs: 60_000, requestTimeoutMs: 2_000 };
  const telemetry = createTelemetryRuntime(telemetryConfig, { stateDirFor: () => stateDir });
  let listener;
  const sdk = {
    sessionId: "FORBIDDEN_REAL_SESSION", model: { provider: "FORBIDDEN_PROVIDER", id: "FORBIDDEN_MODEL" }, thinkingLevel: "high",
    prompt() {}, steer() {}, abort() {}, dispose() {},
    subscribe(next) { listener = next; return () => {}; },
  };
  const nativeAdapter = createNativeRuntimeAdapter("pi", {
    env: { LARKIN_PI_DISTRIBUTION: "builtin" },
    createPiSession: async () => sdk,
  });
  const adapter = {
    id: nativeAdapter.id,
    capabilities: nativeAdapter.capabilities,
    probe: async () => ({ runtime: "pi", state: "ready" }),
    createSession: (input) => nativeAdapter.createSession(input),
  };
  const runtimeHost = createRuntimeHost({
    adapterFor: () => adapter,
    promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: () => store,
    assertOfficialCliReady: () => {},
    telemetry,
  });
  const messageId = "doc_comment_forbidden_payload";
  const target = "document-comment:docx:FORBIDDEN_LOCATOR:FORBIDDEN_COMMENT:in-thread";
  try {
    fs.mkdirSync(workspaceDir, { recursive: true });
    await runtimeHost.start([{ agentId, name: agentId, runtime: "pi", model: "default", piDistribution: "builtin",
      workspaceDir, stateDir }]);
    const envelope = { message_id: messageId, target, kind: "document_comment", content: "FORBIDDEN_PROMPT_BODY", wake: true };
    store.prepareInboxDelivery(envelope);
    telemetry.beginMessage(agentId, messageId, "document_comment");
    assert.equal((await runtimeHost.deliver(agentId, envelope)).status, "accepted");
    listener({ type: "turn_start", turnIndex: 0 });
    listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "FORBIDDEN_OUTPUT" } });
    listener({ type: "tool_execution_start", toolName: "FORBIDDEN_TOOL", args: { token: "FORBIDDEN_SECRET" } });
    listener({ type: "tool_execution_end", toolName: "FORBIDDEN_TOOL", result: "FORBIDDEN_RESULT" });
    store.pollInbox({ target, limit: 1 });
    listener({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "stop", content: "FORBIDDEN_OUTPUT" }] });
    listener({ type: "agent_settled" });
    await new Promise((resolve) => setImmediate(resolve));
    await runtimeHost.shutdown("trace complete");
    await telemetry.shutdown();

    const records = new TelemetrySpool(telemetryConfig).list();
    const spans = records.flatMap(({ payload }) => payload.resourceSpans)
      .flatMap((resource) => resource.scopeSpans).flatMap((scope) => scope.spans);
    const turn = spans.find((span) => span.name === "agent.turn");
    assert.ok(turn);
    const trace = spans.filter((span) => span.traceId === turn.traceId);
    const names = new Set(trace.map((span) => span.name));
    for (const name of ["larkin.message.process", "runtime.deliver", "agent.turn", "pi.rpc.submit", "pi.rpc.lifecycle",
      "pi.output.wait", "pi.generation", "pi.tool.wait", "pi.rpc.settle"]) assert.ok(names.has(name), name);
    for (const name of ["pi.rpc.submit", "pi.rpc.lifecycle", "pi.output.wait", "pi.generation", "pi.tool.wait", "pi.rpc.settle"]) {
      assert.ok(trace.filter((span) => span.name === name).every((span) => span.parentSpanId === turn.spanId), name);
    }
    assert.equal(turn.attributes.find((attribute) => attribute.key === "larkin.runtime.distribution")?.value?.stringValue, "builtin");
    const serialized = JSON.stringify(records.map(({ payload }) => payload));
    for (const forbidden of [agentId, messageId, "FORBIDDEN_REAL_SESSION", "FORBIDDEN_PROVIDER", "FORBIDDEN_MODEL", "FORBIDDEN_LOCATOR",
      "FORBIDDEN_COMMENT", "FORBIDDEN_PROMPT_BODY", "FORBIDDEN_OUTPUT", "FORBIDDEN_TOOL", "FORBIDDEN_SECRET", "FORBIDDEN_RESULT", root]) {
      assert.equal(serialized.includes(forbidden), false, forbidden);
    }
  } finally {
    await runtimeHost.shutdown("test").catch(() => {});
    await telemetry.shutdown().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
