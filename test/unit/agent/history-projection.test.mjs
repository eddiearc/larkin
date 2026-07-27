import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(import.meta.url);
const history = require(path.join(ROOT, "dist/agent/history-projection.cjs"));

test("Feishu text parsing and mention rendering preserve self annotations", () => {
  const message = {
    msg_type: "text",
    content: JSON.stringify({ text: "hello @_user_1 and @_user_2" }),
    mentions: [
      { key: "@_user_1", id: "ou_me", name: "Larkin" },
      { key: "@_user_2", id: "ou_peer", name: "Peer" },
    ],
  };
  const parsed = history.parseFeishuText(message);
  assert.equal(parsed, "hello @_user_1 and @_user_2");
  assert.equal(
    history.renderFeishuMentions(parsed, message.mentions, { open_id: "ou_me", name: "Larkin" }),
    "hello @Larkin(=你) and @Peer",
  );
  assert.equal(history.parseFeishuText({ msg_type: "image", content: "{}" }), null);
  assert.equal(history.parseFeishuText({ msg_type: "text", content: "not-json" }), null);
});

test("history projection preserves envelope identity, content, timestamp, and thread fields", () => {
  const localWallClockTimestamp = new Date(2026, 6, 16, 10, 20).toISOString();
  const envelope = history.projectFeishuHistoryEnvelope({
    message: {
      message_id: "om_1", message_position: "9", msg_type: "text",
      content: JSON.stringify({ text: "hi @_me" }),
      mentions: [{ key: "@_me", id: "ou_bot", name: "Bot" }],
      sender: { id: "ou_human", sender_type: "user", id_type: "open_id" },
      create_time: "2026-07-16 10:20", thread_id: "omt_topic",
    },
    channelType: "thread", channelName: "topic123", names: { ou_human: "Human" },
    selectedAppId: "cli_app", botIdentity: { open_id: "ou_bot", name: "Bot" },
    senderDescription: "<feishu_signature>hello</feishu_signature>",
  });
  assert.deepEqual(envelope, {
    message_id: "om_1", seq: 9, sender_id: "ou_human", sender_name: "Human",
    sender_description: "<feishu_signature>hello</feishu_signature>", sender_type: "human",
    channel_type: "thread", channel_name: "topic123", content: "hi @Bot(=你)",
    timestamp: localWallClockTimestamp, thread_id: "omt_topic",
  });

  const self = history.projectFeishuHistoryEnvelope({
    message: { message_id: "om_2", msg_type: "image", content: { key: "img" }, sender: { id: "cli_app", sender_type: "app" } },
    channelType: "channel", channelName: "croom", selectedAppId: "cli_app", botIdentity: { name: "My Bot" },
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  assert.equal(self.sender_name, "My Bot(你自己)");
  assert.equal(self.sender_type, "agent");
  assert.equal(self.content, '{"key":"img"}');
  assert.equal(self.timestamp, "2026-01-01T00:00:00.000Z");
});

test("history timestamps preserve local wall-clock semantics and stable absolute inputs", () => {
  assert.equal(
    history.toIsoTimestamp("2026-07-16 10:20"),
    new Date(2026, 6, 16, 10, 20).toISOString(),
  );
  assert.equal(
    history.toIsoTimestamp("2026-07-16T10:20:00+08:00"),
    "2026-07-16T02:20:00.000Z",
  );
  assert.equal(history.toIsoTimestamp(0), "1970-01-01T00:00:00.000Z");
  assert.equal(history.toIsoTimestamp("0"), "1970-01-01T00:00:00.000Z");
});

test("history ordering removes deleted messages and sorts by message position", () => {
  const input = [
    { message_id: "m3", message_position: "3" },
    { message_id: "gone", message_position: "1", deleted: true },
    { message_id: "m2", message_position: "2" },
  ];
  assert.deepEqual(history.sortVisibleHistory(input).map((message) => message.message_id), ["m2", "m3"]);
  assert.deepEqual(input.map((message) => message.message_id), ["m3", "gone", "m2"]);
});

test("production history route consumes the typed projection without moving request or injection boundaries", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/agent/agent-transport.ts"), "utf8");
  const context = fs.readFileSync(path.join(ROOT, "src/agent/transport-business-context.ts"), "utf8");
  assert.match(source, /from ["']\.\/transport-business-context\.js["']/);
  assert.match(context, /from ["']\.\/history-projection\.js["']/);
  assert.match(source, /sortVisibleHistory\(jr\.data\.messages \|\| \[\]\)/);
  assert.match(context, /projectFeishuHistoryEnvelope\(\{/);
  assert.match(source, /request: \(input: AgentTransportInput\) => handle\(input\)/);
  assert.match(source, /globalThis\.__LARKIN_AGENT_TRANSPORT/);
});
