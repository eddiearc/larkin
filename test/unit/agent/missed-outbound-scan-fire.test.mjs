import assert from "node:assert/strict";
import { test } from "bun:test";
import { HostReminderOrchestrator } from "../../../src/agent/host-reminder-orchestrator.ts";
import { DEFAULT_MISSED_OUTBOUND_TITLE } from "../../../src/agent/missed-outbound-scan.ts";

test("scan reminder fire produces a canonical envelope bound to the exact target", () => {
  const reminder = {
    reminderId: "scan123456",
    version: 1,
    ownerAgentId: "cli_scan",
    fireAt: "2026-07-16T02:00:00Z",
    createdAt: "2026-07-15T00:00:00Z",
    title: DEFAULT_MISSED_OUTBOUND_TITLE,
    status: "scheduled",
    deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
    deliveryAnchor: "om_anchor1",
    deliveryMode: "user",
    repeat: "every:15m",
    events: [],
  };
  const inbox = [];
  const deliveries = [];
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
    createReminderEnvelope(_agentId, value) {
      return {
        kind: "reminder",
        message_id: `rem_${value.reminderId}`,
        seq: 1,
        wake: true,
        target: "runtime:reminder",
        deliveryTarget: value.deliveryTarget,
        deliveryAnchor: value.deliveryAnchor,
        title: value.title,
      };
    },
    createRedeliveryEnvelope() { return { kind: "redelivery", message_id: "redeliver_1", seq: 2, target: "runtime:redelivery" }; },
  };
  const orchestrator = new HostReminderOrchestrator({
    agents: [{ agentId: "cli_scan", name: "cli_scan" }],
    stateStore: () => state,
    envelopeProjector: projector,
    reminderStore: api,
    now: () => Date.parse("2026-07-16T03:00:00Z"),
    deliveryTarget: { deliver(_agentId, envelope) { deliveries.push(envelope); } },
  });
  orchestrator.handleFire({ agentId: "cli_scan", reminderId: reminder.reminderId });
  assert.equal(inbox.length, 1);
  assert.equal(inbox[0].deliveryTarget, "chat:oc_7961b9d7be893b46520a926b90cf46eb");
  assert.equal(inbox[0].deliveryAnchor, "om_anchor1");
  assert.equal(inbox[0].title, DEFAULT_MISSED_OUTBOUND_TITLE);
  assert.equal(deliveries.length, 1);
});
