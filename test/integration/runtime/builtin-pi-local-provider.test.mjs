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
