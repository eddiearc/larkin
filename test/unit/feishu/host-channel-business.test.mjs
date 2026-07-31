import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { HostChannelBusiness } from "../../../dist/feishu/host-channel-business.mjs";
import { EventDispatcher } from "@larksuiteoapi/node-sdk";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..");
const agent = { agentId: "cli_channel", name: "cli_channel", noMentionChats: ["oc_free"] };

function fixture() {
  const messages = [], receipts = [], statuses = [], json = new Map(), logs = [];
  const state = {
    recordStatusError(_agent, text) { statuses.push({ error: text }); },
    recordReadReceipts(_agent, reader, readAt, ids) { receipts.push({ reader, readAt, ids }); },
    updateStatus(_agent, patch) { statuses.push(patch); },
  };
  const store = { readJson(_key, fallback) { return json.get("bot") || fallback; }, writeJson(_key, value) { json.set("bot", value); } };
  const business = new HostChannelBusiness({ state, stateStore: () => store, onMessage(_agent, event, options) { messages.push({ event, options }); }, log: (...parts) => logs.push(parts.join(" ")), now: () => new Date("2026-07-16T04:00:00.000Z") });
  return { business, messages, receipts, statuses, json, logs };
}

test("channel message callback preserves Owner wake matrix and normalized event", () => {
  const f = fixture();
  const handlers = f.business.handlers(agent);
  handlers.message({ chatId: "oc_group", chatType: "group", senderId: "ou_h", messageId: "om_1", content: "quiet" });
  handlers.message({ chatId: "oc_free", chatType: "group", senderId: "ou_h", messageId: "om_2", content: "free" });
  handlers.message({ chatId: "oc_free", chatType: "group", senderId: "cli_other", senderIsBot: true, messageId: "om_3", content: "bot" });
  handlers.message({ chatId: "oc_group", chatType: "group", senderId: "cli_other", senderIsBot: true, mentionedBot: true, messageId: "om_4", content: "@bot" });
  assert.deepEqual(f.messages.map((item) => item.options.wake), [false, true, false, true]);
  assert.equal(f.messages[3].event._sender_is_bot, true);
  assert.deepEqual(f.statuses, Array.from({ length: 4 }, () => ({ inboundVerifiedAt: "2026-07-16T04:00:00.000Z" })));
});

test("cardAction is a separate callback path and returns the orchestrator response", async () => {
  const calls = [];
  const base = fixture();
  const business = new HostChannelBusiness({
    state: {
      recordStatusError() {}, recordReadReceipts() {}, updateStatus() {},
    },
    stateStore: () => ({ readJson: (_key, fallback) => fallback, writeJson() {} }),
    onMessage() { throw new Error("card actions must not enter ordinary message policy"); },
    onCardAction(subject, event) {
      calls.push({ subject, event });
      return { toast: { type: "info", content: "Accepted" } };
    },
  });
  const event = { messageId: "om_card", chatId: "oc_card", operator: { openId: "ou_user" }, action: { tag: "button", value: { interaction_ref: "ref_1" } } };
  assert.deepEqual(await business.handlers(agent).cardAction(event), { toast: { type: "info", content: "Accepted" } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].event, event);
  assert.equal(base.messages.length, 0);
});

test("production card registration uses the real SDK dispatcher without its action-value TTL dedup", async () => {
  const calls = [];
  const business = new HostChannelBusiness({
    state: { recordStatusError() {}, recordReadReceipts() {}, updateStatus() {} },
    stateStore: () => ({ readJson: (_key, fallback) => fallback, writeJson() {} }),
    onMessage() {},
    onCardAction(_subject, event) { calls.push(event.raw.event_id); return { toast: { type: "info", content: event.raw.event_id } }; },
  });
  const dispatcher = new EventDispatcher({});
  dispatcher.register({ "card.action.trigger": () => ({ swallowed: true }) });
  business.registerCardActions(agent, dispatcher);
  const raw = (eventId) => ({
    schema: "2.0",
    header: { event_id: eventId, event_type: "card.action.trigger", create_time: "1", token: "fixture", app_id: "cli_dispatcherA1", tenant_key: "tenant" },
    event: {
      context: { open_message_id: "om_dispatch", open_chat_id: "oc_dispatch" },
      operator: { open_id: "ou_dispatch" },
      action: { tag: "button", value: { interaction_ref: "ref_same", interaction_version: 1 } },
    },
  });
  const first = await dispatcher.invoke(raw("evt_dispatch_1"), { needCheck: false });
  const retry = await dispatcher.invoke(raw("evt_dispatch_1"), { needCheck: false });
  const later = await dispatcher.invoke(raw("evt_dispatch_2"), { needCheck: false });
  assert.deepEqual(calls, ["evt_dispatch_1", "evt_dispatch_1", "evt_dispatch_2"]);
  assert.deepEqual([first.toast.content, retry.toast.content, later.toast.content], ["evt_dispatch_1", "evt_dispatch_1", "evt_dispatch_2"]);
});

test("read receipt and connected identity preserve persistence/status order and shape", async () => {
  const f = fixture();
  let receiptHandler;
  f.business.registerReadReceipts(agent, { register(map) { receiptHandler = map["im.message.message_read_v1"]; } });
  await receiptHandler({ reader: { reader_id: { open_id: "ou_reader" }, read_time: "10" }, message_id_list: ["om_1"] });
  assert.deepEqual(f.receipts, [{ reader: "ou_reader", readAt: "10", ids: ["om_1"] }]);
  await f.business.connected(agent, {
    botIdentity: { openId: "ou_bot", name: "Old" },
    rawClient: { async request() { return { bot: { open_id: "ou_bot", app_name: "New", avatar_url: "https://avatar" } }; } },
  });
  assert.equal(agent.botOpenId, "ou_bot");
  assert.deepEqual(f.json.get("bot"), { open_id: "ou_bot", name: "New", avatar_url: "https://avatar", updated_at: "2026-07-16T04:00:00.000Z" });
  assert.deepEqual(f.statuses.at(-1), {
    connectedAt: "2026-07-16T04:00:00.000Z", connectedVia: "channel", reconnectingAt: null,
  });
});

test("ws reconnecting/reconnected transitions are visible in status, not just logs", () => {
  const f = fixture();
  const handlers = f.business.handlers(agent);
  handlers.reconnecting();
  handlers.reconnected();
  assert.deepEqual(f.statuses, [
    { reconnectingAt: "2026-07-16T04:00:00.000Z" },
    { reconnectingAt: null, reconnectedAt: "2026-07-16T04:00:00.000Z", connectedAt: "2026-07-16T04:00:00.000Z" },
  ]);
});

test("real host opens one new drought cycle after daemon restart and ignores stale maintenance markers", { timeout: 30_000 }, () => {
 for (const staleMarker of ["droughtReconnectAt", "droughtReconnectAbandonedAt"]) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-drought-reconnect-${staleMarker}-`));
  try {
    const root = path.join(temp, "root");
    const app = "cli_droughtA1";
    const stateDir = path.join(root, "state", "agents", app);
    const marker = path.join(temp, "channel-calls.ndjson");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "status.json"), JSON.stringify({
      connectedAt: "2020-01-01T00:00:00.000Z",
      [staleMarker]: "2020-01-01T00:01:00.000Z",
    }) + "\n");
    const preload = path.join(temp, "channel-package.cjs");
    fs.writeFileSync(preload, `
const fs = require("node:fs");
const mark = (kind) => fs.appendFileSync(process.env.CHANNEL_MARKER, JSON.stringify({ kind }) + "\\n");
module.exports = {
    createLarkChannel() {
      mark("create");
      const keep = setInterval(() => {}, 1000);
      return {
        botIdentity: { openId: "ou_drought", name: "drought-bot" },
        on() {},
        dispatcher: { register() {} },
        connect() { return Promise.resolve(); },
        disconnect() { mark("disconnect"); clearInterval(keep); },
      };
    },
};
`);
    const agentConfig = {
      name: app, agentId: app, feishuAppId: app, feishuProfile: app, feishuAppSecret: "test-secret", feishuDomain: "https://open.feishu.cn",
      runtime: "codex", model: "test",
      workspaceDir: path.join(root, "agents", app), stateDir, larkConfigDir: path.join(root, "lark-cli-config"),
    };
    const result = spawnSync(process.execPath, ["--preload", path.join(ROOT, "test/support/host-shell-test-harness.cjs"), "--eval", "setTimeout(() => process.exit(0), 2500);", "app/runtime-process.mjs"], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: path.join(temp, "isolated-home"),
        LARKIN_HOME: root,
        LARKIN_CONFIG_DIR: root,
        LARKIN_SERVER_ID: "server-drought",
        LARKIN_AGENTS_CONFIG: JSON.stringify([agentConfig]),
        LARKIN_INBOUND_DROUGHT_SEC: "1",
        LARKIN_TEST_EVENT_SOURCE_START_DELAY_MS: "50",
        LARKIN_TEST_CHANNEL_DISCONNECT_TIMEOUT_MS: "200",
        CHANNEL_MARKER: marker,
        LARKIN_TEST_CHANNEL_PACKAGE_MODULE: preload,
      },
      encoding: "utf8",
      timeout: 4_000,
    });
    assert.ok(!result.error || result.error.code === "ETIMEDOUT", result.error?.message || result.stderr);
    assert.equal(fs.existsSync(marker), true, result.stderr || result.stdout || "channel mock never invoked");
    const calls = fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).kind);
    assert.equal(calls.filter((kind) => kind === "create").length, 2, `one drought cycle must recreate the channel exactly once, got ${JSON.stringify(calls)}`);
    const finalCreate = calls.lastIndexOf("create");
    assert.equal(calls.slice(0, finalCreate).filter((kind) => kind === "disconnect").length, 1, `one drought cycle must disconnect exactly once before recreation, got ${JSON.stringify(calls)}`);
    assert.equal(calls[0], "create");
    assert.ok(calls.indexOf("disconnect") > 0 && calls.indexOf("disconnect") < finalCreate, "maintenance disconnect must happen between the two creates");
    const status = JSON.parse(fs.readFileSync(path.join(stateDir, "status.json"), "utf8"));
    assert.ok(status.droughtReconnectAt, "status.json must record the preventive reconnect");
    assert.ok(status.connectedAt, "reconnected channel must refresh connectedAt");
    assert.equal(status.recentErrors?.length || 0, 0, "preventive maintenance must not become an error");
    assert.equal(status.activityLog.filter((item) => /预防性重连/.test(item.detail || "")).length, 1, "one drought cycle must emit one neutral activity entry");
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
 }
});

test("watchdog never creates a parallel channel when maintenance disconnect rejects or times out", { timeout: 30_000 }, () => {
  for (const mode of ["reject", "pending"]) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-drought-disconnect-${mode}-`));
    try {
      const root = path.join(temp, "root");
      const app = `cli_drought${mode}`;
      const stateDir = path.join(root, "state", "agents", app);
      const marker = path.join(temp, "channel-calls.ndjson");
      fs.mkdirSync(root, { recursive: true });
      const preload = path.join(temp, "channel-package.cjs");
      fs.writeFileSync(preload, `
const fs = require("node:fs");
const mark = (kind) => fs.appendFileSync(process.env.CHANNEL_MARKER, JSON.stringify({ kind, at: Date.now() }) + "\\n");
module.exports = {
    createLarkChannel() {
      mark("create");
      return {
        botIdentity: { openId: "ou_drought", name: "drought-bot" },
        on() {}, dispatcher: { register() {} }, connect() { return Promise.resolve(); },
        disconnect() {
          mark("disconnect");
          return process.env.DISCONNECT_MODE === "reject" ? Promise.reject(new Error("fixture disconnect rejected")) : new Promise(() => {});
        },
      };
    },
};
`);
      const agentConfig = {
        name: app, agentId: app, feishuAppId: app, feishuProfile: app, feishuAppSecret: "test-secret", feishuDomain: "https://open.feishu.cn",
        runtime: "codex", model: "test", workspaceDir: path.join(root, "agents", app), stateDir, larkConfigDir: path.join(root, "lark-cli-config"),
      };
      const result = spawnSync(process.execPath, ["--preload", path.join(ROOT, "test/support/host-shell-test-harness.cjs"), "--eval", "setTimeout(() => process.exit(0), 3500);", "app/runtime-process.mjs"], {
        cwd: ROOT,
        env: {
          ...process.env,
          HOME: path.join(temp, "isolated-home"), LARKIN_HOME: root, LARKIN_CONFIG_DIR: root,
          LARKIN_SERVER_ID: `server-drought-${mode}`, LARKIN_AGENTS_CONFIG: JSON.stringify([agentConfig]),
          LARKIN_INBOUND_DROUGHT_SEC: "0.2", CHANNEL_MARKER: marker, DISCONNECT_MODE: mode,
          LARKIN_TEST_CHANNEL_PACKAGE_MODULE: preload,
          LARKIN_TEST_EVENT_SOURCE_START_DELAY_MS: "50", LARKIN_TEST_CHANNEL_DISCONNECT_TIMEOUT_MS: "200",
        },
        encoding: "utf8",
        timeout: 4_000,
      });
      assert.ok(!result.error || result.error.code === "ETIMEDOUT", result.error?.message || result.stderr);
      const calls = fs.readFileSync(marker, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line).kind);
      assert.equal(calls.filter((kind) => kind === "create").length, 1, `${mode}: failed disconnect must not create a parallel channel: ${JSON.stringify(calls)}`);
      const status = JSON.parse(fs.readFileSync(path.join(stateDir, "status.json"), "utf8"));
      assert.equal(status.droughtReconnectAt || null, null, `${mode}: failed disconnect is not a successful reconnect`);
      assert.ok(status.droughtReconnectAbandonedAt, `${mode}: bounded attempts must close the failed drought cycle; status=${JSON.stringify(status)} calls=${JSON.stringify(calls)} stderr=${result.stderr} stdout=${result.stdout}`);
      assert.ok((status.recentErrors || []).some((item) => /预防性重连.*断开失败|maintenance.*disconnect/i.test(item.text || "")), `${mode}: failure must be explainable in status`);
    } finally {
      fs.rmSync(temp, { recursive: true, force: true });
    }
  }
});
