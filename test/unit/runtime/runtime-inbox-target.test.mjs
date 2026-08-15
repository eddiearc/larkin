import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";
import {
  RUNTIME_REDELIVERY_TARGET,
  RUNTIME_REMINDER_TARGET,
  isCanonicalInboxTarget,
  projectInboxCheck,
  targetKeyOfInboxEnvelope,
} from "../../../dist/agent/inbox-projection.mjs";
import { HostEnvelopeProjector } from "../../../dist/feishu/host-business-state.mjs";
import { createRuntimeHost } from "../../../dist/runtime/runtime-host.mjs";

class FakeSession {
  sessionId = "runtime-inbox-target-session";
  listeners = new Set();
  prompts = [];
  steers = [];

  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async prompt(input) { this.prompts.push(input); return { status: "accepted", inputId: input.inputId }; }
  async busyInput(input) { this.steers.push(input); return { status: "accepted", inputId: input.inputId }; }
  async cancel() {}
  async close() {}
}

const canonicalDocumentTarget = "document-comment:docx:doxcnFile_1:comment_1:in-thread";

test("canonical Inbox target derivation accepts only authoritative namespace partitions", () => {
  const valid = [
    [{ target: "chat:oc_preserved_1" }, "chat:oc_preserved_1"],
    [{ target: "chat:oc_preserved_1", chat_id: "oc_preserved_1", kind: "interaction" }, "chat:oc_preserved_1"],
    [{ target: "thread:oc_chat_1:omt_thread_1" }, "thread:oc_chat_1:omt_thread_1"],
    [{ target: "thread:oc_chat_1:omt_thread_1", chat_id: "oc_chat_1", thread_id: "omt_thread_1" }, "thread:oc_chat_1:omt_thread_1"],
    [{ target: canonicalDocumentTarget, kind: "document_comment" }, canonicalDocumentTarget],
    [{ chat_id: "oc_chat_1", kind: "interaction" }, "chat:oc_chat_1"],
    [{ chat_id: "oc_chat_1", thread_id: "omt_thread_1" }, "thread:oc_chat_1:omt_thread_1"],
    [{ target: RUNTIME_REMINDER_TARGET, kind: "reminder", message_id: "rem_current_1" }, RUNTIME_REMINDER_TARGET],
    [{ target: RUNTIME_REDELIVERY_TARGET, kind: "redelivery", message_id: "redeliver_current_1" }, RUNTIME_REDELIVERY_TARGET],
  ];
  for (const [envelope, expected] of valid) {
    assert.equal(targetKeyOfInboxEnvelope(envelope), expected);
    assert.equal(isCanonicalInboxTarget(expected), true);
  }

  for (const envelope of [
    null,
    undefined,
    { message_id: "unlocatable" },
    { target: "" },
    { target: undefined },
    { target: null },
    { target: 7 },
    { target: "dm:@system", message_id: "legacy_dm" },
    { target: "#c123", message_id: "legacy_alias" },
    { target: "runtime:system", message_id: "legacy_runtime" },
    { target: "runtime:unknown", message_id: "legacy_unknown" },
    { target: "runtime:other", message_id: "malformed_runtime" },
    { target: "chat:c123", message_id: "short_chat" },
    { target: "thread:oc_chat_1:thread_1", message_id: "short_thread" },
    { target: "document-comment:docx:file:comment:anywhere", kind: "document_comment" },
    { message_id: "rem_prefix_only" },
    { kind: "reminder", message_id: "om_kind_only" },
    { target: RUNTIME_REMINDER_TARGET, message_id: "om_target_only" },
    { kind: "reminder", message_id: "rem_targetless_both" },
    { kind: "redelivery", message_id: "redeliver_targetless_both" },
    { target: RUNTIME_REDELIVERY_TARGET, kind: "redelivery", message_id: "redeliver_with_chat", chat_id: "oc_conflict" },
    { target: RUNTIME_REMINDER_TARGET, kind: "reminder", message_id: "rem_with_thread", thread_id: "omt_conflict" },
    { target: "chat:oc_expected", chat_id: "oc_different" },
    { target: "chat:oc_expected", thread_id: "omt_forbidden" },
    { target: "chat:oc_expected", kind: "document_comment" },
    { target: "chat:oc_expected", kind: "reminder", message_id: "rem_internal_chat_target" },
    { target: "thread:oc_expected:omt_expected", chat_id: "oc_different" },
    { target: "thread:oc_expected:omt_expected", thread_id: "omt_different" },
    { target: "thread:oc_expected:omt_expected", kind: "reminder", message_id: "rem_internal" },
    { target: canonicalDocumentTarget, message_id: "doc_without_kind" },
    { target: canonicalDocumentTarget, kind: "document_comment", chat_id: "oc_forbidden" },
    { target: canonicalDocumentTarget, kind: "document_comment", message_id: "redeliver_internal" },
    { kind: "document_comment", message_id: "doc_without_locator" },
    { kind: "document_comment", message_id: "doc_with_chat", chat_id: "oc_forbidden" },
    { message_id: "rem_prefix_chat", chat_id: "oc_conflict" },
    { kind: "reminder", message_id: "om_kind_chat", chat_id: "oc_conflict" },
    { kind: "reminder", message_id: "rem_internal_chat", chat_id: "oc_conflict" },
    { kind: "redelivery", message_id: "redeliver_internal_thread", chat_id: "oc_conflict", thread_id: "omt_conflict" },
    { chat_id: "c123", message_id: "display_alias" },
    { chat_id: "oc_chat_1", thread_id: "thread_1", message_id: "bad_thread_locator" },
    { kind: "reminder", message_id: "redeliver_source_conflict", target: RUNTIME_REMINDER_TARGET },
  ]) assert.throws(() => targetKeyOfInboxEnvelope(envelope), /Inbox|canonical|target|locator|source/);
  assert.throws(() => projectInboxCheck([], "dm:@system"), /Invalid canonical Inbox check target/);
});

test("production HostEnvelopeProjector emits source-specific reminder and redelivery targets", () => {
  const projector = new HostEnvelopeProjector(
    {},
    () => {},
    () => "abcdef123456",
    () => new Date("2026-07-16T02:00:00.000Z"),
  );
  const reminder = projector.createReminderEnvelope("cli_targetContractA1", {
    reminderId: "1234567890abcdef", title: "Target contract", fireAt: "2026-07-17T01:00:00.000Z",
  }, 0, null);
  const redelivery = projector.createRedeliveryEnvelope("cli_targetContractA1", 2);

  assert.equal(reminder.kind, "reminder");
  assert.equal(reminder.target, RUNTIME_REMINDER_TARGET);
  assert.equal(targetKeyOfInboxEnvelope(reminder), RUNTIME_REMINDER_TARGET);
  assert.equal(redelivery.kind, "redelivery");
  assert.equal(redelivery.target, RUNTIME_REDELIVERY_TARGET);
  assert.equal(targetKeyOfInboxEnvelope(redelivery), RUNTIME_REDELIVERY_TARGET);
  for (const envelope of [reminder, redelivery]) {
    const output = JSON.stringify(envelope);
    assert.doesNotMatch(output, /dm:|runtime:(?:system|unknown)/);
  }
});

test("persistence rejects legacy and malformed targets and leaves durable old rows untouched", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-target-rejection-"));
  try {
    const store = createAgentStateStore(root, "cli_targetStoreA1", {
      inspectProcess: (pid) => ({ ok: true, dead: false, startToken: `test-${pid}` }),
    });
    store.appendNdjson("inbox", { message_id: "om_valid_before_rejection", target: "chat:oc_valid" });
    const inboxBeforeAppendRejection = fs.readFileSync(store.paths.inbox);
    const stateBeforeAppendRejection = fs.readFileSync(store.paths.inboxState);
    for (const envelope of [
      { message_id: "legacy_dm", target: "dm:@system" },
      { message_id: "legacy_runtime", target: "runtime:system" },
      { message_id: "legacy_unknown", target: "runtime:unknown" },
      { message_id: "unlocatable" },
      { message_id: "rem_prefix_only" },
      { kind: "reminder", message_id: "om_kind_only" },
      { target: "runtime:reminder", message_id: "om_target_only" },
      { kind: "redelivery", message_id: "redeliver_targetless" },
      { target: "chat:oc_expected", chat_id: "oc_conflict" },
      { target: canonicalDocumentTarget, message_id: "doc_without_kind" },
    ]) assert.throws(() => store.appendNdjson("inbox", envelope), /Inbox|canonical|target|locator/);
    assert.throws(() => store.appendInboxOnce({ message_id: "om_valid_before_rejection", target: "dm:@system" }), /Invalid canonical Inbox target/,
      "dedup must not bypass validation");
    assert.throws(() => store.prepareInboxDelivery({ message_id: "interaction_unlocatable", kind: "interaction" }), /no canonical target/,
      "delivery preparation validates before considering append state");
    assert.deepEqual(fs.readFileSync(store.paths.inbox), inboxBeforeAppendRejection, "invalid append leaves Inbox bytes unchanged");
    assert.deepEqual(fs.readFileSync(store.paths.inboxState), stateBeforeAppendRejection, "invalid append leaves target cursors unchanged");

    store.writeJson("status", { fixture: true });
    store.writeJson("runtimeDeliveries", { version: 1, records: [{
      deliveryId: "existing-delivery", messageId: "legacy_prepare", status: "accepted", updatedAt: "2026-08-15T00:00:00.000Z",
      input: { inputId: "existing-delivery", deliveryId: "existing-delivery", kind: "wake", text: "existing", attempt: 0 },
    }] });
    const ledgerBeforePreparationRejection = fs.readFileSync(store.paths.runtimeDeliveries);
    assert.throws(() => store.prepareInboxDelivery({ message_id: "legacy_prepare", target: "dm:@system" }), /Invalid canonical Inbox target/,
      "active ledger ownership must not bypass validation");
    assert.deepEqual(fs.readFileSync(store.paths.runtimeDeliveries), ledgerBeforePreparationRejection);
    const oldRows = [
      { message_id: "legacy_dm_disk", target: "dm:@system" },
      { message_id: "legacy_runtime_disk", target: "runtime:system" },
      { message_id: "redeliver_targetless_disk", kind: "redelivery" },
    ];
    const bytes = `${oldRows.map((row) => JSON.stringify(row)).join("\n")}\n`;
    fs.writeFileSync(store.paths.inbox, bytes, { mode: 0o600 });
    const stateBeforePollRejection = fs.readFileSync(store.paths.inboxState);
    const ledgerBeforePollRejection = fs.readFileSync(store.paths.runtimeDeliveries);
    assert.throws(() => store.pollInbox({ limit: 1 }), /Invalid canonical Inbox target/);
    assert.throws(() => store.pollInbox({ target: "dm:@system", limit: 1 }), /Invalid canonical Inbox poll target/);
    assert.equal(fs.readFileSync(store.paths.inbox, "utf8"), bytes, "rejected legacy rows are neither migrated nor consumed");
    assert.deepEqual(fs.readFileSync(store.paths.inboxState), stateBeforePollRejection, "invalid existing rows leave target cursors unchanged");
    assert.deepEqual(fs.readFileSync(store.paths.runtimeDeliveries), ledgerBeforePollRejection, "invalid existing rows leave Runtime acceptance unchanged");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Runtime final inputs use exact targets and malformed deliveries fail closed before prompt or ledger acceptance", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-target-defense-"));
  const store = createAgentStateStore(root, "cli_targetDefenseA1", {
    inspectProcess: (pid) => ({ ok: true, dead: false, startToken: `test-${pid}` }),
  });
  const session = new FakeSession();
  const events = [];
  const host = createRuntimeHost({
    adapterFor: () => ({ id: "codex", capabilities: {}, async createSession() { return session; } }),
    promptBuilder: new ContextPromptBuilder(),
    stateStoreFor: () => store,
  });
  host.subscribe((event) => events.push(event));
  const agentId = "cli_targetDefenseA1";
  const cases = [
    [{ target: RUNTIME_REMINDER_TARGET, message_id: "rem_final", kind: "reminder" }, RUNTIME_REMINDER_TARGET],
    [{ target: RUNTIME_REDELIVERY_TARGET, message_id: "redeliver_final", kind: "redelivery" }, RUNTIME_REDELIVERY_TARGET],
    [{ message_id: "om_chat", chat_id: "oc_chat" }, "chat:oc_chat"],
    [{ message_id: "om_thread", chat_id: "oc_chat", thread_id: "omt_thread" }, "thread:oc_chat:omt_thread"],
    [{ message_id: "interaction_run", kind: "interaction", chat_id: "oc_interaction" }, "chat:oc_interaction"],
    [{ message_id: "doc_comment_final", kind: "document_comment", target: canonicalDocumentTarget }, canonicalDocumentTarget],
  ];
  try {
    await host.start([{ agentId, name: agentId, runtime: "codex", model: "g", workspaceDir: ".", stateDir: store.paths.root }]);
    for (const [envelope] of cases) assert.equal((await host.deliver(agentId, envelope)).status, "accepted");

    const finalInputs = [...session.prompts, ...session.steers];
    assert.equal(finalInputs.length, cases.length);
    cases.forEach(([, target], index) => {
      assert.ok(finalInputs[index].text.includes(`Inbox changed for ${target}`), `final Runtime input names ${target}`);
      assert.doesNotMatch(finalInputs[index].text, /Inbox changed \(/, "final Runtime notice is never targetless");
    });

    const invalidCases = [
      { message_id: "unlocatable_runtime" },
      { message_id: "legacy_dm_runtime", target: "dm:@system" },
      { message_id: "generic_runtime", target: "runtime:system" },
      { message_id: "malformed_chat_runtime", target: "chat:c_alias" },
      { message_id: "rem_runtime_prefix_only" },
      { message_id: "om_runtime_kind_only", kind: "reminder" },
      { message_id: "om_runtime_target_only", target: RUNTIME_REMINDER_TARGET },
      { message_id: "redeliver_runtime_targetless", kind: "redelivery" },
      { message_id: "om_runtime_chat_conflict", target: "chat:oc_expected", chat_id: "oc_different" },
      { message_id: "rem_runtime_externalized", kind: "reminder", chat_id: "oc_conflict" },
      { message_id: "doc_runtime_no_kind", target: canonicalDocumentTarget },
      { message_id: "doc_runtime_with_chat", kind: "document_comment", target: canonicalDocumentTarget, chat_id: "oc_conflict" },
    ];
    const ledgerBeforeRejection = fs.readFileSync(store.paths.runtimeDeliveries);
    for (const invalid of invalidCases) {
      const first = await host.deliver(agentId, invalid);
      const second = await host.deliver(agentId, invalid);
      assert.deepEqual(second, first, "fail-closed receipt is deterministic");
      assert.equal(first.status, "error");
      assert.equal(first.retryable, false);
      assert.match(first.reason, /Inbox target derivation failed/);
      assert.equal(events.filter((event) => event.type === "delivery" && event.messageId === invalid.message_id
        && event.status === "error").length, 2, "each rejection emits deterministic error telemetry");
    }
    assert.equal([...session.prompts, ...session.steers].length, cases.length, "invalid delivery creates no Runtime prompt");
    const ledger = store.readJson("runtimeDeliveries", { records: [] }).records;
    assert.equal(invalidCases.some((invalid) => ledger.some((record) => record.messageId === invalid.message_id)), false,
      "invalid delivery creates no ledger acceptance");
    assert.deepEqual(fs.readFileSync(store.paths.runtimeDeliveries), ledgerBeforeRejection, "invalid delivery leaves the accepted ledger byte-for-byte unchanged");
  } finally {
    await host.shutdown("target derivation contract complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
