import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  DEFAULT_MISSED_OUTBOUND_TITLE,
  ensureDefaultMissedOutboundScanReminder,
  parseScanDeliveryTarget,
  persistInboundScanTarget,
} from "../../../src/agent/missed-outbound-scan.ts";
test("parseScanDeliveryTarget fail-closes without target, DM, or thread om_ anchor", () => {
  assert.throws(() => parseScanDeliveryTarget(""), /必须显式指定 delivery target/);
  assert.throws(() => parseScanDeliveryTarget("dm:ou_someone"), /禁止推断 DM/);
  assert.throws(() => parseScanDeliveryTarget("thread:oc_abc:omt_def"), /必须是严格 om_/);
});

test("per-target reminders coexist and duplicate inbound is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-scan-rem-"));
  const file = path.join(dir, "reminders.json");
  fs.writeFileSync(file, JSON.stringify({ reminders: [] }), { mode: 0o600 });
  try {
    const chat = persistInboundScanTarget(dir, {
      chat_id: "oc_7961b9d7be893b46520a926b90cf46eb",
      chat_type: "group",
      thread_id: null,
      message_id: "om_chat1",
    }, "cli_a1", file);
    const again = persistInboundScanTarget(dir, {
      chat_id: "oc_7961b9d7be893b46520a926b90cf46eb",
      chat_type: "group",
      thread_id: null,
      message_id: "om_chat1",
    }, "cli_a1", file);
    const thread = persistInboundScanTarget(dir, {
      chat_id: "oc_7961b9d7be893b46520a926b90cf46eb",
      chat_type: "group",
      thread_id: "omt_19f44e32c00f1c85",
      message_id: "om_thread1",
    }, "cli_a1", file);
    assert.equal(chat.scope, "chat");
    assert.equal(again.deliveryTarget, chat.deliveryTarget);
    assert.equal(thread.scope, "thread");
    const live = JSON.parse(fs.readFileSync(file, "utf8")).reminders.filter((reminder) => reminder.status === "scheduled");
    assert.equal(live.length, 2);
    assert.equal(live.every((reminder) => reminder.title === DEFAULT_MISSED_OUTBOUND_TITLE), true);
    assert.equal(live.every((reminder) => reminder.repeat === "every:15m"), true);
    assert.equal(live.every((reminder) => reminder.version === 1), true);
    assert.equal(live.every((reminder) => Array.isArray(reminder.events)), true);
    assert.throws(() => persistInboundScanTarget(dir, {
      chat_id: "oc_7961b9d7be893b46520a926b90cf46eb",
      chat_type: "group",
      _sender_is_bot: true,
      message_id: "om_bot1",
    }, "cli_a1", file), /只接受 human inbound/);
    assert.throws(() => persistInboundScanTarget(dir, {
      chat_id: "oc_7961b9d7be893b46520a926b90cf46eb",
      chat_type: "p2p",
      message_id: "om_dm1",
    }, "cli_a1", file), /禁止 DM/);
    fs.writeFileSync(file, JSON.stringify({
      reminders: [{ ...live[0], status: "canceled", reminderId: "canceled1", deliveryTarget: "chat:oc_canceledaaaaaaaaaaaaaaaaaaaaaaa" }],
    }), { mode: 0o600 });
    const blocked = ensureDefaultMissedOutboundScanReminder({
      storeFile: file,
      agentId: "cli_a1",
      deliveryTarget: "chat:oc_canceledaaaaaaaaaaaaaaaaaaaaaaa",
      deliveryAnchor: "om_chat1",
    });
    assert.equal(blocked.created, false);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).reminders.filter((reminder) => reminder.status === "scheduled").length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDefaultMissedOutboundScanReminder fail-closes without target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-scan-empty-"));
  const file = path.join(dir, "reminders.json");
  fs.writeFileSync(file, JSON.stringify({ reminders: [] }), { mode: 0o600 });
  try {
    assert.throws(() => ensureDefaultMissedOutboundScanReminder({ storeFile: file, agentId: "cli_a1" }), /必须显式指定 delivery target/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

