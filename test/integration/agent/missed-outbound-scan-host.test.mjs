import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
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
  await host.ingest(AGENT, humanEvent({ chat_type: "p2p", event_id: "evt_dm", message_id: "om_dm1" }), { wake: false });
  const reminderFile = path.join(stateDir, "reminders.json");
  assert.equal(fs.existsSync(reminderFile), false, "bot/DM inbound must not create reminders");

  await host.ingest(AGENT, humanEvent({ event_id: "evt_chat", message_id: "om_human1" }), { wake: false });
  await host.ingest(AGENT, humanEvent({ event_id: "evt_chat2", message_id: "om_human1" }), { wake: false });
  await host.ingest(AGENT, humanEvent({ event_id: "evt_t1", message_id: "om_thread1", thread_id: "omt_threadone1" }), { wake: false });
  await host.ingest(AGENT, humanEvent({ event_id: "evt_t2", message_id: "om_thread2", thread_id: "omt_threadtwo2" }), { wake: false });
  let reminders = JSON.parse(fs.readFileSync(reminderFile, "utf8")).reminders;
  assert.equal(reminders.filter((reminder) => reminder.status === "scheduled").length, 3);

  const due = new Date(Date.now() - 1_000).toISOString();
  fs.writeFileSync(reminderFile, JSON.stringify({
    reminders: reminders.map((reminder) => ({ ...reminder, fireAt: due })),
  }, null, 2));
  const restarted = makeHost();
  try {
    await restarted.start();
    reminders = JSON.parse(fs.readFileSync(reminderFile, "utf8")).reminders;
    assert.equal(reminders.filter((reminder) => reminder.title === DEFAULT_MISSED_OUTBOUND_TITLE).length, 3, "restart keeps per-target reminders");
    const deadline = Date.now() + 2_000;
    let fired;
    while (Date.now() < deadline) {
      fired = store.readNdjson("inbox").find((row) => String(row.message_id || "").startsWith("rem_") && row.deliveryTarget === `chat:${CHAT}`);
      if (fired) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(fired, "production Host due fire must append a reminder envelope");
    assert.equal(fired.deliveryTarget, `chat:${CHAT}`);
    assert.equal(fired.deliveryAnchor, "om_human1");
    assert.match(String(fired.content || fired.title || ""), /persisted deliveryTarget/);
    assert.throws(() => persistInboundScanTarget(stateDir, { chat_id: "", chat_type: "group", message_id: "om_x" }, AGENT), /必须显式指定 delivery target/);
  } finally {
    await restarted.shutdown?.();
  }
});
