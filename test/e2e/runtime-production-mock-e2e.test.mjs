import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../dist/agent/agent-state-store.mjs";
import { runAgentCli } from "../../dist/app/agent-cli.mjs";
import { runLarkCli } from "../../dist/app/lark-cli.mjs";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { createHostShell, memberNamesFromPayloads } from "../../dist/feishu/host-shell.mjs";
import { createRuntimeHost } from "../../dist/runtime/runtime-host.mjs";
import { InteractionStateMachine } from "../../dist/agent/interaction-state-machine.mjs";

const testManagedCli = () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.79" }, env: {} });

function callbackValue(card, index = 0) {
  const button = card.body.elements.filter((item) => item.tag === "button")[index];
  return button.behaviors.find((behavior) => behavior.type === "callback").value;
}

class FakeNativeSession {
  listeners = new Set(); prompts = []; busyInputs = []; closes = []; sessionId;
  constructor(runtime) { this.sessionId = `${runtime}-session`; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async prompt(input) { this.prompts.push(input); return { status: "accepted", inputId: input.inputId }; }
  async busyInput(input) { this.busyInputs.push(input); return { status: "accepted", inputId: input.inputId }; }
  async cancel() {} async close(reason) { this.closes.push(reason); }
}

test("production HostShell fresh reset blocks issue-14 backlog, then preserves durable state and other Agents", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-production-reset-"));
  const ids = ["cli_resetMockA1", "cli_resetOtherA1"];
  const stores = new Map(ids.map((id) => [id, createAgentStateStore(root, id)]));
  const created = new Map(ids.map((id) => [id, []]));
  let onCreate = () => {};
  const adapter = { id: "codex", capabilities: {}, async createSession(input) {
    const list = created.get(input.agentId);
    const session = new FakeNativeSession("codex");
    session.sessionId = `${input.agentId}-session-${list.length + 1}`;
    list.push(session);
    onCreate(input, session);
    return session;
  } };
  const runtimeHost = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: (id) => stores.get(id), assertOfficialCliReady: () => {} });
  const agents = ids.map((agentId) => ({ agentId, name: agentId, runtime: "codex", model: "mock",
    feishuAppId: agentId, feishuProfile: agentId, feishuAppSecret: "fixture-secret",
    feishuDomain: "https://open.feishu.cn",
    larkConfigDir: path.join(root, "lark-cli-config"), workspaceDir: path.join(root, "agents", agentId),
    stateDir: path.join(root, "state", "agents", agentId) }));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ version: 3, serverId: "server-reset",
    activeAgent: ids[0], agents: Object.fromEntries(ids.map((id) => [id, { runtime: "codex", model: "mock" }])) }), { mode: 0o600 });
  fs.mkdirSync(path.join(root, "bots"), { recursive: true });
  fs.writeFileSync(path.join(root, "bots", `${ids[0]}.json`), JSON.stringify({ fixture: "credential-preserved" }), { mode: 0o600 });
  const host = createHostShell({ env: { LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-reset",
    LARKIN_AGENTS_CONFIG: JSON.stringify(agents), LARKIN_INBOUND_DROUGHT_SEC: "0" }, runtimeHost,
    stateStoreForImpl: (_root, id) => stores.get(id),
    managedCliForAgent: testManagedCli, eventSourceStartDelayMs: 60_000,
    channelPackage: { createLarkChannel() { throw new Error("event source must not start in reset fixture"); } } });
  try {
    await host.start();
    const connectedAt = new Date().toISOString();
    for (const [id, store] of stores) store.writeJson("status", { ...store.readJson("status", {}), connectedAt, connectedVia: "mock" });
    const target = stores.get(ids[0]);
    target.appendNdjson("conversation", { text: "preserve transcript" });
    target.writeJson("pendingReact", { items: [{ msgId: "om_eye", reactionId: "react_eye" }] });
    const issue14Bodies = ["consumed-body-must-not-replay", "remaining-body-must-stay-pending"];
    const issue14Receipts = [];
    for (const [index, messageId] of ["om_reset_partial_1", "om_reset_partial_2"].entries()) {
      const envelope = { message_id: messageId, target: "chat:oc_reset", content: issue14Bodies[index] };
      target.appendNdjson("inbox", envelope);
      issue14Receipts.push(await runtimeHost.deliver(ids[0], envelope));
    }
    assert.deepEqual(issue14Receipts.map((receipt) => receipt.status), ["accepted", "accepted"]);
    assert.equal(created.get(ids[0])[0].prompts.length + created.get(ids[0])[0].busyInputs.length, 2,
      "production RuntimeHost prompt/busy-input paths own both issue-14 deliveries before any poll");
    const transcriptBefore = target.readNdjson("conversation");
    const otherStateBefore = stores.get(ids[1]).readJson("agentState", {});
    const configBefore = fs.readFileSync(path.join(root, "config.json"));
    const credentialBefore = fs.readFileSync(path.join(root, "bots", `${ids[0]}.json`));
    const nonSessionBefore = target.readJson("pendingReact", {});
    await assert.rejects(host.resetSession("cli_unknownA1"), (error) => error.code === "unknown_agent");
    await assert.rejects(host.resetSession(ids[0]), (error) => error.code === "agent_busy");
    assert.equal(created.get(ids[0]).length, 1, "backlog refusal occurs before fresh Runtime creation");
    assert.equal(target.readNdjson("inbox").length, 2, "no-poll reset refusal preserves the full canonical backlog");
    const partial = target.pollInbox({ limit: 1 });
    assert.deepEqual(partial.envelopes.map((row) => row.message_id), ["om_reset_partial_1"]);
    assert.deepEqual(partial.consumedDeliveryIds, [issue14Receipts[0].deliveryId]);
    assert.deepEqual(target.readNdjson("inbox").map((row) => row.content), [issue14Bodies[1]],
      "partial consumption preserves the unpolled canonical backlog body");
    await assert.rejects(host.resetSession(ids[0]), (error) => error.code === "agent_busy");
    assert.equal(target.readNdjson("inbox").length, 1, "partial-poll reset refusal preserves the remaining backlog");
    const drained = target.pollInbox();
    assert.deepEqual(drained.envelopes.map((row) => row.message_id), ["om_reset_partial_2"]);
    assert.deepEqual(drained.consumedDeliveryIds, [issue14Receipts[1].deliveryId]);
    created.get(ids[0])[0].emit({ type: "turn-end", turnId: "issue-14-drained" });
    await new Promise((resolve) => setImmediate(resolve));
    const ledgerBefore = target.readJson("runtimeDeliveries", {});
    const reset = await host.resetSession(ids[0]);
    assert.equal(reset.readyForFreshScenario, true);
    assert.equal(reset.inboundObserved, false);
    assert.equal(created.get(ids[0]).length, 2);
    assert.deepEqual(created.get(ids[0])[0].closes, ["fresh session reset committed"]);
    assert.deepEqual(created.get(ids[1])[0].closes, []);
    assert.deepEqual(target.readNdjson("conversation"), transcriptBefore);
    assert.deepEqual(target.readJson("pendingReact", {}), nonSessionBefore);
    assert.deepEqual(target.readJson("runtimeDeliveries", {}), ledgerBefore);
    assert.deepEqual(fs.readFileSync(path.join(root, "config.json")), configBefore);
    assert.deepEqual(fs.readFileSync(path.join(root, "bots", `${ids[0]}.json`)), credentialBefore);
    assert.deepEqual(stores.get(ids[1]).readJson("agentState", {}), otherStateBefore);
    assert.equal(target.readNdjson("inbox").length, 0);
    assert.equal(created.get(ids[0])[1].prompts.length, 0, "consumed issue-14 ledger rows are not replayed into the fresh session");
    assert.equal(issue14Bodies.some((body) => JSON.stringify(created.get(ids[0])[1].prompts).includes(body)), false,
      "the fresh session never receives either drained body");

    const originalResetSession = runtimeHost.resetSession.bind(runtimeHost);
    runtimeHost.resetSession = async (agentId) => {
      const result = await originalResetSession(agentId);
      const status = target.readJson("status", {});
      target.writeJson("status", { ...status, runtimeReadiness: { runtime: "codex", state: "ready" },
        session: { ...(status.session || {}), turns: 1 } });
      return result;
    };
    const contaminated = await host.resetSession(ids[0], 0);
    assert.equal(contaminated.resetCommitted, true);
    assert.equal(contaminated.turns, 1);
    assert.equal(contaminated.runtimeReady, true);
    assert.equal(contaminated.readyForFreshScenario, false);
    assert.equal(contaminated.code, "fresh_scenario_contaminated");
    runtimeHost.resetSession = originalResetSession;

    onCreate = (input) => {
      if (input.agentId === ids[0]) target.writeJson("status", { ...target.readJson("status", {}), reconnectingAt: new Date().toISOString() });
    };
    const reconnectRace = await host.resetSession(ids[0], 0);
    assert.equal(reconnectRace.resetCommitted, true);
    assert.equal(reconnectRace.readyForFreshScenario, false);
    assert.equal(reconnectRace.code, "reset_timeout");
    target.writeJson("status", { ...target.readJson("status", {}), reconnectedAt: new Date(Date.now() + 1).toISOString() });
    onCreate = () => {};

    const originalWriteJson = target.writeJson.bind(target);
    target.writeJson = (key, value) => {
      if (key === "agentState") throw new Error("injected agent-state persistence failure");
      return originalWriteJson(key, value);
    };
    const persistenceFailure = await host.resetSession(ids[0], 0);
    assert.equal(persistenceFailure.resetCommitted, true);
    assert.equal(persistenceFailure.readyForFreshScenario, false);
    assert.equal(persistenceFailure.code, "state_persistence_failed");
    target.writeJson = originalWriteJson;
  } finally {
    await host.shutdown("reset Mock E2E complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("member parser accepts the real lark-cli 1.0.79 get/bots shapes", () => {
  assert.deepEqual(memberNamesFromPayloads([
    { ok: true, data: { items: [{ member_id: "ou_user", name: "User" }] } },
    { ok: true, data: { items: [{ bot_id: "cli_bot", bot_name: "Bot" }] } },
  ]), { ou_user: "User", cli_bot: "Bot" });
});

test("CardKit callback -> production HostShell -> durable Reflex -> Runtime -> CLI resolve -> card update", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-production-interaction-"));
  const agentId = "cli_mockInteractionA1";
  const workspaceDir = path.join(root, "agents", agentId);
  const stateDir = path.join(root, "state", "agents", agentId);
  const store = createAgentStateStore(root, agentId);
  const session = new FakeNativeSession("codex");
  const adapter = { id: "codex", capabilities: { busyInput: "direct" }, async createSession() { return session; } };
  const runtimeHost = createRuntimeHost({
    adapterFor: () => adapter,
    promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: () => store,
    assertOfficialCliReady: () => {},
  });
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    version: 3, serverId: "server-interaction", activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "mock" } },
  }), { mode: 0o600 });
  const agent = {
    agentId, name: agentId, runtime: "codex", model: "mock", feishuAppId: agentId, feishuProfile: agentId,
    feishuAppSecret: "fixture-secret", feishuDomain: "https://open.feishu.cn",
    larkConfigDir: path.join(root, "lark-cli-config"), workspaceDir, stateDir,
  };
  const machine = new InteractionStateMachine({ stateStore: store, agentId });
  const created = machine.create({
    expected_chat_id: "oc_interaction",
    definition: {
      schema_version: 1, initial_state: "pending", expires_in_seconds: 3600,
      audience: { open_ids: ["ou_operator"] },
      states: {
        pending: { title: "Mock", markdown: "Ready." }, processing: { title: "Mock", markdown: "Agent is processing." },
        done: { title: "Mock", markdown: "Done.", terminal: true }, failed: { title: "Mock", markdown: "Failed.", terminal: true },
      },
      actions: {
        act: {
          from: ["pending"], label: "Act", processing_state: "processing", success_state: "done", failure_state: "failed",
          reflex: { toast: "Accepted." }, agent: { instruction: "Resolve the production Mock E2E run." },
          result_schema: { properties: {}, required: [], additional_properties: false },
        },
      },
    },
  });
  const actionValue = callbackValue(created.card);
  let handlers;
  const updates = [];
  const channel = {
    botIdentity: { openId: "ou_bot", name: "Mock Bot" },
    rawClient: { async request() { return { bot: { open_id: "ou_bot", app_name: "Mock Bot" } }; } },
    on(value) { handlers = value; }, dispatcher: { register() {} }, async connect() {}, async disconnect() {},
    async updateCard(messageId, card) { updates.push({ messageId, card }); },
  };
  const hostShell = createHostShell({
    env: {
      LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-interaction",
      LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_INBOUND_DROUGHT_SEC: "0",
    },
    runtimeHost,
    managedCliForAgent: testManagedCli,
    eventSourceStartDelayMs: 0,
    channelPackage: { createLarkChannel() { return channel; } },
  });
  try {
    hostShell.start();
    for (let index = 0; !handlers && index < 100; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(handlers?.cardAction, "production HostShell must register cardAction on the existing channel");
    const response = await handlers.cardAction({
      messageId: "om_interaction_card", chatId: "oc_interaction", operator: { openId: "ou_operator", name: "Operator" },
      action: { tag: "button", value: actionValue }, raw: { header: { event_id: "evt_interaction_1" } },
    });
    assert.deepEqual(response.toast, { type: "info", content: "已受理，Agent 正在处理，完成后会更新卡片。" });
    for (let index = 0; (session.prompts.length < 1 || updates.length < 1) && index < 100; index += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(session.prompts.length, 1);
    assert.equal(updates.length, 1);
    assert.match(JSON.stringify(updates[0].card), /Agent 正在处理/);
    const run = machine.snapshot().runs[0];

    let stdout = "", stderr = "";
    const checkCode = runAgentCli(["inbox", "check"], { LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId }, {
      stateStore: store, io: { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } },
    });
    assert.equal(checkCode, 0, stderr);
    const checkedInbox = JSON.parse(stdout);
    assert.equal(checkedInbox.targets.find((target) => target.target === "chat:oc_interaction").pending_count, 1);
    assert.equal("events" in checkedInbox, false, "check remains content-light and non-destructive");
    stdout = ""; stderr = "";
    const pollCode = runAgentCli(["inbox", "poll", "--target", "chat:oc_interaction"], {
      LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId,
    }, { stateStore: store, io: { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } } });
    assert.equal(pollCode, 0, stderr);
    const polledInbox = JSON.parse(stdout);
    assert.equal(polledInbox.delivery, "direct_ack");
    assert.equal(polledInbox.events.filter((event) => event.interaction_run_id === run.run_id).length, 1);
    stdout = ""; stderr = "";
    const resolveCode = runAgentCli(["interaction", "resolve", "--run-id", run.run_id, "--expected-version", "2", "--status", "succeeded", "--summary", "Mock E2E completed"], {
      LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId,
    }, { stateStore: store, io: { stdout: (value) => { stdout += value; }, stderr: (value) => { stderr += value; } } });
    assert.equal(resolveCode, 0, stderr);
    for (let index = 0; updates.length < 2 && index < 100; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(updates.length, 2);
    assert.match(JSON.stringify(updates[1].card), /Mock E2E completed/);
    assert.equal(machine.get({ run_id: run.run_id }).instance.current_state, "done");
  } finally {
    await hostShell.shutdown("interaction mock e2e complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const runtime of ["codex", "claude", "pi"]) {
  test(`synthetic Feishu → production HostShell → fake ${runtime} → freshness-gated poll and send`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-production-${runtime}-`));
    const agentId = `cli_mock${runtime[0].toUpperCase()}A1`;
    const workspaceDir = path.join(root, "agents", agentId);
    const stateDir = path.join(root, "state", "agents", agentId);
    const store = createAgentStateStore(root, agentId);
    const session = new FakeNativeSession(runtime);
    const adapter = { id: runtime, capabilities: { busyInput: runtime === "claude" ? "gated" : "direct" }, async createSession() { return session; } };
    const runtimeHost = createRuntimeHost({
      adapterFor: () => adapter,
      promptBuilder: new ContextPromptBuilder(),
      stateStoreFor: () => store,
      assertOfficialCliReady: () => {},
    });
    const runtimeEvents = [];
    const memberCalls = [];
    runtimeHost.subscribe((event) => runtimeEvents.push(event));
    const model = runtime === "pi" ? "mock/pi-model" : `${runtime}-model`;
    const storedConfig = { version: 3, serverId: "server-mock", activeAgent: agentId, agents: { [agentId]: { runtime, model } } };
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify(storedConfig)}\n`, { mode: 0o600 });
    const agent = { agentId, name: agentId, runtime, model, feishuAppId: agentId, feishuProfile: agentId,
      larkConfigDir: path.join(root, "lark-cli-config"), workspaceDir, stateDir };
    const env = { LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-mock",
      LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_FEISHU_DRYRUN: "1", LARKIN_FEISHU_EVENT_FILE: path.join(root, "events.ndjson") };
    const hostShell = createHostShell({
      env,
      runtimeHost,
      managedCliForAgent: testManagedCli,
      execFileImpl(command, args, _options, callback) {
        memberCalls.push([command, ...args]);
        const data = args.includes("bots")
          ? { items: [{ app_id: "cli_other", open_id: "ou_bot", name: "Other Bot" }] }
          : { items: [{ member_id: "ou_sender", name: "Sender" }] };
        callback(null, JSON.stringify({ ok: true, data }), "");
      },
    });
    try {
      hostShell.start();
      await new Promise((resolve) => setImmediate(resolve));
      await hostShell.ingest(agentId, { chat_id: `oc_${runtime}`, chat_type: "p2p", sender_id: "ou_sender", message_id: `om_${runtime}_1`,
        event_id: `evt_${runtime}_1`, content: "first", create_time: "1784160000000", thread_id: null,
        _mentioned_bot: false, _mention_all: false, _sender_is_bot: true });
      session.emit({ type: "turn-start", turnId: `${runtime}-turn` });
      await hostShell.ingest(agentId, { chat_id: `oc_${runtime}`, chat_type: "p2p", sender_id: "ou_sender", message_id: `om_${runtime}_2`,
        event_id: `evt_${runtime}_2`, content: "second", create_time: "1784160001000", thread_id: null,
        _mentioned_bot: false, _mention_all: false, _sender_is_bot: true });
      assert.equal(session.prompts.length, 1);
      assert.equal(session.busyInputs.length, 1);
      const canonical = store.readNdjson("inbox");
      assert.deepEqual(canonical.map((row) => row.message_id), [`om_${runtime}_1`, `om_${runtime}_2`]);
      assert.equal(canonical[0].sender_id, "ou_sender");
      assert.equal(canonical[0].chat_id, `oc_${runtime}`);
      assert.equal(canonical[0].thread_id, null);
      assert.equal(canonical[0].content, "first");
      assert.deepEqual(memberCalls.slice(0, 2).map((call) => call.slice(1, 5)), [
        ["im", "chat.members", "get", "--chat-id"],
        ["im", "chat.members", "bots", "--chat-id"],
      ]);

      const runtimeEnv = { ...env, LARKIN_AGENT_ID: agentId };
      const target = `chat:oc_${runtime}`;
      const sent = [];
      let guardedStdout = "", guardedStderr = "";
      const guardedDependencies = {
        stateStore: store,
        nativeCommand: { command: "/fixture/@larksuite/cli/scripts/run.js", argsPrefix: [], version: "1.0.79" },
        spawn(command, args, options) {
          if (["+chat-messages-list", "+threads-messages-list"].includes(args[1])
              || (args[0] === "api" && args[1] === "GET" && args[2] === "/open-apis/im/v1/messages")) {
            return { status: 0, stdout: JSON.stringify({ ok: true, identity: "bot", data: { messages: [
              { message_id: `om_${runtime}_1`, chat_id: `oc_${runtime}`, create_time: "1784160000000", content: "first" },
              { message_id: `om_${runtime}_2`, chat_id: `oc_${runtime}`, create_time: "1784160001000", content: "second" },
            ] } }), stderr: "", error: undefined };
          }
          sent.push({ command, args, options });
          return { status: 0, stdout: JSON.stringify({ ok: true, data: {
            message_id: `om_${runtime}_2`, chat_id: `oc_${runtime}`, create_time: "1784160001000",
          } }), stderr: "", error: undefined };
        },
        io: { stdout: (text) => { guardedStdout += text; }, stderr: (text) => { guardedStderr += text; } },
      };
      const sendArgv = ["im", "+messages-send", "--chat-id", `oc_${runtime}`, "--text", "fresh response"];
      assert.equal(runLarkCli(sendArgv, runtimeEnv, guardedDependencies), 3, guardedStderr);
      const conflict = JSON.parse(guardedStderr);
      assert.equal(conflict.error.subtype, "freshness_conflict");
      assert.equal(conflict.target, `feishu.im/chat/oc_${runtime}`);
      assert.equal(sent.length, 0, "a stale target must never reach the provider");

      let stdout = "", stderr = "";
      const code = runAgentCli(["inbox", "check"], runtimeEnv, {
        stateStore: store, io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
      });
      assert.equal(code, 0, stderr);
      const checkedInbox = JSON.parse(stdout);
      assert.equal(checkedInbox.targets.find((row) => row.target === target).pending_count, 2);
      assert.equal("events" in checkedInbox, false);
      assert.equal(store.readNdjson("inbox").length, 2, "check must not consume the batch");

      stdout = ""; stderr = "";
      const pollCode = runAgentCli(["inbox", "poll", "--target", target, "--limit", "1"], runtimeEnv, {
        stateStore: store, io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
      });
      assert.equal(pollCode, 0, stderr);
      const partial = JSON.parse(stdout);
      assert.equal(partial.delivery, "direct_ack");
      assert.equal(partial.at_most_once, true);
      assert.equal(partial.events.length, 1);
      assert.equal(partial.pending_count, 1);
      assert.equal(partial.has_more, true);
      assert.deepEqual(
        Object.fromEntries(["chat_id", "message_id", "thread_id", "sender_id", "content"].map((key) => [key, partial.events[0][key]])),
        { chat_id: `oc_${runtime}`, message_id: `om_${runtime}_1`, thread_id: null, sender_id: "ou_sender", content: "first" },
      );
      assert.deepEqual(partial.consumed_delivery_ids, [session.prompts[0].inputId]);

      session.emit({ type: "turn-end", turnId: `${runtime}-turn` });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(session.prompts.length, 2, "partial consumption schedules another production Runtime wake");
      assert.equal(session.prompts[1].inputId, session.busyInputs[0].inputId, "the replacement wake retains delivery identity");
      session.emit({ type: "turn-start", turnId: `${runtime}-rewake` });

      stdout = ""; stderr = "";
      const finalPollCode = runAgentCli(["inbox", "poll", "--target", target], runtimeEnv, {
        stateStore: store, io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
      });
      assert.equal(finalPollCode, 0, stderr);
      const drained = JSON.parse(stdout);
      assert.deepEqual(drained.events.map((event) => event.message_id), [`om_${runtime}_2`]);
      assert.equal(drained.pending_count, 0);
      assert.equal(drained.has_more, false);
      assert.deepEqual(drained.consumed_delivery_ids, [session.busyInputs[0].inputId]);
      guardedStdout = ""; guardedStderr = "";
      assert.equal(runLarkCli(sendArgv, runtimeEnv, guardedDependencies), 0, guardedStderr);
      assert.equal(sent.length, 1, "the provider is called once after the target is current");
      assert.deepEqual(sent[0].args.slice(0, 6), [
        "im", "+messages-send", "--chat-id", `oc_${runtime}`, "--text", "fresh response",
      ]);
      assert.equal(sent[0].command, "/fixture/@larksuite/cli/scripts/run.js");
      assert.ok(sent[0].args.includes("--as") && sent[0].args.includes("bot"));
      assert.ok(sent[0].args.includes("--idempotency-key"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(runtimeEvents.filter((event) => event.type === "delivery" && event.status === "consumed").length, 2);

      session.emit({ type: "turn-end", turnId: `${runtime}-rewake` });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(session.prompts.length, 2, "draining the replacement turn must not create another wake");
      const status = store.readJson("status", {});
      assert.equal(status.session.turns, 2);
      assert.equal(status.lastActivity.state, "idle");
      if (runtime === "pi") {
        await hostShell.ingest(agentId, { chat_id: "oc_pi", chat_type: "p2p", sender_id: "ou_sender", message_id: "om_pi_auth",
          event_id: "evt_pi_auth", content: "auth retry", create_time: "1784160002000", thread_id: null,
          _mentioned_bot: false, _mention_all: false, _sender_is_bot: true });
        const authInputId = session.prompts.at(-1).inputId;
        session.emit({ type: "turn-start", turnId: "pi-auth-failed" });
        session.emit({
          type: "input-error", inputId: authInputId, retryable: false, willRetry: false, errorCategory: "auth",
          message: "API key auth failed at /Users/example/.pi/agent/bin/cc-switch-token; api_key=fixture-secret",
          nextAction: "unsafe raw action", upstream: { provider: "bigmodel-anthropic", message: "unsafe" },
        });
        session.emit({ type: "turn-end", turnId: "pi-auth-failed" });
        await new Promise((resolve) => setImmediate(resolve));
        const failedStatus = store.readJson("status", {});
        assert.equal(failedStatus.runtimeReadiness.state, "unauthenticated");
        assert.match(failedStatus.runtimeReadiness.reason, /bigmodel-anthropic.*authentication failed/i);
        assert.match(failedStatus.runtimeReadiness.nextAction, /login|API-key resolver/i);
        assert.doesNotMatch(JSON.stringify(failedStatus.runtimeReadiness) + JSON.stringify(failedStatus.recentErrors),
          /Users\/example|cc-switch-token|fixture-secret|unsafe raw action/);

        const authRetry = await runtimeHost.deliver(agentId, { message_id: "om_pi_auth" });
        assert.equal(authRetry.status, "accepted");
        session.emit({ type: "turn-start", turnId: "pi-auth-aborted" });
        session.emit({ type: "activity", activity: "text" });
        session.emit({ type: "input-error", inputId: authRetry.deliveryId, retryable: true, willRetry: false,
          message: "Pi assistant turn aborted" });
        session.emit({ type: "turn-end", turnId: "pi-auth-aborted" });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(store.readJson("status", {}).runtimeReadiness.state, "unauthenticated");

        session.emit({ type: "turn-start", turnId: "pi-auth-recovered" });
        session.emit({ type: "activity", activity: "text" });
        session.emit({ type: "turn-end", turnId: "pi-auth-recovered" });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(store.readJson("status", {}).runtimeReadiness.state, "ready");
      }
    } finally {
      await hostShell.shutdown("mock e2e complete");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
