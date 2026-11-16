import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { collectStatus } from "../../../dist/dashboard/dashboard-view-model.mjs";

const EPOCH = "2026-10-01T01:26:07.000Z";
const OBSERVED = "2026-10-01T01:26:33.000Z";
const HISTORIC = "2026-08-01T00:00:00.000Z";
const STALE_REASON = "Runtime readiness evidence is stale for the current daemon epoch.";

async function projectAgent(status) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-readiness-"));
  fs.chmodSync(root, 0o700);
  const agentId = "cli_ResumedReadyA1";
  const stateDir = path.join(root, "state", "agents", agentId);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4,
    serverId: "server-dashboard-readiness",
    mentionPolicy: "require",
    activeAgent: agentId,
    agents: { [agentId]: { runtime: "pi", model: "mock/known", createdAt: HISTORIC } },
  })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "daemon-status.json"), `${JSON.stringify({ startedAt: EPOCH })}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(stateDir, "status.json"), `${JSON.stringify(status)}\n`, { mode: 0o600 });
  const previousConfigDir = process.env.LARKIN_CONFIG_DIR;
  process.env.LARKIN_CONFIG_DIR = root;
  try {
    const projected = await collectStatus();
    assert.equal(projected.agents.length, 1);
    return projected.agents[0];
  } finally {
    if (previousConfigDir === undefined) delete process.env.LARKIN_CONFIG_DIR;
    else process.env.LARKIN_CONFIG_DIR = previousConfigDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("dashboard keeps ready runtime readiness for a resumed session observed in the current daemon epoch", async () => {
  const agent = await projectAgent({
    runtimeReadiness: { state: "ready", observedAt: OBSERVED },
    session: { id: "resumed-session", runtime: "pi", startedAt: HISTORIC, lastSeenAt: OBSERVED },
  });
  assert.deepEqual(agent.runtimeReadiness, { state: "ready", observedAt: OBSERVED });
  assert.equal(agent.session.startedAt, HISTORIC);
});

test("dashboard still downgrades stale ready evidence for the current daemon epoch", async () => {
  const observedAt = "2026-10-01T01:20:00.000Z";
  const agent = await projectAgent({
    runtimeReadiness: { state: "ready", observedAt },
    session: { id: "resumed-session", runtime: "pi", startedAt: HISTORIC, lastSeenAt: OBSERVED },
  });
  assert.deepEqual(agent.runtimeReadiness, {
    state: "unavailable",
    observedAt,
    reason: STALE_REASON,
  });
});

test("dashboard passes through an explicit unauthenticated runtime readiness state", async () => {
  const runtimeReadiness = {
    state: "unauthenticated",
    observedAt: OBSERVED,
    reason: "Runtime authentication is missing.",
  };
  const agent = await projectAgent({
    runtimeReadiness,
    session: { id: "resumed-session", runtime: "pi", startedAt: HISTORIC, lastSeenAt: OBSERVED },
  });
  assert.deepEqual(agent.runtimeReadiness, runtimeReadiness);
});
