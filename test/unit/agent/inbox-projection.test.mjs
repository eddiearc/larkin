import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const require = createRequire(import.meta.url);
const { projectInboxEnvelope, projectInboxEvents, targetOfInboxEnvelope } = require(path.join(ROOT, "dist/agent/inbox-projection.cjs"));
const { createAgentStateStore } = require(path.join(ROOT, "dist/agent/agent-state-store.cjs"));

test("local Inbox projection adds Feishu locators without mutating the canonical envelope", () => {
  const canonical = { message_id: "om_1", sender_id: "ou_1", content: "hello", thread_id: "omt_1" };
  const local = projectInboxEnvelope(canonical, { chat_id: "oc_1", thread_id: "omt_1", sender_id: "ou_1", content: "hello" });
  assert.deepEqual(local, { ...canonical, chat_id: "oc_1" });
  assert.equal("chat_id" in canonical, false);
});

test("inbox projection exposes only allowlisted canonical reply targets", () => {
  assert.equal(targetOfInboxEnvelope({ chat_id: "oc_peer" }), "chat:oc_peer");
  assert.equal(targetOfInboxEnvelope({ chat_id: "oc_group", thread_id: "omt_topic" }), "thread:oc_group:omt_topic");
  assert.equal(targetOfInboxEnvelope({ target: "dm:@cpeer" }), null);
  assert.equal(targetOfInboxEnvelope({ target: "#cgroup" }), null);
  assert.equal(targetOfInboxEnvelope({ target: "runtime:system" }), null);
});

test("events projection retains the exact check response data shape", () => {
  const events = [
    { message_id: "m1", seq: 4, target: "chat:oc_old" },
    { message_id: "m2", seq: 5, target: "thread:oc_room:omt_abcdefghijk" },
  ];
  assert.deepEqual(projectInboxEvents(events), {
    events,
    last_seen_msgId: "m2",
    last_seen_seq: 5,
    reply_target: "thread:oc_room:omt_abcdefghijk",
    pending_notice_ids: [],
    wake_reason: null,
    has_more: false,
  });
  assert.deepEqual(projectInboxEvents([]), {
    events: [], last_seen_msgId: null, last_seen_seq: null, reply_target: null,
    pending_notice_ids: [], wake_reason: null, has_more: false,
  });
});

test("state store preserves read-then-clear semantics without following inbox symlinks", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-store-"));
  const outside = path.join(root, "outside.ndjson");
  try {
    const store = createAgentStateStore(root, "cli_inboxA1");
    store.clearNdjson("inbox");
    assert.equal(fs.existsSync(store.paths.inbox), false, "clearing a missing inbox must not create it");
    store.appendNdjson("inbox", { message_id: "m1", chat_id: "oc_1" });
    store.appendNdjson("inbox", { message_id: "m2", chat_id: "oc_1" });
    assert.deepEqual(store.readNdjson("inbox").map((event) => event.message_id), ["m1", "m2"]);
    store.clearNdjson("inbox");
    assert.deepEqual(store.readNdjson("inbox"), []);
    assert.equal(fs.statSync(store.paths.inbox).mode & 0o777, 0o600);

    fs.writeFileSync(outside, '{"outside":true}\n');
    fs.rmSync(store.paths.inbox);
    fs.symlinkSync(outside, store.paths.inbox);
    assert.throws(() => store.clearNdjson("inbox"), /symlink/);
    assert.equal(fs.readFileSync(outside, "utf8"), '{"outside":true}\n');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("production events route uses typed storage and projection without moving its API boundary", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/agent/agent-transport.ts"), "utf8");
  assert.match(source, /stateStore\.pollInbox<InboxEnvelope>\(\)/);
  assert.match(source, /data: projectInboxEvents\(envelopes\)/);
  assert.match(source, /Inbox consumption rejected; persisted rows were left unchanged/);
  assert.doesNotMatch(source, /malformed\/unreadable inbox returns empty/);
  assert.match(source, /request: \(input: AgentTransportInput\) => handle\(input\)/);
  assert.match(source, /globalThis\.__LARKIN_AGENT_TRANSPORT/);
});
