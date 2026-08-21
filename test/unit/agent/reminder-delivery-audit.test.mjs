import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { auditReminderDelivery } from "../../../dist/agent/reminder-delivery-audit.mjs";

test("a failed reminder delivery audit remains retryable and a later success clears it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reminder-audit-retry-"));
  try {
    const agentId = "cli_auditRetryA1";
    const store = createAgentStateStore(root, agentId);
    const reminderId = "reminder-audit-retry";
    store.appendNdjson("inbox", { kind: "reminder", message_id: "rem_audit_retry", target: "runtime:reminder",
      reminderId, deliveryTarget: "chat:oc_audit_retry", content: "reminder" });
    store.pollInbox({ target: "runtime:reminder", limit: 1 });
    store.writeJson("reminders", { reminders: [{ reminderId, status: "fired", fireAt: "2026-07-16T02:00:00.000Z",
      events: [{ eventType: "delivery_pending" }] }] });

    auditReminderDelivery({ stateStore: store, agentId, target: "chat:oc_audit_retry", succeeded: false, reason: "provider down" });
    let reminder = JSON.parse(fs.readFileSync(store.paths.reminders, "utf8")).reminders[0];
    assert.equal(reminder.events.at(-1).eventType, "delivery_failed");
    assert.ok(store.resolveCurrentReminder(), "a failed attempt must retain the current reminder context");

    auditReminderDelivery({ stateStore: store, agentId, target: "chat:oc_audit_retry", succeeded: true, messageId: "om_retry_success" });
    reminder = JSON.parse(fs.readFileSync(store.paths.reminders, "utf8")).reminders[0];
    assert.equal(reminder.events.at(-1).eventType, "delivery_succeeded");
    assert.equal(reminder.events.at(-1).metadata.messageId, "om_retry_success");
    assert.equal(store.resolveCurrentReminder(), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
