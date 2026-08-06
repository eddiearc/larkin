#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpanKind } from "@opentelemetry/api";
import { createAgentStateStore } from "../../dist/agent/agent-state-store.mjs";
import { runAgentCli } from "../../dist/app/agent-cli.mjs";
import { createTelemetryRuntime } from "../../dist/platform/telemetry-tracing.mjs";
import { TelemetrySpool } from "../../dist/platform/telemetry-spool.mjs";
import { flushTelemetry } from "../../dist/platform/telemetry-uploader.mjs";

const collector = process.env.LARKIN_LGTM_OTLP_ENDPOINT || "http://127.0.0.1:4318/v1/traces";
const tempo = process.env.LARKIN_LGTM_TEMPO_ENDPOINT || "http://127.0.0.1:3200";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-lgtm-acceptance-"));
const messageId = "acceptance-message"; const agentId = "cli_acceptanceA1";
fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ version: 3, serverId: "acceptance-server", activeAgent: agentId,
  agents: { [agentId]: { runtime: "codex", model: "acceptance-model" } } }), { mode: 0o600 });
const stateStore = createAgentStateStore(root, agentId); const stateDir = stateStore.paths.root;
const telemetryConfig = { enabled: true, spoolDir: path.join(root, "spool"), headers: {}, maxBytes: 1024 * 1024,
  maxFiles: 100, maxAgeMs: 60_000, uploadIntervalMs: 60_000, requestTimeoutMs: 5_000 };
const expectedKinds: Record<string, string> = {
  "larkin.message.process": "SPAN_KIND_CONSUMER", "document.comment.receive": "SPAN_KIND_CONSUMER",
  "document.comment.gate": "SPAN_KIND_INTERNAL", "document.comment.inbox": "SPAN_KIND_PRODUCER",
  "runtime.deliver": "SPAN_KIND_PRODUCER", "agent.turn": "SPAN_KIND_INTERNAL",
  "pi.rpc.submit": "SPAN_KIND_INTERNAL", "pi.rpc.lifecycle": "SPAN_KIND_INTERNAL",
  "pi.output.wait": "SPAN_KIND_INTERNAL", "pi.generation": "SPAN_KIND_INTERNAL",
  "pi.tool.wait": "SPAN_KIND_INTERNAL", "pi.rpc.settle": "SPAN_KIND_INTERNAL",
  "inbox.consume": "SPAN_KIND_CONSUMER", "document.comment.reply": "SPAN_KIND_CLIENT",
};
const hex = (base64: string | undefined): string | undefined => base64 ? Buffer.from(base64, "base64").toString("hex") : undefined;
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

try {
  const runtime = createTelemetryRuntime(telemetryConfig, { stateDirFor: () => stateDir, stateDirs: [stateDir], serviceVersion: "lgtm-acceptance" });
  runtime.beginMessage(agentId, messageId, "document_comment");
  await runtime.phase(messageId, "document.comment.receive", SpanKind.CONSUMER, async () => {});
  await runtime.phase(messageId, "document.comment.gate", SpanKind.INTERNAL, async () => {});
  await runtime.phase(messageId, "document.comment.inbox", SpanKind.PRODUCER, async () => {});
  await runtime.phase(messageId, "runtime.deliver", SpanKind.PRODUCER, async () => {});
  runtime.delivery(agentId, messageId, "accepted");
  const observe = (phase: "rpc_submit" | "rpc_accepted" | "turn_start" | "first_output" | "tool_call" | "tool_result" | "completed" | "settled") =>
    runtime.runtimeEvent(agentId, { type: "runtime-observation", runtime: "pi", distribution: "builtin", phase });
  observe("rpc_submit"); await sleep(10); observe("rpc_accepted"); observe("turn_start");
  runtime.runtimeEvent(agentId, { type: "turn-start" }); await sleep(10); observe("first_output");
  observe("tool_call"); await sleep(10); observe("tool_result"); observe("completed"); await sleep(10); observe("settled");
  await runtime.externalPhase(agentId, stateDir, "document.comment.reply", SpanKind.CLIENT, async () => {});
  stateStore.appendNdjson("inbox", { message_id: messageId, chat_id: "oc_acceptance", create_time: "1785942000000", content: "fixture" });
  const pollCode = await runAgentCli(["inbox", "poll", "--target", "chat:oc_acceptance"], {
    LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId,
  }, { stateStore, telemetry: runtime, io: { stdout() {}, stderr() {} } });
  if (pollCode !== 0) throw new Error("authoritative Inbox poll failed");
  runtime.delivery(agentId, messageId, "consumed"); runtime.runtimeEvent(agentId, { type: "turn-end" });
  await runtime.shutdown();

  const spool = new TelemetrySpool(telemetryConfig); const local = spool.list();
  const localSpans = local.flatMap(({ payload }) => payload.resourceSpans as Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>)
    .flatMap((resource) => resource.scopeSpans).flatMap((scope) => scope.spans);
  const rootSpan = localSpans.find((span) => span.name === "larkin.message.process");
  if (!rootSpan?.traceId) throw new Error("acceptance trace root missing");
  const traceId = String(rootSpan.traceId);
  const upload = await flushTelemetry(spool, { endpoint: collector, timeoutMs: 5_000 });
  const expectedSpanCount = Object.keys(expectedKinds).length;
  if (upload.status !== "uploaded" || upload.uploadedFiles !== expectedSpanCount) throw new Error(`collector upload failed: ${upload.status}`);

  let tempoTrace: { batches?: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }> }> } | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${tempo}/api/traces/${traceId}`);
    if (response.ok) { tempoTrace = await response.json() as typeof tempoTrace; break; }
    await sleep(250);
  }
  const spans = tempoTrace?.batches?.flatMap((batch) => batch.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []) ?? [];
  const byName = Object.fromEntries(spans.map((span) => [String(span.name), span]));
  if (spans.length !== expectedSpanCount || Object.keys(expectedKinds).some((name) => !byName[name])) throw new Error("Tempo trace is incomplete");
  for (const [name, expectedKind] of Object.entries(expectedKinds)) {
    const span = byName[name];
    if (span.kind !== expectedKind || BigInt(String(span.endTimeUnixNano)) <= BigInt(String(span.startTimeUnixNano))) throw new Error(`invalid Tempo semantics for ${name}`);
  }
  const rootId = hex(String(byName["larkin.message.process"].spanId)); const turnId = hex(String(byName["agent.turn"].spanId));
  if (byName["larkin.message.process"].parentSpanId) throw new Error("root must not have a parent");
  for (const name of ["document.comment.receive", "document.comment.gate", "document.comment.inbox", "runtime.deliver", "agent.turn"]) {
    if (hex(String(byName[name].parentSpanId)) !== rootId) throw new Error(`wrong parent for ${name}`);
  }
  for (const name of ["pi.rpc.submit", "pi.rpc.lifecycle", "pi.output.wait", "pi.generation", "pi.tool.wait", "pi.rpc.settle", "inbox.consume", "document.comment.reply"]) {
    if (hex(String(byName[name].parentSpanId)) !== turnId) throw new Error(`wrong parent for ${name}`);
  }
  process.stdout.write(`${JSON.stringify({ traceId, spanCount: spans.length, kinds: Object.fromEntries(spans.map((span) => [span.name, span.kind])),
    durationsNanos: Object.fromEntries(spans.map((span) => [span.name, (BigInt(String(span.endTimeUnixNano)) - BigInt(String(span.startTimeUnixNano))).toString()])),
    parentage: "validated", queueAfterUpload: spool.status().queuedFiles }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
