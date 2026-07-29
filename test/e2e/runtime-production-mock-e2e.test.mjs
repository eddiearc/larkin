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

function callbackValue(card, index = 0) {
  const button = card.body.elements.filter((item) => item.tag === "button")[index];
  return button.behaviors.find((behavior) => behavior.type === "callback").value;
}

class FakeNativeSession {
  listeners = new Set(); prompts = []; busyInputs = []; sessionId;
  constructor(runtime) { this.sessionId = `${runtime}-session`; }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async prompt(input) { this.prompts.push(input); return { status: "accepted", inputId: input.inputId }; }
  async busyInput(input) { this.busyInputs.push(input); return { status: "accepted", inputId: input.inputId }; }
  async cancel() {} async close() {}
}

test("member parser accepts the real lark-cli 1.0.78 get/bots shapes", () => {
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
      assert.deepEqual(memberCalls.slice(0, 2).map((call) => call.slice(3, 7)), [
        ["im", "chat.members", "get", "--chat-id"],
        ["im", "chat.members", "bots", "--chat-id"],
      ]);

      const runtimeEnv = { ...env, LARKIN_AGENT_ID: agentId };
      const target = `chat:oc_${runtime}`;
      const sent = [];
      let guardedStdout = "", guardedStderr = "";
      const guardedDependencies = {
        stateStore: store,
        nativeCommand: { command: "/fixture/@larksuite/cli/scripts/run.js", argsPrefix: [], version: "1.0.78" },
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
      const pollCode = runAgentCli(["inbox", "poll", "--target", target], runtimeEnv, {
        stateStore: store, io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } },
      });
      assert.equal(pollCode, 0, stderr);
      const drained = JSON.parse(stdout);
      assert.equal(drained.delivery, "direct_ack");
      assert.equal(drained.at_most_once, true);
      assert.equal(drained.events.length, 2);
      assert.deepEqual(
        Object.fromEntries(["chat_id", "message_id", "thread_id", "sender_id", "content"].map((key) => [key, drained.events[0][key]])),
        { chat_id: `oc_${runtime}`, message_id: `om_${runtime}_1`, thread_id: null, sender_id: "ou_sender", content: "first" },
      );
      assert.deepEqual(new Set(drained.consumed_delivery_ids), new Set([session.prompts[0].inputId, session.busyInputs[0].inputId]));
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

      session.emit({ type: "turn-end", turnId: `${runtime}-turn` });
      await new Promise((resolve) => setImmediate(resolve));
      const status = store.readJson("status", {});
      assert.equal(status.session.turns, 1);
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
