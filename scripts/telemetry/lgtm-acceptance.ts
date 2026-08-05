#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpanKind } from "@opentelemetry/api";
import { createTelemetryRuntime } from "../../dist/platform/telemetry-tracing.mjs";
import { TelemetrySpool } from "../../dist/platform/telemetry-spool.mjs";
import { flushTelemetry } from "../../dist/platform/telemetry-uploader.mjs";

const collector = process.env.LARKIN_LGTM_OTLP_ENDPOINT || "http://127.0.0.1:4318/v1/traces";
const tempo = process.env.LARKIN_LGTM_TEMPO_ENDPOINT || "http://127.0.0.1:3200";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-lgtm-acceptance-"));
const stateDir = path.join(root, "state");
const config = { enabled: true, spoolDir: path.join(root, "spool"), headers: {}, maxBytes: 1024 * 1024,
  maxFiles: 100, maxAgeMs: 60_000, uploadIntervalMs: 60_000, requestTimeoutMs: 5_000 };
const expectedKinds: Record<string, string> = {
  "larkin.message.process": "SPAN_KIND_CONSUMER", "feishu.receive": "SPAN_KIND_CONSUMER",
  "runtime.deliver": "SPAN_KIND_PRODUCER", "agent.turn": "SPAN_KIND_INTERNAL",
  "model.activity": "SPAN_KIND_INTERNAL", "tool.execute": "SPAN_KIND_INTERNAL",
  "inbox.consume": "SPAN_KIND_CONSUMER", "feishu.send": "SPAN_KIND_CLIENT",
};
const hex = (base64: string | undefined): string | undefined => base64 ? Buffer.from(base64, "base64").toString("hex") : undefined;
const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

try {
  const runtime = createTelemetryRuntime(config, { stateDirFor: () => stateDir, stateDirs: [stateDir], serviceVersion: "lgtm-acceptance" });
  const messageId = "acceptance-message"; const agentId = "acceptance-agent";
  runtime.beginMessage(agentId, messageId);
  await runtime.phase(messageId, "feishu.receive", SpanKind.CONSUMER, async () => {});
  await runtime.phase(messageId, "runtime.deliver", SpanKind.PRODUCER, async () => {});
  runtime.delivery(agentId, messageId, "accepted"); runtime.runtimeEvent(agentId, { type: "turn-start" });
  runtime.runtimeEvent(agentId, { type: "activity", activity: "thinking" }); await sleep(10);
  runtime.runtimeEvent(agentId, { type: "activity", activity: "tool" }); await sleep(10);
  await runtime.externalPhase(agentId, stateDir, "feishu.send", SpanKind.CLIENT, async () => {});
  runtime.delivery(agentId, messageId, "consumed"); runtime.runtimeEvent(agentId, { type: "turn-end" });
  await runtime.shutdown();

  const spool = new TelemetrySpool(config); const local = spool.list();
  const localSpans = local.flatMap(({ payload }) => payload.resourceSpans as Array<{ scopeSpans: Array<{ spans: Array<Record<string, unknown>> }> }>)
    .flatMap((resource) => resource.scopeSpans).flatMap((scope) => scope.spans);
  const rootSpan = localSpans.find((span) => span.name === "larkin.message.process");
  if (!rootSpan?.traceId) throw new Error("acceptance trace root missing");
  const traceId = String(rootSpan.traceId);
  const upload = await flushTelemetry(spool, { endpoint: collector, timeoutMs: 5_000 });
  if (upload.status !== "uploaded" || upload.uploadedFiles !== 8) throw new Error(`collector upload failed: ${upload.status}`);

  let tempoTrace: { batches?: Array<{ scopeSpans?: Array<{ spans?: Array<Record<string, unknown>> }> }> } | null = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await fetch(`${tempo}/api/traces/${traceId}`);
    if (response.ok) { tempoTrace = await response.json() as typeof tempoTrace; break; }
    await sleep(250);
  }
  const spans = tempoTrace?.batches?.flatMap((batch) => batch.scopeSpans ?? []).flatMap((scope) => scope.spans ?? []) ?? [];
  const byName = Object.fromEntries(spans.map((span) => [String(span.name), span]));
  if (spans.length !== 8 || Object.keys(expectedKinds).some((name) => !byName[name])) throw new Error("Tempo trace is incomplete");
  for (const [name, expectedKind] of Object.entries(expectedKinds)) {
    const span = byName[name];
    if (span.kind !== expectedKind || BigInt(String(span.endTimeUnixNano)) <= BigInt(String(span.startTimeUnixNano))) throw new Error(`invalid Tempo semantics for ${name}`);
  }
  const rootId = hex(String(byName["larkin.message.process"].spanId)); const turnId = hex(String(byName["agent.turn"].spanId));
  if (byName["larkin.message.process"].parentSpanId) throw new Error("root must not have a parent");
  for (const name of ["feishu.receive", "runtime.deliver", "agent.turn"]) if (hex(String(byName[name].parentSpanId)) !== rootId) throw new Error(`wrong parent for ${name}`);
  for (const name of ["model.activity", "tool.execute", "inbox.consume", "feishu.send"]) if (hex(String(byName[name].parentSpanId)) !== turnId) throw new Error(`wrong parent for ${name}`);
  process.stdout.write(`${JSON.stringify({ traceId, spanCount: spans.length, kinds: Object.fromEntries(spans.map((span) => [span.name, span.kind])),
    durationsNanos: Object.fromEntries(spans.map((span) => [span.name, (BigInt(String(span.endTimeUnixNano)) - BigInt(String(span.startTimeUnixNano))).toString()])),
    parentage: "validated", queueAfterUpload: spool.status().queuedFiles }, null, 2)}\n`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
