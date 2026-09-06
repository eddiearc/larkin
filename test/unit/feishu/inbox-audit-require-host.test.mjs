import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
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
