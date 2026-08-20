import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { documentCommentMessageId } from "../../../dist/feishu/document-comment.mjs";
import { createTelemetryRuntime } from "../../../dist/platform/telemetry-tracing.mjs";
import { TelemetrySpool } from "../../../dist/platform/telemetry-spool.mjs";
import { runLarkCli } from "../../../dist/app/lark-cli.mjs";

const waitFor = async (predicate, timeout = 2_000) => {
  const deadline = Date.now() + timeout;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(Boolean(predicate()), true, "condition was not reached before timeout");
};

function writePolicyConfig(root, agentId, { globalPolicy = "require", agentPolicy, chatMentionPolicies } = {}) {
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-document-policy", mentionPolicy: globalPolicy, activeAgent: agentId,
    agents: { [agentId]: {
      runtime: "codex", model: "default",
      ...(agentPolicy ? { mentionPolicy: agentPolicy } : {}),
      ...(chatMentionPolicies ? { chatMentionPolicies } : {}),
    } },
  })}\n`, { mode: 0o600 });
}

function writeCommentSubscription(root, agentId) {
  const bots = path.join(root, "bots");
  fs.mkdirSync(bots, { recursive: true, mode: 0o700 });
  const file = path.join(bots, `${agentId}.json`);
  fs.writeFileSync(file, `${JSON.stringify({
    appId: agentId, appSecret: "fixture-secret", tenant: "feishu",
    capabilities: { documentCommentSubscription: {
      mode: "subscribed", status: "platform-verified", source: "platform-status", dimension: "application",
      requestedAt: "2026-08-05T00:00:00.000Z", verifiedAt: "2026-08-05T00:01:00.000Z",
    } },
  })}\n`, { mode: 0o600 });
}

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
  writePolicyConfig(root, agentId, { globalPolicy: "require" });
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
    assert.deepEqual([
      inbox[0].comment_subscription_mode, inbox[0].comment_subscription_status,
      inbox[0].comment_subscription_source, inbox[0].comment_subscription_dimension, inbox[0].mentioned_bot,
    ], ["none", "safe-default", "legacy-default", null, true]);
    assert.equal(inbox[0].target, "document-comment:docx:doc_token:comment_new:in-thread");
    assert.equal(inbox[0].content, "please review this");
    assert.equal(inbox[0].chat_id, undefined, "document comments must not masquerade as IM targets");
  } finally {
    await shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function recoveryFixture(root, { fetchImpl, failInbox = () => false, logs = [], telemetry } = {}) {
  const agentId = "cli_documentRecoveryA1";
  const agent = {
    agentId, name: agentId, runtime: "codex", model: "default", feishuAppId: agentId,
    feishuAppSecret: "fixture-secret", feishuProfile: agentId, feishuDomain: "https://open.feishu.cn",
    larkConfigDir: path.join(root, "lark-cli"), workspaceDir: path.join(root, "agents", agentId),
    stateDir: path.join(root, "state", "agents", agentId),
  };
  if (!fs.existsSync(path.join(root, "config.json"))) writePolicyConfig(root, agentId);
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
      const operation = async () => {
        deliveries.push(envelope);
        realStore.writeJson("runtimeDeliveries", {
          version: 1, records: [{ deliveryId: `delivery-${envelope.message_id}`, messageId: envelope.message_id, status: "accepted" }],
        });
        return { status: "accepted", deliveryId: `delivery-${envelope.message_id}` };
      };
      const receipt = telemetry ? await telemetry.phase(envelope.message_id, "runtime.deliver", 3, operation) : await operation();
      telemetry?.delivery(agentId, envelope.message_id, "accepted");
      telemetry?.runtimeEvent(agentId, { type: "turn-start" });
      return receipt;
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
    ...(telemetry ? { telemetry } : {}),
  });
  return { shell, get channel() { return channel; }, store: realStore, deliveries };
}

test("document comment Mock workflow traces safe rejection, pending replay, Inbox wake, Runtime turn, and same-thread reply", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-telemetry-"));
  fs.chmodSync(root, 0o700);
  const agentId = "cli_documentRecoveryA1";
  const telemetryConfig = { spoolDir: path.join(root, "telemetry", "spool"), headers: {},
    maxBytes: 1024 * 1024, maxFiles: 100, maxAgeMs: 60_000, uploadIntervalMs: 60_000, requestTimeoutMs: 2_000 };
  const stateDir = path.join(root, "state", "agents", agentId);
  const telemetry = createTelemetryRuntime(telemetryConfig, { stateDirFor: () => stateDir });
  let failFetch = true;
  const fixture = recoveryFixture(root, { telemetry, fetchImpl: async () => {
    if (failFetch) throw new Error("FORBIDDEN_PROVIDER_ERROR doc_private_token");
    return recoveredComment;
  } });
  try {
    await fixture.shell.start();
    await waitFor(() => fixture.channel?.handlers);

    await fixture.channel.handlers.comment({
      ...recoveryEvent, commentId: "comment_rejected_private", replyId: "reply_rejected_private", mentionedBot: false,
      raw: { event_id: "evt_rejected_private", notice_type: "add_reply" },
    });
    assert.equal(fixture.deliveries.length, 0, "none + unmentioned must not wake Runtime");

    writeCommentSubscription(root, agentId);
    await fixture.channel.handlers.comment({ ...recoveryEvent, mentionedBot: false });
    assert.equal(fixture.deliveries.length, 0);
    assert.equal(Object.keys(fixture.store.readJson("documentComments", { items: {} }).items).length, 1);
    failFetch = false;
    fixture.channel.handlers.reconnected();
    await waitFor(() => fixture.deliveries.length === 1);
    const [envelope] = fixture.deliveries;
    const target = envelope.target;
    fixture.store.pollInbox({ target, limit: 1 });

    const output = { stdout: "", stderr: "" }; const nativeCalls = [];
    const cliDependencies = {
        telemetry, stateStore: fixture.store,
        io: { stdout: (text) => { output.stdout += text; }, stderr: (text) => { output.stderr += text; } },
        nativeCommand: { command: process.execPath, argsPrefix: ["/fixed/@larksuite/cli/scripts/run.js"], version: "1.0.80" },
        spawn: (command, args, options) => {
          nativeCalls.push({ command, args, options });
          return { status: 0, signal: null, output: [], pid: 1, stdout: "{\"ok\":true}\n", stderr: "", error: undefined };
        },
      };
    const code = runLarkCli(["comment", "reply", "--message-id", envelope.message_id, "--text", "FORBIDDEN_REPLY_BODY", "--json"],
      { LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId }, cliDependencies);
    assert.equal(code, 0, output.stderr);
    assert.equal(nativeCalls.length, 1, "fixture must exercise the real locator-bound reply path once without Feishu I/O");
    const followUp = runLarkCli(["comment", "reply", "--message-id", envelope.message_id, "--text", "FORBIDDEN_CHANGED_BODY", "--json"],
      { LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId }, cliDependencies);
    assert.equal(followUp, 0, output.stderr);
    assert.equal(nativeCalls.length, 2, "a different body appends a follow-up on the same locator");
    telemetry.runtimeEvent(agentId, { type: "turn-end" });
    await telemetry.shutdown();

    const records = new TelemetrySpool(telemetryConfig).list();
    const spans = records.flatMap(({ payload }) => payload.resourceSpans)
      .flatMap((resource) => resource.scopeSpans).flatMap((scope) => scope.spans);
    const rejectedRoot = spans.find((span) => span.name === "larkin.message.process"
      && span.attributes.some((attribute) => attribute.key === "larkin.filter.reason"));
    assert.ok(rejectedRoot);
    assert.equal(spans.some((span) => span.traceId === rejectedRoot.traceId && span.name === "agent.turn"), false);
    const turn = spans.find((span) => span.name === "agent.turn");
    assert.ok(turn);
    const acceptedNames = new Set(spans.filter((span) => span.traceId === turn.traceId).map((span) => span.name));
    for (const name of ["document.comment.receive", "document.comment.gate", "document.comment.pending", "document.comment.replay",
      "document.comment.resolve", "document.comment.inbox", "runtime.deliver", "agent.turn", "document.comment.reply"]) {
      assert.ok(acceptedNames.has(name), `missing ${name}`);
    }
    const replies = spans.filter((span) => span.name === "document.comment.reply");
    assert.equal(replies.length, 2);
    assert.ok(replies.every((reply) => reply.parentSpanId === turn.spanId));
    assert.deepEqual(replies.map((reply) => reply.attributes.find((attribute) => attribute.key === "larkin.operation.outcome")?.value?.stringValue).sort(), ["success", "success"]);
    assert.equal(replies.filter((reply) => reply.status.code === 2).length, 0);
    const serialized = JSON.stringify(records);
    for (const forbidden of ["doc_private_token", "comment_private", "reply_private", "ou_recovery_human", "FORBIDDEN_PROVIDER_ERROR",
      "FORBIDDEN_REPLY_BODY", "FORBIDDEN_CHANGED_BODY", "/fixed/", stateDir]) assert.equal(serialized.includes(forbidden), false, forbidden);
  } finally {
    await telemetry.shutdown().catch(() => {});
    await fixture.shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

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

test("document comments use hot verified subscription state and never consult IM mention policies", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-mention-policy-"));
  fs.chmodSync(root, 0o700);
  const agentId = "cli_documentRecoveryA1";
  writePolicyConfig(root, agentId, { globalPolicy: "require", chatMentionPolicies: { oc_document_fake: "free" } });
  let fetches = 0;
  const fixture = recoveryFixture(root, { fetchImpl: async (_target, commentId) => {
    fetches += 1;
    return { ...recoveredComment, commentId };
  } });
  const unmentioned = (suffix) => ({
    ...recoveryEvent,
    commentId: `comment_policy_${suffix}`,
    mentionedBot: false,
    raw: { event_id: `evt_policy_${suffix}`, notice_type: "add_reply" },
  });
  try {
    await fixture.shell.start();
    await waitFor(() => fixture.channel?.handlers);

    await fixture.channel.handlers.comment(unmentioned("global_require"));
    assert.equal(fetches, 0, "safe default must ignore an unmentioned comment regardless of chat policy");

    writePolicyConfig(root, agentId, { globalPolicy: "free", chatMentionPolicies: { oc_document_fake: "require" } });
    writeCommentSubscription(root, agentId);
    const globalFreeEvent = unmentioned("global_free");
    await fixture.channel.handlers.comment(globalFreeEvent);
    await fixture.channel.handlers.comment({
      ...globalFreeEvent, raw: { event_id: "evt_policy_global_free_redelivery", notice_type: "add_reply" },
    });
    assert.equal(fixture.deliveries.length, 1);
    assert.equal(fixture.store.readNdjson("inbox").filter((row) => row.comment_id === globalFreeEvent.commentId).length, 1,
      "free unmentioned redelivery must still produce exactly one canonical wake");
    assert.deepEqual([
      fixture.deliveries[0].comment_subscription_mode,
      fixture.deliveries[0].comment_subscription_status,
      fixture.deliveries[0].comment_subscription_dimension,
      fixture.deliveries[0].mentioned_bot,
    ], ["subscribed", "platform-verified", "application", false]);

    writePolicyConfig(root, agentId, { globalPolicy: "require", agentPolicy: "free", chatMentionPolicies: { oc_document_fake: "require" } });
    await fixture.channel.handlers.comment(unmentioned("agent_free"));
    assert.equal(fixture.deliveries.length, 2);
    assert.deepEqual([
      fixture.deliveries[1].comment_subscription_mode,
      fixture.deliveries[1].comment_subscription_status,
      fixture.deliveries[1].mentioned_bot,
    ], ["subscribed", "platform-verified", false]);

    writePolicyConfig(root, agentId, { globalPolicy: "free", agentPolicy: "require", chatMentionPolicies: { oc_document_fake: "free" } });
    await fixture.channel.handlers.comment(unmentioned("agent_require"));
    assert.equal(fixture.deliveries.length, 3, "verified subscription must ignore global, Agent, and chat IM policies");
    assert.equal(fixture.store.readNdjson("inbox").filter((row) => row.kind === "document_comment").length, 3);
  } finally {
    await fixture.shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("comment fetch failure persists a private pending locator and reconnect replay wakes only after canonical Inbox append", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-fetch-recovery-"));
  fs.chmodSync(root, 0o700);
  writePolicyConfig(root, "cli_documentRecoveryA1", { globalPolicy: "free" });
  writeCommentSubscription(root, "cli_documentRecoveryA1");
  let failFetch = true;
  const logs = [];
  const fixture = recoveryFixture(root, { logs, fetchImpl: async () => {
    if (failFetch) throw new Error("provider failure containing private comment body");
    return recoveredComment;
  } });
  try {
    await fixture.shell.start();
    await waitFor(() => fixture.channel?.handlers);
    await fixture.channel.handlers.comment({ ...recoveryEvent, mentionedBot: false });
    assert.equal(fixture.deliveries.length, 0);
    assert.equal(fixture.store.readNdjson("inbox").length, 0);
    const pending = fixture.store.readJson("documentComments", { items: {} });
    assert.equal(Object.keys(pending.items).length, 1);
    assert.equal(JSON.stringify(pending).includes("private comment body"), false);
    assert.equal(fs.statSync(fixture.store.paths.documentComments).mode & 0o777, 0o600);
    assert.equal(fixture.store.readJson("status", {}).documentCommentLastErrorCategory, "read_failure_unknown");
    writePolicyConfig(root, "cli_documentRecoveryA1", { globalPolicy: "require" });
    failFetch = false;
    fixture.channel.handlers.reconnected();
    await waitFor(() => fixture.deliveries.length === 1);
    assert.equal(fixture.store.readNdjson("inbox").length, 1);
    assert.deepEqual([
      fixture.deliveries[0].comment_subscription_mode,
      fixture.deliveries[0].comment_subscription_status,
      fixture.deliveries[0].mentioned_bot,
    ], ["subscribed", "platform-verified", false], "replay must preserve the original accepted subscription decision");
    assert.equal(Object.keys(fixture.store.readJson("documentComments", { items: {} }).items).length, 0);
    assert.doesNotMatch(logs.join("\n"), /doc_private_token|private comment body|selected private quote/);
  } finally {
    await fixture.shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("same-process semantic redelivery uses the already-durable acceptance decision after policy changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-semantic-redelivery-"));
  fs.chmodSync(root, 0o700);
  const agentId = "cli_documentRecoveryA1";
  writePolicyConfig(root, agentId, { globalPolicy: "require" });
  let fetches = 0;
  const fixture = recoveryFixture(root, { fetchImpl: async () => {
    fetches += 1;
    if (fetches === 1) throw new Error("temporary provider failure");
    return recoveredComment;
  } });
  try {
    await fixture.shell.start();
    await waitFor(() => fixture.channel?.handlers);
    await fixture.channel.handlers.comment(recoveryEvent);
    const pending = fixture.store.readJson("documentComments", { items: {} });
    const [durable] = Object.values(pending.items);
    assert.deepEqual([
      durable.subscriptionMode,
      durable.subscriptionStatus,
      durable.mentionedBot,
    ], ["none", "safe-default", true]);

    writePolicyConfig(root, agentId, { globalPolicy: "free" });
    await fixture.channel.handlers.comment({
      ...recoveryEvent,
      mentionedBot: false,
      raw: { event_id: "evt_recovery_semantic_redelivery", notice_type: "add_reply" },
    });

    assert.equal(fetches, 2);
    assert.equal(fixture.deliveries.length, 1);
    assert.deepEqual([
      fixture.deliveries[0].comment_subscription_mode,
      fixture.deliveries[0].comment_subscription_status,
      fixture.deliveries[0].mentioned_bot,
    ], ["none", "safe-default", true], "redelivery must process the durable record instead of newly resolved subscription state");
    assert.equal(Object.keys(fixture.store.readJson("documentComments", { items: {} }).items).length, 0);
    assert.equal(fixture.store.readNdjson("inbox").length, 1);
  } finally {
    await fixture.shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent semantic redelivery joins one pending processor and cannot duplicate Runtime delivery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-concurrent-redelivery-"));
  fs.chmodSync(root, 0o700);
  let fetches = 0;
  let releaseFetch;
  const fixture = recoveryFixture(root, { fetchImpl: async () => {
    fetches += 1;
    return new Promise((resolve) => { releaseFetch = () => resolve(recoveredComment); });
  } });
  try {
    await fixture.shell.start();
    await waitFor(() => fixture.channel?.handlers);
    const first = fixture.channel.handlers.comment(recoveryEvent);
    await waitFor(() => fetches === 1 && typeof releaseFetch === "function");
    const second = fixture.channel.handlers.comment({
      ...recoveryEvent,
      raw: { event_id: "evt_recovery_concurrent_redelivery", notice_type: "add_reply" },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(fetches, 1, "semantic redelivery must join the existing in-flight processor");
    releaseFetch();
    await Promise.all([first, second]);
    assert.equal(fixture.deliveries.length, 1);
    assert.equal(fixture.store.readNdjson("inbox").length, 1);
    assert.equal(Object.keys(fixture.store.readJson("documentComments", { items: {} }).items).length, 0);
  } finally {
    releaseFetch?.();
    await fixture.shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("v3 pending upgrade drops rows with legacy IM-policy metadata and retains bounded valid recovery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-pending-v1-upgrade-"));
  fs.chmodSync(root, 0o700);
  let fetches = 0;
  const fixture = recoveryFixture(root, { fetchImpl: async () => {
    fetches += 1;
    throw new Error("keep valid recovery pending");
  } });
  const messageId = documentCommentMessageId("cli_documentRecoveryA1", recoveryEvent);
  const valid = {
    messageId,
    fileToken: recoveryEvent.fileToken,
    fileType: recoveryEvent.fileType,
    commentId: recoveryEvent.commentId,
    replyId: recoveryEvent.replyId,
    operatorOpenId: recoveryEvent.operator.openId,
    timestamp: recoveryEvent.timestamp,
    noticeType: "add_reply",
    subscriptionMode: "none",
    subscriptionStatus: "safe-default",
    subscriptionSource: "legacy-default",
    subscriptionDimension: null,
    mentionedBot: true,
    queuedAt: "2026-08-05T00:00:00.000Z",
  };
  const staleId = `doc_comment_${"f".repeat(32)}`;
  fixture.store.writeJson("documentComments", {
    version: 1,
    items: {
      [staleId]: {
        ...valid, messageId: staleId,
        subscriptionMode: undefined, subscriptionStatus: undefined, subscriptionSource: undefined, subscriptionDimension: undefined,
        mentionPolicy: "free", mentionPolicySource: "global",
      },
      [messageId]: valid,
    },
  });
  try {
    await fixture.shell.start();
    await waitFor(() => fetches === 1);
    const upgraded = fixture.store.readJson("documentComments", { items: {} });
    assert.equal(upgraded.version, 3);
    assert.deepEqual(Object.keys(upgraded.items), [messageId]);
    assert.deepEqual([
      upgraded.items[messageId].subscriptionMode,
      upgraded.items[messageId].subscriptionStatus,
      upgraded.items[messageId].mentionedBot,
    ], ["none", "safe-default", true]);
    assert.equal(Object.keys(upgraded.items).length <= 256, true);
    assert.equal(fs.statSync(fixture.store.paths.documentComments).mode & 0o777, 0o600);
  } finally {
    await fixture.shell.shutdown("test");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("restart drops a forged v3 none-mode unmentioned row before fetch or Runtime delivery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-document-forged-pending-"));
  fs.chmodSync(root, 0o700);
  let fetches = 0;
  const fixture = recoveryFixture(root, { fetchImpl: async () => { fetches += 1; return recoveredComment; } });
  const forgedEvent = {
    ...recoveryEvent, commentId: "comment_forged_unmentioned", mentionedBot: false,
    raw: { event_id: "evt_forged_unmentioned", notice_type: "add_reply" },
  };
  const messageId = documentCommentMessageId("cli_documentRecoveryA1", forgedEvent);
  fixture.store.writeJson("documentComments", { version: 3, items: { [messageId]: {
    messageId, fileToken: forgedEvent.fileToken, fileType: forgedEvent.fileType, commentId: forgedEvent.commentId,
    replyId: forgedEvent.replyId, operatorOpenId: forgedEvent.operator.openId, timestamp: forgedEvent.timestamp,
    noticeType: "add_reply", subscriptionMode: "none", subscriptionStatus: "safe-default",
    subscriptionSource: "legacy-default", subscriptionDimension: null, mentionedBot: false,
    queuedAt: "2026-08-05T00:00:00.000Z",
  } } });
  try {
    await fixture.shell.start();
    await waitFor(() => fixture.channel?.handlers);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(fetches, 0);
    assert.equal(fixture.deliveries.length, 0);
    assert.deepEqual(fixture.store.readJson("documentComments", { items: {} }), { version: 3, items: {} });
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
      noticeType: "add_reply", subscriptionMode: "none", subscriptionStatus: "safe-default",
      subscriptionSource: "legacy-default", subscriptionDimension: null, mentionedBot: true,
      queuedAt: "2026-08-05T00:00:00.000Z",
    };
  }
  try {
    await fixture.shell.start();
    await waitFor(() => fixture.channel?.handlers);
    fixture.store.writeJson("documentComments", { version: 3, items });
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
