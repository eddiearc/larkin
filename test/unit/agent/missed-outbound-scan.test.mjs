import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  ASK_PROMISE_MIN_AGE_MS,
  DEFAULT_MISSED_OUTBOUND_TITLE,
  classifyMissedOutbound,
  ensureDefaultMissedOutboundScanReminder,
  executeMissedOutboundScan,
  parseScanDeliveryTarget,
  persistInboundScanTarget,
  requireCommittedImResult,
  unansweredHumanAfterBot,
} from "../../../src/agent/missed-outbound-scan.ts";
import { planSingleRootBinding } from "../../../src/setup/setup-binding.ts";

const bot = new Set(["cli_bot"]);
const now = 1_000_000;
const aged = String(now - ASK_PROMISE_MIN_AGE_MS - 1);
const fresh = String(now - 1_000);

test("parseScanDeliveryTarget fail-closes without target, DM, or strict om_ anchor", () => {
  assert.throws(() => parseScanDeliveryTarget(""), /必须显式指定 delivery target/);
  assert.throws(() => parseScanDeliveryTarget("thread:oc_abc:omt_def"), /必须是严格 om_/);
  assert.throws(() => parseScanDeliveryTarget("dm:ou_someone"), /禁止推断 DM/);
});

test("classifier contract: aged ask, thanks, substantial reply, english follow-up/stall", () => {
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: fresh, content: "review PR 168" },
  ], bot, now), null);
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: aged, content: "review PR 168" },
  ], bot, now), "om_h1");
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: aged, content: "thanks", mentions: [{ id: "cli_bot" }] },
  ], bot, now), null);
  assert.equal(unansweredHumanAfterBot([
    { message_id: "om_h1", sender: { sender_type: "user" }, create_time: aged, content: "review PR 168" },
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: String(now - 10), content: "Looking at it now" },
  ], bot, now), null);
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: aged, content: "等你确认" },
  ], bot, now), null);
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: fresh, content: "I'll open the PR" },
  ], bot, now), null);
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: aged, content: "I'll open the PR" },
  ], bot, now)?.kind, "unfulfilled-follow-up");
  assert.equal(classifyMissedOutbound([
    { message_id: "om_b1", sender: { sender_type: "app", id: "cli_bot" }, create_time: aged, content: "Waiting for CI" },
    { message_id: "om_s1", sender: { sender_type: "app", id: "cli_bot" }, create_time: String(now - 5), content: "巡检：工作停滞且无新的状态更新。" },
  ], bot, now)?.kind, "stalled-work");
});

test("executeMissedOutboundScan routes chat send and thread anchor reply, requires ok===true", async () => {
  assert.throws(() => requireCommittedImResult({ data: { message_id: "om_x1" } }), /未提交/);
  assert.throws(() => requireCommittedImResult({ ok: true, committed: false, data: { message_id: "om_x1" } }), /committed=false/);
  await assert.rejects(() => executeMissedOutboundScan({
    deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
    botIds: bot,
    nowMs: now,
    listChat: async () => ({ ok: false, data: { messages: [] } }),
    listThread: async () => ({ ok: true, data: { messages: [] } }),
    post: async () => ({ ok: true, data: { message_id: "om_out1" } }),
  }), /未提交/);
  const posts = [];
  const chat = await executeMissedOutboundScan({
    deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
    botIds: bot,
    nowMs: now,
    listChat: async () => ({
      ok: true,
      data: { messages: [{ message_id: "om_h1", sender: { sender_type: "user" }, create_time: aged, content: "review PR 168" }] },
    }),
    listThread: async () => { throw new Error("must not read thread"); },
    post: async (item) => {
      posts.push(item);
      return { ok: true, data: { message_id: "om_out1" } };
    },
  });
  assert.equal(chat.posted, true);
  assert.deepEqual(posts[0].route, { kind: "chat-send", chatId: "oc_7961b9d7be893b46520a926b90cf46eb" });
  const threadPosts = [];
  const thread = await executeMissedOutboundScan({
    deliveryTarget: "thread:oc_7961b9d7be893b46520a926b90cf46eb:omt_19f44e32c00f1c85",
    deliveryAnchor: "om_humananchor1",
    botIds: bot,
    nowMs: now,
    listChat: async () => { throw new Error("must not read chat"); },
    listThread: async () => ({
      ok: true,
      data: { messages: [{ message_id: "om_botstall", sender: { sender_type: "app", id: "cli_bot" }, create_time: aged, content: "Waiting for CI" }] },
    }),
    post: async (item) => {
      threadPosts.push(item);
      return { ok: true, data: { message_id: "om_out2" } };
    },
  });
  assert.equal(thread.posted, true);
  assert.deepEqual(threadPosts[0].route, { kind: "thread-reply", messageId: "om_humananchor1" });
});

test("persistInboundScanTarget writes Agent-specific chat target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-scan-in-"));
  try {
    const parsed = persistInboundScanTarget(dir, {
      chat_id: "oc_7961b9d7be893b46520a926b90cf46eb",
      thread_id: null,
      message_id: "om_inbound1",
    });
    assert.equal(parsed?.deliveryTarget, "chat:oc_7961b9d7be893b46520a926b90cf46eb");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureDefault rebuilds fired reminders and ignores one-shots", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-scan-rem-"));
  const file = path.join(dir, "reminders.json");
  fs.writeFileSync(file, JSON.stringify({
    reminders: [{
      reminderId: "dead",
      ownerAgentId: "cli_a1",
      title: DEFAULT_MISSED_OUTBOUND_TITLE,
      status: "fired",
      deliveryMode: "user",
      repeat: "every:15m",
      deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
    }],
  }), { mode: 0o600 });
  try {
    const rebuilt = ensureDefaultMissedOutboundScanReminder({
      storeFile: file,
      agentId: "cli_a1",
      deliveryTarget: "chat:oc_7961b9d7be893b46520a926b90cf46eb",
      nowMs: 1_000,
    });
    assert.equal(rebuilt.created, true);
    assert.equal(rebuilt.rebuilt, true);
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
});
