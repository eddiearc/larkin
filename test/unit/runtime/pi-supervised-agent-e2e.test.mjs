import assert from "node:assert/strict";
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
import { AgentManager } from "../../../node_modules/@tintinweb/pi-subagents/src/agent-manager.ts";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-supervised-e2e-"));
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-supervised-agent-"));
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(agentDir, { recursive: true, force: true });
});

test("background Agent child exposes supervised tools and accepts steer between waits", async () => {
  const supervisedBundle = fileURLToPath(new URL("../../../dist/runtime/pi-supervised-command.bundle.js", import.meta.url));
  const subagentsEntry = fileURLToPath(new URL("../../../node_modules/@tintinweb/pi-subagents/src/index.ts", import.meta.url));
  assert.ok(fs.existsSync(supervisedBundle), "supervised bundle must exist");
  globalThis[Symbol.for("larkin-pi-supervised-command-bundle")] = supervisedBundle;
  process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS = "1";
  process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS = "8";

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
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(workDir),
    settingsManager: SettingsManager.create(workDir, agentDir),
  });
  await parent.bindExtensions({});
  const agent = parent.getToolDefinition("Agent");
  const steer = parent.getToolDefinition("steer_subagent");
  assert.ok(agent?.execute, "parent must expose public Agent");

  const originalSpawn = AgentManager.prototype.spawn;
  let childSession;
  AgentManager.prototype.spawn = function spawnProbe(...args) {
    const options = args[4] && typeof args[4] === "object" ? args[4] : {};
    const previous = options.onSessionCreated;
    const next = { ...options, onSessionCreated: (session) => {
      childSession = session;
      previous?.(session);
    } };
    for (const key of Object.getOwnPropertySymbols(options)) next[key] = options[key];
    args[4] = next;
    return originalSpawn.apply(this, args);
  };
  try {
    const spawned = await agent.execute("agent-1", {
      prompt: "stay alive",
      description: "supervised-e2e",
      subagent_type: "general-purpose",
      run_in_background: true,
    }, new AbortController().signal, () => {}, {
      cwd: workDir,
      sessionManager: parent.sessionManager,
      model: parent.model,
      modelRegistry: Object.assign(parent.modelRuntime ?? {}, { runtime: parent.modelRuntime }),
      ui: { setStatus() {}, notify() {}, setWidget() {} },
      getSystemPrompt: () => "supervised-e2e",
    });
    const started = Date.now();
    while (!childSession && Date.now() - started < 8000) await new Promise((r) => setTimeout(r, 25));
    assert.ok(childSession, `child session missing: ${JSON.stringify(spawned)}`);
    const startTool = childSession.getToolDefinition("supervised_start");
    const waitTool = childSession.getToolDefinition("supervised_wait");
    const names = (typeof childSession.getAllTools === "function" ? childSession.getAllTools() : []).map((tool) => tool.name);
    assert.ok(startTool?.execute && waitTool?.execute, `background child must register supervised tools: ${names.join(",")}`);
    const startedCmd = await startTool.execute("s1", {
      executable: process.execPath,
      args: ["-e", "setTimeout(() => {}, 4000)"],
    }, new AbortController().signal, () => {}, childSession);
    const handle = JSON.parse(startedCmd.content[0].text).handle;
    const pid = JSON.parse(startedCmd.content[0].text).pid;
    const wait1 = await waitTool.execute("w1", { handle, timeout: 1 }, new AbortController().signal, () => {}, childSession);
    const status1 = JSON.parse(wait1.content[0].text);
    assert.equal(status1.status, "running");
    assert.equal(status1.pid, pid);
    await childSession.steer("supervised-steer-marker");
    await assert.rejects(
      waitTool.execute("w2", { handle, timeout: 1 }, new AbortController().signal, () => {}, childSession),
      /once per turn/,
    );
  } finally {
    AgentManager.prototype.spawn = originalSpawn;
  }
}, { timeout: 20_000 });
