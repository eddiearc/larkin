import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";
import { createRuntimeHost } from "../../../dist/runtime/runtime-host.mjs";

class Session {
  listeners = new Set();
  constructor(id) { this.sessionId = id; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async prompt(input) { return { status: "accepted", inputId: input.inputId }; }
  async busyInput(input) { return { status: "accepted", inputId: input.inputId }; }
  async close() {}
}

async function waitFor(predicate) {
  const deadline = Date.now() + 1_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("runtime lifecycle timeout");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

for (const runtime of ["codex", "claude", "pi"]) {
  test(`${runtime} create, recreate, and stage fail closed through the same official CLI readiness contract`, async () => {
    const sessions = [];
    const checks = [];
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-${runtime}-workspace-env-`));
    const config = { agentId: `cli_${runtime}Official`, name: runtime, runtime, model: "model", workspaceDir: "/tmp",
      feishuAppId: `cli_${runtime}Official`, stateDir, larkConfigDir: path.join(stateDir, "lark-cli-config") };
    const adapter = { id: runtime, capabilities: {}, async probe() { return { runtime, state: "ready" }; },
      async createSession() { const session = new Session(`${runtime}-${sessions.length + 1}`); sessions.push(session); return session; } };
    const host = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
      assertOfficialCliReady(agent, env) {
        checks.push({ agentId: agent.agentId, profile: env.LARKSUITE_CLI_CONFIG_DIR,
          channel: env.LARK_CHANNEL, source: env.LARK_CHANNEL_CONFIG });
      }, retryPolicy: { baseDelayMs: 1, maxDelayMs: 1, maxAttempts: 2, stableWindowMs: 10_000 } });
    try {
      await host.start([config]);
      sessions[0].emit({ type: "closed", code: 1, signal: null });
      await waitFor(() => sessions.length === 2);
      const staged = await host.stage({ ...config, model: "staged" });
      await staged.commit();
      assert.equal(sessions.length, 3);
      assert.deepEqual(checks, Array.from({ length: 3 }, () => ({ agentId: config.agentId, profile: config.larkConfigDir,
        channel: "1", source: path.join(stateDir, "lark-channel-source", "config.json") })));
      await host.shutdown("done");
    } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
  });
}

test("official CLI readiness failure prevents Runtime probing and creation", async () => {
  let probed = false;
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-missing-workspace-env-"));
  const host = createRuntimeHost({ adapterFor: () => ({ id: "codex", capabilities: {}, async probe() {
    probed = true; return { runtime: "codex", state: "ready" };
  }, async createSession() { return new Session("unexpected"); } }), promptBuilder: new ContextPromptBuilder(),
  assertOfficialCliReady() { throw new Error("official lark-cli missing; run larkin setup"); } });
  try {
    await assert.rejects(host.start([{ agentId: "cli_missingOfficial", name: "missing", runtime: "codex", model: "model",
      workspaceDir: "/tmp", feishuAppId: "cli_missingOfficial", stateDir,
      larkConfigDir: path.join(stateDir, "lark-cli-config") }]), /No runtime Agent started.*official lark-cli missing/);
    assert.equal(probed, false);
    await host.shutdown("done");
  } finally { fs.rmSync(stateDir, { recursive: true, force: true }); }
});
