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
import { fileURLToPath } from "node:url";
import { bundledPiBashTimeoutExtensionPath } from "../../../dist/runtime/pi-bash-timeout-injection.mjs";

import { AgentManager } from "../../../node_modules/@tintinweb/pi-subagents/src/agent-manager.ts";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue161-nested-"));
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue161-agent-"));
afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.rmSync(agentDir, { recursive: true, force: true });
});

async function sessionWithCliExtensions(paths) {
  const loader = new DefaultResourceLoader({
    cwd: workDir,
    agentDir,
    noExtensions: true,
    additionalExtensionPaths: paths,
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
  });
  await session.bindExtensions({});
  return session;
}

function toolCtx(session) {
  return {
    cwd: workDir,
    sessionManager: session.sessionManager,
    model: session.model,
    modelRegistry: Object.assign(session.modelRuntime ?? {}, { runtime: session.modelRuntime }),
    ui: { setStatus() {}, notify() {}, setWidget() {}, },
    getSystemPrompt: () => "nested-bash-e2e",
  };
}

async function waitFor(predicate, timeoutMs = 15_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("wait timed out");
}

test("Agent schema to nested session authorizes only that child past the parent cap", async () => {
  const prior = process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
  process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS = "2";
  const originalSpawn = AgentManager.prototype.spawn;
  try {
    const bashBundle = bundledPiBashTimeoutExtensionPath();
    const subagentsEntry = fileURLToPath(new URL("../../../node_modules/@tintinweb/pi-subagents/src/index.ts", import.meta.url));
    assert.ok(bashBundle);
    const parent = await sessionWithCliExtensions([bashBundle, subagentsEntry]);
    const bash = parent.getToolDefinition("bash");
    const agent = parent.getToolDefinition("Agent");
    assert.ok(bash?.execute && agent?.execute);
    const ctx = toolCtx(parent);
    await assert.rejects(
      bash.execute("parent-oversize", { command: "printf parent-no", timeout: 3 },
        new AbortController().signal, () => {}, ctx),
      /timeout:3 exceeds the 2s foreground hard limit/,
    );

    const probes = [];
    AgentManager.prototype.spawn = function spawnWithProbe(...args) {
      const options = args[4] && typeof args[4] === "object" ? args[4] : {};
      const previous = options.onSessionCreated;
      const next = { ...options, onSessionCreated: (session) => {
        probes.push((async () => {
          const childBash = session.getToolDefinition("bash");
          assert.ok(childBash?.execute, "child session must load the bash guard");
          let authorized = false;
          try {
            await childBash.execute("probe-cap", { command: "printf cap-ok", timeout: 5 },
              new AbortController().signal, () => {}, { sessionManager: session.sessionManager });
            authorized = true;
          } catch {
            authorized = false;
          }
          if (authorized) {
            const started = Date.now();
            const childResult = await childBash.execute("child-sleep", { command: "sleep 3 && printf child-ok", timeout: 5 },
              new AbortController().signal, () => {}, { sessionManager: session.sessionManager });
            assert.ok(Date.now() - started >= 2500, "child must outlive the 2s parent cap");
            assert.match(JSON.stringify(childResult), /child-ok/);
            const marker = `larkin-issue161-abort-${process.pid}-${Date.now()}`;
            const ac = new AbortController();
            const pending = childBash.execute("abort-sleep", { command: `sleep 30 # ${marker}`, timeout: 90 },
              ac.signal, () => {}, { sessionManager: session.sessionManager });
            ac.abort();
            await assert.rejects(pending, /abort/i);
            const leftover = spawnSync("pgrep", ["-fl", marker], { encoding: "utf8" });
            assert.equal((leftover.stdout || "").trim(), "", leftover.stdout);
          } else {
            await assert.rejects(
              childBash.execute("sib", { command: "printf no", timeout: 3 },
                new AbortController().signal, () => {}, { sessionManager: session.sessionManager }),
              /timeout:3 exceeds the 2s foreground hard limit/,
            );
          }
        })());
        previous?.(session);
        return probes[probes.length - 1];
      } };
      for (const key of Object.getOwnPropertySymbols(options)) next[key] = options[key];
      args[4] = next;
      return originalSpawn.apply(this, args);
    };

    const spawned = await agent.execute("agent-1", {
      prompt: "do not talk; wait",
      description: "nested-e2e",
      subagent_type: "general-purpose",
      run_in_background: true,
      max_command_wait_seconds: 90,
      isolated: true,
    }, new AbortController().signal, () => {}, ctx);
    const authorizedProbe = await waitFor(() => probes[0]);
    await authorizedProbe;
    const spawnedText = JSON.stringify(spawned);
    const agentId = spawnedText.match(/\b[0-9a-f]{17}\b/i)?.[0]
      ?? spawnedText.match(/[0-9a-f-]{8,}/i)?.[0];
    assert.ok(agentId, spawnedText);

    const siblingSpawned = await agent.execute("agent-2", {
      prompt: "sibling",
      description: "sibling-e2e",
      subagent_type: "general-purpose",
      run_in_background: true,
      isolated: true,
    }, new AbortController().signal, () => {}, ctx);
    const siblingProbe = await waitFor(() => probes[1]);
    await siblingProbe;
    assert.ok(JSON.stringify(siblingSpawned));

    const manager = globalThis[Symbol.for("pi-subagents:manager")];
    assert.equal(typeof manager?.abort, "function", "registry must expose abort");
    assert.equal(manager.abort(agentId), true);
    const record = manager.getRecord(agentId);
    if (record?.promise) await Promise.resolve(record.promise).catch(() => {});
    const child = record?.session;
    assert.ok(child, "aborted child session must still be inspectable");
    const childBash = child.getToolDefinition("bash");
    await assert.rejects(
      childBash.execute("after-revoke", { command: "printf no", timeout: 3 },
        new AbortController().signal, () => {}, { sessionManager: child.sessionManager }),
      /timeout:3 exceeds the 2s foreground hard limit|authorized bash wait was revoked/,
    );
  } finally {
    AgentManager.prototype.spawn = originalSpawn;
    if (prior === undefined) delete process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS;
    else process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS = prior;
  }
}, { timeout: 30_000 });

test("AgentManager spawn rejects public maxCommandWaitSeconds", () => {
  const manager = new AgentManager();
  assert.throws(() => manager.spawn({}, {}, "general-purpose", "go", {
    description: "e2e",
    isBackground: true,
    maxCommandWaitSeconds: 90,
  }), /not a public spawn option/);
  assert.throws(() => manager.spawn({}, {}, "general-purpose", "go", {
    description: "e2e",
    isBackground: true,
    maxCommandWaitSeconds: 600,
  }), /not a public spawn option/);
});
