import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  DEFAULT_MISSED_OUTBOUND_TITLE,
  ensureDefaultMissedOutboundScanReminder,
  requireScanDeliveryTarget,
  unansweredHumanAfterBot,
} from "../../../src/agent/missed-outbound-scan.ts";

test("requireScanDeliveryTarget fail-closes without target or thread anchor", () => {
  assert.throws(() => requireScanDeliveryTarget(""), /必须显式指定 delivery target/);
  assert.throws(() => requireScanDeliveryTarget("thread:oc_x:omt_y"), /必须同时提供可验证的 message-id anchor/);
  assert.equal(requireScanDeliveryTarget("chat:oc_7961b9d7be893b46520a926b90cf46eb"), "chat:oc_7961b9d7be893b46520a926b90cf46eb");
});

test("unansweredHumanAfterBot returns the last human id with no later bot message", () => {
  const bot = new Set(["cli_bot"]);
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: "1" },
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: "2" },
  ], bot), null);
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: "1" },
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: "2" },
  ], bot), "om_h1");
});

test("ensureDefaultMissedOutboundScanReminder requires target and is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-scan-rem-"));
  const file = path.join(dir, "reminders.json");
  fs.writeFileSync(file, JSON.stringify({ reminders: [] }), { mode: 0o600 });
  try {
    assert.throws(() => ensureDefaultMissedOutboundScanReminder({
      storeFile: file, agentId: "cli_a1",
    }), /必须显式指定 delivery target/);
    const first = ensureDefaultMissedOutboundScanReminder({
      storeFile: file,
      agentId: "cli_a1",
      deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
      nowMs: 1_000,
    });
    assert.equal(first.created, true);
    const store = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(store.reminders[0].title, DEFAULT_MISSED_OUTBOUND_TITLE);
    assert.equal(store.reminders[0].deliveryTarget, "chat:oc_7961b9d7be893b46520a926b90cf46eb");
    assert.equal(store.reminders[0].deliveryMode, "user");
    const second = ensureDefaultMissedOutboundScanReminder({
      storeFile: file,
      agentId: "cli_a1",
      deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
      nowMs: 2_000,
    });
    assert.equal(second.created, false);
    assert.equal(second.reminderId, first.reminderId);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).reminders.length, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
