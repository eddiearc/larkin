import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  DEFAULT_MISSED_OUTBOUND_TITLE,
  classifyMissedOutbound,
  ensureDefaultMissedOutboundScanReminder,
  executeMissedOutboundScan,
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

test("classifyMissedOutbound covers follow-up and stalled work", () => {
  const bot = new Set(["cli_bot"]);
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: "1", content: "下一步我去开 PR" },
  ], bot)?.kind, "unfulfilled-follow-up");
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: "1", content: "CI 还在跑" },
  ], bot)?.kind, "stalled-work");
});

test("executeMissedOutboundScan fail-closes DM and posts only to the same chat", async () => {
  await assert.rejects(() => executeMissedOutboundScan({
    deliveryTarget: "",
    botIds: new Set(),
    listChat: async () => [],
    listThread: async () => [],
    reply: async () => {},
  }), /必须显式指定 delivery target/);
  await assert.rejects(() => executeMissedOutboundScan({
    deliveryTarget: "dm:ou_someone",
    botIds: new Set(),
    listChat: async () => [],
    listThread: async () => [],
    reply: async () => {},
  }), /禁止推断 DM/);
  const posts = [];
  const reads = [];
  const result = await executeMissedOutboundScan({
    deliveryTarget: "chat:oc_group",
    botIds: new Set(["cli_bot"]),
    listChat: async (chatId) => {
      reads.push(chatId);
      return [{ message_id: "om_h1", sender: { sender_type: "user" }, create_time: "2" }];
    },
    listThread: async () => { throw new Error("must not read thread"); },
    reply: async (post) => { posts.push(post); },
  });
  assert.equal(result.posted, true);
  assert.equal(result.scope, "chat");
  assert.deepEqual(reads, ["oc_group"]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].deliveryTarget, "chat:oc_group");
  assert.match(posts[0].text, /尚未回复/);
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
