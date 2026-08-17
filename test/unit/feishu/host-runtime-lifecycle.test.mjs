import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { createRuntimeHost } from "../../../dist/runtime/runtime-host.mjs";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const testManagedCli = () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} });

test("production channel disconnect and RuntimeHost use one idempotent ordered shutdown", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-lifecycle-"));
  const agentId = "cli_lifecycleA1";
  const order = [];
  let releaseDisconnect;
  let channelCreated = false;
  const runtimeHost = {
    subscribe() { return () => {}; },
    async start() { order.push("runtime-start"); },
    async deliver() { throw new Error("not used"); },
    async stop() {},
    async shutdown() { order.push("runtime-shutdown"); },
  };
  const channelPackage = {
    createLarkChannel() {
      channelCreated = true;
      return {
        botIdentity: { openId: "ou_lifecycle", name: "Lifecycle" },
        rawClient: null,
        dispatcher: { register() {} },
        on() {},
        async connect() { order.push("channel-connect"); },
        async disconnect() {
          order.push("channel-disconnect-start");
          await new Promise((resolve) => { releaseDisconnect = resolve; });
          order.push("channel-disconnect-end");
        },
      };
    },
  };
  const agent = { agentId, name: agentId, runtime: "codex", model: "gpt", feishuAppId: agentId,
    feishuAppSecret: "fixture-secret", feishuProfile: agentId, feishuDomain: "https://open.feishu.cn",
    workspaceDir: path.join(root, "agents", agentId), stateDir: path.join(root, "state", "agents", agentId) };
  const env = { LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-lifecycle",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_INBOUND_DROUGHT_SEC: "0" };
  const host = createHostShell({ env, runtimeHost, channelPackage, eventSourceStartDelayMs: 0 });
  try {
    host.start();
    const deadline = Date.now() + 2_000;
    while (!channelCreated && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(channelCreated, true);
    const first = host.shutdown("test signal");
    const second = host.shutdown("duplicate signal");
    assert.equal(first, second, "concurrent shutdown callers share one lifecycle promise");
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(order.slice(-1), ["channel-disconnect-start"]);
    assert.equal(order.includes("runtime-shutdown"), false, "RuntimeHost waits for channel disconnect");
    releaseDisconnect();
    await first;
    assert.deepEqual(order.slice(-2), ["channel-disconnect-end", "runtime-shutdown"]);
    assert.equal(order.filter((entry) => entry === "runtime-shutdown").length, 1);
  } finally {
    if (releaseDisconnect) releaseDisconnect();
    await host.shutdown("cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HostShell recovery lifecycle persists the new session but exposes only sanitized aggregate state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-context-recovery-"));
  const agentId = "cli_hostContextA1";
  const stateDir = path.join(root, "state", "agents", agentId);
  const store = createAgentStateStore(root, agentId);
  for (let index = 0; index < 4; index += 1) store.appendNdjson("inbox", { message_id: `om_host_context_${index}`, chat_id: "oc_host_context", content: "synthetic" });
  let channelCreated = false;
  const runtimeHost = {
    subscribe() { return () => {}; },
    async start() {},
    async recoverSession() { return { generationChanged: true, sessionChanged: true, turns: 0, runtimeReady: true,
      pendingCount: 4, rearmedCount: 4, replayStatus: "pending", sessionId: "private-session-not-output" }; },
    async deliver() { throw new Error("not used"); },
    async stop() {},
    async shutdown() {},
  };
  const agent = { agentId, name: agentId, runtime: "pi", model: "model", feishuAppId: agentId, feishuAppSecret: "fixture",
    feishuProfile: agentId, feishuDomain: "https://open.feishu.cn", workspaceDir: path.join(root, "agents", agentId), stateDir };
  const env = { LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-context-recovery",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_INBOUND_DROUGHT_SEC: "0" };
  const channelPackage = { createLarkChannel() { channelCreated = true; return {
    botIdentity: { openId: "ou_context", name: "Context" }, rawClient: null, dispatcher: { register() {} }, on() {},
    async connect() {}, async disconnect() {},
  }; } };
  const host = createHostShell({ env, runtimeHost, channelPackage, eventSourceStartDelayMs: 0 });
  try {
    await host.start();
    const deadline = Date.now() + 1_000;
    while (!channelCreated && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(channelCreated, true);
    const result = await host.recoverSession(agentId, "context-overflow", 0);
    assert.equal(result.recoveryCommitted, true);
    assert.equal(result.rearmedCount, 4);
    assert.equal(result.remainingPendingCount, 4);
    assert.doesNotMatch(JSON.stringify(result), /private-session-not-output|stateDir|fixture/);
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, "agent-state.json"), "utf8"));
    assert.equal(state.sessions.pi, "private-session-not-output", "private session identity is persisted internally, not returned to the operator");
  } finally {
    await host.shutdown("context recovery lifecycle test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("HostShell reset publishes a current readiness observation and rejects stale ready during transition", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-reset-freshness-"));
  const agentId = "cli_hostResetFreshA1";
  const stateDir = path.join(root, "state", "agents", agentId);
  let channelCreated = false;
  let releaseReset;
  let resetStarted;
  const runtimeHost = {
    subscribe() { return () => {}; },
    async start() {},
    async resetSession() {
      resetStarted?.();
      return await new Promise((resolve) => { releaseReset = () => resolve({ generationChanged: true, sessionChanged: true, turns: 0, runtimeReady: true, pendingCount: 0, sessionId: null }); });
    },
    async deliver() { throw new Error("not used"); },
    async stop() {},
    async shutdown() {},
  };
  const agent = { agentId, name: agentId, runtime: "pi", model: "model", feishuAppId: agentId, feishuAppSecret: "fixture",
    feishuProfile: agentId, feishuDomain: "https://open.feishu.cn", workspaceDir: path.join(root, "agents", agentId), stateDir };
  const env = { LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-reset-freshness",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_INBOUND_DROUGHT_SEC: "0" };
  const channelPackage = { createLarkChannel() { channelCreated = true; return {
    botIdentity: { openId: "ou_reset_fresh", name: "Reset Fresh" }, rawClient: null, dispatcher: { register() {} }, on() {},
    async connect() {}, async disconnect() {},
  }; } };
  const host = createHostShell({ env, runtimeHost, channelPackage, eventSourceStartDelayMs: 0 });
  try {
    await host.start();
    const statusFile = path.join(stateDir, "status.json");
    const deadline = Date.now() + 1_000;
    while ((!channelCreated || !fs.existsSync(statusFile) || JSON.parse(fs.readFileSync(statusFile, "utf8")).connectedVia !== "channel") && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(channelCreated, true);
    let markStarted;
    resetStarted = () => markStarted?.();
    const resetStartedPromise = new Promise((resolve) => { markStarted = resolve; });
    const resetPromise = host.resetSession(agentId, 0);
    await resetStartedPromise;
    const transitioning = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    assert.equal(transitioning.runtimeReadiness.state, "unavailable");
    releaseReset();
    const result = await resetPromise;
    assert.equal(result.runtimeReady, true);
    const final = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    const transitionObservedAt = Date.parse(transitioning.runtimeReadiness.observedAt);
    assert.equal(final.runtimeReadiness.state, "ready");
    assert.equal(Date.parse(final.runtimeReadiness.observedAt) >= transitionObservedAt, true);
    assert.equal(Date.parse(final.session.startedAt) >= transitionObservedAt, true);
  } finally {
    releaseReset?.();
    await host.shutdown("reset freshness test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("assembled HostShell recovery compensates persisted session/status after a later Runtime listener throws", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-context-listener-failure-"));
  const agentId = "cli_hostListenerA1";
  const stateDir = path.join(root, "state", "agents", agentId);
  const store = createAgentStateStore(root, agentId);
  const messageId = "om_host_listener_context";
  store.appendNdjson("inbox", { message_id: messageId, chat_id: "oc_host_listener", content: "synthetic" });
  store.writeJson("runtimeDeliveries", { version: 1, records: [{ deliveryId: "d-host-listener", messageId, status: "error", retryable: false,
    reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window",
    input: { inputId: "i-host-listener", deliveryId: "d-host-listener", kind: "wake", text: "redacted", attempt: 0 }, updatedAt: "before" }] });
  const sessions = [];
  class Session {
    constructor(sessionId) { this.sessionId = sessionId; this.listeners = new Set(); this.closes = []; this.prompts = []; }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    async prompt(input) { this.prompts.push(input); return { status: "accepted", inputId: input.inputId }; }
    async close(reason) { this.closes.push(reason); }
  }
  const adapter = { id: "pi", capabilities: {}, async createSession() {
    const session = new Session(sessions.length === 0 ? "old-host-listener" : "fresh-host-listener");
    sessions.push(session);
    return session;
  } };
  const runtimeHost = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  const agent = { agentId, name: agentId, runtime: "pi", model: "model", feishuAppId: agentId, feishuAppSecret: "fixture",
    feishuProfile: agentId, feishuDomain: "https://open.feishu.cn", workspaceDir: path.join(root, "agents", agentId), stateDir };
  let channelCreated = false;
  const channelPackage = { createLarkChannel() { channelCreated = true; return {
    botIdentity: { openId: "ou_host_listener", name: "Listener" }, rawClient: null, dispatcher: { register() {} }, on() {},
    async connect() {}, async disconnect() {},
  }; } };
  const env = { LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-host-listener",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_INBOUND_DROUGHT_SEC: "0" };
  const host = createHostShell({ env, runtimeHost, channelPackage, eventSourceStartDelayMs: 0 });
  try {
    await host.start();
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      const status = store.readJson("status", {});
      if (channelCreated && status.connectedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(channelCreated, true);
    const oldLaunchId = store.readJson("status", {}).session.launchId;
    assert.equal(typeof oldLaunchId, "string");
    runtimeHost.subscribe((event) => {
      if (event.type === "session" && event.sessionId === "fresh-host-listener") throw new Error("later listener failure");
    });
    await assert.rejects(host.recoverSession(agentId, "context-overflow", 0), /later listener failure|not committed/);
    assert.deepEqual(sessions[0].closes, []);
    assert.deepEqual(sessions[1].closes, ["context-window recovery not committed"]);
    assert.equal(store.readJson("agentState", {}).sessions.pi, "old-host-listener");
    const status = store.readJson("status", {});
    assert.equal(status.session.id, "old-host-listener");
    assert.equal(status.session.launchId, oldLaunchId);
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "error");
  } finally {
    await host.shutdown("assembled listener failure test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("assembled HostShell recovery restores a null old session projection after a later Runtime listener throws", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-context-null-listener-"));
  const agentId = "cli_hostNullListenerA1";
  const stateDir = path.join(root, "state", "agents", agentId);
  const store = createAgentStateStore(root, agentId);
  const messageId = "om_host_null_listener_context";
  store.appendNdjson("inbox", { message_id: messageId, chat_id: "oc_host_null_listener", content: "synthetic" });
  store.writeJson("runtimeDeliveries", { version: 1, records: [{ deliveryId: "d-host-null-listener", messageId, status: "error", retryable: false,
    reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window",
    input: { inputId: "i-host-null-listener", deliveryId: "d-host-null-listener", kind: "wake", text: "redacted", attempt: 0 }, updatedAt: "before" }] });
  const sessions = [];
  class Session {
    constructor(sessionId) { this.sessionId = sessionId; this.listeners = new Set(); this.closes = []; }
    subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    async prompt() { return { status: "accepted" }; }
    async close(reason) { this.closes.push(reason); }
  }
  const adapter = { id: "pi", capabilities: {}, async createSession() {
    const session = new Session(sessions.length === 0 ? null : "fresh-host-null-listener");
    sessions.push(session);
    return session;
  } };
  const runtimeHost = createRuntimeHost({ adapterFor: () => adapter, promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store });
  let oldLaunchId = null;
  const captureOld = runtimeHost.subscribe((event) => {
    if (event.type === "session" && event.sessionId === null) oldLaunchId = event.launchId;
  });
  const agent = { agentId, name: agentId, runtime: "pi", model: "model", feishuAppId: agentId, feishuAppSecret: "fixture",
    feishuProfile: agentId, feishuDomain: "https://open.feishu.cn", workspaceDir: path.join(root, "agents", agentId), stateDir };
  let channelCreated = false;
  const channelPackage = { createLarkChannel() { channelCreated = true; return {
    botIdentity: { openId: "ou_host_null_listener", name: "Null Listener" }, rawClient: null, dispatcher: { register() {} }, on() {},
    async connect() {}, async disconnect() {},
  }; } };
  const env = { LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-host-null-listener",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_INBOUND_DROUGHT_SEC: "0" };
  const host = createHostShell({ env, runtimeHost, channelPackage, eventSourceStartDelayMs: 0 });
  try {
    await host.start();
    const channelDeadline = Date.now() + 1_000;
    while (!channelCreated && Date.now() < channelDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(channelCreated, true);
    runtimeHost.subscribe((event) => {
      if (event.type === "session" && event.sessionId === "fresh-host-null-listener") throw new Error("later null-session listener failure");
    });
    await assert.rejects(host.recoverSession(agentId, "context-overflow", 0), /later null-session listener failure|not committed/);
    assert.equal(typeof oldLaunchId, "string");
    assert.deepEqual(sessions[0].closes, []);
    assert.deepEqual(sessions[1].closes, ["context-window recovery not committed"]);
    assert.equal(store.readJson("agentState", {}).sessions.pi, undefined);
    const status = store.readJson("status", {});
    assert.equal(status.session.id, null);
    assert.equal(status.session.launchId, oldLaunchId);
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "error");
  } finally {
    captureOld();
    await host.shutdown("assembled null-session listener failure test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

for (const disconnectMode of ["pending", "reject"]) {
  test(`final HostShell shutdown settles within its bound and reports ${disconnectMode} channel disconnect without logging success`, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-host-final-disconnect-${disconnectMode}-`));
    const agentId = `cli_final${disconnectMode === "pending" ? "Pending" : "Reject"}A1`;
    const logs = [];
    let channelCreated = false;
    let disconnectCalls = 0;
    let runtimeShutdownCalls = 0;
    const runtimeHost = {
      subscribe() { return () => {}; },
      async start() {},
      async deliver() { throw new Error("not used"); },
      async stop() {},
      async shutdown() { runtimeShutdownCalls += 1; },
    };
    const channelPackage = {
      createLarkChannel() {
        channelCreated = true;
        return {
          botIdentity: { openId: "ou_final", name: "Final" },
          rawClient: null,
          dispatcher: { register() {} },
          on() {},
          async connect() {},
          disconnect() {
            disconnectCalls += 1;
            return disconnectMode === "pending"
              ? new Promise(() => {})
              : Promise.reject(new Error("disconnect rejection canary"));
          },
        };
      },
    };
    const agent = {
      agentId, name: agentId, runtime: "codex", model: "gpt", feishuAppId: agentId,
      feishuAppSecret: "fixture-secret", feishuProfile: agentId, feishuDomain: "https://open.feishu.cn",
      workspaceDir: path.join(root, "agents", agentId), stateDir: path.join(root, "state", "agents", agentId),
    };
    const env = {
      LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-final-disconnect",
      LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_INBOUND_DROUGHT_SEC: "0",
    };
    const host = createHostShell({
      env,
      runtimeHost,
      channelPackage,
      eventSourceStartDelayMs: 0,
      channelDisconnectTimeoutMs: 25,
      logImpl: (...parts) => logs.push(parts.join(" ")),
    });
    try {
      host.start();
      const readyDeadline = Date.now() + 500;
      while (!channelCreated && Date.now() < readyDeadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(channelCreated, true);

      const startedAt = Date.now();
      await Promise.race([
        host.shutdown("direct final shutdown test"),
        new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown leaked past bound")), 500)),
      ]);
      assert.ok(Date.now() - startedAt < 500, "final shutdown must settle within the configured disconnect bound");
      assert.equal(runtimeShutdownCalls, 1, "RuntimeHost shutdown must continue after channel close failure");
      assert.equal(disconnectCalls, 1, "final shutdown must not retry or leak a second channel disconnect");
      await host.shutdown("duplicate final shutdown");
      assert.equal(disconnectCalls, 1, "idempotent shutdown must share the settled lifecycle");

      const output = logs.join("\n");
      const expectedOutcome = disconnectMode === "pending" ? "超时" : "失败";
      assert.match(output, new RegExp(`channel disconnect ${expectedOutcome} agent=${agentId}`));
      assert.match(output, /事件连接关闭完成：成功 0，失败 1/);
      assert.doesNotMatch(output, /已断开事件连接/, "failed disconnect must not be logged as success");
      const status = JSON.parse(fs.readFileSync(path.join(agent.stateDir, "status.json"), "utf8"));
      assert.match(JSON.stringify(status.recentErrors), new RegExp(`channel disconnect ${expectedOutcome}`));
    } finally {
      await host.shutdown("cleanup");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("HostShell signal path does not call process.exit ahead of ordered shutdown", () => {
  const source = fs.readFileSync(path.join(ROOT, "src/feishu/host-shell.ts"), "utf8");
  assert.doesNotMatch(source, /process\.exit\s*\(/);
  assert.match(source, /await Promise\.resolve\(eventSourceStop\(\)\)[\s\S]*await runtimeHost\.shutdown\(reason\)/);
});

test("failed durable Inbox append does not burn same-process event redelivery", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-inbox-redelivery-"));
  const agentId = "cli_inboxRetryA1";
  const stateDir = path.join(root, "state", "agents", agentId);
  const inboxFile = path.join(stateDir, "feishu-inbox.ndjson");
  const outside = path.join(root, "unsafe-inbox-target");
  let deliveries = 0;
  const runtimeHost = {
    subscribe() { return () => {}; },
    async start() {},
    async deliver() { deliveries += 1; return { status: "accepted", deliveryId: "delivery-retry" }; },
    async stop() {},
    async shutdown() {},
  };
  const agent = {
    agentId, name: agentId, runtime: "codex", model: "gpt", feishuAppId: agentId,
    feishuProfile: agentId, workspaceDir: path.join(root, "agents", agentId), stateDir,
    larkConfigDir: path.join(stateDir, "lark-cli-config"),
  };
  const eventFile = path.join(root, "events.ndjson");
  const env = {
    LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-inbox-retry",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_FEISHU_DRYRUN: "1", LARKIN_FEISHU_EVENT_FILE: eventFile,
  };
  const logs = [];
  const host = createHostShell({
    env, runtimeHost, eventSourceStartDelayMs: 60_000, logImpl: (...parts) => logs.push(parts.join(" ")),
    managedCliForAgent: testManagedCli,
    execFileImpl(_command, _args, _options, callback) {
      callback(null, JSON.stringify({ ok: true, data: { items: [{ member_id: "ou_sender", name: "Sender" }] } }), "");
      return {};
    },
  });
  const event = {
    chat_id: "oc_retry", chat_type: "group", sender_id: "ou_sender", message_id: "om_retry",
    event_id: "evt_retry", content: "retry me", thread_id: null, _mentioned_bot: true,
    _mention_all: false, _sender_is_bot: true,
  };
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(outside, "must remain unchanged");
    fs.symlinkSync(outside, inboxFile);
    await host.ingest(agentId, event);
    assert.equal(deliveries, 0);
    assert.match(logs.join("\n"), /inbox 写失败/);
    assert.equal(fs.readFileSync(outside, "utf8"), "must remain unchanged");

    fs.unlinkSync(inboxFile);
    await host.ingest(agentId, event);
    assert.equal(deliveries, 1, "the same event_id must be retried after a failed durable append");
    const rows = fs.readFileSync(inboxFile, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(rows.map((row) => row.message_id), ["om_retry"]);
    await host.ingest(agentId, event);
    assert.equal(deliveries, 1, "a durably appended event remains deduplicated");
  } finally {
    await host.shutdown("inbox retry test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("production HostShell clears eyes on inactive/error and ignores heartbeat activity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-eye-terminal-"));
  const agentId = "cli_eyehostA1";
  const eventFile = path.join(root, "events.ndjson");
  let listener = () => {};
  let reactionId = 0;
  const apiCalls = [];
  const runtimeHost = {
    subscribe(next) { listener = next; return () => {}; },
    async start() {},
    async deliver(_agentId, envelope) { return { status: "accepted", deliveryId: `delivery-${envelope.message_id}` }; },
    async stop() {},
    async shutdown() {},
  };
  const agent = { agentId, name: agentId, runtime: "pi", model: "model", feishuAppId: agentId,
    feishuProfile: agentId, workspaceDir: path.join(root, "agents", agentId),
    stateDir: path.join(root, "state", "agents", agentId),
    larkConfigDir: path.join(root, "state", "agents", agentId, "lark-cli-config") };
  const env = { LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-eye-host",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_FEISHU_DRYRUN: "1", LARKIN_FEISHU_EVENT_FILE: eventFile };
  const host = createHostShell({
    env, runtimeHost, eventSourceStartDelayMs: 60_000,
    managedCliForAgent: testManagedCli,
    execFileImpl(_command, args, _options, callback) {
      apiCalls.push(args);
      if (args.includes("POST")) callback(null, JSON.stringify({ data: { reaction_id: `react_${++reactionId}` } }), "");
      else if (args.includes("DELETE")) callback(null, JSON.stringify({ ok: true }), "");
      else if (args.includes("/open-apis/contact/v3/users/ou_sender?user_id_type=open_id")) {
        callback(null, JSON.stringify({ ok: true, data: { user: { name: "Sender" } } }), "");
      } else callback(null, JSON.stringify({ ok: true, data: { items: [{ member_id: "ou_sender", name: "Sender" }] } }), "");
      return {};
    },
  });
  const deletes = () => apiCalls.filter((args) => args.includes("DELETE"));
  const ingest = (suffix) => host.ingest(agentId, {
    chat_id: "oc_eye_host", chat_type: "p2p", sender_id: "ou_sender", message_id: `om_${suffix}`,
    event_id: `evt_${suffix}`, content: suffix, thread_id: null,
    _mentioned_bot: false, _mention_all: false, _sender_is_bot: false,
  });
  try {
    host.start();
    await new Promise((resolve) => setImmediate(resolve));

    listener({ type: "agent-status", agentId, status: "active" });
    assert.equal(JSON.parse(fs.readFileSync(path.join(agent.stateDir, "status.json"), "utf8")).runtimeReadiness.state, "ready");

    await ingest("inactive");
    listener({ type: "agent-status", agentId, status: "inactive", readiness: { runtime: "pi", state: "ready" } });
    assert.equal(deletes().length, 1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(agent.stateDir, "status.json"), "utf8")).runtimeReadiness.state, "missing");

    await ingest("error");
    listener({ type: "agent-status", agentId, status: "active" });
    listener({ type: "agent-status", agentId, status: "error", error: "runtime failed", readiness: { runtime: "pi", state: "ready" } });
    assert.equal(deletes().length, 2);
    assert.equal(JSON.parse(fs.readFileSync(path.join(agent.stateDir, "status.json"), "utf8")).runtimeReadiness.state, "incompatible");

    await ingest("heartbeat");
    listener({ type: "activity", agentId, activity: "idle", activityKind: "idle", isHeartbeat: true });
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    assert.equal(deletes().length, 2, "heartbeat idle must not schedule processing-eye completion");
    listener({ type: "agent-status", agentId, status: "inactive" });
    assert.equal(deletes().length, 3);
  } finally {
    await host.shutdown("eye terminal test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("channel options disable inbound message merging (issue #88)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-no-merge-"));
  const agentId = "cli_nomergeA1";
  let capturedOptions = null;
  let channelCreated = false;
  const runtimeHost = {
    subscribe() { return () => {}; },
    async start() {},
    async deliver() { throw new Error("not used"); },
    async stop() {},
    async shutdown() {},
  };
  const channelPackage = {
    createLarkChannel(options) {
      capturedOptions = options;
      channelCreated = true;
      return {
        botIdentity: { openId: "ou_nomerge", name: "NoMerge" },
        rawClient: null,
        dispatcher: { register() {} },
        on() {},
        async connect() {},
        async disconnect() {},
      };
    },
  };
  const agent = { agentId, name: agentId, runtime: "codex", model: "gpt", feishuAppId: agentId,
    feishuAppSecret: "fixture-secret", feishuProfile: agentId, feishuDomain: "https://open.feishu.cn",
    workspaceDir: path.join(root, "agents", agentId), stateDir: path.join(root, "state", "agents", agentId) };
  const env = { LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-nomerge",
    LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_INBOUND_DROUGHT_SEC: "0" };
  const host = createHostShell({ env, runtimeHost, channelPackage, eventSourceStartDelayMs: 0 });
  try {
    host.start();
    const deadline = Date.now() + 2_000;
    while (!channelCreated && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(channelCreated, true);
    assert.deepEqual(capturedOptions.batch, { text: { delayMs: 0 } },
      "必须关闭 SDK 防抖批量合并，逐条投递以保持身份与内容同源（#88/#66）");
  } finally {
    await host.shutdown("issue88 test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
