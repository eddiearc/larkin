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

test("an anchorless success finalizes the consumed occurrence even after a post-poll mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reminder-audit-mutated-"));
  try {
    const agentId = "cli_auditMutatedA1";
    const store = createAgentStateStore(root, agentId);
    const reminderId = "reminder-audit-mutated";
    store.appendNdjson("inbox", { kind: "reminder", message_id: "rem_mutated_occurrence", target: "runtime:reminder",
      reminderId, deliveryTarget: "chat:oc_mutated", content: "reminder" });
    store.pollInbox({ target: "runtime:reminder", limit: 1 });
    // The reminder was snoozed after polling: the global tail is no longer
    // pending, but the consumed occurrence still awaits its outcome.
    store.writeJson("reminders", { reminders: [{ reminderId, status: "scheduled", fireAt: "2026-07-16T03:00:00.000Z",
      events: [
        { eventType: "delivery_pending", metadata: { occurrenceId: "rem_mutated_occurrence" } },
        { eventType: "snoozed" },
      ] }] });

    auditReminderDelivery({ stateStore: store, agentId, target: "chat:oc_mutated", succeeded: true, messageId: "om_mutated_write" });
    const reminder = JSON.parse(fs.readFileSync(store.paths.reminders, "utf8")).reminders[0];
    assert.equal(reminder.events.at(-1).eventType, "delivery_succeeded", "the committed write must gain a final audit outcome");
    assert.equal(reminder.events.at(-1).metadata.occurrenceId, "rem_mutated_occurrence");
    assert.equal(store.resolveCurrentReminder(), null, "the context clears once success is durably recorded");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a success that could not be persisted retains the occurrence context for reconciliation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reminder-audit-unpersisted-"));
  try {
    const agentId = "cli_auditUnpersistedA1";
    const store = createAgentStateStore(root, agentId);
    const reminderId = "reminder-audit-unpersisted";
    store.appendNdjson("inbox", { kind: "reminder", message_id: "rem_unpersisted_occurrence", target: "runtime:reminder",
      reminderId, deliveryTarget: "chat:oc_unpersisted", content: "reminder" });
    store.pollInbox({ target: "runtime:reminder", limit: 1 });
    // The reminder record disappeared after polling, so delivery_succeeded
    // cannot be appended anywhere; the context must survive the attempt.
    store.writeJson("reminders", { reminders: [] });

    auditReminderDelivery({ stateStore: store, agentId, target: "chat:oc_unpersisted", succeeded: true, messageId: "om_unpersisted_write" });
    assert.deepEqual(JSON.parse(fs.readFileSync(store.paths.reminders, "utf8")).reminders, []);
    assert.ok(store.resolveCurrentReminder(), "an unpersisted success must not discard the occurrence context");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a committed provider write is reconciled as success after audit persistence recovers", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reminder-audit-committed-marker-"));
  try {
    const agentId = "cli_auditCommittedA1";
    const store = createAgentStateStore(root, agentId);
    const reminderId = "reminder-audit-committed";
    store.appendNdjson("inbox", { kind: "reminder", message_id: "rem_committed_occurrence", target: "runtime:reminder",
      reminderId, deliveryTarget: "chat:oc_committed", content: "reminder" });
    store.pollInbox({ target: "runtime:reminder", limit: 1 });
    store.writeJson("reminders", { reminders: [{ reminderId, status: "fired", fireAt: "2026-07-16T02:00:00.000Z",
      events: [{ eventType: "delivery_pending" }] }] });

    store.markCurrentReminderDeliveryCommitted(reminderId, "rem_committed_occurrence", "om_committed_write");
    const context = store.resolveCurrentReminder();
    assert.equal(context.deliveryCommitted, true);
    assert.equal(context.deliveryMessageId, "om_committed_write");
    auditReminderDelivery({ stateStore: store, agentId, target: "chat:oc_committed", deliveryAnchor: "rem_committed_occurrence",
      succeeded: context.deliveryCommitted, finalize: true, messageId: context.deliveryMessageId });
    const reminder = JSON.parse(fs.readFileSync(store.paths.reminders, "utf8")).reminders[0];
    assert.equal(reminder.events.at(-1).eventType, "delivery_succeeded");
    assert.equal(reminder.events.at(-1).metadata.messageId, "om_committed_write");
    assert.equal(store.resolveCurrentReminder(), null);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("recurring audit finalizes one occurrence without resurrecting it from a late receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-reminder-audit-occurrence-"));
  try {
    const agentId = "cli_auditOccurrenceA1";
    const store = createAgentStateStore(root, agentId);
    const reminderId = "reminder-audit-occurrence";
    store.bindInboxDeliveryAnchor("om_occurrence_target", "chat:oc_occurrence");
    for (const occurrenceId of ["rem_occurrence_1", "rem_occurrence_2"]) {
      store.appendNdjson("inbox", { kind: "reminder", message_id: occurrenceId, target: "runtime:reminder",
        reminderId, deliveryTarget: "chat:oc_occurrence", deliveryAnchor: "om_occurrence_target", content: occurrenceId });
    }
    store.pollInbox({ target: "runtime:reminder", limit: 2 });
    store.writeJson("reminders", { reminders: [{ reminderId, status: "scheduled", fireAt: "2026-07-16T02:00:00.000Z",
      events: [
        { eventType: "delivery_pending", metadata: { occurrenceId: "rem_occurrence_1" } },
        { eventType: "delivery_pending", metadata: { occurrenceId: "rem_occurrence_2" } },
      ] }] });

    auditReminderDelivery({ stateStore: store, agentId, target: "chat:oc_occurrence", deliveryAnchor: "rem_occurrence_1",
      succeeded: false, finalize: true, reason: "turn ended" });
    const beforeLateReceipt = JSON.parse(fs.readFileSync(store.paths.reminders, "utf8")).reminders[0].events.length;
    auditReminderDelivery({ stateStore: store, agentId, target: "chat:oc_occurrence", deliveryAnchor: "rem_occurrence_1",
      succeeded: false, reason: "late accepted receipt" });
    const afterLateReceipt = JSON.parse(fs.readFileSync(store.paths.reminders, "utf8")).reminders[0];
    assert.equal(afterLateReceipt.events.length, beforeLateReceipt, "a late receipt must not re-pending a finalized failure");
    assert.equal(afterLateReceipt.events.at(-1).metadata.occurrenceId, "rem_occurrence_1");
    assert.deepEqual(store.resolveCurrentReminders().map((row) => row.deliveryAnchor), ["rem_occurrence_1", "rem_occurrence_2"]);

    auditReminderDelivery({ stateStore: store, agentId, target: "chat:oc_occurrence", deliveryAnchor: "rem_occurrence_2",
      succeeded: true, messageId: "om_new_delivery" });
    const completed = JSON.parse(fs.readFileSync(store.paths.reminders, "utf8")).reminders[0];
    assert.equal(completed.events.at(-1).eventType, "delivery_succeeded");
    assert.deepEqual(store.resolveCurrentReminders().map((row) => row.deliveryAnchor), ["rem_occurrence_1"]);
    assert.equal(store.resolveInboxMessageTarget("om_occurrence_target"), "chat:oc_occurrence", "failed occurrence retains routing until turn expiry");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
