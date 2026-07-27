import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { collectStatus, parsePiSessionUsage } from "../../../dist/dashboard/dashboard-view-model.mjs";

function withSession(rows, run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-context-"));
  const file = path.join(root, "session.jsonl");
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  try { return run(file); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const catalog = [
  { id: "mock/changed", contextWindow: 100_000 },
  { id: "mock/assistant", contextWindow: 200_000 },
];

test("Pi context uses current model_change catalog window and latest usage instead of cumulative tokens", () => {
  withSession([
    { type: "session", id: "pi-known", timestamp: "2026-07-25T00:00:00.000Z", cwd: "/tmp" },
    { type: "model_change", provider: "mock", modelId: "changed", timestamp: "2026-07-25T00:00:01.000Z" },
    { type: "message", timestamp: "2026-07-25T00:00:02.000Z", message: { role: "assistant", usage: { totalTokens: 90_000 } } },
    { type: "message", timestamp: "2026-07-25T00:00:03.000Z", message: { role: "assistant", usage: { totalTokens: 10_000 } } },
  ], (file) => {
    const usage = parsePiSessionUsage(file, catalog);
    assert.equal(usage.cumulativeTokens, 100_000);
    assert.equal(usage.latestTokens, 10_000);
    assert.equal(usage.contextWindow, 100_000);
    assert.equal(usage.contextPercent, 10);
  });
});

test("Pi assistant provider/model updates the current catalog model", () => {
  withSession([
    { type: "session", id: "pi-assistant", timestamp: "2026-07-25T00:00:00.000Z", cwd: "/tmp" },
    { type: "model_change", provider: "mock", modelId: "changed", timestamp: "2026-07-25T00:00:01.000Z" },
    { type: "message", timestamp: "2026-07-25T00:00:02.000Z", message: { role: "assistant", provider: "mock", model: "assistant", usage: { totalTokens: 10_000 } } },
  ], (file) => {
    const usage = parsePiSessionUsage(file, catalog);
    assert.equal(usage.contextWindow, 200_000);
    assert.equal(usage.contextPercent, 5);
  });
});

test("Pi unknown model and invalid catalog windows preserve the turns fallback contract", () => {
  withSession([
    { type: "session", id: "pi-unknown", timestamp: "2026-07-25T00:00:00.000Z", cwd: "/tmp" },
    { type: "message", timestamp: "2026-07-25T00:00:01.000Z", message: { role: "user", content: "test" } },
    { type: "message", timestamp: "2026-07-25T00:00:02.000Z", message: { role: "assistant", provider: "mock", model: "missing", usage: { totalTokens: 10_000 } } },
  ], (file) => {
    const usage = parsePiSessionUsage(file, [
      { id: "mock/missing", contextWindow: 0 },
      { id: "mock/other", contextWindow: Number.NaN },
    ]);
    assert.equal(usage.turns, 1);
    assert.equal(usage.contextWindow, null);
    assert.equal(usage.contextPercent, null);
  });
});

test("collectStatus projects a known Pi catalog window using the latest assistant usage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-pi-status-"));
  fs.chmodSync(root, 0o700);
  const agentId = "cli_PiContextA1";
  const sessionId = "pi-context-session";
  const stateDir = path.join(root, "state", "agents", agentId);
  const sessionFile = path.join(stateDir, "runtime", "pi-sessions", "session.jsonl");
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4,
    serverId: "server-pi-context",
    mentionPolicy: "require",
    activeAgent: agentId,
    agents: { [agentId]: { runtime: "pi", model: "mock/known", createdAt: "2026-07-25T00:00:00.000Z" } },
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(stateDir, "agent-state.json"), JSON.stringify({ sessions: { pi: sessionId } }));
  fs.writeFileSync(sessionFile, `${[
    { type: "session", id: sessionId, timestamp: "2026-07-25T00:00:00.000Z", cwd: "/tmp" },
    { type: "model_change", provider: "mock", modelId: "known", timestamp: "2026-07-25T00:00:01.000Z" },
    { type: "message", timestamp: "2026-07-25T00:00:02.000Z", message: { role: "assistant", provider: "mock", model: "known", usage: { totalTokens: 80_000 } } },
    { type: "message", timestamp: "2026-07-25T00:00:03.000Z", message: { role: "assistant", provider: "mock", model: "known", usage: { totalTokens: 10_000 } } },
  ].map((row) => JSON.stringify(row)).join("\n")}\n`);
  const previousConfigDir = process.env.LARKIN_CONFIG_DIR;
  process.env.LARKIN_CONFIG_DIR = root;
  try {
    const calls = [];
    const projected = await collectStatus({ piModelResolver: { async resolve(input) {
      calls.push(input);
      return [{ id: "mock/known", contextWindow: 200_000 }];
    } } });
    const usage = projected.agents[0].session.usage;
    assert.equal(calls.length, 1);
    assert.equal(usage.cumulativeTokens, 90_000);
    assert.equal(usage.latestTokens, 10_000);
    assert.equal(usage.contextWindow, 200_000);
    assert.equal(usage.contextPercent, 5);

    const fallback = await collectStatus({ piModelResolver: { async resolve() {
      throw new Error("fixture auth secret detail");
    } } });
    assert.equal(fallback.agents[0].session.usage.contextWindow, null);
    assert.equal(fallback.agents[0].session.usage.contextPercent, null);
    assert.doesNotMatch(JSON.stringify(fallback), /fixture auth secret detail/);
  } finally {
    if (previousConfigDir === undefined) delete process.env.LARKIN_CONFIG_DIR;
    else process.env.LARKIN_CONFIG_DIR = previousConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
