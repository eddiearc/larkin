import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import { test } from "bun:test";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const policy = await import(pathToFileURL(path.join(ROOT, "dist/feishu/message-policy.mjs")).href);

test("wake policy matches the Owner-approved human and bot matrix", () => {
  const decide = (overrides) => policy.decideWake({
    senderIsBot: false,
    mentionedBot: false,
    mentionAll: false,
    isGroup: true,
    noMentionChat: false,
    ...overrides,
  });

  assert.deepEqual(decide({ isGroup: false }), { wake: true, reason: "human-direct-message" });
  assert.deepEqual(decide({ mentionedBot: true }), { wake: true, reason: "human-mentioned" });
  assert.deepEqual(decide({ mentionAll: true }), { wake: true, reason: "human-mentioned" });
  assert.deepEqual(decide({ noMentionChat: true }), { wake: true, reason: "human-no-mention-chat" });
  assert.deepEqual(decide({ mentionPolicy: "free" }), { wake: true, reason: "human-no-mention-chat" });
  assert.deepEqual(decide({}), { wake: false, reason: "human-group-not-mentioned" });
  assert.deepEqual(decide({ senderIsBot: true, mentionedBot: true }), { wake: true, reason: "bot-exact-mention" });
  assert.deepEqual(decide({ senderIsBot: true, mentionedBot: true, mentionAll: true }), { wake: false, reason: "bot-not-exactly-mentioned" });
  assert.deepEqual(decide({ senderIsBot: true, noMentionChat: true }), { wake: false, reason: "bot-not-exactly-mentioned" });
  assert.deepEqual(decide({ senderIsBot: true, mentionPolicy: "free" }), { wake: false, reason: "bot-not-exactly-mentioned" });
  assert.deepEqual(decide({ senderIsBot: true, isGroup: false }), { wake: false, reason: "bot-not-exactly-mentioned" });
});

test("channel normalization preserves topic, mention, and bot identity inputs", () => {
  assert.deepEqual(policy.normalizeChannelMessage({
    chatId: "oc_chat",
    chatMode: "topic",
    chatType: "p2p",
    senderId: "ou_sender",
    messageId: "om_message",
    content: "hello",
    createTime: "1700000000000",
    threadId: "omt_topic",
    mentionedBot: false,
    mentionAll: true,
    senderIsBot: true,
  }), {
    chat_id: "oc_chat",
    chat_type: "group",
    sender_id: "ou_sender",
    message_id: "om_message",
    event_id: "om_message",
    content: "hello",
    create_time: "1700000000000",
    thread_id: "omt_topic",
    _mentioned_bot: true,
    _mention_all: true,
    _sender_is_bot: true,
  });
});

test("targets keep DM, channel, and topic aliases stable", () => {
  const dm = policy.targetFor({ chat_id: "oc_1234567890", chat_type: "p2p", thread_id: null });
  assert.deepEqual(dm, { target: "dm:@c1234567890", channel_type: "dm", channel_name: "c1234567890" });

  const topicEvent = { chat_id: "oc_1234567890", chat_type: "group", thread_id: "omt_abcdefghij" };
  const topic = policy.targetFor(topicEvent);
  assert.deepEqual(topic, {
    target: "#c1234567890:abcdefgh",
    channel_type: "thread",
    channel_name: "abcdefghij",
    parent_channel_type: "channel",
    parent_channel_name: "c1234567890",
  });
  assert.deepEqual(policy.targetAliases(topicEvent, topic), [
    "#c1234567890",
    "#c1234567890:abcdefghij",
    "#c1234567890:abcdefgh",
  ]);
});

test("envelope construction preserves sender semantics and escapes untrusted signatures", () => {
  const event = policy.normalizeChannelMessage({
    chatId: "oc_1234567890",
    chatType: "group",
    senderId: "ou_sender",
    messageId: "om_message",
    content: "hello",
    createTime: "1700000000000",
    mentionedBot: true,
  });
  const envelope = policy.createMessageEnvelope({
    agent: { botOpenId: "ou_bot", botName: "Larkin" },
    event,
    seq: 7,
    names: { ou_sender: "林一丹" },
    signature: `<admin & \"owner\">'`,
  });
  assert.equal(envelope.sender_id, "ou_sender");
  assert.equal(envelope.sender_name, "林一丹");
  assert.equal(envelope.sender_type, "human");
  assert.equal(envelope.sender_description, "<feishu_signature>&lt;admin &amp; &quot;owner&quot;&gt;&apos;</feishu_signature>");
  assert.match(envelope.content, /@ 的“Larkin”就是你自己/);
  assert.equal(envelope.timestamp, "2023-11-14T22:13:20.000Z");
});

test("other bots are agents and mention-all never adds the directed-mention annotation", () => {
  const event = policy.normalizeChannelMessage({
    chatId: "oc_1234567890",
    chatType: "group",
    senderId: "cli_otherbot",
    messageId: "om_bot",
    content: "broadcast",
    mentionedBot: true,
    mentionAll: true,
    senderIsBot: true,
  });
  const envelope = policy.createMessageEnvelope({ agent: { botOpenId: "ou_self", botName: "Larkin" }, event, seq: 1 });
  assert.equal(envelope.sender_type, "agent");
  assert.equal(envelope.content, "broadcast");
  assert.equal("sender_description" in envelope, false);
});

test("message sequence must be a positive safe integer", () => {
  const event = policy.normalizeChannelMessage({ messageId: "om_invalid" });
  assert.throws(() => policy.createMessageEnvelope({ agent: {}, event, seq: 0 }), /invalid message sequence/);
});

test("real host channel wiring persists every non-self message and only delivers Owner-approved wake cases", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-wake-matrix-"));
  try {
    const agentId = "cli_wakeMatrix1";
    const stateDir = path.join(temp, "state", "agents", agentId);
    const workspaceDir = path.join(temp, "agents", agentId);
    const inboxFile = path.join(stateDir, "feishu-inbox.ndjson");
    const replyFile = path.join(stateDir, "feishu-replyctx.json");
    const scenarios = [
      { chatId: "oc_human_quiet", chatType: "group", senderId: "ou_human_1", messageId: "om_human_quiet", content: "quiet human" },
      { chatId: "oc_human_mention", chatType: "group", senderId: "ou_human_2", messageId: "om_human_mention", content: "mentioned human", mentionedBot: true },
      { chatId: "oc_human_whitelist", chatType: "group", senderId: "ou_human_3", messageId: "om_human_whitelist", content: "whitelisted human" },
      { chatId: "oc_human_dm", chatType: "p2p", senderId: "ou_human_4", messageId: "om_human_dm", content: "direct human" },
      { chatId: "oc_bot_whitelist", chatType: "group", senderId: "cli_otherBot1", messageId: "om_bot_whitelist", content: "bot in whitelist", senderIsBot: true },
      { chatId: "oc_bot_all", chatType: "group", senderId: "cli_otherBot2", messageId: "om_bot_all", content: "bot broadcast", senderIsBot: true, mentionedBot: true, mentionAll: true },
      { chatId: "oc_bot_exact", chatType: "group", senderId: "cli_otherBot3", messageId: "om_bot_exact", content: "bot exact mention", senderIsBot: true, mentionedBot: true },
    ];
    const preload = path.join(temp, "channel-matrix-package.cjs");
    fs.writeFileSync(preload, `
const scenarios = JSON.parse(process.env.HOST_WAKE_SCENARIOS);
module.exports.execFileImpl = function(_command, _args, _options, callback) {
  callback(null, JSON.stringify({ ok: true, data: { users: [], bots: [] } }), "");
};
module.exports.managedCliForAgent = function() {
  return { command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} };
};
module.exports.channelPackage = {
    createLarkChannel() {
      return {
        on(handlers) {
          scenarios.forEach((message, index) => setTimeout(() => handlers.message(message), 25 * index));
        },
        dispatcher: { register() {} },
        connect() { return new Promise(() => {}); },
        disconnect() {},
        rawClient: null,
        botIdentity: null,
      };
    },
};
`);
    const fixture = `
const fs = require("node:fs");
require(${JSON.stringify(path.join(ROOT, "test", "support", "host-shell-test-harness.cjs"))});
const deadline = Date.now() + 7000;
const timer = setInterval(() => {
  let count = 0;
  try { count = fs.readFileSync(process.env.HOST_WAKE_INBOX, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
  if (count === Number(process.env.HOST_WAKE_COUNT)) {
    clearInterval(timer);
    setTimeout(() => {
      let deliveries = [];
      try { deliveries = fs.readFileSync(process.env.LARKIN_TEST_DELIVERY_FILE, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse); } catch {}
      process.stdout.write(JSON.stringify({ deliveries }));
      process.exit(0);
    }, 200);
  } else if (Date.now() > deadline) {
    clearInterval(timer);
    console.error("timed out waiting for inbox, count=" + count);
    process.exit(2);
  }
}, 25);
`;
    fs.mkdirSync(stateDir, { recursive: true });
    const agent = {
      agentId,
      name: agentId,
      runtime: "codex",
      model: "gpt-test",
      feishuAppId: agentId,
      feishuProfile: agentId,
      workspaceDir,
      stateDir,
      larkConfigDir: path.join(stateDir, "lark-cli-config"),
      noMentionChats: ["oc_human_whitelist", "oc_bot_whitelist"],
      feishuAppSecret: "fixture-secret",
      feishuDomain: "https://open.feishu.cn",
    };
    const result = spawnSync(process.execPath, ["--eval", fixture], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 10_000,
      env: {
        ...process.env,
        LARKIN_HOME: temp,
        LARKIN_CONFIG_DIR: temp,
        LARKIN_SERVER_ID: "server-wake-matrix",
        LARKIN_AGENTS_CONFIG: JSON.stringify([agent]),
        HOST_WAKE_SCENARIOS: JSON.stringify(scenarios),
        HOST_WAKE_INBOX: inboxFile,
        HOST_WAKE_COUNT: String(scenarios.length),
        LARKIN_TEST_DELIVERY_FILE: path.join(temp, "deliveries.ndjson"),
        LARKIN_TEST_EVENT_SOURCE_START_DELAY_MS: "50",
        LARKIN_TEST_CHANNEL_PACKAGE_MODULE: preload,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout || result.error?.message);

    const inbox = fs.readFileSync(inboxFile, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
    assert.deepEqual(inbox.map((message) => message.message_id), scenarios.map((message) => message.messageId),
      "every human/other-bot message must remain visible in the inbox even when it does not wake");
    assert.deepEqual(inbox.filter((message) => message.wake === true).map((message) => message.message_id), [
      "om_human_mention", "om_human_whitelist", "om_human_dm", "om_bot_exact",
    ]);

    const delivered = JSON.parse(result.stdout).deliveries;
    assert.deepEqual(delivered.map((message) => message.message_id), [
      "om_human_mention", "om_human_whitelist", "om_human_dm", "om_bot_exact",
    ], "only directed/allowed messages may cross the RuntimeHost delivery boundary");

    const replyContext = JSON.parse(fs.readFileSync(replyFile, "utf8"));
    assert.equal(replyContext.oc_human_quiet, undefined, "unmentioned human group chatter must not replace the reply anchor");
    assert.equal(replyContext.oc_bot_whitelist, undefined, "the no-mention whitelist must never wake or anchor bot messages");
    assert.equal(replyContext.oc_bot_all, undefined, "bot @all must never wake or replace the reply anchor");
    assert.equal(replyContext.oc_human_mention.reply_to, "om_human_mention");
    assert.equal(replyContext.oc_human_whitelist.reply_to, "om_human_whitelist");
    assert.equal(replyContext.oc_human_dm.reply_to, "om_human_dm");
    assert.equal(replyContext.oc_bot_exact.reply_to, "om_bot_exact");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
