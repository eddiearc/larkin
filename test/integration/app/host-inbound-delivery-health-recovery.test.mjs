import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FAILURE_REASON = "Inbound Runtime delivery failed non-retryably; durable Inbox/ledger state is retained for recovery.";
const testManagedCli = () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} });

function seedResidue(store, messageId) {
  store.appendCanonicalInboxOnce({
    message_id: messageId, target: "chat:oc_legacy", chat_id: "oc_legacy", chat_type: "group",
    sender_id: "ou_legacy_sender", sender_type: "human", content: "historical fixture", create_time: "1786819563000",
  });
  const ledger = store.readJson("runtimeDeliveries", { version: 1, records: [] });
  store.writeJson("runtimeDeliveries", { ...ledger, records: [...ledger.records, {
    deliveryId: `delivery-${messageId}`, messageId, status: "consumed", target: "chat:oc_legacy",
    input: { inputId: `input-${messageId}`, deliveryId: `delivery-${messageId}` },
  }] });
}

async function fixture({ residue = 2 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-host-consumption-proof-"));
  const agentId = "cli_hostConsumptionProofA1";
  const store = createAgentStateStore(root, agentId, {
    inspectProcess: () => ({ ok: true, dead: false, startToken: "host-consumption-proof" }),
  });
  for (let index = 1; index <= residue; index += 1) seedResidue(store, `om_legacy_residue_${index}`);
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    version: 4, serverId: "server-host-consumption-proof", mentionPolicy: "require", activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "fixture" } },
  }), { mode: 0o600 });
  const agent = {
    agentId, name: agentId, runtime: "codex", model: "fixture", feishuAppId: agentId, feishuProfile: agentId,
    larkConfigDir: path.join(store.paths.root, "lark-cli-config"),
    workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root,
  };
  let listener = () => {};
  const failNext = new Set();
  const runtimeHost = {
    subscribe(next) { listener = next; return () => {}; },
    async start() { listener({ type: "agent-status", agentId, status: "active", readiness: { runtime: "codex", state: "ready" } }); },
    async deliver(_agentId, envelope) {
      const messageId = String(envelope.message_id);
      const deliveryId = `delivery-${messageId}`;
      const failed = failNext.has(messageId);
      // Mirror the Runtime Host ledger so the canonical Inbox and the durable
      // delivery records move together, as they do in production.
      const ledger = store.readJson("runtimeDeliveries", { version: 1, records: [] });
      store.writeJson("runtimeDeliveries", { ...ledger, records: [...ledger.records, {
        deliveryId, messageId, status: failed ? "error" : "accepted",
        target: String(envelope.target || ""),
        input: { inputId: `input-${messageId}`, deliveryId },
      }] });
      listener({ type: "delivery", agentId, deliveryId, messageId, status: failed ? "error" : "accepted" });
      if (failed) return { status: "error", deliveryId, reason: "fixture terminal failure", retryable: false };
      return { status: "accepted", deliveryId };
    },
    async stop() {},
    async shutdown() {},
  };
  const logs = [];
  const host = createHostShell({
    env: {
      LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-host-consumption-proof",
      LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_FEISHU_DRYRUN: "1",
      LARKIN_FEISHU_EVENT_FILE: path.join(root, "events.ndjson"), LARKIN_INBOUND_DROUGHT_SEC: "0",
    }, runtimeHost, stateStoreForImpl: () => store, managedCliForAgent: testManagedCli,
    eventSourceStartDelayMs: 60_000, logImpl: (...parts) => logs.push(parts.join(" ")),
    execFileImpl(_command, _args, _options, callback) {
      callback(null, JSON.stringify({ ok: true, data: { items: [{ member_id: "ou_proof_sender", name: "Sender" }] } }), "");
      return {};
    },
  });
  let counter = 0;
  const status = () => store.readJson("status", {});
  const ingest = async (chatId = "oc_health") => {
    const messageId = `om_health_${++counter}`;
    await host.ingest(agentId, {
      chat_id: chatId, chat_type: "group", sender_id: "ou_proof_sender", message_id: messageId,
      event_id: `evt_${messageId}`, content: "fixture task", create_time: String(Date.now()),
      _mentioned_bot: true, _mention_all: false, _sender_is_bot: true,
    });
    return messageId;
  };
  const failDelivery = async (chatId = "oc_health") => {
    const messageId = `om_health_${counter + 1}`;
    failNext.add(messageId);
    const ingested = await ingest(chatId);
    failNext.delete(ingested);
    assert.equal(status().inboundDeliveryHealth.state, "error");
    return ingested;
  };
  const poll = (target = "chat:oc_health") => {
    const result = spawnSync(process.execPath, [path.join(ROOT, "dist/app/agent-cli.mjs"), "inbox", "poll", "--target", target], {
      cwd: root, env: { ...process.env, LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: agentId },
      encoding: "utf8", timeout: 20_000,
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  const consumed = (messageId) => listener({ type: "delivery", agentId, deliveryId: `delivery-${messageId}`, messageId, status: "consumed" });
  const ledger = () => store.readJson("runtimeDeliveries", { version: 1, records: [] }).records;
  return { root, store, host, status, ingest, failDelivery, poll, consumed, ledger, logs,
    event: (next) => listener(next), agentId };
}

test("a proven consumption restores inbound health while historical Inbox residue is retained", { timeout: 30_000 }, async () => {
  const f = await fixture();
  try {
    await f.host.start();
    assert.deepEqual(f.store.readNdjson("inbox").map((row) => row.message_id), ["om_legacy_residue_1", "om_legacy_residue_2"]);
    assert.equal(f.status().inboundDeliveryHealth, undefined, "a clean startup publishes no inbound failure diagnostic");

    const failedId = await f.failDelivery();
    assert.equal(f.status().inboundDeliveryHealth.state, "error");
    assert.deepEqual(f.status().inboundDeliveryHealth.messageIds, [failedId]);
    assert.equal(f.status().runtimeReadiness.state, "unavailable");
    assert.equal(f.status().runtimeReadiness.reason, FAILURE_REASON);

    assert.deepEqual(f.poll().events.map((row) => row.message_id), [failedId]);
    assert.equal(f.status().inboundDeliveryHealth.state, "error", "a drained row is not proof until the ledger says consumed");
    f.consumed(failedId);

    assert.equal(f.status().inboundDeliveryHealth.state, "healthy");
    assert.equal(f.status().inboundDeliveryHealth.reason, undefined, "a healthy status keeps no stale recovery instruction");
    assert.equal(f.status().inboundDeliveryHealth.messageIds, undefined);
    assert.equal(f.status().runtimeReadiness.state, "ready");
    assert.deepEqual(f.store.readNdjson("inbox").map((row) => row.message_id), ["om_legacy_residue_1", "om_legacy_residue_2"],
      "historical residue is never rewritten to clear health");
    const residueRecords = f.ledger().filter((record) => record.messageId.startsWith("om_legacy_residue_"));
    assert.ok(residueRecords.every((record) => record.status === "consumed" && record.target === "chat:oc_legacy"));
    assert.ok(f.status().deliverLog.some((row) => row.status === "error"), "the failure history is kept");
    assert.ok(f.status().recentErrors.some((row) => /delivery failed non-retryably/.test(String(row.text))));
  } finally {
    await f.host.shutdown("inbound health recovery test complete");
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("a queued failed message keeps health at error until the Agent actually receives it", { timeout: 30_000 }, async () => {
  const f = await fixture({ residue: 0 });
  try {
    await f.host.start();
    const failedId = await f.failDelivery();
    // A ledger claim alone is not consumption: the canonical row is still owed.
    const ledger = f.store.readJson("runtimeDeliveries", { version: 1, records: [] });
    f.store.writeJson("runtimeDeliveries", { ...ledger,
      records: ledger.records.map((record) => record.messageId === failedId ? { ...record, status: "consumed" } : record) });
    f.consumed(failedId);
    assert.equal(f.status().inboundDeliveryHealth.state, "error");
    assert.equal(f.store.readNdjson("inbox").length, 1);

    f.poll();
    f.consumed(failedId);
    assert.equal(f.status().inboundDeliveryHealth.state, "healthy");
  } finally {
    await f.host.shutdown("queued failure test complete");
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("a later failure cannot borrow an earlier recovery", { timeout: 30_000 }, async () => {
  const f = await fixture({ residue: 1 });
  try {
    await f.host.start();
    const first = await f.failDelivery();
    f.poll();
    f.consumed(first);
    assert.equal(f.status().inboundDeliveryHealth.state, "healthy");

    const second = await f.failDelivery();
    assert.equal(f.status().inboundDeliveryHealth.state, "error");
    assert.deepEqual(f.status().inboundDeliveryHealth.messageIds, [second], "each failure requires its own consumption");
    f.consumed(first);
    assert.equal(f.status().inboundDeliveryHealth.state, "error", "a stale consumed event cannot clear a later failure");

    f.poll();
    f.consumed(second);
    assert.equal(f.status().inboundDeliveryHealth.state, "healthy");
    assert.equal(f.store.readNdjson("inbox").length, 1, "unrelated residue remains untouched");
  } finally {
    await f.host.shutdown("later failure test complete");
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("recovery never overwrites an independent Runtime diagnostic", { timeout: 30_000 }, async () => {
  const f = await fixture({ residue: 0 });
  try {
    await f.host.start();
    const failedId = await f.failDelivery();
    f.event({ type: "agent-status", agentId: f.agentId, status: "error", readiness: {
      runtime: "codex", state: "missing", reason: "independent prerequisite is missing", nextAction: "install the prerequisite" } });
    assert.equal(f.status().runtimeReadiness.state, "missing");
    f.poll();
    f.consumed(failedId);
    assert.equal(f.status().inboundDeliveryHealth.state, "healthy");
    assert.equal(f.status().runtimeReadiness.state, "missing");
    assert.equal(f.status().runtimeReadiness.reason, "independent prerequisite is missing");
  } finally {
    await f.host.shutdown("independent diagnostic test complete");
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("multiple failed messages all need proof before health clears", { timeout: 30_000 }, async () => {
  const f = await fixture({ residue: 2 });
  try {
    await f.host.start();
    const first = await f.failDelivery("oc_health_a");
    const second = await f.failDelivery("oc_health_b");
    assert.deepEqual(f.status().inboundDeliveryHealth.messageIds.sort(), [first, second].sort());
    f.poll("chat:oc_health_a");
    f.consumed(first);
    assert.equal(f.status().inboundDeliveryHealth.state, "error", "one outstanding message keeps the diagnostic");
    f.poll("chat:oc_health_b");
    f.consumed(second);
    assert.equal(f.status().inboundDeliveryHealth.state, "healthy");
  } finally {
    await f.host.shutdown("multiple failures test complete");
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});
