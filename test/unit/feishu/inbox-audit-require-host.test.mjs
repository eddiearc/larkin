import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { INBOX_AUDIT_CADENCE_MS } from "../../../src/agent/inbox-audit-heartbeat.ts";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";
import { inboxAuditRegistryFile, readInboxAuditTargets } from "../../../dist/agent/missed-outbound-scan.mjs";

const CHAT = "oc_7961b9d7be893b46520a926b90cf46eb";
const testManagedCli = () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} });

test("Host ingest records only originally wake=true group traffic into the audit registry", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-host-"));
  const agentId = "cli_inboxAuditHostA1";
  const agent = {
    agentId, name: agentId, runtime: "codex", model: "gpt", feishuAppId: agentId,
    feishuAppSecret: "fixture-secret", feishuProfile: agentId, feishuDomain: "https://open.feishu.cn",
    workspaceDir: path.join(root, "agents", agentId), stateDir: path.join(root, "state", "agents", agentId),
    larkConfigDir: path.join(root, "state", "agents", agentId, "lark-cli-config"),
  };
  const env = {
    LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-inbox-audit-host",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]),
  };
  const runtimeHost = {
    subscribe() { return () => {}; },
    async start() {},
    async deliver() { return { status: "accepted" }; },
    async stop() {},
    async shutdown() {},
  };
  const host = createHostShell({
    env, runtimeHost, eventSourceStartDelayMs: 60_000,
    managedCliForAgent: testManagedCli,
    execFileImpl(_command, _args, _options, callback) {
      callback(null, JSON.stringify({ ok: true, data: { items: [{ member_id: "ou_human", name: "Human" }] } }), "");
      return {};
    },
  });
  const event = {
    chat_id: CHAT, chat_type: "group", sender_id: "ou_human", message_id: "om_unmentioned",
    event_id: "ev_unmentioned", content: "hello", thread_id: null,
    _mentioned_bot: false, _mention_all: false, _sender_is_bot: false, _scan_authority: true,
  };
  try {
    await host.ingest(agentId, event, { wake: false });
    assert.equal(readInboxAuditTargets(inboxAuditRegistryFile(root), agentId).targets.length, 0);
    await host.ingest(agentId, { ...event, message_id: "om_mentioned", event_id: "ev_mentioned" }, { wake: true });
    const audit = readInboxAuditTargets(inboxAuditRegistryFile(root), agentId);
    assert.deepEqual(audit.targets.map((row) => row.anchor), ["om_mentioned"]);
    assert.equal(audit.targets[0].target, `chat:${CHAT}`);
  } finally {
    await host.shutdown("cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function inboxRows(root, agentId) {
  const file = path.join(root, "state", "agents", agentId, "feishu-inbox.ndjson");
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

async function waitFor(predicate, label, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(label);
}

test("Host channel decideWake persists Inbox then Host heartbeat wakes only the sibling with a retained target", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-host-timer-"));
  const eligibleId = "cli_inboxAuditWakeA1";
  const siblingId = "cli_inboxAuditWakeB2";
  const agentFor = (agentId) => ({
    agentId, name: agentId, runtime: "codex", model: "gpt", feishuAppId: agentId,
    feishuAppSecret: "fixture-secret", feishuProfile: agentId, feishuDomain: "https://open.feishu.cn",
    workspaceDir: path.join(root, "agents", agentId), stateDir: path.join(root, "state", "agents", agentId),
    larkConfigDir: path.join(root, "state", "agents", agentId, "lark-cli-config"),
  });
  const env = {
    LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-inbox-audit-host-timer",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agentFor(eligibleId), agentFor(siblingId)]),
    LARKIN_INBOUND_DROUGHT_SEC: "0",
  };
  const deliveries = [];
  const runtimeHost = {
    subscribe() { return () => {}; },
    async start() {},
    async deliver(agentId, envelope) {
      deliveries.push({ agentId, envelope });
      return { status: "accepted" };
    },
    async stop() {},
    async shutdown() {},
  };
  const handlersByApp = new Map();
  const channelPackage = {
    createLarkChannel(options) {
      const channel = {
        botIdentity: { openId: `ou_${options.appId}`, name: options.appId },
        rawClient: { async request() { return { bot: { open_id: `ou_${options.appId}`, app_name: options.appId } }; } },
        dispatcher: { register() {} },
        on(handlers) { handlersByApp.set(options.appId, handlers); },
        async connect() {},
        async disconnect() {},
      };
      return channel;
    },
  };
  const auditTimers = [];
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === INBOX_AUDIT_CADENCE_MS) {
      const handle = { callback, delay, unref() {} };
      auditTimers.push(handle);
      return handle;
    }
    return realSetTimeout(callback, delay, ...args);
  };
  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === "object" && handle.delay === INBOX_AUDIT_CADENCE_MS) return;
    return realClearTimeout(handle);
  };
  const host = createHostShell({
    env, runtimeHost, channelPackage, eventSourceStartDelayMs: 0,
    managedCliForAgent: testManagedCli,
    execFileImpl(_command, _args, _options, callback) {
      callback(null, JSON.stringify({ ok: true, data: { items: [{ member_id: "ou_human", name: "Human" }] } }), "");
      return {};
    },
  });
  try {
    await host.start();
    await waitFor(() => handlersByApp.size === 2, "Host-installed channels did not register");
    assert.equal(auditTimers.length, 1, "Host must install one inbox-audit timer at the production cadence");
    assert.equal(auditTimers[0].delay, INBOX_AUDIT_CADENCE_MS);

    handlersByApp.get(eligibleId).message({
      chatId: CHAT, chatType: "group", senderId: "ou_human", messageId: "om_mentioned",
      content: "hello @bot", mentionedBot: true, senderIsBot: false,
    });
    handlersByApp.get(siblingId).message({
      chatId: CHAT, chatType: "group", senderId: "ou_human", messageId: "om_quiet",
      content: "ordinary context", mentionedBot: false, senderIsBot: false,
    });

    await waitFor(() => inboxRows(root, eligibleId).some((row) => row.message_id === "om_mentioned")
      && inboxRows(root, siblingId).some((row) => row.message_id === "om_quiet"),
    "channel decideWake did not persist durable Inbox");

    const registry = inboxAuditRegistryFile(root);
    assert.deepEqual(readInboxAuditTargets(registry, eligibleId).targets.map((row) => row.anchor), ["om_mentioned"]);
    assert.equal(readInboxAuditTargets(registry, siblingId).targets.length, 0);
    assert.equal(inboxRows(root, siblingId).some((row) => row.message_id === "om_quiet"), true);
    const inbound = deliveries.filter((row) => row.envelope?.kind !== "reminder");
    assert.deepEqual(inbound.map((row) => row.agentId), [eligibleId]);

    await auditTimers[0].callback();
    const reminders = deliveries.filter((row) => row.envelope?.kind === "reminder" || row.envelope?.target === "runtime:reminder");
    assert.deepEqual(reminders.map((row) => row.agentId), [eligibleId]);
    assert.equal(reminders.length, 1);
    assert.equal(reminders[0].envelope.kind, "reminder");
    assert.equal(reminders[0].envelope.target, "runtime:reminder");
    assert.equal(inboxRows(root, siblingId).some((row) => row.kind === "reminder"), false);
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    await host.shutdown("cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
