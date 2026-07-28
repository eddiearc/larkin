import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";

const moduleUrl = pathToFileURL(path.resolve(import.meta.dirname, "../../../dist/feishu/im-freshness-adapter.mjs")).href;

test("IM cursor uses max create/update revision and preserves every ID at the same millisecond", async () => {
  const { feishuImFreshnessAdapter: adapter, mergeFeishuImCursor, messageRevisionTime } = await import(moduleUrl);
  const messages = [
    { message_id: "om_a", create_time: "100", update_time: "300" },
    { message_id: "om_b", create_time: "300" },
    { message_id: "om_old", create_time: "200" },
  ];
  assert.equal(messageRevisionTime(messages[0]), 300n);
  assert.deepEqual(adapter.cursor({ messages }), { schema: 1, revisionTime: "300", messageIds: ["om_a", "om_b"] });
  assert.equal(adapter.compare({ schema: 1, revisionTime: "300", messageIds: ["om_a"] }, adapter.cursor({ messages })), "conflict");
  assert.deepEqual(mergeFeishuImCursor(
    { schema: 1, revisionTime: "300", messageIds: ["om_a"] },
    { schema: 1, revisionTime: "300", messageIds: ["om_b"] },
  ), { schema: 1, revisionTime: "300", messageIds: ["om_a", "om_b"] });
});

test("IM adapter detects edits, first touch, empty targets, gaps, malformed payloads, and exact target keys", async () => {
  const { feishuImFreshnessAdapter: adapter, feishuImTarget, serializeFeishuImTarget } = await import(moduleUrl);
  assert.equal(adapter.compare(null, null), "fresh");
  assert.equal(adapter.compare(null, { schema: 1, revisionTime: "1", messageIds: ["om_1"] }), "conflict");
  assert.equal(adapter.compare({ schema: 1, revisionTime: "9", messageIds: ["om_9"] }, { schema: 1, revisionTime: "8", messageIds: ["om_8"] }), "gap");
  const edit = adapter.cursor({ messages: [{ message_id: "om_edit", create_time: "1", update_time: "10" }] });
  assert.equal(adapter.compare({ schema: 1, revisionTime: "1", messageIds: ["om_edit"] }, edit), "conflict");
  assert.throws(() => adapter.cursor({ messages: [{ message_id: "om_bad", create_time: "not-ms" }] }), /malformed/);
  assert.equal(serializeFeishuImTarget(feishuImTarget("chat:oc_a")), "feishu.im/chat/oc_a");
  assert.equal(serializeFeishuImTarget(feishuImTarget("thread:oc_a:omt_1")), "feishu.im/thread/oc_a/omt_1");
});
