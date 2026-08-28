import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { afterAll, test } from "bun:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { materializeEmbeddedPiSubagentBundle } from "../../../src/runtime/pi-subagent-injection.ts";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const workDir = fs.mkdtempSync(path.join(ROOT, ".tmp-sa-supervised-"));
const agentDir = fs.mkdtempSync(path.join(ROOT, ".tmp-sa-supervised-agent-"));
const configDir = fs.mkdtempSync(path.join(workDir, "config-"));
const priorStandalone = process.env.LARKIN_STANDALONE;
const priorWait = process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS;
const priorLife = process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS;
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(agentDir, { recursive: true, force: true });
  if (priorStandalone === undefined) delete process.env.LARKIN_STANDALONE;
  else process.env.LARKIN_STANDALONE = priorStandalone;
  if (priorWait === undefined) delete process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS;
  else process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS = priorWait;
  if (priorLife === undefined) delete process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS;
  else process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS = priorLife;
  delete globalThis.__LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__;
  delete globalThis.__LARKIN_EMBEDDED_PI_SUPERVISED_COMMAND_BUNDLE__;
});

test("standalone embed materialize exposes public Agent start/wait/cancel", async () => {
  const subSrc = path.join(ROOT, "dist/runtime/pi-subagents.bundle.js");
  const supSrc = path.join(ROOT, "dist/runtime/pi-supervised-command.bundle.js");
  assert.ok(fs.existsSync(subSrc) && fs.existsSync(supSrc), "production dist bundles must exist");
  globalThis.__LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__ = fs.readFileSync(subSrc, "utf8");
  globalThis.__LARKIN_EMBEDDED_PI_SUPERVISED_COMMAND_BUNDLE__ = fs.readFileSync(supSrc, "utf8");
  process.env.LARKIN_STANDALONE = "1";
  process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS = "1";
  process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS = "8";
  assert.ok(globalThis.__LARKIN_EMBEDDED_PI_SUBAGENTS_BUNDLE__?.length > 100);
  assert.ok(globalThis.__LARKIN_EMBEDDED_PI_SUPERVISED_COMMAND_BUNDLE__?.length > 100);
  const materialized = materializeEmbeddedPiSubagentBundle(configDir);
  assert.ok(materialized, `standalone entry must materialize the subagents bundle under ${configDir}`);
  const sibling = path.join(path.dirname(materialized), "pi-supervised-command.bundle.js");
  assert.equal(fs.existsSync(sibling), true);
  assert.equal(fs.statSync(materialized).mode & 0o777, 0o600);
  assert.equal(fs.statSync(sibling).mode & 0o777, 0o600);

  const loader = new DefaultResourceLoader({
    cwd: workDir,
    agentDir,
    noExtensions: true,
    additionalExtensionPaths: [materialized],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "standalone-supervised",
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
  assert.ok(agent?.execute, "standalone-loaded parent must expose public Agent");
  const registry = globalThis[Symbol.for("pi-subagents:manager")];
  const spawned = await agent.execute("agent-1", {
    prompt: "stay alive",
    description: "sa-supervised",
    subagent_type: "general-purpose",
    run_in_background: true,
  }, new AbortController().signal, () => {}, {
    cwd: workDir,
    sessionManager: parent.sessionManager,
    model: parent.model,
    modelRegistry: Object.assign(parent.modelRuntime ?? {}, { runtime: parent.modelRuntime }),
    ui: { setStatus() {}, notify() {}, setWidget() {} },
    getSystemPrompt: () => "standalone-supervised",
  });
  const agentId = spawned?.details?.agentId;
  assert.ok(agentId);
  const deadline = Date.now() + 8000;
  let childSession;
  while (Date.now() < deadline) {
    childSession = registry.getRecord(agentId)?.session;
    if (childSession) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.ok(childSession, "child session missing");
  const startTool = childSession.getToolDefinition("supervised_start");
  const waitTool = childSession.getToolDefinition("supervised_wait");
  const cancelTool = childSession.getToolDefinition("supervised_cancel");
  assert.ok(startTool?.execute && waitTool?.execute && cancelTool?.execute);
  const started = await startTool.execute("s1", {
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 4000)"],
  }, new AbortController().signal, () => {}, childSession);
  const handle = JSON.parse(started.content[0].text).handle;
  const pid = JSON.parse(started.content[0].text).pid;
  const wait1 = JSON.parse((await waitTool.execute("w1", { handle, timeout: 1 }, new AbortController().signal, () => {}, childSession)).content[0].text);
  assert.equal(wait1.status, "running");
  assert.equal(wait1.pid, pid);
  await cancelTool.execute("c1", { handle }, new AbortController().signal, () => {}, childSession);
  let alive = true;
  try { process.kill(pid, 0); } catch { alive = false; }
  assert.equal(alive, false);
}, { timeout: 20_000 });
