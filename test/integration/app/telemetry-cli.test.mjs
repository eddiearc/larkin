import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "bun:test";
import { TelemetrySpool } from "../../../dist/platform/telemetry-spool.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const entry = path.join(ROOT, "dist/app/binary-entry.mjs");
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "larkin-telemetry-cli-"));
const spoolConfig = (home) => ({ spoolDir: path.join(home, "telemetry", "spool"), maxBytes: 1024 * 1024,
  maxFiles: 100, maxAgeMs: 60_000 });
const payload = { resourceSpans: [{ resource: { attributes: [{ key: "service.name", value: { stringValue: "larkin" } }] },
  scopeSpans: [{ scope: { name: "larkin.telemetry", version: "1.0.0" }, spans: [{ traceId: "1".repeat(32), spanId: "2".repeat(16),
    name: "larkin.message.process", kind: 5, startTimeUnixNano: "1", endTimeUnixNano: "2", attributes: [], links: [], status: { code: 0 }, flags: 1 }] }] }] };
const cli = (home, args, env = {}) => new Promise((resolve) => {
  const child = spawn(process.execPath, [entry, "__internal", "telemetry", ...args], {
    cwd: ROOT, env: { ...process.env, LARKIN_HOME: home, LARKIN_CONFIG_DIR: home, ...env },
  });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("exit", (status) => resolve({ status, stdout, stderr }));
});

test("telemetry status and export/import/flush work through the real CLI dispatcher", async () => {
  const sourceHome = temp(); const destinationHome = temp();
  const source = new TelemetrySpool(spoolConfig(sourceHome));
  source.enqueue(payload);
  const status = await cli(sourceHome, ["status"]);
  assert.equal(status.status, 0, status.stderr); assert.equal(JSON.parse(status.stdout).queuedFiles, 1);
  const bundle = path.join(sourceHome, "bundle.json.gz");
  const exported = await cli(sourceHome, ["export", "--output", bundle]);
  assert.equal(exported.status, 0, exported.stderr); assert.equal(JSON.parse(exported.stdout).sourceQueueRetained, true);
  assert.equal(JSON.parse(exported.stdout).output, "bundle.json.gz");
  const imported = await cli(destinationHome, ["import", "--input", bundle]);
  assert.equal(imported.status, 0, imported.stderr); assert.equal(JSON.parse(imported.stdout).imported, 1);

  let received;
  const server = http.createServer((request, response) => {
    const chunks = []; request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => { received = JSON.parse(Buffer.concat(chunks)); response.writeHead(200); response.end("{}"); });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const flushed = await cli(destinationHome, ["flush", "--endpoint", `http://127.0.0.1:${address.port}/v1/traces`]);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(flushed.status, 0, flushed.stderr); assert.equal(JSON.parse(flushed.stdout).status, "uploaded");
  assert.equal(received.resourceSpans[0].scopeSpans[0].spans[0].traceId, "1".repeat(32));

  const privatePath = path.join(sourceHome, "private", "v1", "traces");
  const endpointStatus = await cli(sourceHome, ["status"], { LARKIN_TELEMETRY_OTLP_ENDPOINT: `http://collector.example:4318${privatePath}` });
  assert.equal(JSON.parse(endpointStatus.stdout).endpoint, "http://collector.example:4318");
  const missing = await cli(sourceHome, ["import", "--input", path.join(sourceHome, "FORBIDDEN-secret.gz")]);
  assert.equal(missing.status, 1); assert.equal(missing.stderr.includes(sourceHome), false); assert.match(missing.stderr, /operation failed/);
});
