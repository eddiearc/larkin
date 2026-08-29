import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { HostReminderOrchestrator } from "../../../dist/agent/host-reminder-orchestrator.mjs";
import { DEFAULT_MISSED_OUTBOUND_TITLE, persistInboundScanTarget } from "../../../dist/agent/missed-outbound-scan.mjs";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";
import { createRuntimeHost } from "../../../dist/runtime/runtime-host.mjs";

const AGENT = "cli_scanHost1";
const CHAT = "oc_abc123def4567890aaaa";

function humanEvent(overrides = {}) {
  return {
    chat_id: CHAT,
    chat_type: "group",
    sender_id: "ou_human",
    message_id: "om_human1",
    event_id: "evt_human1",
    content: "hello",
    thread_id: null,
    _mentioned_bot: false,
    _mention_all: false,
    _sender_is_bot: false,
    ...overrides,
  };
}

test("HostShell human inbound registers per-target reminders and fire keeps exact target", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-scan-host-"));
  const stateDir = path.join(root, "state", "agents", AGENT);
  const workspaceDir = path.join(root, "agents", AGENT);
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    version: 4, serverId: "server-scan", mentionPolicy: "require", activeAgent: AGENT,
    agents: { [AGENT]: { runtime: "codex", model: "mock", createdAt: "2026-07-01T00:00:00.000Z" } },
  }), { mode: 0o600 });
  const store = createAgentStateStore(root, AGENT);
  const adapter = { id: "codex", capabilities: {}, async createSession() { return { sessionId: "s", subscribe() { return () => {}; }, async prompt() { return { status: "accepted" }; }, async busyInput() { return { status: "accepted" }; }, async close() {} }; } };
  const runtimeHost = createRuntimeHost({
    adapterFor: () => adapter,
    promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: () => store,
    assertOfficialCliReady: () => {},
  });
  const agent = {
    agentId: AGENT, name: AGENT, runtime: "codex", model: "mock",
    feishuAppId: AGENT, feishuProfile: AGENT, feishuAppSecret: "fixture-secret",
    feishuDomain: "https://open.feishu.cn",
    larkConfigDir: path.join(stateDir, "lark-cli-config"),
    workspaceDir, stateDir,
  };
  const env = {
    LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-scan",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]),
  };
  const makeHost = () => createHostShell({
    env, runtimeHost,
    stateStoreForImpl: () => store,
    managedCliForAgent: () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} }),
    reconcileAgentWorkspaceImpl: () => {},
    eventSourceStartDelayMs: 60_000,
    channelPackage: { createLarkChannel() { throw new Error("event source must not start"); } },
  });
  const host = makeHost();
  await host.ingest(AGENT, humanEvent({ _sender_is_bot: true, sender_id: "ou_other_bot", message_id: "om_bot1", event_id: "evt_bot" }), { wake: false });
  const reminderFile = path.join(stateDir, "reminders.json");
  assert.equal(fs.existsSync(reminderFile), false, "bot inbound must not create reminders");

  await host.ingest(AGENT, humanEvent({ event_id: "evt_chat", message_id: "om_human1" }), { wake: false });
  await host.ingest(AGENT, humanEvent({ event_id: "evt_chat2", message_id: "om_human1" }), { wake: false });
  await host.ingest(AGENT, humanEvent({ event_id: "evt_t1", message_id: "om_thread1", thread_id: "omt_threadone1" }), { wake: false });
  await host.ingest(AGENT, humanEvent({ event_id: "evt_t2", message_id: "om_thread2", thread_id: "omt_threadtwo2" }), { wake: false });
  let reminders = JSON.parse(fs.readFileSync(reminderFile, "utf8")).reminders;
  assert.equal(reminders.filter((reminder) => reminder.status === "scheduled").length, 3);

  const restarted = makeHost();
  reminders = JSON.parse(fs.readFileSync(reminderFile, "utf8")).reminders;
  assert.equal(reminders.filter((reminder) => reminder.status === "scheduled").length, 3, "restart keeps per-target reminders");
  assert.ok(restarted);

  const chatReminder = reminders.find((reminder) => reminder.deliveryTarget === `chat:${CHAT}`);
  const orchestrator = new HostReminderOrchestrator({
    agents: [{ agentId: AGENT, name: AGENT, stateDir }],
    stateStore: () => store,
    envelopeProjector: {
      createReminderEnvelope(_id, value) {
        return { kind: "reminder", message_id: `rem_${value.reminderId}`, seq: 1, wake: true, target: "runtime:reminder",
          deliveryTarget: value.deliveryTarget, deliveryAnchor: value.deliveryAnchor, title: value.title };
      },
      createRedeliveryEnvelope() { return { kind: "redelivery", message_id: "redeliver_1", seq: 2, target: "runtime:redelivery" }; },
    },
    now: () => Date.parse(chatReminder.fireAt) + 1,
    deliveryTarget: { deliver() {} },
  });
  orchestrator.handleFire({ agentId: AGENT, reminderId: chatReminder.reminderId });
  const inbox = store.readNdjson("inbox");
  const fired = inbox.find((row) => row.message_id === `rem_${chatReminder.reminderId}`);
  assert.ok(fired, "fire must append a reminder envelope");
  assert.equal(fired.deliveryTarget, `chat:${CHAT}`);
  assert.equal(fired.deliveryAnchor, "om_human1");
  assert.equal(fired.title, DEFAULT_MISSED_OUTBOUND_TITLE);
  assert.throws(() => persistInboundScanTarget(stateDir, { chat_id: "", message_id: "om_x" }, AGENT), /必须显式指定 delivery target/);
});
