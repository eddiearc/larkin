import assert from "node:assert/strict";
import { test } from "bun:test";

import {
  HostStateProjection,
  HostEnvelopeProjector,
  SenderIdentityCache,
  countWakeEnvelopes,
  projectActivityStatus,
  projectSessionStatus,
  safeConversationExcerpt,
} from "../../../dist/feishu/host-business-state.mjs";

const agent = { agentId: "cli_test", name: "cli_test", feishuProfile: "cli_test" };

function memoryStore() {
  const json = new Map();
  const ndjson = new Map();
  return {
    json,
    ndjson,
    paths: { root: "/state/cli_test", inbox: "/state/cli_test/inbox.ndjson", reminders: "/state/cli_test/reminders.json" },
    readJson(key, fallback) { return structuredClone(json.has(key) ? json.get(key) : fallback); },
    writeJson(key, value) { json.set(key, structuredClone(value)); },
    appendNdjson(key, value) { ndjson.set(key, [...(ndjson.get(key) || []), structuredClone(value)]); },
  };
}

test("host status and conversation projection preserves caps/latest fields and redacts secrets", () => {
  const store = memoryStore();
  const state = new HostStateProjection(() => store, () => {}, () => new Date("2026-07-16T01:02:03.000Z"));
  state.updateStatus(agent, { connectedVia: "channel" });
  state.appendStatusLog(agent, "activityLog", { at: "one", state: "thinking" }, 2);
  state.appendStatusLog(agent, "activityLog", { at: "two", state: "working" }, 2);
  state.appendStatusLog(agent, "activityLog", { at: "three", state: "online" }, 2);
  assert.deepEqual(store.json.get("status"), {
    connectedVia: "channel",
    activityLog: [{ at: "two", state: "working" }, { at: "three", state: "online" }],
    lastActivity: { at: "three", state: "online" },
  });
  state.recordStatusError(agent, "x".repeat(250));
  assert.equal(store.json.get("status").recentErrors[0].at, "2026-07-16T01:02:03.000Z");
  assert.equal(store.json.get("status").recentErrors[0].text.length, 200);
  state.appendConversation(agent, { direction: "in", text: "secret=abc123 token:xyz sk-abcdefghijklmnop" });
  assert.equal(store.ndjson.get("conversation")[0].text, "secret=[已隐藏] token=[已隐藏] [已隐藏凭证]");
  assert.equal(safeConversationExcerpt("a".repeat(400)).length, 360);
});

test("activity and session status projections preserve privacy, compaction dedupe, and turn counters", () => {
  const now = new Date("2026-07-16T03:00:00.000Z");
  const first = projectActivityStatus({}, {
    activity: "working", activityKind: "tool", detail: "token=secret-value", detailKind: "compacting_context",
    producerFactId: "fact-1", launchId: "launch-1", clientSeq: 4,
    entries: [{ kind: "tool_start", toolName: "message.send" }],
  }, "codex", "session-from-state", now);
  assert.equal(first.lastActivity.detail, "token=[已隐藏]");
  assert.equal(first.lastActivity.tool, "message.send");
  assert.equal(first.compaction.count, 1);
  assert.equal(first.compaction.active, true);
  const duplicate = projectActivityStatus(first, {
    activity: "working", detailKind: "compacting_context", producerFactId: "fact-1",
  }, "codex", null, new Date("2026-07-16T03:00:03.000Z"));
  assert.equal(duplicate.compaction.count, 1);
  const received = projectActivityStatus({ session: { id: "session-1", turns: 2, startedAt: "old" } }, {
    activity: "working", detailKind: "message_received",
  }, "codex", "fallback", now);
  assert.deepEqual(received.session, { id: "session-1", turns: 3, startedAt: "old", runtime: "codex", lastTurnAt: now.toISOString() });
  const nativeTurn = projectActivityStatus({ session: { id: "session-1", turns: 3, startedAt: "old" } }, {
    activity: "working", activityKind: "working", detailKind: "turn_started",
  }, "codex", null, now);
  assert.equal(nativeTurn.session.turns, 4, "normalized Runtime turn-start updates dashboard turn count");
  assert.equal(projectActivityStatus({}, { isHeartbeat: true }, "codex", null, now), null);

  const same = projectSessionStatus({ session: { id: "session-1", launchId: "old-launch", startedAt: "old", lastTurnAt: "turn", turns: 3 } }, "codex", "session-1", null, now);
  assert.deepEqual(same.session, { runtime: "codex", id: "session-1", launchId: "old-launch", startedAt: "old", lastSeenAt: now.toISOString(), lastTurnAt: "turn", turns: 3 });
  assert.equal("compaction" in same, false);
  const changed = projectSessionStatus({}, "claude", "session-2", "launch-2", now);
  assert.deepEqual(changed.compaction, { sessionId: "session-2", active: false, count: 0, startedAt: null, lastFinishedAt: null, lastEventId: null });
  const effective = projectSessionStatus({}, "pi", "session-pi", "launch-pi", now, {
    model: "provider/model", reasoningEffort: "high",
  });
  assert.equal(effective.session.model, "provider/model");
  assert.equal(effective.session.reasoningEffort, "high");
});

test("streaming text and repeated thinking frames refresh current activity without flooding history", () => {
  const idle = { state: "idle", activityKind: "idle", detail: null, detailKind: "turn_ended", tool: null, at: "2026-07-16T02:59:00.000Z", launchId: null, clientSeq: null };
  const started = projectActivityStatus({ activityLog: [idle], lastActivity: idle }, {
    activity: "working", activityKind: "working", detailKind: "turn_started",
  }, "codex", "session-1", new Date("2026-07-16T03:00:00.000Z"));
  assert.equal(started.activityLog.length, 2, "turn transition remains durable");

  const firstText = projectActivityStatus(started, {
    activity: "text", activityKind: "text",
  }, "codex", "session-1", new Date("2026-07-16T03:00:01.000Z"));
  assert.equal(firstText.lastActivity.state, "working", "text delta keeps the Agent visibly busy");
  assert.equal(firstText.lastActivity.activityKind, "text");
  assert.equal(firstText.activityLog.length, 2, "text delta is transient rather than a timeline row");

  const secondText = projectActivityStatus({ ...started, ...firstText }, {
    activity: "text", activityKind: "text",
  }, "codex", "session-1", new Date("2026-07-16T03:00:02.000Z"));
  assert.equal(secondText.activityLog.length, 2, "every streamed token must not become a durable row");
  assert.equal(secondText.lastActivity.at, "2026-07-16T03:00:02.000Z", "transient activity still refreshes freshness");

  const firstThinking = projectActivityStatus({ ...started, ...secondText }, {
    activity: "thinking", activityKind: "thinking",
  }, "codex", "session-1", new Date("2026-07-16T03:00:03.000Z"));
  assert.equal(firstThinking.activityLog.length, 3, "entering thinking remains a meaningful transition");
  const repeatedThinking = projectActivityStatus({ ...started, ...firstThinking }, {
    activity: "thinking", activityKind: "thinking",
  }, "codex", "session-1", new Date("2026-07-16T03:00:04.000Z"));
  assert.equal(repeatedThinking.activityLog.length, 3, "repeated thinking deltas are coalesced");
  assert.equal(repeatedThinking.lastActivity.at, "2026-07-16T03:00:04.000Z");
});

test("inbound, reminder, and restart envelopes retain exact persistence and sequence behavior", () => {
  const store = memoryStore();
  const state = new HostStateProjection(() => store);
  const unknown = [];
  const projector = new HostEnvelopeProjector(
    state,
    (_agent, chatId, senderId) => unknown.push([chatId, senderId]),
    () => "abcdef123456",
    () => new Date("2026-07-16T02:00:00.000Z"),
  );
  const inbound = projector.projectInbound(agent, {
    chat_id: "oc_chat", chat_type: "group", sender_id: "ou_user", message_id: "om_one", event_id: "evt_one",
    content: "hello", thread_id: "omt_topic", _mentioned_bot: false, _mention_all: false, _sender_is_bot: false,
  }, { anchorReply: true });
  assert.equal(inbound.seq, 1);
  assert.deepEqual(unknown, [["oc_chat", "ou_user"]]);
  assert.equal(store.json.get("replyctx").oc_chat.reply_to, "om_one");
  assert.equal(store.json.get("map")["#cocchat:omttopic"], "oc_chat");

  const reminder = projector.createReminderEnvelope(agent.agentId, {
    reminderId: "1234567890abcdef1234", title: "Send report", repeat: "daily@09:00", fireAt: "2026-07-17T01:00:00.000Z",
    msgRef: "om_anchor", channel: "#team",
  }, 180_000, "每天 09:00");
  assert.deepEqual(reminder, {
    kind: "reminder", message_id: "rem_1234567890abcdef_2", target: "runtime:reminder", seq: 2, sender_name: "定时提醒", sender_type: "system",
    channel_type: "dm", channel_name: "system",
    content: "[定时提醒触发] Send report\n提醒ID: #12345678　重复: 每天 09:00（下次已自动排在 2026-07-17T01:00:00.000Z）\n注意: 原定时间已过 3 分钟（Runtime Host 离线期间错过，现补触发）\n这是升级前存量 user-facing reminder，优先回复其安全锚点；不得向标题中的任何人或第三方发送消息\n锚定消息: om_anchor\n回复原会话: larkin im +messages-reply --message-id om_anchor ...\n这是你之前用 larkin reminder schedule 设置的提醒，请按标题执行相应动作。管理: larkin reminder list / larkin reminder snooze / larkin reminder cancel",
    deliveryAnchor: "om_anchor", deliveryTarget: null,
    timestamp: "2026-07-16T02:00:00.000Z", thread_id: null, wake: true,
  });
  const redelivery = projector.createRedeliveryEnvelope(agent.agentId, 2);
  assert.equal(redelivery.seq, 3);
  assert.equal(redelivery.kind, "redelivery");
  assert.equal(redelivery.message_id, "redeliver_abcdef123456");
  assert.equal(redelivery.target, "runtime:redelivery");
  assert.match(redelivery.content, /有 2 条/);
  assert.match(redelivery.content, /larkin inbox check/);
  assert.match(redelivery.content, /larkin im \+messages-reply/);
  assert.equal(countWakeEnvelopes([JSON.stringify({ wake: true }), "bad", JSON.stringify({ wake: false }), JSON.stringify({ wake: true })]), 2);
});

test("pre-upgrade reminder fields retain safe legacy delivery guidance", () => {
  const store = memoryStore();
  const projector = new HostEnvelopeProjector(new HostStateProjection(() => store), () => {}, () => "legacy123456", () => new Date("2026-07-16T02:00:00.000Z"));
  const channelOnly = projector.createReminderEnvelope(agent.agentId, {
    reminderId: "legacy-channel", title: "Channel reminder", fireAt: "2026-07-17T01:00:00.000Z", channel: "oc_legacy_chat",
  }, 0, null);
  assert.match(channelOnly.content, /原始 deliveryTarget: chat:oc_legacy_chat/);
  assert.match(channelOnly.content, /发送到原始 target: chat:oc_legacy_chat/);
  assert.doesNotMatch(channelOnly.content, /internal\/no-delivery/);
  const anchored = projector.createReminderEnvelope(agent.agentId, {
    reminderId: "legacy-anchor", title: "Anchored reminder", fireAt: "2026-07-17T01:00:00.000Z", msgRef: "om_legacy_anchor", channel: "#legacy",
  }, 0, null);
  assert.match(anchored.content, /存量 user-facing reminder/);
  assert.match(anchored.content, /回复原会话: .*om_legacy_anchor/);
  assert.doesNotMatch(anchored.content, /internal\/no-delivery/);
});

test("chat reminder guidance keeps a persisted chat-send fallback when its anchor is unresolvable", () => {
  const store = memoryStore();
  const projector = new HostEnvelopeProjector(new HostStateProjection(() => store), () => {}, () => "chatfallback123", () => new Date("2026-07-16T02:00:00.000Z"));
  const reminder = projector.createReminderEnvelope(agent.agentId, {
    reminderId: "interaction-card-reminder", title: "Card follow-up", fireAt: "2026-07-17T01:00:00.000Z",
    deliveryTarget: "chat:oc_interaction", deliveryAnchor: "om_card",
  }, 0, null);
  assert.match(reminder.content, /回复原会话: .*om_card/);
  assert.match(reminder.content, /interaction_\* 卡片锚点/);
  assert.match(reminder.content, /im \+messages-send --chat-id oc_interaction \.\.\./);
});

test("thread reminder guidance keeps +messages-reply inside the source thread", () => {
  const store = memoryStore();
  const projector = new HostEnvelopeProjector(new HostStateProjection(() => store), () => {}, () => "thread123456", () => new Date("2026-07-16T02:00:00.000Z"));
  const reminder = projector.createReminderEnvelope(agent.agentId, {
    reminderId: "thread-reminder", title: "Thread reminder", fireAt: "2026-07-17T01:00:00.000Z",
    deliveryTarget: "thread:oc_thread:omt_topic", deliveryAnchor: "om_thread_anchor",
  }, 0, null);
  assert.match(reminder.content, /im \+messages-reply --message-id om_thread_anchor --reply-in-thread \.\.\./);
  assert.doesNotMatch(reminder.content, /im \+messages-send --chat-id oc_thread/);
});

test("reminder and restart guidance use the injected CLI and never reply to synthetic ids", () => {
  const store = memoryStore();
  const executable = '"/opt/bun" "/installed/agent-cli.mjs"';
  const projector = new HostEnvelopeProjector(
    new HostStateProjection(() => store), () => {}, () => "abcdef123456",
    () => new Date("2026-07-16T02:00:00.000Z"), executable,
  );
  const synthetic = projector.createReminderEnvelope(agent.agentId, {
    reminderId: "1234567890abcdef", title: "Synthetic", fireAt: "2026-07-17T01:00:00.000Z",
    msgRef: "rem_not_a_feishu_message", channel: null,
  }, 0, null);
  assert.doesNotMatch(synthetic.content, /messages-reply.*rem_/);
  assert.match(synthetic.content, /internal\/no-delivery|不能.*回复/);
  assert.doesNotMatch(synthetic.content, /im \+chat-search/);
  assert.doesNotMatch(synthetic.content, /lark-cli im/);
  for (const suffix of ["reminder schedule", "reminder list", "reminder snooze", "reminder cancel"]) {
    assert.ok(synthetic.content.includes(`${executable} ${suffix}`), suffix);
  }
  assert.doesNotMatch(synthetic.content, /\blarkin reminder\b/);
  const restart = projector.createRedeliveryEnvelope(agent.agentId, 1);
  assert.match(restart.content, /"\/opt\/bun" "\/installed\/agent-cli\.mjs" inbox check/);
  assert.match(restart.content, /仅当 message_id 以 om_ 开头/);
  assert.doesNotMatch(restart.content, /使用每条记录的 message_id/);
});

test("target map, topic reply context, sender profiles, and receipt cap retain their persisted shapes", () => {
  const store = memoryStore();
  const state = new HostStateProjection(() => store);
  state.mapTargets(agent, ["group:a", "topic:b"], "oc_chat");
  state.saveReplyContext(agent, ["group:a", "topic:b"], "oc_chat", "om_message", "omt_thread");
  assert.deepEqual(store.json.get("map"), { "group:a": "oc_chat", "topic:b": "oc_chat" });
  const expected = { chat_id: "oc_chat", reply_to: "om_message", thread_id: "omt_thread", in_topic: true };
  assert.deepEqual(store.json.get("replyctx"), { "group:a": expected, "topic:b": expected, oc_chat: expected });
  state.saveSenderProfile(agent, "ou_user", { description: "hello", name: "User", at: 10 });
  assert.deepEqual(store.json.get("senderProfiles"), { ou_user: { description: "hello", name: "User", at: 10 } });
  for (let i = 0; i < 205; i++) state.recordReadReceipts(agent, `reader-${i}`, i, [`om_${i}`]);
  const receipts = store.json.get("readReceipts").receipts;
  assert.equal(receipts.length, 200);
  assert.equal(receipts[0].reader, "reader-5");
  assert.equal(receipts.at(-1).reader, "reader-204");
});

test("sender identity cache deduplicates fetches, honors wait/refresh semantics, and persists successful signatures", async () => {
  const store = memoryStore();
  const state = new HostStateProjection(() => store);
  let now = 1_000;
  let memberFetches = 0;
  let signatureFetches = 0;
  let releaseNames;
  const namesPromise = new Promise((resolve) => { releaseNames = resolve; });
  const identity = new SenderIdentityCache({
    state,
    now: () => now,
    wait: async () => {},
    async fetchChatNames() { memberFetches++; return namesPromise; },
    async fetchSenderSignature() { signatureFetches++; return { desc: "bio", name: "User", ok: true, ttl: 100 }; },
  });
  assert.deepEqual(await identity.ensureChatNames(agent, "oc_chat", 10), {});
  assert.equal(memberFetches, 1);
  assert.deepEqual(await identity.ensureChatNames(agent, "oc_chat", 10), {});
  assert.equal(memberFetches, 1);
  releaseNames({ ou_user: "User" });
  await namesPromise;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await identity.ensureChatNames(agent, "oc_chat", 10), { ou_user: "User" });
  now += 60_001;
  identity.noteUnknownSender(agent, "oc_chat", "ou_unknown");
  assert.equal(memberFetches, 2);

  assert.equal(await identity.ensureSenderSignature(agent, "ou_user", 10), "bio");
  assert.equal(signatureFetches, 1);
  assert.deepEqual(store.json.get("senderProfiles").ou_user, { description: "bio", name: "User", at: now });
  assert.equal(await identity.ensureSenderSignature(agent, "ou_user", 10), "bio");
  assert.equal(signatureFetches, 1);
  now += 101;
  assert.equal(await identity.ensureSenderSignature(agent, "ou_user", 10), "bio");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(signatureFetches, 2);
});

test("inbound silence measures from the freshest of connect/inbound and requires a connection", async () => {
  const { inboundSilenceMs } = await import("../../../dist/feishu/host-business-state.mjs");
  const now = new Date("2026-07-17T07:00:00.000Z");
  assert.equal(inboundSilenceMs({}, now), null);
  assert.equal(inboundSilenceMs({ connectedAt: "not-a-date" }, now), null);
  assert.equal(inboundSilenceMs({ connectedAt: "2026-07-17T06:50:00.000Z" }, now), 600_000);
  assert.equal(inboundSilenceMs({ connectedAt: "2026-07-17T06:50:00.000Z", inboundVerifiedAt: "2026-07-17T06:59:00.000Z" }, now), 60_000);
  assert.equal(inboundSilenceMs({ connectedAt: "2026-07-17T06:59:00.000Z", inboundVerifiedAt: "2026-07-17T06:50:00.000Z" }, now), 60_000, "stale inbound from a previous run must not shrink silence");
});

test("preventive reconnect fires only on stuck-but-connected channels of the current run", async () => {
  const { shouldPreventiveReconnect } = await import("../../../dist/feishu/host-business-state.mjs");
  const now = new Date("2026-07-17T07:00:00.000Z");
  const threshold = 600_000;
  const bootMs = Date.parse("2026-07-17T06:45:00.000Z");
  // 未连接 / 阈值关闭 → 不动。
  assert.equal(shouldPreventiveReconnect({}, now, threshold), false);
  assert.equal(shouldPreventiveReconnect({ connectedAt: "2026-07-17T06:40:00.000Z" }, now, 0), false);
  // 静默超阈值 → 重连;最近有入站 → 不动。
  assert.equal(shouldPreventiveReconnect({ connectedAt: "2026-07-17T06:49:00.000Z" }, now, threshold), true);
  assert.equal(shouldPreventiveReconnect({ connectedAt: "2026-07-17T06:49:00.000Z", inboundVerifiedAt: "2026-07-17T06:55:00.000Z" }, now, threshold), false);
  // 上一轮 daemon 的残留 connectedAt(早于本轮启动)→ 不动,等本轮真正连上再说。
  assert.equal(shouldPreventiveReconnect({ connectedAt: "2026-07-17T06:40:00.000Z" }, now, threshold, bootMs), false);
  assert.equal(shouldPreventiveReconnect({ connectedAt: "2026-07-17T06:46:00.000Z" }, now, threshold, bootMs), true);
  // SDK 自己正在重连(reconnectingAt 未过期)→ 不抢;过期了(卡死)→ 接管。
  assert.equal(shouldPreventiveReconnect({ connectedAt: "2026-07-17T06:46:00.000Z", reconnectingAt: "2026-07-17T06:55:00.000Z" }, now, threshold, bootMs), false);
  assert.equal(shouldPreventiveReconnect({ connectedAt: "2026-07-17T06:30:00.000Z", reconnectingAt: "2026-07-17T06:35:00.000Z" }, now, threshold), true);
  // 同一个入站静默周期只维护一次；watchdog 自己触发的新 connectedAt 不能开启新周期。
  assert.equal(shouldPreventiveReconnect({
    connectedAt: "2026-07-17T06:49:00.000Z",
    droughtReconnectAt: "2026-07-17T06:50:00.000Z",
  }, now, threshold), false);
  assert.equal(shouldPreventiveReconnect({
    connectedAt: "2026-07-17T06:49:00.000Z",
    droughtReconnectAbandonedAt: "2026-07-17T06:50:00.000Z",
  }, now, threshold), false, "a bounded failed maintenance cycle stays closed until real inbound arrives");
  assert.equal(shouldPreventiveReconnect({
    connectedAt: "2026-07-17T06:49:00.000Z",
    inboundVerifiedAt: "2026-07-17T06:48:00.000Z",
    droughtReconnectAt: "2026-07-17T06:50:00.000Z",
  }, now, threshold), false);
  // 只有新的真实入站晚于上次维护，未来再次静默时才允许下一次维护。
  assert.equal(shouldPreventiveReconnect({
    connectedAt: "2026-07-17T06:40:00.000Z",
    droughtReconnectAt: "2026-07-17T06:45:00.000Z",
    inboundVerifiedAt: "2026-07-17T06:49:00.000Z",
  }, now, threshold), true);
  assert.equal(shouldPreventiveReconnect({
    connectedAt: "2026-07-17T06:40:00.000Z",
    droughtReconnectAbandonedAt: "2026-07-17T06:45:00.000Z",
    inboundVerifiedAt: "2026-07-17T06:49:00.000Z",
  }, now, threshold), true);
  // daemon restart opens a new cycle: maintenance markers from an older epoch cannot suppress it.
  assert.equal(shouldPreventiveReconnect({
    connectedAt: "2026-07-17T06:46:00.000Z",
    droughtReconnectAt: "2026-07-17T06:44:00.000Z",
  }, now, threshold, bootMs), true);
  assert.equal(shouldPreventiveReconnect({
    connectedAt: "2026-07-17T06:46:00.000Z",
    droughtReconnectAbandonedAt: "2026-07-17T06:44:00.000Z",
  }, now, threshold, bootMs), true);
  // A marker written by the current daemon still closes the cycle until newer real inbound.
  assert.equal(shouldPreventiveReconnect({
    connectedAt: "2026-07-17T06:46:00.000Z",
    droughtReconnectAt: "2026-07-17T06:50:00.000Z",
  }, now, threshold, bootMs), false);
  assert.equal(shouldPreventiveReconnect({
    connectedAt: "2026-07-17T06:46:00.000Z",
    droughtReconnectAbandonedAt: "2026-07-17T06:50:00.000Z",
  }, now, threshold, bootMs), false);
});
