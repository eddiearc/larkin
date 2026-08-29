import assert from "node:assert/strict";
import { test } from "bun:test";
import { HostReminderOrchestrator } from "../../../src/agent/host-reminder-orchestrator.ts";
import {
  DEFAULT_MISSED_OUTBOUND_TITLE,
  executeMissedOutboundScan,
} from "../../../src/agent/missed-outbound-scan.ts";

test("default scan fire reads scoped chat history and replies in the same conversation", async () => {
  const reminder = {
    reminderId: "scan123456",
    version: 1,
    ownerAgentId: "cli_scan",
    fireAt: "2026-07-16T02:00:00Z",
    createdAt: "2026-07-15T00:00:00Z",
    title: DEFAULT_MISSED_OUTBOUND_TITLE,
    status: "scheduled",
    deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
    deliveryAnchor: null,
    deliveryMode: "user",
    repeat: "every:15m",
    events: [],
  };
  const reads = [];
  const posts = [];
  const inbox = [];
  const state = {
    paths: { reminders: "/state/reminders.json", inbox: "/state/inbox.ndjson" },
    bindInboxDeliveryAnchor() {},
    unbindInboxDeliveryAnchor() {},
    appendNdjson(_key, value) { inbox.push(value); },
  };
  const api = {
    load: () => ({ reminders: [reminder] }),
    mutate(_file, fn) { return fn({ reminders: [reminder] }); },
    parseRepeat: () => ({ next: () => Date.parse("2026-07-16T03:15:00Z"), description: "every 15m" }),
    nowIso: (ms) => new Date(ms).toISOString(),
    appendEvent(record, eventType, _a, _b, _c, _d, metadata) {
      if (!Array.isArray(record.events)) record.events = [];
      record.events.push({ eventType, metadata: metadata ?? null });
    },
  };
  const projector = {
    createReminderEnvelope() { return { kind: "reminder", message_id: "rem_scan", seq: 1, wake: true, target: "runtime:reminder" }; },
    createRedeliveryEnvelope() { return { kind: "redelivery", message_id: "redeliver_1", seq: 2, target: "runtime:redelivery" }; },
  };
  const agent = { agentId: "cli_scan", name: "cli_scan", feishuAppId: "cli_scan", botOpenId: "ou_bot" };
  const orchestrator = new HostReminderOrchestrator({
    agents: [agent],
    stateStore: () => state,
    envelopeProjector: projector,
    reminderStore: api,
    now: () => Date.parse("2026-07-16T03:00:00Z"),
    missedOutboundScan: {
      execute: ({ reminder: record }) => executeMissedOutboundScan({
        deliveryTarget: record.deliveryTarget,
        deliveryAnchor: record.deliveryAnchor,
        botIds: new Set(["ou_bot", "cli_scan"]),
        listChat: async (chatId) => {
          reads.push(`chat:${chatId}`);
          return [{ message_id: "om_ask", sender: { sender_type: "user", id: "ou_human" }, create_time: "2", content: "帮看 CI？" }];
        },
        listThread: async () => { throw new Error("must not read thread"); },
        reply: async (post) => {
          posts.push(post);
          return { ok: true, data: { message_id: "om_committed1" } };
        },
      }),
    },
  });
  orchestrator.handleFire({ agentId: "cli_scan", reminderId: reminder.reminderId });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(reads, ["chat:oc_7961b9d7be893b46520a926b90cf46eb"]);
  assert.equal(inbox.length, 0, "scan fire must not wake Runtime via inbox");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].deliveryTarget, "chat:oc_7961b9d7be893b46520a926b90cf46eb");
  assert.notEqual(posts[0].deliveryTarget.startsWith("dm:"), true);
});
