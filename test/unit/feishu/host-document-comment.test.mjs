import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";

const waitFor = async (predicate, timeout = 2_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(Boolean(predicate()), true, "condition was not reached before timeout");
};

test("production Host comment wiring persists one semantic Inbox wake and fails closed on non-mentions/self/duplicates", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-comment-host-"));
  fs.chmodSync(root, 0o700);
  const agentId = "cli_documentCommentA1";
  const agent = {
    agentId, name: agentId, runtime: "codex", model: "default", feishuAppId: agentId,
    feishuAppSecret: "fixture-secret", feishuProfile: agentId, feishuDomain: "https://open.feishu.cn",
    larkConfigDir: path.join(root, "lark-cli"), workspaceDir: path.join(root, "agents", agentId),
    stateDir: path.join(root, "state", "agents", agentId),
  };
  const deliveries = [];
  const store = createAgentStateStore(root, agentId);
  const runtimeHost = {
    subscribe() { return () => {}; }, async start() {}, async stop() {}, async shutdown() {},
    async deliver(_agentId, envelope) {
      deliveries.push(envelope);
      store.writeJson("runtimeDeliveries", {
        version: 1, records: [{ deliveryId: `delivery-${envelope.message_id}`, messageId: envelope.message_id, status: "accepted" }],
      });
      return { status: "accepted", deliveryId: `delivery-${envelope.message_id}` };
    },
  };
  let channel;
  let fetches = 0;
  const channelPackage = { createLarkChannel(options) {
    channel = {
      options, handlers: null, registrations: {}, botIdentity: { openId: "ou_document_bot", name: "Document Bot" },
      rawClient: { async request() { return { bot: { open_id: "ou_document_bot", app_name: "Document Bot" } }; } },
      comments: {
        async resolveTarget(fileToken, fileType) { return ["doc", "docx", "sheet", "file"].includes(fileType) ? { fileToken, fileType } : null; },
        async fetch(_target, commentId) {
          fetches += 1;
          return { commentId, quote: "selected", isWhole: false, replies: [{
            reply_id: "reply_new", content: { elements: [{ type: "text_run", text_run: { text: "please review this" } }] },
          }] };
        },
      },
      dispatcher: { register(map) { Object.assign(channel.registrations, map); } },
      on(handlers) { channel.handlers = handlers; }, async connect() {}, async disconnect() {}, async updateCard() {},
    };
    return channel;
  } };
  const env = {
    ...process.env, LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-document-comment",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_INBOUND_DROUGHT_SEC: "0",
  };
  const shell = createHostShell({ env, runtimeHost, channelPackage, eventSourceStartDelayMs: 0 });
  try {
    await shell.start();
    await waitFor(() => channel?.handlers);
    assert.equal(channel.options.includeRawEvent, true, "raw event_id must be available for durable dedup");
    const base = {
      fileToken: "doc_token", fileType: "docx", commentId: "comment_new", replyId: "reply_new",
      operator: { openId: "ou_human" }, mentionedBot: true, timestamp: 1_786_000_000_000,
      raw: { event_id: "evt_doc_comment", notice_type: "add_reply" },
    };
    await channel.handlers.comment({ ...base, mentionedBot: false });
    await channel.handlers.comment({ ...base, operator: { openId: "ou_document_bot" } });
    assert.equal(fetches, 0);
    await channel.handlers.comment(base);
    await channel.handlers.comment({ ...base, raw: { event_id: "evt_doc_comment_redelivery", notice_type: "add_reply" } });
    assert.equal(deliveries.length, 1, "semantic locator + Runtime ledger must suppress redelivery even when event_id changes");
    const inbox = store.readNdjson("inbox");
    assert.equal(inbox.length, 1);
    assert.equal(inbox[0].kind, "document_comment");
    assert.equal(inbox[0].wake, true);
    assert.equal(inbox[0].target, "document-comment:docx:doc_token:comment_new:in-thread");
    assert.equal(inbox[0].content, "please review this");
    assert.equal(inbox[0].chat_id, undefined, "document comments must not masquerade as IM targets");
  } finally {
    await shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function recoveryFixture(root, { fetchImpl, failInbox = () => false, logs = [] } = {}) {
  const agentId = "cli_documentRecoveryA1";
  const agent = {
    agentId, name: agentId, runtime: "codex", model: "default", feishuAppId: agentId,
    feishuAppSecret: "fixture-secret", feishuProfile: agentId, feishuDomain: "https://open.feishu.cn",
    larkConfigDir: path.join(root, "lark-cli"), workspaceDir: path.join(root, "agents", agentId),
    stateDir: path.join(root, "state", "agents", agentId),
  };
  const realStore = createAgentStateStore(root, agentId);
  const wrappedStore = Object.create(realStore);
  wrappedStore.prepareInboxDelivery = (envelope) => {
    if (failInbox()) throw new Error("private fixture inbox failure");
    return realStore.prepareInboxDelivery(envelope);
  };
  const deliveries = [];
  const runtimeHost = {
    subscribe() { return () => {}; }, async start() {}, async stop() {}, async shutdown() {},
    async deliver(_agentId, envelope) {
      deliveries.push(envelope);
      realStore.writeJson("runtimeDeliveries", {
        version: 1, records: [{ deliveryId: `delivery-${envelope.message_id}`, messageId: envelope.message_id, status: "accepted" }],
      });
      return { status: "accepted", deliveryId: `delivery-${envelope.message_id}` };
    },
  };
  let channel;
  const channelPackage = { createLarkChannel() {
    channel = {
      handlers: null, registrations: {}, botIdentity: { openId: "ou_recovery_bot", name: "Recovery Bot" },
      rawClient: { async request() { return { bot: { open_id: "ou_recovery_bot", app_name: "Recovery Bot" } }; } },
      comments: {
        async resolveTarget(fileToken, fileType) { return { fileToken, fileType }; },
        fetch: fetchImpl,
      },
      dispatcher: { register(map) { Object.assign(channel.registrations, map); } },
      on(handlers) { channel.handlers = handlers; }, async connect() {}, async disconnect() {}, async updateCard() {},
    };
    return channel;
  } };
  const env = {
    ...process.env, LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-document-recovery",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_INBOUND_DROUGHT_SEC: "0",
  };
  const shell = createHostShell({
    env, runtimeHost, channelPackage, eventSourceStartDelayMs: 0,
    stateStoreForImpl: () => wrappedStore,
    logImpl: (...parts) => logs.push(parts.join(" ")),
  });
  return { shell, get channel() { return channel; }, store: realStore, deliveries };
}

const recoveryEvent = {
  fileToken: "doc_private_token", fileType: "docx", commentId: "comment_private", replyId: "reply_private",
  operator: { openId: "ou_recovery_human" }, mentionedBot: true, timestamp: 1_786_000_100_000,
  raw: { event_id: "evt_recovery", notice_type: "add_reply" },
};
const recoveredComment = {
  commentId: "comment_private", quote: "selected private quote", isWhole: false, replies: [{
    reply_id: "reply_private", content: { elements: [{ type: "text_run", text_run: { text: "private comment body" } }] },
  }],
};

test("comment fetch failure persists a private pending locator and reconnect replay wakes only after canonical Inbox append", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-fetch-recovery-"));
  fs.chmodSync(root, 0o700);
  let failFetch = true;
  const logs = [];
  const fixture = recoveryFixture(root, { logs, fetchImpl: async () => {
    if (failFetch) throw new Error("provider failure containing private comment body");
    return recoveredComment;
  } });
  try {
    await fixture.shell.start();
    await waitFor(() => fixture.channel?.handlers);
    await fixture.channel.handlers.comment(recoveryEvent);
    assert.equal(fixture.deliveries.length, 0);
    assert.equal(fixture.store.readNdjson("inbox").length, 0);
    const pending = fixture.store.readJson("documentComments", { items: {} });
    assert.equal(Object.keys(pending.items).length, 1);
    assert.equal(JSON.stringify(pending).includes("private comment body"), false);
    assert.equal(fs.statSync(fixture.store.paths.documentComments).mode & 0o777, 0o600);
    assert.equal(fixture.store.readJson("status", {}).documentCommentLastErrorCategory, "read_failure_unknown");
    failFetch = false;
    fixture.channel.handlers.reconnected();
    await waitFor(() => fixture.deliveries.length === 1);
    assert.equal(fixture.store.readNdjson("inbox").length, 1);
    assert.equal(Object.keys(fixture.store.readJson("documentComments", { items: {} }).items).length, 0);
    assert.doesNotMatch(logs.join("\n"), /doc_private_token|private comment body|selected private quote/);
  } finally {
    await fixture.shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("null or empty comment context is terminal, removed from recovery, and not replayed on reconnect or restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-terminal-comment-"));
  fs.chmodSync(root, 0o700);
  let fetches = 0;
  const first = recoveryFixture(root, { fetchImpl: async () => {
    fetches += 1;
    return { commentId: "comment_private", isWhole: false, replies: [] };
  } });
  let second;
  try {
    await first.shell.start();
    await waitFor(() => first.channel?.handlers);
    await first.channel.handlers.comment(recoveryEvent);
    assert.equal(fetches, 1);
    assert.equal(first.deliveries.length, 0);
    assert.equal(first.store.readNdjson("inbox").length, 0);
    assert.equal(Object.keys(first.store.readJson("documentComments", { items: {} }).items).length, 0);
    assert.deepEqual({
      category: first.store.readJson("status", {}).documentCommentLastErrorCategory,
      reason: first.store.readJson("status", {}).documentCommentLastError,
    }, { category: "comment_unavailable_or_empty", reason: "comment_unavailable_or_empty" });
    first.channel.handlers.reconnected();
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fetches, 1, "terminal comment must not replay on reconnect");
    await first.shell.shutdown("restart");
    let restartFetches = 0;
    second = recoveryFixture(root, { fetchImpl: async () => { restartFetches += 1; return recoveredComment; } });
    await second.shell.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(restartFetches, 0, "terminal comment must not survive into restart replay");
    assert.equal(second.deliveries.length, 0);
  } finally {
    await first.shell.shutdown("test");
    if (second) await second.shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pending saturation preserves all unresolved records and fails closed with a stable diagnostic", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-pending-capacity-"));
  fs.chmodSync(root, 0o700);
  let fetches = 0;
  const logs = [];
  const fixture = recoveryFixture(root, { logs, fetchImpl: async () => { fetches += 1; return recoveredComment; } });
  const items = {};
  for (let index = 0; index < 256; index += 1) {
    const messageId = `doc_comment_${index.toString(16).padStart(32, "0")}`;
    items[messageId] = {
      messageId, fileToken: `retained_${index}`, fileType: "docx", commentId: `comment_${index}`,
      replyId: `reply_${index}`, operatorOpenId: "ou_retained", timestamp: 1_786_001_000_000 + index,
      noticeType: "add_reply", queuedAt: "2026-08-05T00:00:00.000Z",
    };
  }
  try {
    await fixture.shell.start();
    await waitFor(() => fixture.channel?.handlers);
    fixture.store.writeJson("documentComments", { version: 1, items });
    await fixture.channel.handlers.comment(recoveryEvent);
    const retained = fixture.store.readJson("documentComments", { items: {} });
    assert.equal(Object.keys(retained.items).length, 256);
    assert.deepEqual(Object.keys(retained.items), Object.keys(items), "saturation must not evict unresolved work");
    assert.equal(JSON.stringify(retained).includes(recoveryEvent.fileToken), false, "rejected new locator must not expand private state");
    assert.equal(fetches, 0, "a locator without durable capacity must not fetch or wake");
    assert.equal(fixture.deliveries.length, 0);
    assert.deepEqual({
      category: fixture.store.readJson("status", {}).documentCommentLastErrorCategory,
      reason: fixture.store.readJson("status", {}).documentCommentLastError,
    }, { category: "pending_capacity_exhausted", reason: "pending_capacity_exhausted" });
    assert.equal(fs.statSync(fixture.store.paths.documentComments).mode & 0o777, 0o600);
    assert.doesNotMatch(logs.join("\n"), /doc_private_token|private comment body/);
  } finally {
    await fixture.shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("comment read failures classify only stable permission/access signals and retain pending recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-read-diagnostics-"));
  fs.chmodSync(root, 0o700);
  let failure = { response: { data: { code: 99991672 } } };
  const fixture = recoveryFixture(root, { fetchImpl: async () => { throw failure; } });
  try {
    await fixture.shell.start();
    await waitFor(() => fixture.channel?.handlers);
    for (const [nextFailure, expected] of [
      [{ response: { data: { code: 99991672 } } }, ["permission_missing", "required_scope_missing"]],
      [{ response: { status: 403, data: { code: 1069301 } } }, ["document_access_denied", "bot_document_access_denied"]],
      [new Error("opaque provider failure with private body"), ["read_failure_unknown", "provider_read_failed_unknown"]],
    ]) {
      failure = nextFailure;
      await fixture.channel.handlers.comment(recoveryEvent);
      const status = fixture.store.readJson("status", {});
      assert.deepEqual([status.documentCommentLastErrorCategory, status.documentCommentLastError], expected);
      assert.equal(Object.keys(fixture.store.readJson("documentComments", { items: {} }).items).length, 1);
    }
    assert.equal(fixture.deliveries.length, 0);
  } finally {
    await fixture.shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("canonical Inbox write failure retains pending comment until reconnect replay succeeds", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-inbox-recovery-"));
  fs.chmodSync(root, 0o700);
  let inboxFailure = true;
  const fixture = recoveryFixture(root, { fetchImpl: async () => recoveredComment, failInbox: () => inboxFailure });
  try {
    await fixture.shell.start();
    await waitFor(() => fixture.channel?.handlers);
    await fixture.channel.handlers.comment(recoveryEvent);
    assert.equal(fixture.deliveries.length, 0);
    assert.equal(fixture.store.readNdjson("inbox").length, 0);
    assert.equal(Object.keys(fixture.store.readJson("documentComments", { items: {} }).items).length, 1);
    inboxFailure = false;
    fixture.channel.handlers.reconnected();
    await waitFor(() => fixture.deliveries.length === 1);
    assert.equal(fixture.store.readNdjson("inbox").length, 1);
    assert.equal(Object.keys(fixture.store.readJson("documentComments", { items: {} }).items).length, 0);
  } finally {
    await fixture.shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Host restart replays a durable pending document comment without provider redelivery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-restart-recovery-"));
  fs.chmodSync(root, 0o700);
  const first = recoveryFixture(root, { fetchImpl: async () => { throw new Error("temporary read failure"); } });
  let second;
  try {
    await first.shell.start();
    await waitFor(() => first.channel?.handlers);
    await first.channel.handlers.comment(recoveryEvent);
    assert.equal(Object.keys(first.store.readJson("documentComments", { items: {} }).items).length, 1);
    await first.shell.shutdown("restart");
    second = recoveryFixture(root, { fetchImpl: async () => recoveredComment });
    await second.shell.start();
    await waitFor(() => second.deliveries.length === 1);
    assert.equal(second.store.readNdjson("inbox").length, 1);
    assert.equal(Object.keys(second.store.readJson("documentComments", { items: {} }).items).length, 0);
  } finally {
    await first.shell.shutdown("test");
    if (second) await second.shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
