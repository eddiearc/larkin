import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "bun:test";
import { TelemetrySpool } from "../../../dist/platform/telemetry-spool.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const run = (script, env) => new Promise((resolve) => {
  const child = spawn(process.execPath, ["--eval", script], { cwd: ROOT, env: { ...process.env, ...env } });
  let stdout = "", stderr = ""; child.stdout.on("data", (chunk) => { stdout += chunk; }); child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("exit", (status) => resolve({ status, stdout, stderr }));
});

test("a restarted background uploader in a different PID drains the prior process durable spool", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-telemetry-restart-")); const spoolDir = path.join(root, "spool");
  const env = { TEST_SPOOL: spoolDir };
  const producer = await run(`
const {SpanKind}=require("@opentelemetry/api");
const {createTelemetryRuntime}=require("./dist/platform/telemetry-tracing.mjs");
const config={spoolDir:process.env.TEST_SPOOL,headers:{},maxBytes:1048576,maxFiles:100,maxAgeMs:60000,uploadIntervalMs:60000,requestTimeoutMs:1000};
const runtime=createTelemetryRuntime(config,{serviceVersion:"restart-test"});
runtime.externalPhase("agent",process.env.TEST_SPOOL,"feishu.send",SpanKind.CLIENT,async()=>{}).then(()=>runtime.shutdown()).then(()=>process.stdout.write(String(process.pid)));
`, env);
  assert.equal(producer.status, 0, producer.stderr); assert.equal(new TelemetrySpool({ spoolDir, maxBytes: 1048576, maxFiles: 100, maxAgeMs: 60000 }).status().queuedFiles, 1);
  let received = 0; const server = http.createServer((request, response) => { request.resume(); request.on("end", () => { received += 1; response.writeHead(200); response.end("{}"); }); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); const address = server.address();
  const uploader = await run(`
const {TelemetrySpool}=require("./dist/platform/telemetry-spool.mjs");const {startTelemetryUploader}=require("./dist/platform/telemetry-uploader.mjs");
const config={spoolDir:process.env.TEST_SPOOL,endpoint:process.env.TEST_ENDPOINT,headers:{},maxBytes:1048576,maxFiles:100,maxAgeMs:60000,uploadIntervalMs:10,requestTimeoutMs:1000};
const spool=new TelemetrySpool(config);const uploader=startTelemetryUploader(spool,config);const deadline=Date.now()+3000;
const timer=setInterval(()=>{if(spool.status().queuedFiles===0||Date.now()>deadline){clearInterval(timer);uploader.stop();process.stdout.write(String(process.pid));process.exit(spool.status().queuedFiles===0?0:2)}},10);
`, { ...env, TEST_ENDPOINT: `http://127.0.0.1:${address.port}/v1/traces` });
  await new Promise((resolve) => server.close(resolve));
  assert.equal(uploader.status, 0, uploader.stderr); assert.notEqual(uploader.stdout, producer.stdout); assert.equal(received, 1);
  assert.equal(new TelemetrySpool({ spoolDir, maxBytes: 1048576, maxFiles: 100, maxAgeMs: 60000 }).status().queuedFiles, 0);
  fs.rmSync(root, { recursive: true, force: true });
});
