import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";

const testManagedCli = () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} });

for (const mode of ["error-receipt", "throw-after-persist", "async-input-error"]) {
  test(`HostShell ${mode} keeps Inbox durable and degrades visible health without raw Runtime error data`, { timeout: 10_000 }, async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-host-delivery-health-${mode}-`));
    const agentId = `cli_issue124Health${mode === "error-receipt" ? "Receipt" : mode === "throw-after-persist" ? "Throw" : "Async"}A1`;
    const store = createAgentStateStore(root, agentId);
    const secret = "api_key=issue124-super-secret";
    let listener = () => {};
    let deliveries = 0;
    const runtimeHost = {
      subscribe(next) { listener = next; return () => {}; },
      async start() { listener({ type: "agent-status", agentId, status: "active", readiness: { runtime: "codex", state: "ready" } }); },
      async deliver() {
        deliveries += 1;
        if (mode === "throw-after-persist") throw new Error(`provider raw failure ${secret}`);
        if (mode === "async-input-error") return { status: "accepted", deliveryId: "delivery-async" };
        return { status: "error", deliveryId: `unsafe-${secret}`, reason: `raw rejected payload ${secret}`, retryable: false };
      },
      async stop() {},
      async shutdown() {},
    };
    const agent = {
      agentId, name: agentId, runtime: "codex", model: "fixture", feishuAppId: agentId, feishuProfile: agentId,
      larkConfigDir: path.join(store.paths.root, "lark-cli-config"), workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root,
    };
    const logs = [];
    const host = createHostShell({
      env: {
        LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-issue124-health",
        LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_FEISHU_DRYRUN: "1",
        LARKIN_FEISHU_EVENT_FILE: path.join(root, "events.ndjson"), LARKIN_INBOUND_DROUGHT_SEC: "0",
      }, runtimeHost, stateStoreForImpl: () => store, managedCliForAgent: testManagedCli,
      eventSourceStartDelayMs: 60_000, logImpl: (...parts) => logs.push(parts.join(" ")),
      execFileImpl(_command, _args, _options, callback) {
        callback(null, JSON.stringify({ ok: true, data: { items: [{ member_id: "ou_health_sender", name: "Sender" }] } }), "");
        return {};
      },
    });
    const event = {
      chat_id: "oc_issue124_health", chat_type: "group", sender_id: "ou_health_sender",
      message_id: `om_issue124_health_${mode}`, event_id: `evt_issue124_health_${mode}`,
      content: "raw inbound body must not enter delivery health", create_time: "1786819563000",
      thread_id: "omt_issue124_health", _mentioned_bot: true, _mention_all: false, _sender_is_bot: true,
    };
    try {
      await host.start();
      assert.equal(store.readJson("status", {}).runtimeReadiness.state, "ready");
      await host.ingest(agentId, event);
      assert.equal(deliveries, 1);
      if (mode === "async-input-error") {
        listener({ type: "runtime", agentId, event: { type: "input-error", inputId: "delivery-async",
          retryable: false, willRetry: false, errorCategory: "provider",
          message: `raw asynchronous provider payload ${secret}`, nextAction: `unsafe next action ${secret}` } });
        listener({ type: "delivery", agentId, deliveryId: "delivery-async", messageId: event.message_id,
          status: "error", reason: `raw asynchronous delivery reason ${secret}` });
      }
      const rows = store.readNdjson("inbox");
      assert.equal(rows.length, 1);
      assert.deepEqual({ message_id: rows[0].message_id, target: rows[0].target }, {
        message_id: event.message_id,
        target: `thread:${event.chat_id}:${event.thread_id}`,
      });
      const inboxState = store.readJson("inboxState", {});
      assert.equal(inboxState.targets[rows[0].target].model_seen_seq, 0, "delivery failure must not mark Agent model-seen");

      const status = store.readJson("status", {});
      assert.equal(status.runtimeReadiness.state, "incompatible");
      assert.equal(status.inboundDeliveryHealth.state, "error");
      const expectedCode = mode === "error-receipt" ? "non_retryable_receipt"
        : mode === "throw-after-persist" ? "runtime_delivery_exception" : "runtime_delivery_event";
      assert.equal(status.inboundDeliveryHealth.code, expectedCode);
      assert.match(status.runtimeReadiness.nextAction, /inspect.*restart.*replay/i);
      const errorDeliveryLog = (status.deliverLog || []).filter((entry) => entry.status === "error");
      const visible = JSON.stringify({ health: status.inboundDeliveryHealth, readiness: status.runtimeReadiness,
        recentErrors: status.recentErrors, errorDeliveryLog, logs });
      assert.doesNotMatch(visible, /issue124-super-secret|raw rejected payload|raw asynchronous|unsafe next action|raw inbound body/);

      await host.ingest(agentId, event);
      assert.equal(deliveries, 1, "transport duplicate must not create a second delivery attempt");
      assert.equal(store.readNdjson("inbox").length, 1, "transport duplicate must not append a second durable row");
    } finally {
      await host.shutdown("delivery health test complete");
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
