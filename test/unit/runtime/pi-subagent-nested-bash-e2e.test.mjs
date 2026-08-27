import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "bun:test";
import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { bundledPiBashTimeoutExtensionPath } from "../../../dist/runtime/pi-bash-timeout-injection.mjs";
import { setSubagentBashWaitSeconds } from "../../../dist/runtime/pi-subagent-bash-wait.mjs";
import { AgentManager } from "../../../node_modules/@tintinweb/pi-subagents/src/agent-manager.ts";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue161-nested-"));
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue161-agent-"));
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(agentDir, { recursive: true, force: true });
});

async function nestedSessionWithBashGuard() {
  const bundle = bundledPiBashTimeoutExtensionPath();
  assert.ok(bundle, "pi-bash-timeout bundle must exist (run bun run build first)");
  const loader = new DefaultResourceLoader({
    cwd: workDir,
    agentDir,
    noExtensions: true,
    additionalExtensionPaths: [bundle],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => "nested-bash-e2e",
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: workDir,
    agentDir,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(workDir),
    settingsManager: SettingsManager.create(workDir, agentDir),
    tools: ["bash"],
  });
  await session.bindExtensions({});
  const bash = session.getToolDefinition("bash");
  assert.ok(bash?.execute, "child session must expose the bash tool from the Larkin guard");
  return { session, bash };
}

test("child loader applies Larkin bash guard and WeakMap cap", async () => {
  const { session, bash } = await nestedSessionWithBashGuard();
  const ctx = { sessionManager: session.sessionManager };
  await assert.rejects(
    bash.execute("cap-60", { command: "printf should-not-run", timeout: 61 },
      new AbortController().signal, () => {}, ctx),
    /timeout:61 exceeds the 60s foreground hard limit/,
  );
  setSubagentBashWaitSeconds(session.sessionManager, 90);
  const result = await bash.execute("cap-90", { command: "printf nested-ok", timeout: 90 },
    new AbortController().signal, () => {}, ctx);
  assert.match(JSON.stringify(result), /nested-ok/);
  await assert.rejects(
    bash.execute("cap-91", { command: "printf should-not-run", timeout: 91 },
      new AbortController().signal, () => {}, ctx),
    /timeout:91 exceeds the 90s background-subagent bash limit/,
  );
});

test("authorized nested bash abort reclaims the sleep process", async () => {
  const { session, bash } = await nestedSessionWithBashGuard();
  setSubagentBashWaitSeconds(session.sessionManager, 90);
  const marker = `larkin-issue161-abort-${process.pid}-${Date.now()}`;
  const ac = new AbortController();
  const pending = bash.execute("abort-sleep", { command: `sleep 30 # ${marker}`, timeout: 90 },
    ac.signal, () => {}, { sessionManager: session.sessionManager });
  ac.abort();
  await assert.rejects(pending, /abort/i);
  const leftover = spawnSync("pgrep", ["-fl", marker], { encoding: "utf8" });
  assert.equal((leftover.stdout || "").trim(), "", leftover.stdout);
});

test("AgentManager spawn rejects unauthorized or oversized wait caps", () => {
  const manager = new AgentManager();
  const spawn = (options) => manager.spawn({}, {}, "general-purpose", "go", {
    description: "e2e",
    ...options,
  });
  assert.throws(() => spawn({ isBackground: false, maxCommandWaitSeconds: 90 }), /isBackground: true/);
  assert.throws(() => spawn({ isBackground: true, maxCommandWaitSeconds: 60 }), /61..600/);
  assert.throws(() => spawn({ isBackground: true, maxCommandWaitSeconds: 601 }), /61..600/);
  assert.throws(() => spawn({ isBackground: true, maxCommandWaitSeconds: 90.5 }), /61..600/);
});
