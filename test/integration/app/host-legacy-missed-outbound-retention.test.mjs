import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";

const AGENT = "cli_legacyCollisionA1";
const CHAT = "oc_7961b9d7be893b46520a926b90cf46eb";
// Exact payload used by the former per-target helper. Historical records do
// not carry a managed-origin marker, so this can also be a user reminder.
const FORMER_SCAN_TITLE = "Read scoped history from this reminder envelope's persisted deliveryTarget (chat: +chat-messages-list; thread: +threads-messages-list). Judge unanswered asks, undelivered follow-ups, and stalled work. On a hit, post a short status in the same conversation using that persisted deliveryTarget/anchor; otherwise stay silent. Never infer recipients from the title.";

function samePayloadUserReminder() {
  return {
    reminderId: "user-reminder-with-former-scan-payload",
    ownerAgentId: AGENT,
    title: FORMER_SCAN_TITLE,
    fireAt: "2030-01-01T00:00:00.000Z",
    firedAt: null,
    createdAt: "2019-12-31T00:00:00.000Z",
    status: "scheduled",
    version: 1,
    events: [],
    deliveryMode: "user",
    deliveryTarget: `chat:${CHAT}`,
    deliveryAnchor: "om_samePayloadUser1",
    repeat: "every:15m",
  };
}

test("Host startup retains a same-payload user reminder because historical scan loops have no unique marker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-scan-collision-"));
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
    LARKIN_SERVER_ID: "server-legacy-collision",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]),
  };
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const expected = samePayloadUserReminder();
  const reminderFile = path.join(stateDir, "reminders.json");
  fs.writeFileSync(reminderFile, JSON.stringify({ reminders: [expected] }, null, 2));
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
    const reminders = JSON.parse(fs.readFileSync(reminderFile, "utf8")).reminders;
    assert.deepEqual(reminders, [expected]);
    assert.equal(deliveries.length, 0);
  } finally {
    await host.shutdown("legacy scan collision retention test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
