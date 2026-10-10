import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";

const testManagedCli = () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} });

function writeConfig(root, agentId, extra = {}) {
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4,
    serverId: "server-processing-eye-host",
    mentionPolicy: "free",
    activeAgent: agentId,
    agents: { [agentId]: { runtime: "pi", model: "default" } },
    ...extra,
  }, null, 2)}\n`, { mode: 0o600 });
}

function createHost(root, agentId) {
  const agent = {
    agentId, name: agentId, runtime: "pi", model: "default", feishuAppId: agentId,
    feishuAppSecret: "fixture-secret", feishuProfile: agentId, feishuDomain: "https://open.feishu.cn",
    workspaceDir: path.join(root, "agents", agentId),
    stateDir: path.join(root, "state", "agents", agentId),
    larkConfigDir: path.join(root, "state", "agents", agentId, "lark-cli-config"),
  };
  const apiCalls = [];
  let reactionId = 0;
  const host = createHostShell({
    env: {
      LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-processing-eye-host",
      LARKIN_AGENTS_CONFIG: JSON.stringify([agent]),
    },
    runtimeHost: {
      subscribe() { return () => {}; },
      async start() {},
      async deliver(_id, envelope) { return { status: "accepted", deliveryId: `delivery-${envelope.message_id}` }; },
      async stop() {},
      async shutdown() {},
    },
    eventSourceStartDelayMs: 60_000,
    managedCliForAgent: testManagedCli,
    execFileImpl(_command, args, _options, callback) {
      apiCalls.push(args);
      if (args.includes("POST") && args.some((arg) => String(arg).includes("/reactions"))) {
        callback(null, JSON.stringify({ data: { reaction_id: `react_${++reactionId}` } }), "");
      } else callback(null, JSON.stringify({ ok: true, data: { items: [{ member_id: "ou_sender", name: "Sender" }] } }), "");
      return {};
    },
  });
  return { host, apiCalls };
}

function reactionPosts(apiCalls) {
  return apiCalls.filter((args) => args.includes("POST") && args.some((arg) => String(arg).includes("/reactions")));
}

async function ingest(host, agentId, { suffix, chatType = "p2p", mentionedBot = false }) {
  await host.ingest(agentId, {
    chat_id: chatType === "p2p" ? "oc_eye_dm" : "oc_eye_group",
    chat_type: chatType,
    sender_id: "ou_sender",
    message_id: `om_${suffix}`,
    event_id: `evt_${suffix}`,
    content: suffix,
    thread_id: null,
    _mentioned_bot: mentionedBot,
    _mention_all: false,
    _sender_is_bot: false,
  });
}

test("Host posts OnIt for DM and group @, and skips group messages without @", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-processing-eye-host-gate-"));
  const agentId = "cli_eyeGateA1";
  writeConfig(root, agentId);
  const { host, apiCalls } = createHost(root, agentId);
  try {
    await ingest(host, agentId, { suffix: "dm", chatType: "p2p", mentionedBot: false });
    assert.equal(reactionPosts(apiCalls).length, 1, "private chat must POST OnIt");
    assert.ok(reactionPosts(apiCalls)[0].some((arg) => String(arg).includes("/open-apis/im/v1/messages/om_dm/reactions")));
    assert.ok(reactionPosts(apiCalls)[0].some((arg) => String(arg).includes("OnIt")));

    await ingest(host, agentId, { suffix: "group_mention", chatType: "group", mentionedBot: true });
    assert.equal(reactionPosts(apiCalls).length, 2, "group @ must POST OnIt");
    assert.ok(reactionPosts(apiCalls)[1].some((arg) => String(arg).includes("/open-apis/im/v1/messages/om_group_mention/reactions")));

    await ingest(host, agentId, { suffix: "group_plain", chatType: "group", mentionedBot: false });
    assert.equal(reactionPosts(apiCalls).length, 2, "group without @ must not POST OnIt");
  } finally {
    await host.shutdown("cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Leftover processingEye.enabled does not restore a master OnIt switch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-processing-eye-host-legacy-"));
  const agentId = "cli_eyeLegacyA1";
  writeConfig(root, agentId, { processingEye: { enabled: false } });
  const { host, apiCalls } = createHost(root, agentId);
  try {
    await ingest(host, agentId, { suffix: "legacy_off_dm", chatType: "p2p", mentionedBot: false });
    assert.equal(reactionPosts(apiCalls).length, 1, "retired enabled=false must not suppress DM OnIt");

    writeConfig(root, agentId, { processingEye: { enabled: true } });
    await ingest(host, agentId, { suffix: "legacy_on_group", chatType: "group", mentionedBot: false });
    assert.equal(reactionPosts(apiCalls).length, 1, "retired enabled=true must not OnIt a group without @");
  } finally {
    await host.shutdown("cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
