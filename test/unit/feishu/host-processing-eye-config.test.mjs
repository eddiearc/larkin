import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";

const testManagedCli = () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} });

function writeConfig(root, agentId, processingEye) {
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4,
    serverId: "server-processing-eye-host",
    mentionPolicy: "require",
    ...(processingEye ? { processingEye } : {}),
    activeAgent: agentId,
    agents: { [agentId]: { runtime: "pi", model: "default" } },
  }, null, 2)}\n`, { mode: 0o600 });
}

function createHost(root, agentId) {
  const agent = {
    agentId, name: agentId, runtime: "pi", model: "default", feishuAppId: agentId,
    feishuProfile: agentId, workspaceDir: path.join(root, "agents", agentId),
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

async function ingest(host, agentId, suffix) {
  await host.ingest(agentId, {
    chat_id: "oc_eye_config", chat_type: "p2p", sender_id: "ou_sender", message_id: `om_${suffix}`,
    event_id: `evt_${suffix}`, content: suffix, thread_id: null,
    _mentioned_bot: false, _mention_all: false, _sender_is_bot: false,
  });
}

test("Host skips the OnIt reactions API when processingEye is omitted or disabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-processing-eye-host-off-"));
  const agentId = "cli_eyeOffA1";
  writeConfig(root, agentId);
  const { host, apiCalls } = createHost(root, agentId);
  try {
    await ingest(host, agentId, "omitted");
    assert.equal(reactionPosts(apiCalls).length, 0, "missing processingEye key must not POST OnIt");

    writeConfig(root, agentId, { enabled: false });
    await ingest(host, agentId, "explicit_off");
    assert.equal(reactionPosts(apiCalls).length, 0, "explicit processingEye.enabled=false must not POST OnIt");
  } finally {
    await host.shutdown("cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Host posts OnIt when processingEye is explicitly enabled", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-processing-eye-host-on-"));
  const agentId = "cli_eyeOnA1";
  writeConfig(root, agentId, { enabled: true });
  const { host, apiCalls } = createHost(root, agentId);
  try {
    await ingest(host, agentId, "explicit_on");
    const posts = reactionPosts(apiCalls);
    assert.equal(posts.length, 1, "explicit processingEye.enabled=true must POST OnIt");
    assert.ok(posts[0].some((arg) => String(arg).includes("/open-apis/im/v1/messages/om_explicit_on/reactions")));
    assert.ok(posts[0].some((arg) => String(arg).includes("OnIt")));
  } finally {
    await host.shutdown("cleanup");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
