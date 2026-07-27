import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { createNativeRuntimeAdapter } from "../../dist/runtime/runtime-adapters.mjs";

const enabled = process.env.LARKIN_RUN_RUNTIME_LIVE_TEST === "1";
const selected = new Set((process.env.LARKIN_LIVE_RUNTIMES || "codex,claude,pi").split(",").map((value) => value.trim()));

const waitFor = (events, predicate, timeoutMs = 60_000) => new Promise((resolve, reject) => {
  const existing = events.find(predicate);
  if (existing) return resolve(existing);
  const timer = setTimeout(() => reject(new Error("runtime live event timeout")), timeoutMs);
  events.waiters.push((event) => {
    if (!predicate(event)) return;
    clearTimeout(timer);
    resolve(event);
  });
});

for (const runtime of ["codex", "claude", "pi"]) {
  test.skipIf(!enabled || !selected.has(runtime))(`native ${runtime} standing prompt, session and busy input smoke`, { timeout: 180_000 }, async () => {
    const workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-live-${runtime}-`));
    const stateDir = path.join(workspaceDir, ".state");
    const events = [];
    events.waiters = [];
    try {
      const prompt = new ContextPromptBuilder().build({ agentId: "cli_liveSmokeA1", runtime, name: "Live Smoke" });
      const configuredModel = process.env[`LARKIN_LIVE_${runtime.toUpperCase()}_MODEL`]?.trim();
      const configuredEffort = process.env[`LARKIN_LIVE_${runtime.toUpperCase()}_EFFORT`]?.trim();
      const session = await createNativeRuntimeAdapter(runtime).createSession({
        agentId: "cli_liveSmokeA1", workspaceDir, stateDir, standingPrompt: prompt,
        ...(configuredModel ? { model: configuredModel } : {}),
        ...(configuredEffort ? { reasoningEffort: configuredEffort } : {}),
      });
      session.subscribe((event) => { events.push(event); for (const waiter of events.waiters) waiter(event); });
      if (runtime === "codex" && !session.sessionId) await waitFor(events, (event) => event.type === "session-init");
      const initial = await session.prompt({ inputId: "live-initial", kind: "initial", text: "Print LIVE_START, then briefly inspect the current directory without changing files." });
      assert.equal(initial.status, "accepted");
      await waitFor(events, (event) => event.type === "turn-start");
      const busy = await session.busyInput({ inputId: "live-busy", kind: "inbox_update", text: "At the next safe boundary, print LIVE_STEER. Do not cancel the current tool." });
      assert.equal(busy.status, "accepted");
      await waitFor(events, (event) => event.type === "turn-end", 120_000);
      const text = events.filter((event) => event.type === "activity" && event.text).map((event) => event.text).join("");
      assert.match(text, /LIVE_(?:START|STEER)/);
      const sessionId = session.sessionId;
      await session.close("live smoke complete");
      if (runtime === "pi" && sessionId) {
        const resumed = await createNativeRuntimeAdapter(runtime).createSession({
          agentId: "cli_liveSmokeA1", workspaceDir, stateDir, standingPrompt: prompt,
          resumeSessionId: sessionId,
          ...(configuredModel ? { model: configuredModel } : {}),
          ...(configuredEffort ? { reasoningEffort: configuredEffort } : {}),
        });
        assert.equal(resumed.sessionId, sessionId);
        await resumed.close("live resume smoke complete");
      }
    } finally { fs.rmSync(workspaceDir, { recursive: true, force: true }); }
  });
}
