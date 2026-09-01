import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";
import {
  DEFAULT_MISSED_OUTBOUND_REPEAT,
  DEFAULT_MISSED_OUTBOUND_TITLE,
} from "../../../dist/agent/missed-outbound-scan.mjs";

const AGENT = "cli_legacyMigrationA1";
const CHAT = "oc_7961b9d7be893b46520a926b90cf46eb";

function reminder(overrides = {}) {
  return {
    reminderId: "legacy-scan-loop",
    ownerAgentId: AGENT,
    title: DEFAULT_MISSED_OUTBOUND_TITLE,
    fireAt: "2020-01-01T00:00:00.000Z",
    createdAt: "2019-12-31T00:00:00.000Z",
    status: "scheduled",
    version: 1,
    events: [],
    deliveryMode: "user",
    deliveryTarget: `chat:${CHAT}`,
    deliveryAnchor: "om_legacyScan1",
    repeat: DEFAULT_MISSED_OUTBOUND_REPEAT,
    ...overrides,
  };
}

test("Host startup deletes exact v0.4.21 scan loops before reminder orchestration and retains user reminders", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-scan-migration-"));
  const stateDir = path.join(root, "state", "agents", AGENT);
  const workspaceDir = path.join(root, "agents", AGENT);
  const deliveries = [];
  const agent = {
    agentId: AGENT, name: AGENT, runtime: "codex", model: "mock",
    feishuAppId: AGENT, feishuAppSecret: "fixture-secret", feishuProfile: AGENT,
    feishuDomain: "https://open.feishu.cn", stateDir, workspaceDir,
  };
  const runtimeHost = {
    subscribe() { return () => {}; },
    async start() {},
    async deliver(agentId, envelope) { deliveries.push({ agentId, envelope }); return { status: "accepted" }; },
    async stop() {},
    async shutdown() {},
  };
  const env = {
    LARKIN_HOME: root,
    LARKIN_CONFIG_DIR: root,
    LARKIN_SERVER_ID: "server-legacy-migration",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]),
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(stateDir, "reminders.json"), JSON.stringify({ reminders: [
    reminder(),
    reminder({
      reminderId: "same-title-user-reminder",
      fireAt: "2030-01-01T00:00:00.000Z",
      deliveryAnchor: "om_sameTitleUser1",
      repeat: "every:1h",
    }),
    reminder({
      reminderId: "user-reminder",
      title: "User's 15-minute status reminder",
      fireAt: "2030-01-01T00:00:00.000Z",
      deliveryAnchor: "om_userReminder1",
    }),
  ] }, null, 2));
  const host = createHostShell({
    env,
    runtimeHost,
    eventSourceStartDelayMs: 60_000,
    managedCliForAgent: () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} }),
    reconcileAgentWorkspaceImpl: () => {},
  });
  try {
    await host.start();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reminders = JSON.parse(fs.readFileSync(path.join(stateDir, "reminders.json"), "utf8")).reminders;
    assert.deepEqual(reminders.map((entry) => entry.reminderId), ["same-title-user-reminder", "user-reminder"]);
    assert.equal(reminders.every((entry) => entry.status === "scheduled"), true);
    assert.equal(deliveries.length, 0, "the past-due legacy loop must be gone before HostReminderOrchestrator can arm it");
  } finally {
    await host.shutdown("legacy scan migration integration test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
