import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { afterAll, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-supervised-steer-"));
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-supervised-steer-agent-"));
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(agentDir, { recursive: true, force: true });
});

function sse(payloads) {
  return payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("") + "data: [DONE]\n\n";
}

test("public steer_subagent changes the next fake-provider turn", async () => {
  const subagentsEntry = fileURLToPath(new URL("../../../dist/runtime/pi-subagents.bundle.js", import.meta.url));
  assert.ok(fs.existsSync(subagentsEntry));
  process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS = "1";
  process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS = "8";
  process.env.PI_CODING_AGENT_DIR = agentDir;
  process.env.OPENAI_API_KEY = "sk-test";
  fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({
    openai: { type: "api_key", key: "sk-test" },
  }));

  const bodies = [];
  const sockets = [];
  let startCalls = 0;
  const provider = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      bodies.push(body);
      res.writeHead(200, { "content-type": "text/event-stream" });
      if (body.includes("supervised-steer-marker")) {
        res.end(sse([
          { id: "f", object: "chat.completion.chunk", created: 1, model: "fixture-supervised", choices: [{ index: 0, delta: { role: "assistant", content: "STEERED_OK" }, finish_reason: null }] },
          { id: "f", object: "chat.completion.chunk", created: 1, model: "fixture-supervised", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]));
        return;
      }
      startCalls += 1;
      if (startCalls === 1) {
        res.end(sse([
          { id: "f", object: "chat.completion.chunk", created: 1, model: "fixture-supervised", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "call_start", type: "function", function: { name: "supervised_start", arguments: "" } }] }, finish_reason: null }] },
          { id: "f", object: "chat.completion.chunk", created: 1, model: "fixture-supervised", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify({ executable: process.execPath, args: ["-e", "setTimeout(()=>{}, 8000)"] }) } }] }, finish_reason: null }] },
          { id: "f", object: "chat.completion.chunk", created: 1, model: "fixture-supervised", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
    });
  });
  provider.on("connection", (socket) => sockets.push(socket));
  await new Promise((resolve, reject) => {
    provider.once("error", reject);
    provider.listen(0, "127.0.0.1", resolve);
  });
  const model = {
    id: "fixture-supervised",
    name: "Fixture",
    api: "openai-completions",
    provider: "openai",
    baseUrl: `http://127.0.0.1:${provider.address().port}/v1`,
    reasoning: false,
    input: ["text"],
    contextWindow: 128000,
    maxTokens: 256,
  };
  try {
    const loader = new DefaultResourceLoader({
      cwd: workDir,
      agentDir,
      noExtensions: true,
      additionalExtensionPaths: [subagentsEntry],
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPromptOverride: () => "supervised-e2e",
      appendSystemPromptOverride: () => [],
    });
    await loader.reload();
    const { session: parent } = await createAgentSession({
      cwd: workDir,
      agentDir,
      model,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(workDir),
      settingsManager: SettingsManager.create(workDir, agentDir),
    });
    await parent.bindExtensions({});
    const agent = parent.getToolDefinition("Agent");
    const steer = parent.getToolDefinition("steer_subagent");
    const registry = globalThis[Symbol.for("pi-subagents:manager")];
    const spawned = await agent.execute("agent-1", {
      prompt: "stay alive",
      description: "supervised-steer",
      subagent_type: "general-purpose",
      run_in_background: true,
    }, new AbortController().signal, () => {}, {
      cwd: workDir,
      sessionManager: parent.sessionManager,
      model,
      modelRegistry: Object.assign(parent.modelRuntime ?? {}, { runtime: parent.modelRuntime }),
      ui: { setStatus() {}, notify() {}, setWidget() {} },
      getSystemPrompt: () => "supervised-e2e",
    });
    const agentId = spawned?.details?.agentId;
    assert.ok(agentId, JSON.stringify(spawned));
    const deadline = Date.now() + 8000;
    let record;
    while (Date.now() < deadline) {
      record = registry.getRecord(agentId);
      if (record?.status === "running" && record.session) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(record?.status, "running", JSON.stringify({ status: record?.status, error: record?.error }));
    const steered = await steer.execute("st1", {
      agent_id: agentId,
      message: "supervised-steer-marker",
    }, new AbortController().signal, () => {}, {
      cwd: workDir,
      sessionManager: parent.sessionManager,
      ui: { setStatus() {}, notify() {}, setWidget() {} },
    });
    const steeredText = steered?.content?.[0]?.text ?? "";
    assert.doesNotMatch(steeredText, /failed to steer|is not running/i);
    assert.match(steeredText, /^Steering message (sent to agent|queued for agent)/);
    const saw = Date.now() + 8000;
    while (Date.now() < saw && !bodies.some((body) => body.includes("supervised-steer-marker"))) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(bodies.some((body) => body.includes("supervised-steer-marker")), "fake provider never saw steered user input");
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => provider.close(resolve));
  }
}, { timeout: 20_000 });
