import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createNativeRuntimeAdapter } from "../../../dist/runtime/runtime-adapters.mjs";
import { PiRpcClient } from "../../../dist/runtime/pi-rpc-client.mjs";
import { stageBuiltinPiProvider } from "../../../dist/runtime/pi-provider-config.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");

async function exerciseBuiltinPiTurn(binaryEntryPath, prefix, compiled = false) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  let observedAuthorization = "";
  let observedModel = "";
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      observedAuthorization = String(request.headers.authorization || "");
      try { observedModel = JSON.parse(body).model; } catch { /* assertion below */ }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "LARKIN_READY" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    fs.chmodSync(temp, 0o700);
    const address = server.address();
    assert.equal(typeof address, "object");
    const agentId = "cli_builtinPiA1";
    const transaction = stageBuiltinPiProvider(temp, agentId, {
      distribution: "builtin", preset: "custom", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "fixture-provider-key", model: "fixture-model",
    });
    transaction.commit();
    const workspaceDir = path.join(temp, "agents", agentId);
    const stateDir = path.join(temp, "state", "agents", agentId);
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    const env = {
      PATH: "/usr/bin:/bin",
      LARKIN_CONFIG_DIR: temp,
      LARKIN_HOME: temp,
      LARKIN_PI_DISTRIBUTION: "builtin",
      LARKIN_BINARY_ENTRY_PATH: binaryEntryPath,
    };
    if (compiled) {
      const child = spawn(binaryEntryPath, ["__internal", "pi-rpc", "--mode", "rpc", "--no-session",
        "--model", "larkin-custom/fixture-model"], {
        cwd: workspaceDir,
        env: { ...env, PI_CODING_AGENT_DIR: path.join(temp, "providers", "pi", agentId), PI_TELEMETRY: "0" },
        stdio: ["pipe", "pipe", "pipe"],
      });
      const client = new PiRpcClient(child, { requestTimeoutMs: 15_000 });
      const events = [];
      const terminal = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for compiled Pi turn: ${JSON.stringify(events)}`)), 15_000);
        client.subscribe((event) => {
          events.push(event);
          if (event.type === "agent_end") { clearTimeout(timer); resolve(); }
        });
        client.subscribeFailure((error) => { clearTimeout(timer); reject(error); });
      });
      const state = await client.request("get_state");
      assert.equal(`${state.model.provider}/${state.model.id}`, "larkin-custom/fixture-model");
      await client.request("prompt", { message: "Reply exactly LARKIN_READY" });
      await terminal;
      await client.close();
      assert.equal(observedAuthorization, "Bearer fixture-provider-key");
      assert.equal(observedModel, "fixture-model");
      assert.equal(events.some((event) => event.type === "message_end" && JSON.stringify(event).includes("LARKIN_READY")), true);
      assert.equal(events.some((event) => event.type === "agent_end"), true);
      return;
    }
    const adapter = createNativeRuntimeAdapter("pi", { env });
    const readiness = await adapter.probe({ agentId, workspaceDir, stateDir, env });
    assert.equal(readiness.state, "ready");
    assert.match(readiness.version, /official-pi 0\.84\.1 \(bundled\)/);
    const session = await adapter.createSession({
      agentId, workspaceDir, stateDir, model: "larkin-custom/fixture-model", standingPrompt: {
        version: "fixture", content: "Reply concisely.", hash: "fixture",
      }, env,
    });
    const events = [];
    const terminal = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for bundled Pi turn: ${JSON.stringify(events)}`)), 15_000);
      session.subscribe((event) => {
        events.push(event);
        if (event.type === "turn-end") { clearTimeout(timer); resolve(); }
        if (event.type === "error") { clearTimeout(timer); reject(new Error(event.message)); }
      });
    });
    assert.deepEqual(await session.prompt({ inputId: "controlled-turn", kind: "user", text: "Reply exactly LARKIN_READY", attempt: 1 }),
      { status: "accepted", inputId: "controlled-turn" });
    await terminal;
    const resumedSessionId = session.sessionId;
    assert.equal(typeof resumedSessionId, "string", "a real Pi turn must establish a resumable session id");
    const sessionFiles = fs.readdirSync(path.join(stateDir, "runtime", "pi-sessions"));
    assert.equal(sessionFiles.length, 1, "the first turn must persist exactly one Pi session file");
    assert.equal(JSON.parse(fs.readFileSync(path.join(stateDir, "runtime", "pi-sessions", sessionFiles[0]), "utf8").split("\n", 1)[0]).id, resumedSessionId);
    await session.close("test complete");
    const resumed = await adapter.createSession({
      agentId, workspaceDir, stateDir, model: "larkin-custom/fixture-model", resumeSessionId: resumedSessionId,
      standingPrompt: { version: "fixture", content: "Reply concisely.", hash: "fixture" }, env,
    });
    assert.equal(resumed.sessionId, resumedSessionId, "bundled Pi must resume the existing session rather than create a new one");
    const resumedEvents = [];
    const resumedTerminal = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for resumed bundled Pi turn: ${JSON.stringify(resumedEvents)}`)), 15_000);
      resumed.subscribe((event) => {
        resumedEvents.push(event);
        if (event.type === "turn-end") { clearTimeout(timer); resolve(); }
        if (event.type === "error") { clearTimeout(timer); reject(new Error(event.message)); }
      });
    });
    assert.deepEqual(await resumed.prompt({ inputId: "resumed-turn", kind: "user", text: "Reply exactly LARKIN_READY again", attempt: 1 }),
      { status: "accepted", inputId: "resumed-turn" });
    await resumedTerminal;
    await resumed.close("test complete");
    assert.equal(observedAuthorization, "Bearer fixture-provider-key");
    assert.equal(observedModel, "fixture-model");
    assert.equal(events.some((event) => event.type === "activity" && event.text?.includes("LARKIN_READY")), true);
    assert.equal(resumedEvents.some((event) => event.type === "activity" && event.text?.includes("LARKIN_READY")), true);
    assert.equal(events.some((event) => event.type === "turn-end"), true);
    assert.equal(resumedEvents.some((event) => event.type === "turn-end"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test("bundled official Pi completes a controlled turn against a local OpenAI-compatible provider without external Agent CLIs", { timeout: 30_000 }, async () => {
  await exerciseBuiltinPiTurn(path.join(ROOT, "dist", "app", "binary-entry.mjs"), "larkin-builtin-pi-turn-");
});

test("an external-shaped Pi 0.84.1 session resumes under bundled Pi with only a local provider", { timeout: 30_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-external-to-builtin-resume-"));
  const agentId = "cli_crossDistributionA1";
  const entry = path.join(ROOT, "dist", "app", "binary-entry.mjs");
  const workspaceDir = path.join(temp, "agents", agentId);
  const stateDir = path.join(temp, "state", "agents", agentId);
  fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let observedAuthorization = "";
  let observedModel = "";
  const server = http.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      observedAuthorization = String(request.headers.authorization || "");
      try { observedModel = JSON.parse(body).model; } catch { /* assertion below */ }
      response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      response.write(`data: ${JSON.stringify({ id: "cross", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: { role: "assistant", content: "CROSS_DIST_READY" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ id: "cross", object: "chat.completion.chunk", created: 1, model: "fixture-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
      response.end("data: [DONE]\n\n");
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    stageBuiltinPiProvider(temp, agentId, {
      distribution: "builtin", preset: "custom", baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: "cross-distribution-fixture-key", model: "fixture-model",
    }).commit();
    const providerDir = path.join(temp, "providers", "pi", agentId);
    const wrapper = path.join(temp, "pi-0.84.1-external-fixture");
    fs.writeFileSync(wrapper, `#!${process.execPath}
import { spawn } from "node:child_process";
if (process.argv.includes("--version")) { console.log("0.84.1"); process.exit(0); }
const incoming = process.argv.slice(2); const args = [];
for (let index = 0; index < incoming.length; index += 1) {
  if (incoming[index] === "-e") { index += 1; continue; }
  args.push(incoming[index]);
}
const child = spawn(process.execPath, [${JSON.stringify(entry)}, "__internal", "pi-rpc", ...args], {
  env: { ...process.env, HOME: ${JSON.stringify(temp)}, PI_CODING_AGENT_DIR: ${JSON.stringify(providerDir)},
    LARKIN_PI_DISTRIBUTION: "builtin", LARKIN_BINARY_ENTRY_PATH: ${JSON.stringify(entry)} },
  stdio: ["pipe", "pipe", "inherit"],
});
process.stdin.pipe(child.stdin);
let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += String(chunk);
  for (;;) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
    try {
      const value = JSON.parse(line);
      if (value.type === "response" && value.command === "get_state" && value.success === true && value.data) {
        value.data.compactionCapabilities = { reserveTokens: 40800, keepRecentTokens: 20000,
          events: ["compaction_start", "compaction_end", "agent_end", "agent_settled"] };
      }
      process.stdout.write(JSON.stringify(value) + "\\n");
    } catch { process.stdout.write(line + "\\n"); }
  }
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
`, { mode: 0o700 });
    fs.chmodSync(wrapper, 0o700);
    const baseEnv = { PATH: "/usr/bin:/bin", LARKIN_CONFIG_DIR: temp, LARKIN_HOME: temp, LARKIN_BINARY_ENTRY_PATH: entry };
    const standingPrompt = { version: "cross-distribution-fixture", content: "Reply concisely.", hash: "cross-distribution-fixture" };
    const external = createNativeRuntimeAdapter("pi", { piCommand: wrapper, env: baseEnv });
    const externalReadiness = await external.probe({ agentId, workspaceDir, stateDir, env: baseEnv });
    assert.equal(externalReadiness.state, "ready", externalReadiness.reason);
    const created = await external.createSession({ agentId, workspaceDir, stateDir, model: "larkin-custom/fixture-model", standingPrompt, env: baseEnv });
    const firstEvents = [];
    const firstEnd = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`external fixture turn timeout: ${JSON.stringify(firstEvents)}`)), 15_000);
      created.subscribe((event) => {
        firstEvents.push(event);
        if (event.type === "turn-end") { clearTimeout(timer); resolve(); }
        if (event.type === "error") { clearTimeout(timer); reject(new Error(event.message)); }
      });
    });
    assert.deepEqual(await created.prompt({ inputId: "external-created", kind: "user", text: "Reply exactly CROSS_DIST_READY", attempt: 1 }),
      { status: "accepted", inputId: "external-created" });
    await firstEnd;
    const externalSessionId = created.sessionId;
    assert.equal(typeof externalSessionId, "string");
    await created.close("external fixture complete");
    const bundledEnv = { ...baseEnv, LARKIN_PI_DISTRIBUTION: "builtin" };
    const bundled = createNativeRuntimeAdapter("pi", { env: bundledEnv });
    const resumed = await bundled.createSession({ agentId, workspaceDir, stateDir, model: "larkin-custom/fixture-model",
      resumeSessionId: externalSessionId, standingPrompt, env: bundledEnv });
    assert.equal(resumed.sessionId, externalSessionId, "bundled Pi must resume the external-created session");
    const resumedEvents = [];
    const resumedEnd = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`bundled resume timeout: ${JSON.stringify(resumedEvents)}`)), 15_000);
      resumed.subscribe((event) => {
        resumedEvents.push(event);
        if (event.type === "turn-end") { clearTimeout(timer); resolve(); }
        if (event.type === "error") { clearTimeout(timer); reject(new Error(event.message)); }
      });
    });
    assert.deepEqual(await resumed.prompt({ inputId: "bundled-resumed", kind: "user", text: "Reply exactly CROSS_DIST_READY again", attempt: 1 }),
      { status: "accepted", inputId: "bundled-resumed" });
    await resumedEnd;
    await resumed.close("cross-distribution test complete");
    assert.equal(observedAuthorization, "Bearer cross-distribution-fixture-key");
    assert.equal(observedModel, "fixture-model");
    assert.equal(firstEvents.some((event) => event.type === "turn-end"), true);
    assert.equal(resumedEvents.some((event) => event.type === "turn-end"), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

const compiledEnabled = process.env.LARKIN_RUN_COMPILED_BUILTIN_PI_E2E === "1";
test.skipIf(!compiledEnabled)("compiled single-file Larkin completes a real bundled official Pi provider turn with embedded assets", { timeout: 180_000 }, async () => {
  const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-compiled-builtin-pi-release-"));
  try {
    const build = spawnSync(process.execPath, ["scripts/release/build.ts", "--target", `${os.platform()}-${os.arch()}`,
      "--out-dir", releaseDir, "--allow-dirty"], { cwd: ROOT, env: process.env, encoding: "utf8", timeout: 150_000 });
    assert.equal(build.error, undefined, build.error?.message);
    assert.equal(build.status, 0, `${build.stdout}\n${build.stderr}`);
    const manifest = JSON.parse(fs.readFileSync(path.join(releaseDir, "release-manifest.json"), "utf8"));
    const artifact = path.join(releaseDir, manifest.artifacts[0].file);
    await exerciseBuiltinPiTurn(artifact, "larkin-compiled-builtin-pi-turn-", true);
  } finally {
    fs.rmSync(releaseDir, { recursive: true, force: true });
  }
});
