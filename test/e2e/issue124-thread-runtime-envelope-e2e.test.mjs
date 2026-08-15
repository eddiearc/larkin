import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../dist/agent/agent-state-store.mjs";
import { runAgentCli } from "../../dist/app/agent-cli.mjs";
import { runLarkCli } from "../../dist/app/lark-cli.mjs";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { createHostShell } from "../../dist/feishu/host-shell.mjs";
import { createRuntimeHost } from "../../dist/runtime/runtime-host.mjs";

const testManagedCli = () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} });

class FakeRuntimeSession {
  sessionId = "issue124-runtime-session";
  listeners = new Set();
  prompts = [];
  steers = [];
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async prompt(input) { this.prompts.push(structuredClone(input)); return { status: "accepted", inputId: input.inputId }; }
  async busyInput(input) { this.steers.push(structuredClone(input)); return { status: "accepted", inputId: input.inputId }; }
  async cancel() {}
  async close() {}
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-issue124-boundary-"));
  const agentId = "cli_issue124BoundaryA1";
  const store = createAgentStateStore(root, agentId, {
    inspectProcess: (pid) => ({ ok: true, dead: false, startToken: `issue124-e2e-${pid}` }),
  });
  const agent = {
    agentId, name: agentId, runtime: "codex", model: "fixture", feishuAppId: agentId, feishuProfile: agentId,
    larkConfigDir: path.join(store.paths.root, "lark-cli-config"), workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root,
  };
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4, serverId: "server-issue124-boundary", mentionPolicy: "require", activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "fixture" } },
  })}\n`, { mode: 0o600 });
  const session = new FakeRuntimeSession();
  const runtimeEvents = [];
  const runtimeHost = createRuntimeHost({
    adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store, assertOfficialCliReady: () => {},
  });
  runtimeHost.subscribe((event) => runtimeEvents.push(event));
  const persistedObjects = [];
  const deliveredObjects = [];
  const append = store.appendCanonicalInboxOnce.bind(store);
  store.appendCanonicalInboxOnce = (value) => {
    const result = append(value);
    if (result.envelope) persistedObjects.push(result.envelope);
    return result;
  };
  const deliver = runtimeHost.deliver.bind(runtimeHost);
  runtimeHost.deliver = (id, envelope) => {
    deliveredObjects.push(envelope);
    return deliver(id, envelope);
  };
  const host = createHostShell({
    env: {
      LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-issue124-boundary",
      LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_FEISHU_DRYRUN: "1",
      LARKIN_FEISHU_EVENT_FILE: path.join(root, "events.ndjson"), LARKIN_INBOUND_DROUGHT_SEC: "0",
    },
    runtimeHost, stateStoreForImpl: () => store, managedCliForAgent: testManagedCli,
    eventSourceStartDelayMs: 60_000,
    execFileImpl(_command, args, _options, callback) {
      const data = args.includes("bots") ? { items: [] } : { items: [{ member_id: "ou_issue124_sender", name: "Sender" }] };
      callback(null, JSON.stringify({ ok: true, data }), "");
      return {};
    },
    logImpl() {},
  });
  return { root, agentId, store, session, runtimeHost, runtimeEvents, host, persistedObjects, deliveredObjects };
}

function inbound({ chatId, messageId, eventId, threadId, content, createTime }) {
  return {
    chat_id: chatId, chat_type: "group", sender_id: "ou_issue124_sender", message_id: messageId,
    event_id: eventId, content, create_time: createTime, thread_id: threadId,
    _mentioned_bot: true, _mention_all: false, _sender_is_bot: true,
  };
}

async function pollNative(root, agentId, store, target) {
  let stdout = "", stderr = "";
  const code = await runAgentCli(["inbox", "poll", "--target", target, "--limit", "1"], {
    LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId,
  }, { stateStore: store, io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } } });
  assert.equal(code, 0, stderr);
  return JSON.parse(stdout);
}

function nativeReply(root, agentId, store, source, replyInThread) {
  const providerCalls = [];
  let stdout = "", stderr = "";
  const argv = ["im", "+messages-reply", "--message-id", source.message_id, "--text", `reply-${source.message_id}`,
    ...(replyInThread ? ["--reply-in-thread"] : []), "--json"];
  const code = runLarkCli(argv, { LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId }, {
    stateStore: store,
    nativeCommand: { command: "/fixture/@larksuite/cli/scripts/run.js", argsPrefix: [], version: "1.0.80" },
    spawn(command, args, options) {
      if (args[0] === "api" && args[1] === "GET") return {
        status: 0, stdout: JSON.stringify({ ok: true, identity: "bot", data: { messages: [source] } }), stderr: "", error: undefined,
      };
      providerCalls.push({ command, args, options });
      return { status: 0, stdout: JSON.stringify({ ok: true, identity: "bot", data: {
        message_id: `om_reply_${source.message_id}`, chat_id: source.chat_id,
      } }), stderr: "", error: undefined };
    },
    io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
  });
  assert.equal(code, 0, stderr);
  assert.equal(providerCalls.length, 1);
  return { argv, provider: providerCalls[0], output: JSON.parse(stdout) };
}

test("issue #124 production boundary keeps one canonical envelope through thread/chat poll and reply payloads", { timeout: 20_000 }, async () => {
  const fx = fixture();
  const chatId = "oc_issue124_exact";
  const threadId = "omt_issue124_exact";
  const threadTarget = `thread:${chatId}:${threadId}`;
  const chatTarget = `chat:${chatId}`;
  const threadEvent = inbound({ chatId, threadId, messageId: "om_issue124_thread_anchor", eventId: "evt_issue124_thread",
    content: "thread request", createTime: "1786819560000" });
  const chatEvent = inbound({ chatId, threadId: null, messageId: "om_issue124_chat_anchor", eventId: "evt_issue124_chat",
    content: "chat request", createTime: "1786819561000" });
  try {
    await fx.host.start();
    await fx.host.ingest(fx.agentId, threadEvent);
    assert.equal(fx.persistedObjects.length, 1);
    assert.equal(fx.deliveredObjects.length, 1);
    assert.equal(fx.deliveredObjects[0], fx.persistedObjects[0], "HostShell must deliver the exact object returned by canonical persistence");
    const threadDisk = fx.store.readNdjson("inbox")[0];
    assert.deepEqual(threadDisk, fx.deliveredObjects[0]);
    assert.deepEqual({ target: threadDisk.target, chat_id: threadDisk.chat_id, thread_id: threadDisk.thread_id }, {
      target: threadTarget, chat_id: chatId, thread_id: threadId,
    });
    assert.equal(fx.session.prompts.length, 1);
    assert.match(fx.session.prompts[0].text, new RegExp(`Inbox changed for ${threadTarget}`));
    assert.equal(fx.runtimeEvents.some((event) => event.type === "delivery" && /invalid-target|target derivation failed/i.test(event.reason || "")), false);

    const threadPoll = await pollNative(fx.root, fx.agentId, fx.store, threadTarget);
    assert.equal(threadPoll.delivery, "direct_ack");
    assert.equal(threadPoll.at_most_once, true);
    assert.deepEqual(threadPoll.events.map((row) => row.message_id), [threadEvent.message_id]);
    assert.equal(threadPoll.reply_target, threadTarget);
    const threadReply = nativeReply(fx.root, fx.agentId, fx.store, {
      message_id: threadEvent.message_id, chat_id: chatId, thread_id: threadId,
      create_time: threadEvent.create_time, content: threadEvent.content,
    }, true);
    assert.ok(threadReply.provider.args.includes("--message-id"));
    assert.equal(threadReply.provider.args[threadReply.provider.args.indexOf("--message-id") + 1], threadEvent.message_id);
    assert.ok(threadReply.provider.args.includes("--reply-in-thread"));

    fx.session.emit({ type: "turn-start", turnId: "issue124-thread-turn" });
    fx.session.emit({ type: "turn-end", turnId: "issue124-thread-turn" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fx.session.prompts.length, 1, "consumed thread delivery must not retry at turn end");
    let records = fx.store.readJson("runtimeDeliveries", { records: [] }).records;
    assert.equal(records.filter((record) => record.messageId === threadEvent.message_id).length, 1);
    assert.equal(records.find((record) => record.messageId === threadEvent.message_id).status, "consumed");

    await fx.host.ingest(fx.agentId, threadEvent);
    assert.equal(fx.persistedObjects.length, 1, "duplicate event_id must not append a second canonical row");
    assert.equal(fx.deliveredObjects.length, 1, "duplicate event_id must not redeliver");

    await fx.host.ingest(fx.agentId, chatEvent);
    assert.equal(fx.deliveredObjects[1], fx.persistedObjects[1]);
    const chatDisk = fx.store.readNdjson("inbox")[0];
    assert.deepEqual(chatDisk, fx.deliveredObjects[1]);
    assert.deepEqual({ target: chatDisk.target, chat_id: chatDisk.chat_id, thread_id: chatDisk.thread_id }, {
      target: chatTarget, chat_id: chatId, thread_id: null,
    });
    assert.equal(fx.session.prompts.length, 2);
    assert.match(fx.session.prompts[1].text, new RegExp(`Inbox changed for ${chatTarget}`));

    const chatPoll = await pollNative(fx.root, fx.agentId, fx.store, chatTarget);
    assert.deepEqual(chatPoll.events.map((row) => row.message_id), [chatEvent.message_id]);
    assert.equal(chatPoll.reply_target, chatTarget);
    const chatReply = nativeReply(fx.root, fx.agentId, fx.store, {
      message_id: chatEvent.message_id, chat_id: chatId, thread_id: null,
      create_time: chatEvent.create_time, content: chatEvent.content,
    }, false);
    assert.equal(chatReply.provider.args.includes("--reply-in-thread"), false, "chat-level opposite case must not invent a thread reply");
    assert.equal(chatReply.provider.args[chatReply.provider.args.indexOf("--message-id") + 1], chatEvent.message_id);

    fx.session.emit({ type: "turn-start", turnId: "issue124-chat-turn" });
    fx.session.emit({ type: "turn-end", turnId: "issue124-chat-turn" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fx.session.prompts.length, 2);
    records = fx.store.readJson("runtimeDeliveries", { records: [] }).records;
    assert.equal(records.length, 2);
    assert.equal(records.every((record) => record.status === "consumed"), true);
    assert.equal(fx.runtimeEvents.filter((event) => event.type === "delivery" && event.status === "consumed").length, 2);
  } finally {
    await fx.host.shutdown("issue124 boundary complete");
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test("issue #124 poll racing between HostShell persistence and Runtime delivery closes ownership without a stale turn", { timeout: 10_000 }, async () => {
  const fx = fixture();
  const chatId = "oc_issue124_race";
  const target = `thread:${chatId}:omt_issue124_race`;
  const event = inbound({ chatId, threadId: "omt_issue124_race", messageId: "om_issue124_race", eventId: "evt_issue124_race",
    content: "race", createTime: "1786819562000" });
  const productionDeliver = fx.runtimeHost.deliver.bind(fx.runtimeHost);
  let poll;
  fx.runtimeHost.deliver = async (agentId, envelope) => {
    poll = await pollNative(fx.root, fx.agentId, fx.store, target);
    return productionDeliver(agentId, envelope);
  };
  try {
    await fx.host.start();
    await fx.host.ingest(fx.agentId, event);
    assert.deepEqual(poll.events.map((row) => row.message_id), [event.message_id]);
    assert.deepEqual(poll.consumed_delivery_ids, [], "the poll can win before Runtime ledger creation");
    assert.equal(fx.session.prompts.length, 0, "post-poll delivery must reconcile consumed canonical state before prompt");
    assert.deepEqual(fx.store.readNdjson("inbox"), []);
    const records = fx.store.readJson("runtimeDeliveries", { records: [] }).records;
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "consumed");
    assert.equal(fx.runtimeEvents.filter((runtimeEvent) => runtimeEvent.type === "delivery" && runtimeEvent.status === "consumed").length, 1);
  } finally {
    await fx.host.shutdown("issue124 poll race complete");
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});
