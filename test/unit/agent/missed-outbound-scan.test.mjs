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
  parseScanDeliveryTarget,
  unansweredHumanAfterBot,
} from "../../../src/agent/missed-outbound-scan.ts";

const bot = new Set(["cli_bot"]);

test("parseScanDeliveryTarget fail-closes without target, DM, or thread anchor", () => {
  assert.throws(() => parseScanDeliveryTarget(""), /必须显式指定 delivery target/);
  assert.throws(() => parseScanDeliveryTarget("thread:oc_x:omt_y"), /必须同时提供可验证的 message-id anchor/);
  assert.throws(() => parseScanDeliveryTarget("thread:oc_abc:omt_def"), /必须同时提供可验证的 message-id anchor/);
  assert.throws(() => parseScanDeliveryTarget("dm:ou_someone"), /禁止推断 DM/);
  assert.equal(parseScanDeliveryTarget("chat:oc_7961b9d7be893b46520a926b90cf46eb").chatId, "oc_7961b9d7be893b46520a926b90cf46eb");
});

test("unansweredHumanAfterBot ignores chatter and third-party bots", () => {
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: "1", content: "闲聊" },
  ], bot), null);
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: "1", content: "帮我看 CI？" },
    { message_id: "om_other", sender: { sender_type: "app", id: "cli_other" }, create_time: "2", content: "ok" },
  ], bot), "om_h1");
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: "1", content: "帮我看 CI？" },
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: "2", content: "收到" },
  ], bot), null);
});

test("classifyMissedOutbound keeps earlier follow-up and stall after later bot chatter", () => {
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: "1", content: "下一步我去开 PR" },
    { message_id: "om_b2", sender: { sender_type: "app", id: "cli_bot" }, create_time: "2", content: "顺手记一下" },
  ], bot)?.kind, "unfulfilled-follow-up");
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: "1", content: "CI 还在跑" },
    { message_id: "om_b2", sender: { sender_type: "app", id: "cli_bot" }, create_time: "2", content: "顺手记一下" },
  ], bot)?.kind, "stalled-work");
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: "1", content: "下一步我去开 PR" },
    { message_id: "om_b2", sender: { sender_type: "app", id: "cli_bot" }, create_time: "2", content: "已完成" },
  ], bot), null);
});

test("executeMissedOutboundScan posts only to the same chat", async () => {
  await assert.rejects(() => executeMissedOutboundScan({
    deliveryTarget: "",
    botIds: bot,
    listChat: async () => [],
    listThread: async () => [],
    reply: async () => {},
  }), /必须显式指定 delivery target/);
  const posts = [];
  const reads = [];
  const result = await executeMissedOutboundScan({
    deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
    botIds: bot,
    listChat: async (chatId) => {
      reads.push(chatId);
      return [{ message_id: "om_h1", sender: { sender_type: "user" }, create_time: "2", content: "帮看一下？" }];
    },
    listThread: async () => { throw new Error("must not read thread"); },
    reply: async (post) => { posts.push(post); },
  });
  assert.equal(result.posted, true);
  assert.equal(result.scope, "chat");
  assert.deepEqual(reads, ["oc_7961b9d7be893b46520a926b90cf46eb"]);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].deliveryTarget, "chat:oc_7961b9d7be893b46520a926b90cf46eb");
  assert.match(posts[0].text, /尚未回复/);
});

test("ensureDefaultMissedOutboundScanReminder rebuilds when target changes", () => {
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
    const second = ensureDefaultMissedOutboundScanReminder({
      storeFile: file,
      agentId: "cli_a1",
      deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
      nowMs: 2_000,
    });
    assert.equal(second.created, false);
    assert.equal(second.reminderId, first.reminderId);
    const rebuilt = ensureDefaultMissedOutboundScanReminder({
      storeFile: file,
      agentId: "cli_a1",
      deliveryTarget: "chat:oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      nowMs: 3_000,
    });
    assert.equal(rebuilt.created, true);
    assert.equal(rebuilt.rebuilt, true);
    assert.notEqual(rebuilt.reminderId, first.reminderId);
    const store = JSON.parse(fs.readFileSync(file, "utf8"));
    const live = store.reminders.filter((reminder) => reminder.status !== "canceled");
    assert.equal(live.length, 1);
    assert.equal(live[0].title, DEFAULT_MISSED_OUTBOUND_TITLE);
    assert.equal(live[0].deliveryTarget, "chat:oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
