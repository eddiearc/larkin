import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";
import { createRuntimeHost } from "../../../dist/runtime/runtime-host.mjs";
import { createNativeRuntimeAdapter } from "../../../dist/runtime/runtime-adapters.mjs";
import { createHostShell } from "../../../dist/feishu/host-shell.mjs";

class Session {
  sessionId = "synthetic-session";
  listeners = new Set();
  inputs = [];
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(event) { if (event.type === "turn-end") event = { outcome: "success", ...event }; for (const fn of this.listeners) fn(event); }
  async prompt(input) { this.inputs.push(input); return { status: "accepted", inputId: input.inputId }; }
  async busyInput(input) { return this.prompt(input); }
  async steer(text) { this.inputs.push(text); }
  async abort() {}
  async close() {}
}

async function fixture(run, { nativePi = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-delivery-recovery-"));
  const agentId = "cli_deliveryRecoveryA1";
  const store = createAgentStateStore(root, agentId);
  const agent = { agentId, name: agentId, runtime: nativePi ? "pi" : "codex", model: "fixture", feishuAppId: agentId,
    feishuProfile: agentId, larkConfigDir: path.join(store.paths.root, "lark-cli-config"),
    workspaceDir: path.join(root, "agents", agentId), stateDir: store.paths.root };
  let host, runtime, session, inject;
  let sequence = 0;
  const events = [];
  const start = async () => {
    session = new Session();
    runtime = createRuntimeHost({
      adapterFor: () => nativePi
        ? { ...createNativeRuntimeAdapter("pi", { createPiSession: async () => session }),
          async probe() { return { runtime: "pi", state: "ready" }; } }
        : { id: "codex", capabilities: {}, async createSession() { return session; } },
      promptBuilder: new ContextPromptBuilder(), stateStoreFor: () => store, assertOfficialCliReady: async () => {},
    });
    const subscribe = runtime.subscribe.bind(runtime);
    runtime.subscribe = (fn) => { inject = fn; return subscribe(fn); };
    subscribe((event) => events.push(event));
    host = createHostShell({
      env: { LARKIN_HOME: root, LARKIN_CONFIG_DIR: root, LARKIN_SERVER_ID: "server-recovery-fixture",
        LARKIN_AGENTS_CONFIG: JSON.stringify([agent]), LARKIN_FEISHU_DRYRUN: "1",
        LARKIN_FEISHU_EVENT_FILE: path.join(root, "events.ndjson"), LARKIN_INBOUND_DROUGHT_SEC: "0" },
      runtimeHost: runtime, stateStoreForImpl: () => store, eventSourceStartDelayMs: 60_000, logImpl() {},
      managedCliForAgent: () => ({ command: { command: "/test/official-lark-cli", argsPrefix: [], version: "1.0.80" }, env: {} }),
      execFileImpl(_command, _args, _options, callback) {
        callback(null, JSON.stringify({ ok: true, data: { items: [{ member_id: "ou_fixture", name: "Sender" }] } }), "");
        return {};
      },
    });
    await host.start();
  };
  const ingest = async (chatId = "oc_recovery") => {
    const id = ++sequence;
    await host.ingest(agentId, { chat_id: chatId, chat_type: "group", sender_id: "ou_fixture",
      message_id: `om_recovery_${id}`, event_id: `evt_recovery_${id}`, content: "synthetic request",
      _mentioned_bot: true, _sender_is_bot: true });
    return session.inputs.at(-1).inputId;
  };
  const fail = async (category = "provider") => {
    const inputId = await ingest();
    session.emit({ type: "turn-start" });
    session.emit({ type: "input-error", inputId, retryable: false, willRetry: false,
      errorCategory: category, message: "synthetic account model access failure" });
    session.emit({ type: "turn-end" });
    assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "error");
  };
  const succeed = ({ poll = true, output = true, target = "chat:oc_recovery" } = {}) => {
    session.emit({ type: "turn-start" });
    if (poll) store.pollInbox({ target });
    if (output) session.emit({ type: "activity", activity: "text" });
    session.emit({ type: "turn-end" });
  };
  try {
    await start();
    await run({ agentId, store, events, ingest, fail, succeed,
      session: () => session, inject: (event) => inject(event),
      restart: async () => { await host.shutdown("synthetic restart"); await start(); } });
  } finally {
    await host?.shutdown("recovery test complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("Host/Runtime recover terminal model-access failure only after successful turn and canonical consumption", async () => {
  await fixture(async ({ store, fail, ingest, succeed, events, restart }) => {
    await fail();
    const before = store.readJson("status", {});
    await ingest();
    assert.equal(store.readJson("status", {}).runtimeReadiness.state, "unavailable", "accepted input alone is insufficient");
    succeed();
    const after = store.readJson("status", {});
    assert.equal(after.runtimeReadiness.state, "ready");
    assert.equal(after.inboundDeliveryHealth.state, "healthy");
    assert.ok(after.inboundDeliveryHealth.recoveredAt);
    assert.equal(after.inboundDeliveryHealth.lastFailure.at, before.inboundDeliveryHealth.at);
    assert.deepEqual(after.recentErrors, before.recentErrors, "historical diagnostics remain intact");
    assert.ok(after.deliverLog.some((entry) => entry.status === "error"));
    assert.equal(events.filter((event) => event.type === "delivery-recovered").length, 1);
    assert.ok(store.readJson("runtimeDeliveries", {}).records.every((record) => record.status === "consumed"));
    await restart();
    assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "healthy", "recovery persists across daemon restart");
  });
});

for (const blocker of ["unconsumed-failure", "activity-only", "no-output", "failed-after-poll", "auth", "canonical-conflict"]) {
  test(`Host/Runtime delivery recovery fails closed for ${blocker}`, async () => {
    await fixture(async ({ store, fail, ingest, succeed, session, events }) => {
      await fail(blocker === "auth" ? "auth" : "provider");
      const inputId = await ingest(blocker === "unconsumed-failure" ? "oc_other" : "oc_recovery");
      if (blocker === "activity-only") session().emit({ type: "activity", activity: "text" });
      else if (blocker === "failed-after-poll") {
        session().emit({ type: "turn-start" });
        store.pollInbox({ target: "chat:oc_recovery" });
        session().emit({ type: "activity", activity: "text" });
        session().emit({ type: "input-error", inputId, retryable: false, willRetry: false, errorCategory: "provider", message: "failed after poll" });
        session().emit({ type: "turn-end" });
      } else if (blocker === "auth") {
        // Consumption plus an empty turn must not clear a persisted auth blocker.
        succeed({ output: false });
      } else if (blocker === "canonical-conflict") {
        store.pollInbox({ target: "chat:oc_recovery" });
        store.writeJson("inboxState", { version: 1, targets: {}, messages: {} });
        succeed();
      } else succeed({ target: blocker === "unconsumed-failure" ? "chat:oc_other" : "chat:oc_recovery", output: blocker !== "no-output" });
      assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "error");
      assert.notEqual(store.readJson("status", {}).runtimeReadiness.state, "ready");
      assert.equal(events.filter((event) => event.type === "delivery-recovered").length, 0);
    });
  });
}

for (const state of ["missing", "unauthenticated", "incompatible", "unavailable"]) {
  test(`Host preserves explicit ${state} prerequisite after a successful consumed turn`, async () => {
    await fixture(async ({ agentId, store, fail, ingest, succeed, inject }) => {
      await fail();
      inject({ type: "agent-status", agentId, status: "error", readiness: { runtime: "codex", state, reason: "explicit prerequisite" } });
      await ingest();
      succeed();
      assert.equal(store.readJson("status", {}).runtimeReadiness.state, state);
      assert.equal(store.readJson("status", {}).runtimeReadiness.reason, "explicit prerequisite");
      assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "error");
    });
  });
}

test("Host rejects recovery for another agent/runtime/session/launch and after daemon restart", async () => {
  await fixture(async ({ agentId, store, events, fail, ingest, succeed, inject, restart, session }) => {
    await fail();
    const old = session();
    const sessionEvent = events.find((event) => event.type === "session");
    const proof = { type: "delivery-recovered", agentId, runtime: "codex", launchId: sessionEvent.launchId, sessionId: sessionEvent.sessionId };
    await ingest();
    store.pollInbox({ target: "chat:oc_recovery" });
    for (const patch of [{ agentId: "cli_otherA1" }, { runtime: "claude" }, { launchId: "old-launch" }, { sessionId: "old-session" }]) {
      inject({ ...proof, ...patch });
      assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "error");
    }
    await restart();
    inject(proof);
    old.emit({ type: "turn-start" });
    old.emit({ type: "activity", activity: "text" });
    old.emit({ type: "turn-end" });
    assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "error");
    await ingest();
    succeed();
    assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "healthy");
  });
});

for (const category of ["quota", "billing"]) {
  test(`Host/Runtime recover terminal ${category} failure without replaying the failed input`, async () => {
    await fixture(async ({ store, fail, ingest, succeed, session }) => {
      await fail(category);
      await ingest();
      succeed();
      await new Promise((resolve) => setTimeout(resolve, 300));
      assert.equal(store.readJson("status", {}).runtimeReadiness.state, "ready");
      assert.equal(session().inputs.length, 2, "health repair must not submit an automatic paid retry");
    });
  });
}

test("Host/Runtime recover when canonical consumption becomes visible after successful turn-end", async () => {
  await fixture(async ({ agentId, store, fail, ingest, succeed, inject }) => {
    await fail();
    inject({ type: "agent-status", agentId, status: "active", readiness: { runtime: "codex", state: "ready" } });
    assert.equal(store.readJson("status", {}).runtimeReadiness.state, "unavailable", "active alone cannot mask an unresolved failure");
    await ingest();
    succeed({ poll: false });
    assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "error");
    store.pollInbox({ target: "chat:oc_recovery" });
    const deadline = Date.now() + 2_000;
    while (store.readJson("status", {}).inboundDeliveryHealth.state === "error" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(store.readJson("status", {}).runtimeReadiness.state, "ready");
    assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "healthy");
  });
});

test("fresh Runtime readiness after restart does not inherit a fully consumed historical delivery fault", async () => {
  await fixture(async ({ store, fail, restart, ingest, succeed }) => {
    await fail();
    store.pollInbox({ target: "chat:oc_recovery" });
    await restart();
    assert.equal(store.readJson("status", {}).runtimeReadiness.state, "ready", "a drained historical fault must not block fresh dispatch after a successful prerequisite probe");
    assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "error", "startup alone does not claim successful delivery recovery");
    await ingest();
    succeed();
    assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "healthy");
  });
});

test("startup does not submit a paid unread replay while a terminal delivery is unresolved", { timeout: 10_000 }, async () => {
  await fixture(async ({ store, fail, restart, session }) => {
    await fail();
    await restart();
    await new Promise((resolve) => setTimeout(resolve, 5_200));
    assert.equal(store.readJson("status", {}).runtimeReadiness.state, "unavailable");
    assert.equal(session().inputs.length, 0, "the startup redelivery timer must respect the unresolved delivery gate");
    assert.equal(store.readJson("runtimeDeliveries", {}).records.filter((record) => record.status === "error").length, 1);
  });
});

test("passive unread messages do not block proven delivery recovery or startup readiness", async () => {
  await fixture(async ({ store, fail, ingest, succeed, restart }) => {
    await fail();
    await ingest();
    store.appendCanonicalInboxOnce({ message_id: "om_passive", target: "chat:oc_passive", content: "passive fixture", wake: false });
    succeed();
    assert.equal(store.areRuntimeDeliveriesConsumed(), true);
    assert.equal(store.readJson("status", {}).runtimeReadiness.state, "ready");
    assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "healthy");
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), ["om_passive"]);
    await restart();
    assert.equal(store.readJson("status", {}).runtimeReadiness.state, "ready");
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), ["om_passive"]);
  });
});

test("Host failures before ledger creation require consumption of the exact failed message", async () => {
  await fixture(async ({ agentId, store, ingest, succeed, inject }) => {
    store.appendCanonicalInboxOnce({ message_id: "om_before_ledger", target: "chat:oc_failed", content: "failed fixture", wake: true });
    inject({ type: "delivery", agentId, messageId: "om_before_ledger", deliveryId: "missing-ledger", status: "error" });
    await ingest();
    succeed();
    assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "error");
    assert.equal(store.readJson("status", {}).runtimeReadiness.state, "unavailable");
    store.pollInbox({ target: "chat:oc_failed" });
    const deadline = Date.now() + 2_000;
    while (store.readJson("status", {}).inboundDeliveryHealth.state === "error" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "healthy");
    assert.equal(store.readJson("status", {}).runtimeReadiness.state, "ready");
  });
});

for (const outcome of ["error", "aborted", "pending", "deferred", "stop", "length", "toolUse"]) {
  test(`native Pi unowned ${outcome} follow-up requires successful completion to recover Host delivery health`, async () => {
    await fixture(async ({ store, ingest, session, events }) => {
      await ingest();
      const end = (stopReason) => {
        session().emit({ type: "agent_end", messages: [{ role: "assistant", stopReason,
          ...(stopReason === "error" ? { errorMessage: "insufficient quota" } : {}) }] });
        session().emit({ type: "agent_settled" });
      };
      session().emit({ type: "turn_start" });
      end("error");
      assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "error");
      assert.equal(store.readJson("runtimeDeliveries", {}).records[0].status, "error");
      // A native follow-up has no new Host-owned input. Partial text/tool output
      // and a canonical poll cannot prove that this follow-up completed well.
      session().emit({ type: "turn_start" });
      store.pollInbox({ target: "chat:oc_recovery" });
      if (outcome === "aborted") session().emit({ type: "tool_execution_start", toolName: "synthetic_tool" });
      else session().emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "partial synthetic output" } });
      end(outcome);
      const successful = ["stop", "length", "toolUse"].includes(outcome);
      assert.equal(events.filter((event) => event.type === "delivery-recovered").length, successful ? 1 : 0);
      assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, successful ? "healthy" : "error");
      assert.equal(store.readJson("status", {}).runtimeReadiness.state, successful ? "ready" : "unavailable");
      assert.equal(session().inputs.length, 1, "native failure evidence must not submit an extra Host prompt");
    }, { nativePi: true });
  });
}

for (const outcome of ["error", "aborted", "unknown"]) {
  test(`Host refuses recovery on unowned ${outcome} terminal evidence without input-error`, async () => {
    await fixture(async ({ store, fail, session, events }) => {
      await fail();
      session().emit({ type: "turn-start" });
      store.pollInbox({ target: "chat:oc_recovery" });
      session().emit({ type: "activity", activity: "text" });
      session().emit({ type: "turn-end", outcome });
      assert.equal(events.filter((event) => event.type === "delivery-recovered").length, 0);
      assert.equal(store.readJson("status", {}).inboundDeliveryHealth.state, "error");
      assert.equal(store.readJson("status", {}).runtimeReadiness.state, "unavailable");
    });
  });
}
