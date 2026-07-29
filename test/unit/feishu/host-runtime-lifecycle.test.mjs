import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const testManagedCli = () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.79" }, env: {} });

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
