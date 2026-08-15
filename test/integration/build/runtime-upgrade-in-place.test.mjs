import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { runAgentCli } from "../../../dist/app/agent-cli.mjs";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";
import { createRuntimeHost } from "../../../dist/runtime/runtime-host.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURES = ["v0.2.79-active-thread.json", "v0.3.3-active-thread.json"];
const TARGET = "thread:oc_issue124_upgrade:omt_issue124_upgrade";
const STALE_NOTICE = "The Larkin Inbox changed (1 pending message). Poll that target at the next safe boundary before any target-local side effect.";
const EXACT_NOTICE = `The Larkin Inbox changed for ${TARGET} (1 pending message). Poll that target at the next safe boundary before any target-local side effect.`;

class CapturingSession {
  sessionId = "candidate-0.4.1-session";
  listeners = new Set();
  prompts = [];
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  emit(event) { for (const listener of this.listeners) listener(event); }
  async prompt(input) { this.prompts.push(structuredClone(input)); return { status: "accepted", inputId: input.inputId }; }
  async busyInput(input) { throw new Error(`unexpected busy input ${input.inputId}`); }
  async cancel() {}
  async close() {}
}

function loadFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "test", "fixtures", "runtime-upgrade", name), "utf8"));
}

function materialize(name, mutate = () => {}) {
  const fixture = loadFixture(name);
  assert.match(fixture.provenance.capture_method, /exact tagged source/);
  assert.match(fixture.provenance.claim_boundary, /not a customer home.*full historical environment checkout/i);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-upgrade-in-place-"));
  const store = createAgentStateStore(root, fixture.agent_id);
  fs.mkdirSync(store.paths.root, { recursive: true, mode: 0o700 });
  const files = structuredClone(fixture.files);
  mutate(files);
  if (files["feishu-inbox.ndjson"] !== null) {
    const rows = files["feishu-inbox.ndjson"];
    const bytes = rows === "syntactically-malformed" ? "{not-json\n"
      : rows.length ? `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` : "";
    fs.writeFileSync(store.paths.inbox, bytes, { mode: 0o600 });
  }
  fs.writeFileSync(store.paths.inboxState, `${JSON.stringify(files["inbox-state.json"], null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(store.paths.runtimeDeliveries, `${JSON.stringify(files["runtime-deliveries.json"], null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 4,
    serverId: "server-upgrade-fixture",
    mentionPolicy: "require",
    activeAgent: fixture.agent_id,
    agents: { [fixture.agent_id]: { runtime: "codex", model: "captured" } },
  })}\n`, { mode: 0o600 });
  return { fixture, root, store };
}

function candidate(store, session, events) {
  const host = createRuntimeHost({
    adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: () => store,
  });
  host.subscribe((event) => events.push(event));
  return host;
}

for (const fixtureName of FIXTURES) {
  for (const persistedStatus of ["pending", "submitting", "accepted"]) {
    test(`${fixtureName} ${persistedStatus} upgrades in place by rebuilding the exact canonical target`, { timeout: 10_000 }, async () => {
      const { fixture, root, store } = materialize(fixtureName, (files) => {
        files["runtime-deliveries.json"].records[0].status = persistedStatus;
      });
      const session = new CapturingSession();
      const events = [];
      const host = candidate(store, session, events);
      try {
        await host.start([{ agentId: fixture.agent_id, name: fixture.agent_id, runtime: "codex", model: "captured",
          workspaceDir: path.join(root, "agents", fixture.agent_id), stateDir: store.paths.root }]);
        assert.equal(session.prompts.length, 1);
        assert.equal(session.prompts[0].text, EXACT_NOTICE);
        assert.notEqual(session.prompts[0].text, STALE_NOTICE);
        assert.equal(session.prompts[0].inputId, fixture.files["runtime-deliveries.json"].records[0].deliveryId);

        const active = store.readJson("runtimeDeliveries", { records: [] }).records[0];
        assert.equal(active.target, TARGET);
        assert.equal(active.input.text, EXACT_NOTICE);
        assert.equal(active.status, "accepted");

        let stdout = "", stderr = "";
        const code = await runAgentCli(["inbox", "poll", "--target", TARGET, "--limit", "1"], {
          LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: fixture.agent_id,
        }, { stateStore: store, io: { stdout: (text) => { stdout += text; }, stderr: (text) => { stderr += text; } } });
        assert.equal(code, 0, stderr);
        const poll = JSON.parse(stdout);
        assert.deepEqual(poll.events.map((row) => row.message_id), [active.messageId]);
        assert.deepEqual(poll.consumed_delivery_ids, [active.deliveryId]);
        assert.equal(poll.reply_target, TARGET);

        session.emit({ type: "turn-start", turnId: `upgrade-${persistedStatus}` });
        session.emit({ type: "turn-end", turnId: `upgrade-${persistedStatus}` });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(session.prompts.length, 1, "direct-acked upgrade delivery must not retry at turn end");
        const ledger = store.readJson("runtimeDeliveries", { records: [] }).records;
        assert.equal(ledger.length, 1);
        assert.equal(ledger[0].status, "consumed");
        assert.equal(events.filter((event) => event.type === "delivery" && event.status === "consumed").length, 1);
      } finally {
        await host.shutdown("upgrade fixture complete");
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }
}

test("startup rebuilds wake reason from the canonical Inbox row rather than stale Runtime text", { timeout: 10_000 }, async () => {
  const canonicalReason = "canonical-upgrade-reason";
  const { fixture, root, store } = materialize("v0.3.3-active-thread.json", (files) => {
    files["feishu-inbox.ndjson"][0].wake_reason = canonicalReason;
    files["runtime-deliveries.json"].records[0].input.text = `${STALE_NOTICE}; reason=stale-runtime-only-reason`;
  });
  const session = new CapturingSession();
  const host = candidate(store, session, []);
  try {
    await host.start([{ agentId: fixture.agent_id, name: fixture.agent_id, runtime: "codex", model: "captured",
      workspaceDir: path.join(root, "agents", fixture.agent_id), stateDir: store.paths.root }]);
    assert.equal(session.prompts.length, 1);
    assert.match(session.prompts[0].text, new RegExp(`reason=${canonicalReason}`));
    assert.doesNotMatch(session.prompts[0].text, /stale-runtime-only-reason/);
    const record = store.readJson("runtimeDeliveries", { records: [] }).records[0];
    assert.equal(record.wakeReason, canonicalReason);
    assert.equal(record.input.text, session.prompts[0].text);
  } finally {
    await host.shutdown("canonical wake reason upgrade complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("invalid or missing legacy canonical rows are quarantined visibly without target guessing", { timeout: 10_000 }, async () => {
  const cases = [
    ["missing", (files) => { files["feishu-inbox.ndjson"] = null; }],
    ["orphan-thread", (files) => { delete files["feishu-inbox.ndjson"][0].chat_id; }],
    ["conflicting-target", (files) => { files["feishu-inbox.ndjson"][0].target = "chat:oc_wrong"; }],
    ["conflicting-sequence", (files) => { files["inbox-state.json"].messages.om_upgrade_033.seq = 2; }],
    ["malformed-row-sequence", (files) => { files["feishu-inbox.ndjson"][0].target_seq = "one"; }],
    ["pending-row-marked-consumed", (files) => { files["inbox-state.json"].targets[TARGET].model_seen_seq = 1; }],
    ["malformed-structured-target", (files) => { files["runtime-deliveries.json"].records[0].target = "dm:oc_unsafe_fallback"; }],
    ["conflicting-wake-reason", (files) => { files["runtime-deliveries.json"].records[0].wakeReason = "stale runtime-only reason"; }],
    ["duplicate-message-id", (files) => { files["feishu-inbox.ndjson"].push(structuredClone(files["feishu-inbox.ndjson"][0])); }],
    ["syntactically-malformed", (files) => { files["feishu-inbox.ndjson"] = "syntactically-malformed"; }],
  ];
  for (const [label, mutate] of cases) {
    const { fixture, root, store } = materialize("v0.3.3-active-thread.json", mutate);
    const inboxBytes = fs.existsSync(store.paths.inbox) ? fs.readFileSync(store.paths.inbox) : null;
    const session = new CapturingSession();
    const events = [];
    const host = candidate(store, session, events);
    try {
      await host.start([{ agentId: fixture.agent_id, name: fixture.agent_id, runtime: "codex", model: "captured",
        workspaceDir: path.join(root, "agents", fixture.agent_id), stateDir: store.paths.root }]);
      assert.equal(session.prompts.length, 0, `${label}: stale RuntimeInput must not be submitted`);
      const record = store.readJson("runtimeDeliveries", { records: [] }).records[0];
      assert.equal(record.status, "error", label);
      assert.equal(record.retryable, false, label);
      assert.match(record.reason, /Runtime delivery quarantined/);
      assert.notEqual(record.input.text, STALE_NOTICE, `${label}: terminal state must scrub the stale targetless notice`);
      assert.ok(events.some((event) => event.type === "delivery" && event.status === "error"), label);
      assert.ok(events.some((event) => event.type === "agent-status" && event.status === "error" && /quarantined/.test(event.error)), label);
      assert.deepEqual(fs.existsSync(store.paths.inbox) ? fs.readFileSync(store.paths.inbox) : null, inboxBytes,
        `${label}: malformed/missing Inbox evidence must not be rewritten or consumed`);
    } finally {
      await host.shutdown(`invalid upgrade case ${label}`);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("a terminal upgrade quarantine remains visibly degraded on later startups", { timeout: 10_000 }, async () => {
  const { fixture, root, store } = materialize("v0.3.3-active-thread.json", (files) => {
    files["feishu-inbox.ndjson"] = null;
  });
  const startOnce = async () => {
    const session = new CapturingSession();
    const events = [];
    const host = candidate(store, session, events);
    await host.start([{ agentId: fixture.agent_id, name: fixture.agent_id, runtime: "codex", model: "captured",
      workspaceDir: path.join(root, "agents", fixture.agent_id), stateDir: store.paths.root }]);
    return { host, session, events };
  };
  let first, second;
  try {
    first = await startOnce();
    assert.equal(first.session.prompts.length, 0);
    assert.ok(first.events.some((event) => event.type === "agent-status" && event.status === "error" && /quarantined/.test(event.error)));
    await first.host.shutdown("first quarantined startup");
    first = null;

    second = await startOnce();
    assert.equal(second.session.prompts.length, 0);
    assert.ok(second.events.some((event) => event.type === "delivery" && event.status === "error"));
    assert.ok(second.events.some((event) => event.type === "agent-status" && event.status === "error" && /quarantined/.test(event.error)),
      "a later Runtime-ready event must not hide unresolved terminal recovery state");
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "error");
  } finally {
    if (first) await first.host.shutdown("cleanup first quarantine");
    if (second) await second.host.shutdown("cleanup second quarantine");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a partial poll winning candidate startup consumes only its row and rebuilds the remaining exact target", { timeout: 10_000 }, async () => {
  const secondMessageId = "om_upgrade_033_second";
  const secondDeliveryId = "6e157f81-569c-4127-8bfd-4932376896dd";
  const { fixture, root, store } = materialize("v0.3.3-active-thread.json", (files) => {
    const secondRow = { ...structuredClone(files["feishu-inbox.ndjson"][0]),
      message_id: secondMessageId, target_seq: 2, content: "second captured-shape row" };
    files["feishu-inbox.ndjson"].push(secondRow);
    files["inbox-state.json"].targets[TARGET].latest_received_seq = 2;
    files["inbox-state.json"].messages[secondMessageId] = { target: TARGET, seq: 2 };
    const secondRecord = structuredClone(files["runtime-deliveries.json"].records[0]);
    secondRecord.deliveryId = secondDeliveryId;
    secondRecord.messageId = secondMessageId;
    secondRecord.status = "submitting";
    secondRecord.input.inputId = secondDeliveryId;
    secondRecord.input.deliveryId = secondDeliveryId;
    files["runtime-deliveries.json"].records.push(secondRecord);
  });
  const firstMessageId = fixture.files["runtime-deliveries.json"].records[0].messageId;
  const originalResolve = store.resolveInboxDeliverySource.bind(store);
  let partialPoll;
  store.resolveInboxDeliverySource = (messageId) => {
    const resolution = originalResolve(messageId);
    if (!partialPoll && messageId === firstMessageId && resolution.status === "pending") {
      partialPoll = store.pollInbox({ target: resolution.target, limit: 1 });
    }
    return resolution;
  };
  const session = new CapturingSession();
  const events = [];
  const host = candidate(store, session, events);
  try {
    await host.start([{ agentId: fixture.agent_id, name: fixture.agent_id, runtime: "codex", model: "captured",
      workspaceDir: path.join(root, "agents", fixture.agent_id), stateDir: store.paths.root }]);
    assert.deepEqual(partialPoll.envelopes.map((row) => row.message_id), [firstMessageId]);
    assert.equal(session.prompts.length, 1);
    assert.equal(session.prompts[0].inputId, secondDeliveryId);
    assert.equal(session.prompts[0].text, EXACT_NOTICE);
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), [secondMessageId]);
    const statuses = Object.fromEntries(store.readJson("runtimeDeliveries", { records: [] }).records
      .map((record) => [record.messageId, record.status]));
    assert.deepEqual(statuses, { [firstMessageId]: "consumed", [secondMessageId]: "accepted" });
    assert.equal(events.filter((event) => event.type === "delivery" && event.status === "consumed").length, 1);

    const finalPoll = store.pollInbox({ target: TARGET, limit: 1 });
    assert.deepEqual(finalPoll.envelopes.map((row) => row.message_id), [secondMessageId]);
    session.emit({ type: "turn-start", turnId: "partial-upgrade-race" });
    session.emit({ type: "turn-end", turnId: "partial-upgrade-race" });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(session.prompts.length, 1);
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records.every((record) => record.status === "consumed"), true);
  } finally {
    await host.shutdown("partial startup poll race complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an Agent CLI poll winning the candidate startup race consumes once and prevents rebuilt replay", { timeout: 10_000 }, async () => {
  const { fixture, root, store } = materialize("v0.3.3-active-thread.json");
  const originalResolve = store.resolveInboxDeliverySource.bind(store);
  let raced = false;
  store.resolveInboxDeliverySource = (messageId) => {
    const resolution = originalResolve(messageId);
    if (!raced && resolution.status === "pending") {
      raced = true;
      const poll = store.pollInbox({ target: resolution.target, limit: 1 });
      assert.deepEqual(poll.envelopes.map((row) => row.message_id), [messageId]);
      assert.equal(poll.consumedDeliveryIds.length, 1);
    }
    return resolution;
  };
  const session = new CapturingSession();
  const events = [];
  const host = candidate(store, session, events);
  try {
    await host.start([{ agentId: fixture.agent_id, name: fixture.agent_id, runtime: "codex", model: "captured",
      workspaceDir: path.join(root, "agents", fixture.agent_id), stateDir: store.paths.root }]);
    assert.equal(raced, true);
    assert.equal(session.prompts.length, 0);
    assert.deepEqual(store.readNdjson("inbox"), []);
    assert.equal(store.readJson("runtimeDeliveries", { records: [] }).records[0].status, "consumed");
    assert.equal(events.filter((event) => event.type === "delivery" && event.status === "consumed").length, 1);
  } finally {
    await host.shutdown("startup poll race complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
