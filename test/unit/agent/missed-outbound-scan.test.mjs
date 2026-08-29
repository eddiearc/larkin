import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  DEFAULT_MISSED_OUTBOUND_TITLE,
  PROMISE_STALL_MIN_AGE_MS,
  classifyMissedOutbound,
  ensureDefaultMissedOutboundScanReminder,
  executeMissedOutboundScan,
  parseScanDeliveryTarget,
  requireCommittedImResult,
  unansweredHumanAfterBot,
} from "../../../src/agent/missed-outbound-scan.ts";
import { planSingleRootBinding } from "../../../src/setup/setup-binding.ts";

const bot = new Set(["cli_bot"]);
const aged = String(1_000_000 - PROMISE_STALL_MIN_AGE_MS - 1);
const fresh = String(1_000_000 - 1_000);

test("parseScanDeliveryTarget fail-closes without target, DM, or strict om_ anchor", () => {
  assert.throws(() => parseScanDeliveryTarget(""), /必须显式指定 delivery target/);
  assert.throws(() => parseScanDeliveryTarget("thread:oc_abc:omt_def"), /必须是严格 om_/);
  assert.throws(() => parseScanDeliveryTarget("thread:oc_abc:omt_def", "om-bad"), /必须是严格 om_/);
  assert.throws(() => parseScanDeliveryTarget("dm:ou_someone"), /禁止推断 DM/);
  assert.equal(parseScanDeliveryTarget("chat:oc_7961b9d7be893b46520a926b90cf46eb").chatId, "oc_7961b9d7be893b46520a926b90cf46eb");
});

test("unansweredHumanAfterBot ignores chatter, third-party bots, and idle bot notes", () => {
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: "1", content: "闲聊" },
  ], bot, 1_000_000), null);
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: "1", content: "Review PR #168" },
    { message_id: "om_other", sender: { sender_type: "app", id: "cli_other" }, create_time: "2", content: "ok" },
  ], bot, 1_000_000), "om_h1");
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: "1", content: "Review PR #168" },
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: "2", content: "顺手记一下" },
  ], bot, 1_000_000), "om_h1");
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: "1", content: "Review PR #168" },
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: "2", content: "收到" },
  ], bot, 1_000_000), null);
});

test("classifyMissedOutbound ages promises, ignores waiting-on-user, and does not close stall via scan status", () => {
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: aged, content: "等你确认" },
  ], bot, 1_000_000), null);
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: fresh, content: "下一步我去开 PR" },
  ], bot, 1_000_000), null);
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: aged, content: "下一步我去开 PR" },
    { message_id: "om_b2", sender: { sender_type: "app", id: "cli_bot" }, create_time: String(1_000_000 - 10), content: "顺手记一下" },
  ], bot, 1_000_000)?.kind, "unfulfilled-follow-up");
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: aged, content: "CI 还在跑" },
    { message_id: "om_s1", sender: { sender_type: "app", id: "cli_bot" }, create_time: String(1_000_000 - 5), content: "巡检：工作停滞且无新的状态更新。" },
  ], bot, 1_000_000)?.kind, "stalled-work");
});

test("executeMissedOutboundScan requires committed IM result and skips posted occurrences", async () => {
  await assert.rejects(() => executeMissedOutboundScan({
    deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
    botIds: bot,
    nowMs: 1_000_000,
    listChat: async () => [{ message_id: "om_h1", sender: { sender_type: "user" }, create_time: "2", content: "帮看一下？" }],
    listThread: async () => [],
    reply: async () => null,
  }), /未提交|缺失/);
  const skipped = await executeMissedOutboundScan({
    deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
    botIds: bot,
    nowMs: 1_000_000,
    postedOccurrenceIds: new Set(["unanswered-human:om_h1"]),
    listChat: async () => [{ message_id: "om_h1", sender: { sender_type: "user" }, create_time: "2", content: "帮看一下？" }],
    listThread: async () => [],
    reply: async () => { throw new Error("must not reply"); },
  });
  assert.equal(skipped.posted, false);
  const posts = [];
  const result = await executeMissedOutboundScan({
    deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
    botIds: bot,
    nowMs: 1_000_000,
    listChat: async (chatId) => {
      assert.equal(chatId, "oc_7961b9d7be893b46520a926b90cf46eb");
      return [{ message_id: "om_h1", sender: { sender_type: "user" }, create_time: "2", content: "帮看一下？" }];
    },
    listThread: async () => { throw new Error("must not read thread"); },
    reply: async (post) => {
      posts.push(post);
      return { ok: true, data: { message_id: "om_committed1" } };
    },
  });
  assert.equal(result.posted, true);
  assert.equal(result.committedMessageId, "om_committed1");
  assert.equal(posts[0].deliveryTarget, "chat:oc_7961b9d7be893b46520a926b90cf46eb");
});

test("requireCommittedImResult rejects ok:false and missing om_", () => {
  assert.throws(() => requireCommittedImResult({ ok: false, data: { message_id: "om_x" } }), /未提交/);
  assert.throws(() => requireCommittedImResult({ ok: true, data: { message_id: "rem_x" } }), /om_/);
});

test("ensureDefaultMissedOutboundScanReminder ignores same-title one-shots and rebuilds on target change", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-scan-rem-"));
  const file = path.join(dir, "reminders.json");
  fs.writeFileSync(file, JSON.stringify({
    reminders: [{
      reminderId: "oneshot",
      ownerAgentId: "cli_a1",
      title: DEFAULT_MISSED_OUTBOUND_TITLE,
      status: "scheduled",
      deliveryMode: "user",
      deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
    }],
  }), { mode: 0o600 });
  try {
    const first = ensureDefaultMissedOutboundScanReminder({
      storeFile: file,
      agentId: "cli_a1",
      deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
      nowMs: 1_000,
    });
    assert.equal(first.created, true);
    const rebuilt = ensureDefaultMissedOutboundScanReminder({
      storeFile: file,
      agentId: "cli_a1",
      deliveryTarget: "chat:oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      nowMs: 3_000,
    });
    assert.equal(rebuilt.rebuilt, true);
    const store = JSON.parse(fs.readFileSync(file, "utf8"));
    const live = store.reminders.filter((reminder) => reminder.status === "scheduled" && reminder.repeat === "every:15m");
    assert.equal(live.length, 1);
    assert.equal(live[0].deliveryTarget, "chat:oc_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("planSingleRootBinding preserves scan target across rebind", () => {
  const next = planSingleRootBinding({
    config: {
      version: 4,
      serverId: "srv",
      mentionPolicy: "require",
      activeAgent: "cli_keep1",
      agents: {
        cli_keep1: {
          runtime: "pi",
          model: "default",
          createdAt: "2026-07-01T00:00:00.000Z",
          defaultScanDeliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
          defaultScanDeliveryAnchor: "om_anchor1",
        },
      },
    },
    profile: { appId: "cli_keep1" },
    requestedAgent: "cli_keep1",
    runtime: "pi",
    defaultModel: "default",
    supportedReasoningEfforts: [],
    now: "2026-07-15T00:00:00.000Z",
  });
  assert.equal(next.agents.cli_keep1.defaultScanDeliveryTarget, "chat:oc_7961b9d7be893b46520a926b90cf46eb");
  assert.equal(next.agents.cli_keep1.defaultScanDeliveryAnchor, "om_anchor1");
});
