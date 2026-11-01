import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const streamReply = await import(pathToFileURL(path.join(ROOT, "dist/feishu/stream-reply.mjs")).href);
const {
  StreamReplyCoordinator, STREAM_REPLY_FAILURE_TEXT, STREAM_REPLY_SILENT_TEXT,
  replyAddressOf, replyModeFromEnv,
} = streamReply;

function findElement(node, elementId) {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const item of node) { const found = findElement(item, elementId); if (found) return found; }
    return null;
  }
  if (node.element_id === elementId) return node;
  for (const value of Object.values(node)) { const found = findElement(value, elementId); if (found) return found; }
  return null;
}

/** Mirrors the CardKit + IM OpenAPI surface of `LarkChannel.rawClient`, keeping each card's live JSON. */
function fakeClient() {
  const cards = [];
  const calls = [];
  const byId = (cardId) => cards.find((card) => card.cardId === cardId);
  const rawClient = {
    cardkit: { v1: {
      card: {
        async create(request) {
          const card = { cardId: `card_${cards.length + 1}`, json: JSON.parse(request.data.data), settings: null, sequences: [] };
          cards.push(card);
          calls.push("create");
          return { code: 0, data: { card_id: card.cardId } };
        },
        async update(request) {
          const card = byId(request.path.card_id);
          card.json = JSON.parse(request.data.card.data);
          card.sequences.push(request.data.sequence);
          calls.push("update");
          return { code: 0 };
        },
        async settings(request) {
          const card = byId(request.path.card_id);
          card.settings = JSON.parse(request.data.settings);
          card.sequences.push(request.data.sequence);
          calls.push("settings");
          return { code: 0 };
        },
      },
      cardElement: {
        async content(request) {
          const card = byId(request.path.card_id);
          findElement(card.json, request.path.element_id).content = request.data.content;
          card.sequences.push(request.data.sequence);
          calls.push(`content:${request.path.element_id}`);
          return { code: 0 };
        },
      },
    } },
    im: { v1: { message: {
      async reply(request) {
        const card = byId(JSON.parse(request.data.content).data.card_id);
        card.replyTo = request.path.message_id;
        card.inThread = request.data.reply_in_thread;
        card.messageId = `om_card_${cards.indexOf(card) + 1}`;
        return { code: 0, data: { message_id: card.messageId } };
      },
    } } },
  };
  return { cards, calls, rawClient };
}

function harness(initialSource = null) {
  const client = fakeClient();
  const state = { source: initialSource };
  const logs = [];
  const coordinator = new StreamReplyCoordinator({
    channelFor: () => ({ rawClient: client.rawClient }),
    resolveSource: () => state.source,
    log: (...parts) => logs.push(parts.join(" ")),
    throttleMs: 0,
    resolveIntervalMs: 0,
    now: () => 0,
  });
  const send = (event) => coordinator.observe("agent-1", event);
  return { cards: client.cards, calls: client.calls, state, logs, coordinator, send };
}

const answerOf = (card) => findElement(card.json, "answer")?.content;
const replayTitleOf = (card) => findElement(card.json, "replay")?.header.title.content;
const replayStepsOf = (card) => findElement(card.json, "replayc")?.content;
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** The poll is itself a tool call: its source appears only once it returns. */
function poll(send, state, source) {
  send({ type: "activity", activity: "tool", name: "command", text: "larkin inbox poll --target chat:x --limit 1", toolId: "poll" });
  state.source = source;
  send({ type: "tool-result", toolId: "poll", ok: true });
}

test("reply mode defaults to cli, so bots without the CardKit scope keep replying, and card mode is opt-in", () => {
  assert.equal(replyModeFromEnv({}), "cli");
  assert.equal(replyModeFromEnv({ LARKIN_REPLY_MODE: "card" }), "card");
  assert.equal(replyModeFromEnv({ LARKIN_REPLY_MODE: "cli" }), "cli");
});

test("only chat/thread sources with a real om_ anchor become card addresses", () => {
  assert.deepEqual(replyAddressOf({ deliveryTarget: "chat:oc_a", deliveryAnchor: "om_1" }),
    { key: "chat:oc_a#om_1", chatId: "oc_a", anchor: "om_1", inThread: false });
  assert.deepEqual(replyAddressOf({ deliveryTarget: "thread:oc_a:omt_t", deliveryAnchor: "om_2" }),
    { key: "thread:oc_a:omt_t#om_2", chatId: "oc_a", anchor: "om_2", inThread: true });
  assert.equal(replyAddressOf({ deliveryTarget: "document-comment:doc_x", deliveryAnchor: "doc_comment_1" }), null);
  assert.equal(replyAddressOf({ deliveryTarget: "chat:oc_a", deliveryAnchor: "rem_1" }), null);
  assert.equal(replyAddressOf(null), null);
  assert.equal(replyAddressOf({ deliveryTarget: "chat:oc_a", deliveryAnchor: "om_3", replyByCommand: true }), null,
    "a source that replies by command opens no card");
});

test("after the poll the card streams the answer, folds the steps into a replay panel and closes streaming", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  send({ type: "text-delta", text: "I will poll first.", newBlock: true });
  poll(send, state, { deliveryTarget: "chat:oc_room", deliveryAnchor: "om_user" });
  assert.equal(cards.length, 0, "neither pre-poll text nor the poll itself opens a card");
  send({ type: "text-delta", text: "你好", newBlock: true });
  send({ type: "text-delta", text: "，世界" });
  send({ type: "activity", activity: "tool", name: "command", text: "ls docs", toolId: "t1" });
  send({ type: "tool-result", toolId: "t1", ok: false });
  send({ type: "text-delta", text: "查完了。", newBlock: true });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.equal(cards.length, 1);
  const [card] = cards;
  assert.equal(card.replyTo, "om_user");
  assert.equal(card.inThread, false);
  assert.equal(answerOf(card), "你好，世界\n\n查完了。");
  assert.match(replayTitleOf(card), /Replay · 1 tool call · 1s</);
  assert.equal(replayStepsOf(card), "- `ls docs` · failed", "a step shows the raw input, marked only when it failed");
  assert.deepEqual(card.settings, { config: { streaming_mode: false, summary: { content: "你好，世界 查完了。" } } });
  assert.deepEqual(card.sequences, [...card.sequences].sort((a, b) => a - b), "CardKit sequences only increase");
});

test("a long tool input keeps its head and tail on one line and elides the middle", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_room", deliveryAnchor: "om_user" });
  const command = `bash -lc "cd /srv/app &&\n${"x".repeat(400)} && echo \`done\`" TAIL_END`;
  send({ type: "activity", activity: "tool", name: "command", text: command, toolId: "long" });
  send({ type: "activity", activity: "tool", name: "command", toolId: "bare" });
  send({ type: "turn-end" });
  await coordinator.idle();
  const [first, second] = replayStepsOf(cards[0]).split("\n");
  const shown = /^- `(.*)`$/.exec(first)[1];
  assert.equal(shown.length, 200, "the shown input is bounded");
  assert.match(shown, /^bash -lc "cd \/srv\/app && x+…x+ && echo 'done'" TAIL_END$/, "head and tail survive; newlines and backticks are flattened");
  assert.equal(second, "- command", "a call without input falls back to the tool name");
});

test("while streaming, text grows through element updates and a new step restructures the card", async () => {
  const { cards, calls, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_room", deliveryAnchor: "om_user" });
  send({ type: "text-delta", text: "第一段", newBlock: true });
  await tick();
  send({ type: "text-delta", text: "继续" });
  await tick();
  assert.equal(findElement(cards[0].json, "t0").content, "第一段继续");
  assert.ok(calls.includes("content:t0"), "same structure streams the text element in place");
  send({ type: "activity", activity: "tool", name: "web search", text: "飞书 卡片", toolId: "s1" });
  await tick();
  assert.match(findElement(cards[0].json, "p1").header.title.content, /1 tool call/);
  assert.match(findElement(cards[0].json, "status").content, /Running `飞书 卡片`/);
  assert.ok(calls.includes("update"), "a new steps panel is a full card update");
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.equal(answerOf(cards[0]), "第一段继续");
  assert.match(replayStepsOf(cards[0]), /^- `飞书 卡片`$/, "a call without a reported result is complete, not failed, when the turn ends");
});

test("reasoning after the poll waits for the answer and then shows in the steps", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_room", deliveryAnchor: "om_user" });
  send({ type: "activity", activity: "thinking", text: "用户在打招呼，" });
  send({ type: "activity", activity: "thinking", text: "简短回应即可。" });
  assert.equal(cards.length, 0);
  send({ type: "text-delta", text: "你好！", newBlock: true });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.equal(cards.length, 1);
  assert.equal(answerOf(cards[0]), "你好！");
  assert.match(replayTitleOf(cards[0]), /Replay · Thinking · /);
  assert.equal(replayStepsOf(cards[0]), "> 用户在打招呼，简短回应即可。");
});

test("a silent turn after the poll posts no card, even when it reasoned", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "activity", activity: "thinking", text: "这条消息是发给另一个 Agent 的。" });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.equal(cards.length, 0);
});

test("work after the poll that ends without answer text still closes its card", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "activity", activity: "tool", name: "command", text: "larkin reminder add", toolId: "r1" });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.equal(cards.length, 1);
  assert.equal(answerOf(cards[0]), STREAM_REPLY_SILENT_TEXT);
});

test("a thread source keeps the card reply inside the same topic", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "thread:oc_room:omt_topic", deliveryAnchor: "om_in_topic" });
  send({ type: "text-delta", text: "ok", newBlock: true });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.equal(cards.length, 1);
  assert.equal(cards[0].replyTo, "om_in_topic");
  assert.equal(cards[0].inThread, true);
});

test("polling another target mid-turn closes the first card and opens a new one", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "text-delta", text: "answer A", newBlock: true });
  poll(send, state, { deliveryTarget: "chat:oc_b", deliveryAnchor: "om_b" });
  send({ type: "text-delta", text: "answer B", newBlock: true });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.deepEqual(cards.map((card) => [card.replyTo, answerOf(card), card.settings?.config.streaming_mode]), [
    ["om_a", "answer A", false],
    ["om_b", "answer B", false],
  ]);
});

test("a turn that fails after the poll still answers the user with a failure card", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "input-error", inputId: "i1", retryable: false, message: "provider down" });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.equal(cards.length, 1);
  assert.equal(answerOf(cards[0]), STREAM_REPLY_FAILURE_TEXT);
});

test("a failure after partial text keeps the text and appends the failure notice", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "text-delta", text: "half an answer", newBlock: true });
  send({ type: "closed", code: 1, signal: null });
  await coordinator.idle();
  assert.equal(cards.length, 1);
  assert.equal(answerOf(cards[0]), `half an answer\n\n<font color='grey'>${STREAM_REPLY_FAILURE_TEXT}</font>`);
});

test("a retrying input-error does not mark the turn failed", async () => {
  const { cards, coordinator, send } = harness({ deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "turn-start" });
  send({ type: "input-error", inputId: "i1", retryable: true, willRetry: true, message: "compacting" });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.equal(cards.length, 0);
});

test("document-comment and reminder turns never produce an IM card", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "document-comment:doc_x", deliveryAnchor: "doc_comment_1" });
  send({ type: "text-delta", text: "comment reply goes through comment reply", newBlock: true });
  send({ type: "turn-end" });
  state.source = null;
  send({ type: "turn-start" });
  send({ type: "text-delta", text: "reminder text", newBlock: true });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.equal(cards.length, 0);
});

/** A coordinator over a client whose CardKit or IM calls fail in the given way. */
function failingHarness(rawClient) {
  const state = { source: null };
  const logs = [];
  const coordinator = new StreamReplyCoordinator({
    channelFor: () => ({ rawClient }),
    resolveSource: () => state.source,
    log: (...parts) => logs.push(parts.join(" ")),
    throttleMs: 0, resolveIntervalMs: 0, now: () => 0,
  });
  return { state, logs, coordinator, send: (event) => coordinator.observe("agent-1", event) };
}

test("a card that cannot be created falls back to a plain text reply with the answer", async () => {
  const replies = [];
  const { state, logs, coordinator, send } = failingHarness({
    cardkit: { v1: { card: { create: async () => ({ code: 99991672, msg: "no permission" }) } } },
    im: { v1: { message: { reply: async (request) => { replies.push(request); return { code: 0, data: { message_id: "om_plain" } }; } } } },
  });
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "thread:oc_a:omt_t", deliveryAnchor: "om_a" });
  send({ type: "text-delta", text: "hi", newBlock: true });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.ok(logs.some((line) => /流式卡片回复失败 anchor=om_a: cardkit\.card\.create code=99991672 no permission/.test(line)), logs.join("\n"));
  assert.deepEqual(replies.map((request) => [request.path.message_id, request.data.msg_type, JSON.parse(request.data.content).text, request.data.reply_in_thread]),
    [["om_a", "text", "hi", true]]);
  assert.ok(logs.some((line) => line.startsWith("流式卡片不可用，已改用普通消息回复 anchor=om_a message=om_plain")), logs.join("\n"));
  assert.ok(!logs.some((line) => line.startsWith("流式卡片已发送")));
});

test("a card reply that failed in transit may have posted, so no plain reply duplicates it", async () => {
  const replies = [];
  const { state, logs, coordinator, send } = failingHarness({
    cardkit: { v1: { card: { create: async () => ({ code: 0, data: { card_id: "card_1" } }) } } },
    im: { v1: { message: { reply: async (request) => { replies.push(request); throw new Error("socket hang up"); } } } },
  });
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "text-delta", text: "hi", newBlock: true });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.equal(replies.length, 1, "only the card reply was attempted");
  assert.ok(logs.some((line) => /流式卡片回复失败 anchor=om_a: socket hang up/.test(line)), logs.join("\n"));
});

test("a final card update that keeps failing is retried once and reported, not logged as sent", async () => {
  const client = fakeClient();
  let updates = 0;
  client.rawClient.cardkit.v1.card.update = async () => { updates += 1; return { code: 300301, msg: "rate limited" }; };
  const { state, logs, coordinator, send } = failingHarness(client.rawClient);
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "text-delta", text: "final answer", newBlock: true });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.equal(updates, 2, "the final body is retried once");
  assert.ok(logs.some((line) => line.startsWith("流式卡片最终内容未能写入")), logs.join("\n"));
  assert.ok(!logs.some((line) => line.startsWith("流式卡片已发送")), logs.join("\n"));
});

test("answer text keeps its exact leading and trailing whitespace", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "text-delta", text: "    indented code\n", newBlock: true });
  send({ type: "activity", activity: "tool", name: "command", toolId: "t1" });
  send({ type: "text-delta", text: "  ", newBlock: true });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.equal(answerOf(cards[0]), "    indented code\n", "blank blocks are skipped, text is not trimmed");
});

test("a terminal Runtime error finishes the card at once, because the replaced session sends no turn-end", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "text-delta", text: "half", newBlock: true });
  send({ type: "error", message: "runtime crashed" });
  await coordinator.idle();
  assert.equal(cards.length, 1);
  assert.equal(answerOf(cards[0]), `half\n\n<font color='grey'>${STREAM_REPLY_FAILURE_TEXT}</font>`);
  assert.equal(cards[0].settings?.config.streaming_mode, false);
});

test("a failure after polling A then B answers B, not the earlier card's message", async () => {
  const { cards, state, coordinator, send } = harness();
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "text-delta", text: "answer A", newBlock: true });
  poll(send, state, { deliveryTarget: "chat:oc_b", deliveryAnchor: "om_b" });
  send({ type: "input-error", inputId: "i1", retryable: false, message: "provider down" });
  state.source = null; // the turn boundary clears the source before turn-end is observed
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.deepEqual(cards.map((card) => [card.replyTo, answerOf(card)]), [
    ["om_a", "answer A"],
    ["om_b", STREAM_REPLY_FAILURE_TEXT],
  ]);
});

test("each turn with reply text logs a diagnostic summary, flagging text that no card carried", async () => {
  const { state, logs, coordinator, send } = harness();
  send({ type: "turn-start" });
  send({ type: "text-delta", text: "没有领取消息就写的回复", newBlock: true });
  send({ type: "turn-end" });
  assert.match(logs.at(-1), /流式回复回合结束 agent=agent-1 text=11 cards=0 tools=0 source=none（本回合没有领到消息，Agent 输出的文字没有可回复的对象，没有发到飞书）/);

  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_room", deliveryAnchor: "om_user" });
  send({ type: "text-delta", text: "你好", newBlock: true });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.ok(logs.includes("流式回复回合结束 agent=agent-1 text=2 cards=1 tools=1 source=chat:oc_room#om_user"), logs.join("\n"));
  assert.ok(logs.includes("流式卡片已发送 anchor=om_user message=om_card_1 chars=2"), logs.join("\n"));

  state.source = null; // the turn boundary clears the previous poll's source
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_room", deliveryAnchor: "om_quiet", replyByCommand: true });
  send({ type: "text-delta", text: "随手一句", newBlock: true });
  send({ type: "turn-end" });
  assert.match(logs.at(-1), /cards=0 tools=1 source=chat:oc_room#om_quiet（本回合领到的消息没有 @ 机器人，Agent 输出的文字不会自动发到飞书）/);

  const before = logs.length;
  state.source = null;
  send({ type: "turn-start" });
  send({ type: "turn-end" });
  assert.equal(logs.length, before, "a silent turn logs nothing");
});

/** Default 500ms source cache and an injected clock. Does not pass resolveIntervalMs. */
function productionCacheHarness() {
  const client = fakeClient();
  const state = { source: null };
  const logs = [];
  let clock = 1_000;
  const coordinator = new StreamReplyCoordinator({
    channelFor: () => ({ rawClient: client.rawClient }),
    resolveSource: () => state.source,
    log: (...parts) => logs.push(parts.join(" ")),
    throttleMs: 0,
    now: () => clock,
  });
  return {
    cards: client.cards,
    state,
    logs,
    coordinator,
    send: (event) => coordinator.observe("agent-1", event),
    advance(ms) { clock += ms; },
  };
}

test("the Host keeps the production 500ms source cache", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/feishu/host-shell.ts"), "utf8");
  const at = source.indexOf("new StreamReplyCoordinator(");
  const call = source.slice(at, source.indexOf("});", at) + 3);
  assert.match(call, /resolveSource:/);
  assert.doesNotMatch(call, /resolveIntervalMs|now:/);
});

test("text for a second poll stays on that poll's card inside the default 500ms source cache", async () => {
  const { cards, state, coordinator, send, advance } = productionCacheHarness();
  assert.equal(coordinator.resolveIntervalMs, 500);
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "text-delta", text: "answer A", newBlock: true });
  advance(1);
  poll(send, state, { deliveryTarget: "chat:oc_b", deliveryAnchor: "om_b" });
  send({ type: "text-delta", text: "answer B", newBlock: true });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.deepEqual(cards.map((card) => [card.replyTo, answerOf(card)]), [
    ["om_a", "answer A"],
    ["om_b", "answer B"],
  ]);
});

test("without a new poll the default source cache holds the open card until 500ms", async () => {
  const { cards, state, coordinator, send, advance } = productionCacheHarness();
  assert.equal(coordinator.resolveIntervalMs, 500);
  send({ type: "turn-start" });
  poll(send, state, { deliveryTarget: "chat:oc_a", deliveryAnchor: "om_a" });
  send({ type: "text-delta", text: "answer A", newBlock: true });
  state.source = { deliveryTarget: "chat:oc_b", deliveryAnchor: "om_b" };
  advance(499);
  send({ type: "text-delta", text: " more", newBlock: false });
  advance(1);
  send({ type: "text-delta", text: "answer B", newBlock: true });
  send({ type: "turn-end" });
  await coordinator.idle();
  assert.deepEqual(cards.map((card) => [card.replyTo, answerOf(card)]), [
    ["om_a", "answer A more"],
    ["om_b", "answer B"],
  ]);
});
