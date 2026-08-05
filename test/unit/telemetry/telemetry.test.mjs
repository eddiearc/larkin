import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import zlib from "node:zlib";
import { test } from "bun:test";
import { SpanKind } from "@opentelemetry/api";
import { TelemetrySpool } from "../../../dist/platform/telemetry-spool.mjs";
import { flushTelemetry, startTelemetryUploader } from "../../../dist/platform/telemetry-uploader.mjs";
import { createTelemetryRuntime } from "../../../dist/platform/telemetry-tracing.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "larkin-otel-"));
const config = (root, overrides = {}) => ({ enabled: true, spoolDir: path.join(root, "spool"), headers: {},
  maxBytes: 1024 * 1024, maxFiles: 100, maxAgeMs: 60_000, uploadIntervalMs: 60_000, requestTimeoutMs: 2_000, ...overrides });
const payload = (id = "1") => ({ resourceSpans: [{ resource: { attributes: [
  { key: "service.name", value: { stringValue: "larkin" } },
  { key: "service.version", value: { stringValue: "test" } },
] }, scopeSpans: [{ scope: { name: "larkin.telemetry", version: "1.0.0" }, spans: [{
  traceId: id.padStart(32, "0"), spanId: id.padStart(16, "0"), name: "larkin.message.process", kind: 5,
  startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: [], links: [], status: { code: 0 }, flags: 1,
}] }] }] });

test("official OTel spans form a privacy-safe end-to-end tree in the durable OTLP spool", async () => {
  const root = temp(); const stateDir = path.join(root, "agent-state");
  const runtime = createTelemetryRuntime(config(root), { stateDirFor: () => stateDir });
  const messageId = "om_forbidden-message-body";
  runtime.beginMessage("cli_private-user", messageId);
  await runtime.phase(messageId, "feishu.receive", SpanKind.CONSUMER, async () => {});
  await runtime.phase(messageId, "runtime.deliver", SpanKind.PRODUCER, async () => ({ status: "accepted" }));
  runtime.delivery("cli_private-user", messageId, "accepted");
  runtime.runtimeEvent("cli_private-user", { type: "turn-start", turnId: "forbidden-turn-id" });
  runtime.runtimeEvent("cli_private-user", { type: "activity", activity: "thinking", text: "FORBIDDEN_PROMPT" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  runtime.runtimeEvent("cli_private-user", { type: "activity", activity: "tool", name: "FORBIDDEN_COMMAND", text: "token=FORBIDDEN_SECRET" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await runtime.externalPhase("cli_private-user", stateDir, "feishu.send", SpanKind.CLIENT, async () => {});
  runtime.delivery("cli_private-user", messageId, "consumed");
  runtime.runtimeEvent("cli_private-user", { type: "turn-end", turnId: "forbidden-turn-id" });
  await runtime.shutdown();

  const spool = new TelemetrySpool(config(root));
  const records = spool.list();
  const spans = records.flatMap(({ payload }) => payload.resourceSpans)
    .flatMap((resource) => resource.scopeSpans).flatMap((scope) => scope.spans);
  const names = new Set(spans.map((span) => span.name));
  for (const expected of ["larkin.message.process", "feishu.receive", "runtime.deliver", "agent.turn", "model.activity", "tool.execute", "inbox.consume", "feishu.send"]) {
    assert.ok(names.has(expected), `missing ${expected}`);
  }
  const rootSpan = spans.find((span) => span.name === "larkin.message.process");
  assert.ok(rootSpan);
  assert.equal(new Set(spans.map((span) => span.traceId)).size, 1);
  const byName = Object.fromEntries(spans.map((span) => [span.name, span]));
  assert.deepEqual(Object.fromEntries(Object.entries(byName).map(([name, span]) => [name, span.kind])), {
    "larkin.message.process": 5, "feishu.receive": 5, "runtime.deliver": 4, "agent.turn": 1,
    "model.activity": 1, "tool.execute": 1, "feishu.send": 3, "inbox.consume": 5,
  });
  assert.equal(rootSpan.parentSpanId, undefined);
  for (const name of ["feishu.receive", "runtime.deliver", "agent.turn"]) assert.equal(byName[name].parentSpanId, rootSpan.spanId, name);
  for (const name of ["model.activity", "tool.execute", "feishu.send", "inbox.consume"]) assert.equal(byName[name].parentSpanId, byName["agent.turn"].spanId, name);
  for (const name of ["model.activity", "tool.execute"]) assert.ok(BigInt(byName[name].endTimeUnixNano) > BigInt(byName[name].startTimeUnixNano), name);
  const serialized = JSON.stringify(records);
  for (const forbidden of ["om_forbidden", "FORBIDDEN_PROMPT", "FORBIDDEN_COMMAND", "FORBIDDEN_SECRET", "cli_private-user", stateDir]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(fs.statSync(config(root).spoolDir).mode & 0o777, 0o700);
  for (const record of records) assert.equal(fs.statSync(record.file).mode & 0o777, 0o600);
});

test("spool survives failures, bounds retention, and export/import remains idempotent", () => {
  const root = temp(); const source = new TelemetrySpool(config(root, { maxFiles: 2 }));
  source.enqueue(payload("1")); source.enqueue(payload("2")); source.enqueue(payload("3"));
  assert.equal(source.status().queuedFiles, 2);
  assert.equal(source.status().droppedFiles, 1);
  const bundle = path.join(root, "offline.json.gz");
  const exported = source.exportBundle(bundle);
  assert.equal(exported.records, 2);
  assert.equal(source.status().queuedFiles, 2, "export uses copy semantics");
  const importedRoot = temp(); const imported = new TelemetrySpool(config(importedRoot));
  assert.deepEqual(imported.importBundle(bundle), { imported: 2, duplicates: 0 });
  assert.deepEqual(imported.importBundle(bundle), { imported: 0, duplicates: 2 });
  assert.equal(imported.status().queuedFiles, 2);
});

test("busy fan-in is a linked trace and does not replace the active turn parent", async () => {
  const root = temp(); const stateDir = path.join(root, "state"); const runtime = createTelemetryRuntime(config(root), { stateDirFor: () => stateDir });
  runtime.beginMessage("cli_a", "om_1"); runtime.delivery("cli_a", "om_1", "accepted");
  runtime.runtimeEvent("cli_a", { type: "turn-start" });
  runtime.beginMessage("cli_a", "om_2"); runtime.delivery("cli_a", "om_2", "accepted");
  await runtime.externalPhase("cli_a", stateDir, "feishu.send", SpanKind.CLIENT, async () => {});
  runtime.runtimeEvent("cli_a", { type: "turn-end" }); await runtime.shutdown();
  const spans = new TelemetrySpool(config(root)).list().flatMap(({ payload }) => payload.resourceSpans)
    .flatMap((resource) => resource.scopeSpans).flatMap((scope) => scope.spans);
  const roots = spans.filter((span) => span.name === "larkin.message.process");
  assert.equal(roots.length, 2, JSON.stringify(roots)); assert.deepEqual(roots.map((span) => span.links.length).sort(), [0, 1]);
  assert.equal(spans.find((span) => span.name === "feishu.send").traceId, roots.find((span) => span.links.length === 0).traceId);
});

test("OTLP upload only acknowledges files after a successful standard /v1/traces response", async () => {
  const root = temp(); const spool = new TelemetrySpool(config(root));
  spool.enqueue(payload());
  const failed = await flushTelemetry(spool, { endpoint: "http://127.0.0.1:1/v1/traces", timeoutMs: 100 });
  assert.equal(failed.status, "retained"); assert.equal(spool.status().queuedFiles, 1);
  let requestPath = ""; let received;
  const server = http.createServer((request, response) => {
    requestPath = request.url || ""; const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => { received = JSON.parse(Buffer.concat(chunks)); response.writeHead(200); response.end("{}"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const result = await flushTelemetry(spool, { endpoint: `http://127.0.0.1:${address.port}/v1/traces` });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(result.status, "uploaded"); assert.equal(requestPath, "/v1/traces");
  assert.ok(Array.isArray(received.resourceSpans)); assert.equal(spool.status().queuedFiles, 0);
});

test("OTLP partial success, throttling, and server failures retain the durable batch", async () => {
  for (const [expected, response] of [
    ["partial_success", new Response(JSON.stringify({ partialSuccess: { rejectedSpans: "1", errorMessage: "FORBIDDEN_RAW" } }), { status: 200 })],
    ["rate_limit", new Response("FORBIDDEN_RAW", { status: 429 })],
    ["server", new Response("FORBIDDEN_RAW", { status: 503 })],
  ]) {
    const root = temp(); const spool = new TelemetrySpool(config(root)); spool.enqueue(payload());
    const result = await flushTelemetry(spool, { endpoint: "http://collector.invalid/v1/traces", fetchImpl: async () => response });
    assert.deepEqual(result, { uploadedFiles: 0, status: "retained", errorCategory: expected });
    assert.equal(spool.status().queuedFiles, 1); assert.equal(JSON.stringify(spool.status()).includes("FORBIDDEN_RAW"), false);
  }
});

test("concurrent uploaders have single ownership of a batch", async () => {
  const root = temp(); const spool = new TelemetrySpool(config(root)); spool.enqueue(payload()); let calls = 0;
  const fetchImpl = async () => { calls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return new Response("{}", { status: 200 }); };
  const results = await Promise.all([
    flushTelemetry(spool, { endpoint: "http://collector.invalid/v1/traces", fetchImpl }),
    flushTelemetry(spool, { endpoint: "http://collector.invalid/v1/traces", fetchImpl }),
  ]);
  assert.equal(calls, 1); assert.ok(results.some((result) => result.status === "uploaded")); assert.equal(spool.status().queuedFiles, 0);
});

test("acknowledgement does not follow a swapped symlink", () => {
  const root = temp(); const spool = new TelemetrySpool(config(root)); spool.enqueue(payload());
  const [record] = spool.list(); const outside = path.join(root, "outside.txt"); fs.writeFileSync(outside, "preserve");
  fs.unlinkSync(record.file); fs.symlinkSync(outside, record.file);
  assert.throws(() => spool.acknowledge([record]), /acknowledgement failed/);
  assert.equal(fs.readFileSync(outside, "utf8"), "preserve"); assert.equal(fs.lstatSync(record.file).isSymbolicLink(), true);
});

test("bundle import validates every record before changing the queue", () => {
  const sourceRoot = temp(); const source = new TelemetrySpool(config(sourceRoot)); source.enqueue(payload());
  const original = path.join(sourceRoot, "bundle.gz"); source.exportBundle(original);
  const bundle = JSON.parse(zlib.gunzipSync(fs.readFileSync(original)).toString("utf8"));
  bundle.records.push({ sha256: "0".repeat(64), payload: payload("2") });
  const invalid = path.join(sourceRoot, "invalid.gz"); fs.writeFileSync(invalid, zlib.gzipSync(JSON.stringify(bundle)));
  const destination = new TelemetrySpool(config(temp()));
  assert.throws(() => destination.importBundle(invalid), /invalid telemetry bundle/); assert.equal(destination.status().queuedFiles, 0);
  const poisonedPayload = structuredClone(payload("3")); poisonedPayload.resourceSpans[0].resource.attributes.push({ key: "service.version", value: { stringValue: "/private/FORBIDDEN" } });
  const poisonedBytes = Buffer.from(JSON.stringify(poisonedPayload));
  bundle.records = [{ sha256: crypto.createHash("sha256").update(poisonedBytes).digest("hex"), payload: poisonedPayload }];
  const poisoned = path.join(sourceRoot, "poisoned.gz"); fs.writeFileSync(poisoned, zlib.gzipSync(JSON.stringify(bundle)));
  assert.throws(() => destination.importBundle(poisoned), /invalid telemetry payload/); assert.equal(destination.status().queuedFiles, 0);
});

test("runtime startup rejects stale cross-process parent state and clean shutdown removes ownership", async () => {
  const root = temp(); const stateDir = path.join(root, "state"); fs.mkdirSync(stateDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "telemetry-runtime-generation.json"), JSON.stringify({ version: 1, generation: "stale", pid: 99999999, expiresAt: Date.now() + 60_000 }));
  fs.writeFileSync(path.join(stateDir, "telemetry-active-context.json"), JSON.stringify({ version: 2, generation: "stale", traceId: "a".repeat(32), spanId: "b".repeat(16), traceFlags: 1, expiresAt: Date.now() + 60_000 }));
  const runtime = createTelemetryRuntime(config(root), { stateDirFor: () => stateDir, stateDirs: [stateDir] });
  assert.equal(fs.existsSync(path.join(stateDir, "telemetry-active-context.json")), false);
  assert.notEqual(JSON.parse(fs.readFileSync(path.join(stateDir, "telemetry-runtime-generation.json"), "utf8")).generation, "stale");
  await runtime.shutdown();
  assert.equal(fs.existsSync(path.join(stateDir, "telemetry-runtime-generation.json")), false);
});

test("corrupt queue and diagnostics files are isolated from manual and background upload", async () => {
  const root = temp(); const spool = new TelemetrySpool(config(root)); const file = spool.enqueue(payload());
  fs.writeFileSync(file, "{broken"); fs.writeFileSync(path.join(config(root).spoolDir, "diagnostics.json"), "{broken");
  let calls = 0; const result = await flushTelemetry(spool, { endpoint: "http://collector.invalid/v1/traces", fetchImpl: async () => { calls += 1; return new Response("{}"); } });
  assert.deepEqual(result, { uploadedFiles: 0, status: "retained", errorCategory: "spool" }); assert.equal(calls, 0);
  const uploader = startTelemetryUploader(spool, config(root, { endpoint: "http://collector.invalid/v1/traces", uploadIntervalMs: 5 }));
  await new Promise((resolve) => setTimeout(resolve, 20)); uploader.stop();
  assert.equal(spool.status().queuedFiles, 1); assert.equal(spool.status().lastErrorCategory, "spool");
});

test("configured background upload drains a restarted spool without blocking the producer", async () => {
  const root = temp(); const spool = new TelemetrySpool(config(root));
  spool.enqueue(payload());
  let received = 0;
  const server = http.createServer((request, response) => { request.resume(); request.on("end", () => { received += 1; response.writeHead(200); response.end("{}"); }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address();
  const uploader = startTelemetryUploader(new TelemetrySpool(config(root)), config(root, {
    endpoint: `http://127.0.0.1:${address.port}/v1/traces`, uploadIntervalMs: 10,
  }));
  const deadline = Date.now() + 2_000;
  while (spool.status().queuedFiles && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  uploader.stop(); await new Promise((resolve) => server.close(resolve));
  assert.equal(spool.status().queuedFiles, 0); assert.equal(received, 1);
});

test("telemetry records business failures without retrying or replacing their result", async () => {
  const root = temp(); const runtime = createTelemetryRuntime(config(root)); let calls = 0;
  await assert.rejects(runtime.externalPhase("cli_a", path.join(root, "state"), "tool.execute", SpanKind.CLIENT, async () => {
    calls += 1; throw new Error("FORBIDDEN_RAW_ERROR");
  }), /FORBIDDEN_RAW_ERROR/);
  assert.equal(calls, 1); await runtime.shutdown();
  assert.equal(JSON.stringify(new TelemetrySpool(config(root)).list()).includes("FORBIDDEN_RAW_ERROR"), false);
});
