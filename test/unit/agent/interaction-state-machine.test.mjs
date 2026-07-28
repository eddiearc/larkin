import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const interactions = await import(pathToFileURL(path.join(ROOT, "dist/agent/interaction-state-machine.mjs")).href);
const state = await import(pathToFileURL(path.join(ROOT, "dist/agent/agent-state-store.mjs")).href);

function callbackValue(card, index = 0) {
  const button = card.body.elements.filter((item) => item.tag === "button")[index];
  return button.behaviors.find((behavior) => behavior.type === "callback").value;
}

const validDefinition = (effect = undefined) => ({
  schema_version: 1,
  initial_state: "pending",
  expires_in_seconds: 3600,
  audience: { open_ids: ["ou_owner"] },
  states: {
    pending: { title: "Decision", markdown: "Choose an action." },
    processing: { title: "Decision", markdown: "Agent is processing." },
    done: { title: "Done", markdown: "Completed.", terminal: true },
    failed: { title: "Failed", markdown: "Agent could not complete it.", terminal: true },
    timed_out: { title: "Timed out", markdown: "Agent did not resolve in time.", terminal: true },
  },
  actions: {
    complete: {
      from: ["pending"],
      label: "Complete",
      success_state: "done",
      failure_state: "failed",
      timeout_state: "timed_out",
      processing_state: "processing",
      agent: { instruction: "Verify the request and resolve this run." },
      reflex: { toast: "Accepted. Agent is processing.", ...(effect ? { effect } : {}) },
      result_schema: { properties: { ticket: { type: "string", max_length: 100 } }, required: [], additional_properties: false },
    },
  },
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-interaction-"));
  const agentId = "cli_interactionA1";
  const store = state.createAgentStateStore(root, agentId);
  let now = Date.parse("2026-07-23T00:00:00.000Z");
  let sequence = 0;
  const machine = new interactions.InteractionStateMachine({
    stateStore: store,
    agentId,
    now: () => now,
    randomId: (prefix) => `${prefix}_${++sequence}`,
  });
  return { root, agentId, store, machine, advance: (ms) => { now += ms; } };
}

test("compile persists an immutable graph and emits opaque CardKit v2 action references", () => {
  const f = fixture();
  try {
    const created = f.machine.create({ definition: validDefinition(), expected_chat_id: "oc_decision" });
    assert.equal(created.instance.current_state, "pending");
    assert.equal(created.instance.state_version, 1);
    assert.equal(created.card.schema, "2.0");
    assert.match(JSON.stringify(created.card), /Complete/);
    assert.equal(created.card.body.elements.some((item) => item.tag === "action"), false, "CardKit v2 must not emit the removed action container");
    assert.equal(created.card.body.elements.find((item) => item.tag === "button").behaviors[0].type, "callback");
    assert.doesNotMatch(JSON.stringify(created.card), /Verify the request/, "Agent instruction must not leak into card action values");
    const actionValue = callbackValue(created.card);
    assert.deepEqual(Object.keys(actionValue), ["interaction_ref", "interaction_version"]);
    assert.match(actionValue.interaction_ref, /^ref_/);
    assert.equal(f.machine.get({ instance_id: created.instance.instance_id }).definition.initial_state, "pending");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("compile rejects unsafe or incomplete definitions before persistence", () => {
  const f = fixture();
  try {
    const cases = [
      { ...validDefinition(), arbitrary_url: "https://example.test/callback" },
      { ...validDefinition(), actions: { complete: { ...validDefinition().actions.complete, agent: undefined } } },
      { ...validDefinition(), actions: { complete: { ...validDefinition().actions.complete, success_state: "missing" } } },
      validDefinition({ id: "shell.exec", args: { command: "rm -rf" } }),
      JSON.parse(JSON.stringify(validDefinition()).replace('"pending":{"title"', '"constructor":{"title":"bad","markdown":"bad"},"pending":{"title"')),
    ];
    for (const candidate of cases) assert.throws(() => f.machine.create({ definition: candidate, expected_chat_id: "oc_decision" }));
    assert.deepEqual(f.store.readJson("interactions", { instances: [] }).instances, []);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("processing UI is engine-owned and stale card versions are rejected", () => {
  const f = fixture();
  try {
    const spec = validDefinition();
    spec.states.processing = { title: "Success", markdown: "Everything completed." };
    spec.actions.complete.reflex.toast = "Success; completed.";
    const created = f.machine.create({ definition: spec, expected_chat_id: "oc_decision" });
    const value = callbackValue(created.card);
    assert.throws(() => f.machine.claim({ interaction_ref: value.interaction_ref, expected_version: 99, callback_id: "cb_stale", operator_open_id: "ou_owner", chat_id: "oc_decision", message_id: "om_card" }), /version is stale/);
    const claimed = f.machine.claim({ interaction_ref: value.interaction_ref, expected_version: value.interaction_version, callback_id: "cb_truth", operator_open_id: "ou_owner", chat_id: "oc_decision", message_id: "om_card" });
    assert.match(JSON.stringify(claimed.card), /当前状态不代表业务已经完成/);
    assert.doesNotMatch(JSON.stringify(claimed.card), /Everything completed/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("claim is durable, authorized, replay-safe and always creates one Agent wake", () => {
  const f = fixture();
  try {
    const created = f.machine.create({ definition: validDefinition(), expected_chat_id: "oc_decision" });
    const ref = callbackValue(created.card).interaction_ref;
    assert.throws(() => f.machine.claim({ interaction_ref: ref, expected_version: 1, callback_id: "cb_bad", operator_open_id: "ou_other", chat_id: "oc_decision", message_id: "om_card" }), /not allowed/);
    const first = f.machine.claim({ interaction_ref: ref, expected_version: 1, callback_id: "cb_1", operator_open_id: "ou_owner", chat_id: "oc_decision", message_id: "om_card" });
    const replay = f.machine.claim({ interaction_ref: ref, expected_version: 1, callback_id: "cb_1", operator_open_id: "ou_owner", chat_id: "oc_decision", message_id: "om_card" });
    assert.equal(replay.run.run_id, first.run.run_id);
    assert.equal(replay.duplicate, true);
    assert.equal(first.run.agent_delivery_status, "pending");
    assert.equal(first.run.reflex.status, "pending");
    assert.equal(first.instance.current_state, "processing");
    const snapshot = f.machine.snapshot();
    assert.equal(snapshot.runs.length, 1);
    assert.equal(snapshot.outbox.filter((item) => item.kind === "agent_wake").length, 1);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("reflex result is truthful and resolve uses owner plus expected-version CAS", () => {
  const f = fixture();
  try {
    const created = f.machine.create({ definition: validDefinition(), expected_chat_id: "oc_decision" });
    const ref = callbackValue(created.card).interaction_ref;
    const claimed = f.machine.claim({ interaction_ref: ref, expected_version: 1, callback_id: "cb_1", operator_open_id: "ou_owner", chat_id: "oc_decision", message_id: "om_card" });
    f.machine.recordReflex(claimed.run.run_id, { status: "failed", summary: "reference effect failed safely", data: { category: "fixture" } });
    assert.equal(f.machine.get({ run_id: claimed.run.run_id }).run.reflex.status, "failed");
    assert.throws(() => f.machine.resolve({ run_id: claimed.run.run_id, expected_version: 1, status: "succeeded", summary: "done", agent_id: f.agentId }), /version/);
    assert.throws(() => f.machine.resolve({ run_id: claimed.run.run_id, expected_version: 2, status: "succeeded", summary: "done", agent_id: "cli_otherA1" }), /owner/);
    const resolved = f.machine.resolve({ run_id: claimed.run.run_id, expected_version: 2, status: "succeeded", summary: "done", data: { ticket: "T-1" }, agent_id: f.agentId });
    assert.equal(resolved.instance.current_state, "done");
    assert.equal(resolved.instance.state_version, 3);
    assert.equal(resolved.run.resolve.status, "succeeded");
    assert.equal(f.machine.resolve({ run_id: claimed.run.run_id, expected_version: 2, status: "succeeded", summary: "done", data: { ticket: "T-1" }, agent_id: f.agentId }).idempotent, true);
    assert.throws(() => f.machine.resolve({ run_id: claimed.run.run_id, expected_version: 3, status: "failed", summary: "changed", agent_id: f.agentId }), /terminal/);
    assert.equal(f.machine.snapshot().outbox.filter((item) => item.kind === "card_projection").length, 2);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("expired interactions reject clicks without creating transition state", () => {
  const f = fixture();
  try {
    const created = f.machine.create({ definition: { ...validDefinition(), expires_in_seconds: 30 }, expected_chat_id: "oc_decision" });
    const ref = callbackValue(created.card).interaction_ref;
    f.advance(30_001);
    assert.throws(() => f.machine.claim({ interaction_ref: ref, expected_version: 1, callback_id: "cb_late", operator_open_id: "ou_owner", chat_id: "oc_decision", message_id: "om_card" }), /expired/);
    assert.equal(f.machine.snapshot().runs.length, 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("unresolved Agent runs advance to the declared timed-out state and queue projection", () => {
  const f = fixture();
  try {
    const spec = validDefinition();
    spec.actions.complete.agent.timeout_seconds = 30;
    const created = f.machine.create({ definition: spec, expected_chat_id: "oc_decision" });
    const ref = callbackValue(created.card).interaction_ref;
    const claimed = f.machine.claim({ interaction_ref: ref, expected_version: 1, callback_id: "cb_timeout", operator_open_id: "ou_owner", chat_id: "oc_decision", message_id: "om_card" });
    f.machine.recordReflex(claimed.run.run_id, { status: "succeeded", summary: "accepted" });
    f.advance(30_001);
    assert.equal(f.machine.expireTimedOutRuns(), 1);
    const current = f.machine.get({ run_id: claimed.run.run_id });
    assert.equal(current.instance.current_state, "timed_out");
    assert.equal(current.run.resolve.status, "timed_out");
    assert.match(JSON.stringify(current.card), /did not resolve in time/);
    assert.equal(f.machine.expireTimedOutRuns(), 0);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("claim-to-Reflex crash recovery records uncertainty and releases exactly one Agent wake", () => {
  const f = fixture();
  try {
    const created = f.machine.create({ definition: validDefinition(), expected_chat_id: "oc_decision" });
    const value = callbackValue(created.card);
    const claimed = f.machine.claim({ interaction_ref: value.interaction_ref, expected_version: value.interaction_version, callback_id: "cb_crash", operator_open_id: "ou_owner", chat_id: "oc_decision", message_id: "om_card" });
    assert.equal(f.machine.recoverInterruptedReflexes(), 0, "live callback keeps its Reflex lease");
    f.advance(3_001);
    assert.equal(f.machine.recoverInterruptedReflexes(), 1);
    assert.equal(f.machine.recoverInterruptedReflexes(), 0);
    const current = f.machine.get({ run_id: claimed.run.run_id });
    assert.equal(current.run.reflex.status, "uncertain");
    assert.equal(current.run.reflex.data.category, "reflex_interrupted");
    const wakes = f.machine.snapshot().outbox.filter((item) => item.kind === "agent_wake" && item.run_id === claimed.run.run_id);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0].status, "pending");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("resolve rejects expired ownership and validates data against the declared result schema", () => {
  const f = fixture();
  try {
    const spec = { ...validDefinition(), expires_in_seconds: 30 };
    spec.actions.complete.result_schema = {
      properties: { ticket: { type: "string", max_length: 5 } }, required: ["ticket"], additional_properties: false,
    };
    const created = f.machine.create({ definition: spec, expected_chat_id: "oc_decision" });
    const value = callbackValue(created.card);
    const claimed = f.machine.claim({ interaction_ref: value.interaction_ref, expected_version: value.interaction_version, callback_id: "cb_schema", operator_open_id: "ou_owner", chat_id: "oc_decision", message_id: "om_card" });
    f.machine.recordReflex(claimed.run.run_id, { status: "succeeded", summary: "accepted" });
    assert.throws(() => f.machine.resolve({ run_id: claimed.run.run_id, expected_version: 2, status: "succeeded", summary: "done", data: {}, agent_id: f.agentId }), /requires property ticket/);
    assert.throws(() => f.machine.resolve({ run_id: claimed.run.run_id, expected_version: 2, status: "succeeded", summary: "done", data: { ticket: "too-long" }, agent_id: f.agentId }), /max_length/);
    assert.throws(() => f.machine.resolve({ run_id: claimed.run.run_id, expected_version: 2, status: "succeeded", summary: "done", data: { ticket: "T-1", extra: true }, agent_id: f.agentId }), /not declared/);
    f.advance(30_001);
    assert.throws(() => f.machine.resolve({ run_id: claimed.run.run_id, expected_version: 2, status: "succeeded", summary: "done", data: { ticket: "T-1" }, agent_id: f.agentId }), /expired/);
    assert.equal(f.machine.expireTimedOutRuns(), 1, "expiry routes the active run to its timeout state without waiting for the longer Agent deadline");
    assert.equal(f.machine.get({ run_id: claimed.run.run_id }).run.resolve.status, "timed_out");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("capacity backpressure never slices active or pending durable state", () => {
  const f = fixture();
  try {
    const created = f.machine.create({ definition: validDefinition(), expected_chat_id: "oc_decision" });
    const value = callbackValue(created.card);
    f.machine.claim({ interaction_ref: value.interaction_ref, expected_version: value.interaction_version, callback_id: "cb_capacity", operator_open_id: "ou_owner", chat_id: "oc_decision", message_id: "om_card" });
    const seeded = f.machine.snapshot();
    const template = seeded.runs[0];
    const wake = seeded.outbox.find((item) => item.kind === "agent_wake");
    seeded.runs = Array.from({ length: 501 }, (_, index) => ({ ...template, run_id: `run_seed_${index}` }));
    seeded.outbox = Array.from({ length: 501 }, (_, index) => ({ ...wake, outbox_id: `out_seed_${index}`, run_id: `run_seed_${index}`, status: "pending" }));
    f.store.writeJson("interactions", seeded);
    assert.throws(() => f.machine.expireTimedOutRuns(), /active run capacity/);
    const after = f.machine.snapshot();
    assert.equal(after.runs.length, 501);
    assert.equal(after.outbox.length, 501);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("public create enforces atomic global byte backpressure before the persisted store becomes unreadable", { timeout: 15_000 }, () => {
  const f = fixture();
  try {
    const active = f.machine.create({ definition: validDefinition(), expected_chat_id: "oc_decision" });
    const value = callbackValue(active.card);
    const claimed = f.machine.claim({ interaction_ref: value.interaction_ref, expected_version: value.interaction_version,
      callback_id: "cb_byte_capacity", operator_open_id: "ou_owner", chat_id: "oc_decision", message_id: "om_byte_capacity" });
    f.machine.recordReflex(claimed.run.run_id, { status: "succeeded", summary: "accepted" });

    const large = validDefinition();
    for (const view of Object.values(large.states)) view.markdown = "x".repeat(7_000);
    large.states.archive_one = { title: "Archive one", markdown: "x".repeat(7_000), terminal: true };
    large.states.archive_two = { title: "Archive two", markdown: "x".repeat(7_000), terminal: true };
    large.actions.complete.agent.instruction = "x".repeat(4_000);
    let lastSafeBytes = fs.readFileSync(f.store.paths.interactions);
    let accepted = 0;
    let rejected;
    for (; accepted < 200; accepted += 1) {
      try {
        f.machine.create({ definition: large, expected_chat_id: "oc_decision" });
        lastSafeBytes = fs.readFileSync(f.store.paths.interactions);
      } catch (error) {
        rejected = error;
        break;
      }
    }
    assert.match(String(rejected), /state byte capacity/);
    assert.ok(accepted > 1 && accepted < 200);
    assert.equal(f.machine.snapshot().instances.length, accepted + 1);
    assert.deepEqual(fs.readFileSync(f.store.paths.interactions), lastSafeBytes, "failed create must not partially persist its oversized mutation");
    assert.ok(lastSafeBytes.byteLength <= interactions.MAX_INTERACTION_STATE_BYTES);
    const safe = f.machine.snapshot();
    assert.equal(safe.instances.find((item) => item.instance_id === active.instance.instance_id).active_run_id, claimed.run.run_id);
    assert.ok(safe.outbox.some((item) => item.run_id === claimed.run.run_id && item.status === "pending"), "active pending outbox work survives byte backpressure");
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test("expired interaction history is garbage-collected after the declared retention window", () => {
  const f = fixture();
  try {
    const created = f.machine.create({
      definition: { ...validDefinition(), expires_in_seconds: 30, retention_seconds: 3600 },
      expected_chat_id: "oc_decision",
    });
    assert.equal(f.machine.snapshot().instances.length, 1);
    f.advance((30 + 3600) * 1000);
    assert.equal(f.machine.expireTimedOutRuns(), 0);
    const snapshot = f.machine.snapshot();
    assert.equal(snapshot.instances.length, 0);
    assert.equal(snapshot.definitions.length, 0);
    assert.equal(snapshot.action_refs.length, 0);
    assert.throws(() => f.machine.get({ instance_id: created.instance.instance_id }), /not found/);
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
