import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";

const AGENT = "cli_consumptionProofA1";
const TARGET = "chat:oc_proof";
const LEGACY_TARGET = "chat:oc_legacy";

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-consumption-proof-"));
  const store = createAgentStateStore(root, AGENT, {
    inspectProcess: () => ({ ok: true, dead: false, startToken: "consumption-proof" }),
  });
  return { root, store };
}

function row(messageId, target = TARGET, chatId = "oc_proof") {
  return {
    message_id: messageId, target, chat_id: chatId, chat_type: "group",
    sender_id: "ou_proof_sender", sender_type: "human", content: "proof fixture", create_time: "1786819563000",
  };
}

function deliveryRecord(messageId, status = "consumed", target) {
  return {
    deliveryId: `delivery-${messageId}`, messageId, status,
    input: { inputId: `input-${messageId}`, deliveryId: `delivery-${messageId}` },
    ...(target ? { target } : {}),
  };
}

function writeLedger(store, records) {
  store.writeJson("runtimeDeliveries", { version: 1, records });
}

function readLedger(store) {
  return store.readJson("runtimeDeliveries", { version: 1, records: [] });
}

/** A historical row that a previous release left behind after marking it consumed. */
function seedResidue(store, messageId, target = LEGACY_TARGET, chatId = "oc_legacy") {
  store.appendCanonicalInboxOnce(row(messageId, target, chatId));
  writeLedger(store, [...readLedger(store).records, deliveryRecord(messageId, "consumed", target)]);
}

function consume(store, target = TARGET) {
  const result = store.pollInbox({ target });
  assert.ok(result.envelopes.length > 0, "poll must drain canonical work");
  return result;
}

test("consumption is proven per failed message while unrelated Inbox residue stays", () => {
  const { root, store } = fixture();
  try {
    seedResidue(store, "om_legacy_residue_1");
    seedResidue(store, "om_legacy_residue_2");
    store.appendCanonicalInboxOnce(row("om_failed_1"));
    writeLedger(store, [...readLedger(store).records, deliveryRecord("om_failed_1", "error")]);

    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), false, "a queued failed message is never consumption");

    consume(store);
    assert.equal(store.readNdjson("inbox").length, 2, "unrelated historical rows are retained");
    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), true, "residue rows cannot veto the proof");
    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1", "om_legacy_residue_1"]), false,
      "a message that never reached the model is not proven");
    assert.equal(store.provenConsumedInboundDeliveries(["om_unknown"]), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("the ledger must agree with canonical state for every required message", () => {
  const { root, store } = fixture();
  try {
    store.appendCanonicalInboxOnce(row("om_failed_1"));
    consume(store);

    for (const status of ["error", "pending", "submitting", "accepted", null]) {
      writeLedger(store, [deliveryRecord("om_failed_1", status)]);
      assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), false, `ledger status ${status}`);
    }
    writeLedger(store, [deliveryRecord("om_failed_1", "consumed", LEGACY_TARGET)]);
    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), false, "a foreign ledger target is not proof");
    writeLedger(store, [deliveryRecord("om_failed_1", "consumed"), deliveryRecord("om_failed_1", "consumed")]);
    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), false, "ambiguous ledger identity is not proof");
    writeLedger(store, []);
    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), false, "missing ledger evidence is not proof");
    writeLedger(store, [deliveryRecord("om_failed_1", "consumed")]);
    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a queued row blocks the proof even when the ledger claims consumption", () => {
  const { root, store } = fixture();
  try {
    store.appendCanonicalInboxOnce(row("om_failed_1"));
    writeLedger(store, [deliveryRecord("om_failed_1", "consumed")]);
    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), false, "the row is still owed to the Agent");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("malformed or unreadable canonical state fails closed", () => {
  const { root, store } = fixture();
  try {
    store.appendCanonicalInboxOnce(row("om_failed_1"));
    consume(store);
    writeLedger(store, [deliveryRecord("om_failed_1", "consumed")]);
    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), true);

    for (const state of [null, {}, { version: 1, targets: {}, messages: {} },
      { version: 2, targets: [], messages: {} }, { version: 2, targets: {}, messages: [] }]) {
      store.writeJson("inboxState", state);
      assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), false, JSON.stringify(state));
    }
    store.writeJson("inboxState", { version: 2, targets: {}, messages: {} });
    store.appendNdjson("inbox", row("om_duplicate", TARGET, "oc_proof"));
    store.appendNdjson("inbox", row("om_duplicate", TARGET, "oc_proof"));
    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), false, "duplicate canonical identities are not proof");
    writeLedger(store, "broken");
    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), false, "a malformed ledger is not proof");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a pruned message index still proves consumption from the drained row and the ledger", () => {
  const { root, store } = fixture();
  try {
    store.appendCanonicalInboxOnce(row("om_failed_1"));
    consume(store);
    writeLedger(store, [deliveryRecord("om_failed_1", "consumed")]);
    const state = store.readJson("inboxState", {});
    delete state.messages.om_failed_1;
    store.writeJson("inboxState", state);
    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1"]), true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("invalid required identities are refused instead of silently ignored", () => {
  const { root, store } = fixture();
  try {
    assert.equal(store.provenConsumedInboundDeliveries([]), false);
    assert.equal(store.provenConsumedInboundDeliveries(["", "om_failed_1"]), false);
    assert.equal(store.provenConsumedInboundDeliveries(["om_failed_1", "om_failed_1"]), false);
    assert.equal(store.provenConsumedInboundDeliveries([42]), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
