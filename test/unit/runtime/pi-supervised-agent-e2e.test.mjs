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

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-supervised-e2e-"));
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-supervised-agent-"));
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(agentDir, { recursive: true, force: true });
});

test("background Agent child exposes supervised tools and wait barrier", async () => {
  const supervisedBundle = fileURLToPath(new URL("../../../dist/runtime/pi-supervised-command.bundle.js", import.meta.url));
  const subagentsEntry = fileURLToPath(new URL("../../../dist/runtime/pi-subagents.bundle.js", import.meta.url));
  assert.ok(fs.existsSync(supervisedBundle), "supervised bundle must exist");
  assert.ok(fs.existsSync(subagentsEntry), "subagents bundle must exist");
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
  assert.ok(steer?.execute, "parent must expose public steer_subagent");

  const registry = globalThis[Symbol.for("pi-subagents:manager")];
  assert.ok(registry?.getRecord, "parent must expose subagents manager");
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
    const agentId = spawned?.details?.agentId;
    assert.ok(agentId, `missing agent id: ${JSON.stringify(spawned)}`);
    const started = Date.now();
    let childSession;
    while (Date.now() - started < 8000) {
      childSession = registry.getRecord(agentId)?.session;
      if (childSession) break;
      await new Promise((r) => setTimeout(r, 25));
    }
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
    const steered = await steer.execute("st1", {
      agent_id: agentId,
      message: "supervised-steer-marker",
    }, new AbortController().signal, () => {}, {
      cwd: workDir,
      sessionManager: parent.sessionManager,
      ui: { setStatus() {}, notify() {}, setWidget() {} },
    });
    const steeredText = steered?.content?.[0]?.text ?? "";
    assert.equal(/failed to steer/i.test(steeredText), false);
    if (!/^Steering message (sent to agent|queued for agent)/.test(steeredText)) {
      assert.match(steeredText, /is not running \(status: error\)/);
    }
    await assert.rejects(
      waitTool.execute("w2", { handle, timeout: 1 }, new AbortController().signal, () => {}, childSession),
      /once per turn/,
    );
    await childSession._extensionRunner?.emit?.({ type: "turn_end" });
    const wait2 = await waitTool.execute("w3", { handle, timeout: 1 }, new AbortController().signal, () => {}, childSession);
    assert.equal(JSON.parse(wait2.content[0].text).pid, pid);
    const cancelTool = childSession.getToolDefinition("supervised_cancel");
    await cancelTool.execute("c1", { handle }, new AbortController().signal, () => {}, childSession);
    await registry.dispose?.();
    let alive = true;
    try { process.kill(pid, 0); } catch { alive = false; }
    assert.equal(alive, false);
  } finally {
    await registry.dispose?.().catch(() => {});
  }
}, { timeout: 20_000 });
