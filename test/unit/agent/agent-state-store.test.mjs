import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { test } from "bun:test";
import { pathToFileURL, fileURLToPath } from "node:url";

process.env.LARKIN_BUN_TEST_RUNNER = "1";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const moduleUrl = pathToFileURL(path.join(ROOT, "dist/agent/agent-state-store.mjs")).href;
const processStateUrl = pathToFileURL(path.join(ROOT, "dist/platform/process-state.mjs")).href;

test("Agent state layout owns every canonical persistence path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-layout-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_state1");
    assert.deepEqual(Object.fromEntries(Object.entries(store.paths).map(([key, file]) => [key, path.relative(store.paths.root, file)])), {
      root: "",
      agentState: "agent-state.json",
      status: "status.json",
      map: "feishu-map.json",
      replyctx: "feishu-replyctx.json",
      botIdentity: "bot-identity.json",
      senderProfiles: "sender-profiles.json",
      readReceipts: "feishu-read.json",
      pendingReact: "feishu-pending-react.json",
      runtimeDeliveries: "runtime-deliveries.json",
      inboxState: "inbox-state.json",
      freshnessState: "freshness-state.json",
      documentComments: "document-comments.json",
      interactions: "interactions.json",
      conversation: "conversation.ndjson",
      inbox: "feishu-inbox.ndjson",
      reminders: "reminders.json",
    });
    assert.equal(fs.existsSync(store.paths.root), false, "layout planning must not touch disk");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("typed store atomically writes JSON and appends strict NDJSON with private modes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-store-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_state2");
    assert.deepEqual(store.readJson("status", { fresh: true }), { fresh: true });
    assert.equal(fs.existsSync(store.paths.root), false, "missing-file reads must not create state directories");
    assert.throws(() => store.writeJson("status", undefined), /JSON serializable/);
    store.writeJson("status", { online: true });
    assert.deepEqual(store.readJson("status", {}), { online: true });
    assert.equal(fs.statSync(store.paths.status).mode & 0o777, 0o600);
    assert.equal(fs.statSync(store.paths.root).mode & 0o077, 0);
    assert.deepEqual(fs.readdirSync(store.paths.root).filter((name) => name.endsWith(".tmp")), []);

    store.appendNdjson("conversation", { seq: 1 });
    store.appendNdjson("conversation", { seq: 2 });
    assert.deepEqual(store.readNdjson("conversation"), [{ seq: 1 }, { seq: 2 }]);
    assert.equal(fs.statSync(store.paths.conversation).mode & 0o777, 0o600);
    fs.appendFileSync(store.paths.conversation, "not-json\n");
    assert.throws(() => store.readNdjson("conversation"), /invalid NDJSON.*:3/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Inbox draft schema preserves legacy held drafts and safely downgrades incomplete sending records", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-draft-migration-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_draftMigrationA1");
    const base = {
      version: 2, targets: {}, messages: {}, intents: {}, drafts: {
        draft_legacy: {
          draft_id: "draft_legacy", target: "chat:oc_legacy", argv: ["im", "+messages-send", "--chat-id", "oc_legacy", "--text", "legacy"],
          status: "held", held_at_seq: 1, created_at: "2026-07-28T00:00:00.000Z", updated_at: "2026-07-28T00:00:00.000Z",
        },
        draft_interrupted_migration: {
          draft_id: "draft_interrupted_migration", target: "chat:oc_old", argv: ["im", "+messages-send", "--chat-id", "oc_old", "--text", "old"],
          status: "sending", held_at_seq: 2, created_at: "2026-07-28T00:00:00.000Z", updated_at: "2026-07-28T00:00:00.000Z",
        },
      },
    };
    store.writeJson("inboxState", base);
    assert.equal(store.readInboxDraft("draft_legacy").status, "held");
    assert.equal(store.readInboxDraft("draft_interrupted_migration").status, "held",
      "pre-migration sending without a durable intent boundary must fail safely to retryable held");
    assert.deepEqual(store.listInboxDrafts().map((draft) => draft.draft_id).sort(), ["draft_interrupted_migration", "draft_legacy"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("typed store rejects symlinked Agent directories and files", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-symlink-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-outside-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_state3");
    fs.mkdirSync(path.dirname(store.paths.root), { recursive: true });
    fs.symlinkSync(outside, store.paths.root, "dir");
    assert.throws(() => store.writeJson("status", { escaped: true }), /symlink/);
    assert.equal(fs.readdirSync(outside).length, 0);

    fs.unlinkSync(store.paths.root);
    fs.mkdirSync(store.paths.root);
    const outsideFile = path.join(outside, "captured.json");
    fs.writeFileSync(outsideFile, "owner");
    fs.symlinkSync(outsideFile, store.paths.status);
    assert.throws(() => store.readJson("status", {}), /symlink|ELOOP/);
    assert.throws(() => store.writeJson("status", { escaped: true }), /symlink/);
    assert.equal(fs.readFileSync(outsideFile, "utf8"), "owner");

    fs.unlinkSync(store.paths.status);
    const lockTarget = path.join(outside, "lock-target");
    fs.mkdirSync(lockTarget);
    fs.symlinkSync(lockTarget, `${store.paths.inbox}.lock`, "dir");
    assert.throws(() => store.appendNdjson("inbox", { escaped: true }), /symlink/);
    assert.deepEqual(fs.readdirSync(lockTarget), [], "Inbox lock symlink must not be followed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test("typed store rejects unsafe Agent IDs and unknown keys", async () => {
  const { createAgentStateStore } = await import(moduleUrl);
  for (const id of ["../escape", "cli_has-dash", "", "friendly"]) {
    assert.throws(() => createAgentStateStore(os.tmpdir(), id), /agent|id|App/i);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-key-"));
  try {
    const store = createAgentStateStore(root, "cli_state4");
    assert.throws(() => store.readJson("inbox", {}), /unknown|key/i);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Inbox delivery preparation treats consumed Runtime ownership as final across restart", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-delivery-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_stateDeliveryA1");
    const envelope = { message_id: "interaction_run_1", kind: "interaction", chat_id: "oc_interaction", wake: true };
    assert.equal(store.prepareInboxDelivery(envelope), "appended");
    assert.equal(store.prepareInboxDelivery(envelope), "present");
    store.writeJson("runtimeDeliveries", { version: 1, records: [{ deliveryId: "d1", messageId: envelope.message_id, status: "accepted" }] });
    assert.equal(store.prepareInboxDelivery(envelope), "active");
    store.writeJson("runtimeDeliveries", { version: 1, records: [{ deliveryId: "d1", messageId: envelope.message_id, status: "error" }] });
    assert.equal(store.prepareInboxDelivery(envelope), "terminal_error");
    store.drainInbox();
    assert.equal(store.prepareInboxDelivery(envelope), "consumed");
    assert.equal(store.readNdjson("inbox").length, 0);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("canonical Inbox append returns the exact persisted shape and deduplicates coherently across consumption", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-canonical-append-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_stateCanonicalAppendA1");
    const candidate = { message_id: "om_canonical_once", chat_id: "oc_canonical", thread_id: "omt_canonical",
      target: "thread:oc_canonical:omt_canonical", content: "canonical" };
    const appended = store.appendCanonicalInboxOnce(candidate);
    assert.equal(appended.status, "appended");
    assert.deepEqual(store.readNdjson("inbox"), [appended.envelope]);
    assert.equal(appended.envelope.envelope_version, 2);
    assert.equal(appended.envelope.target_seq, 1);

    const pendingDuplicate = store.appendCanonicalInboxOnce(candidate);
    assert.equal(pendingDuplicate.status, "duplicate_pending");
    assert.deepEqual(pendingDuplicate.envelope, appended.envelope);
    assert.equal(store.readNdjson("inbox").length, 1);
    assert.throws(() => store.appendCanonicalInboxOnce({ ...candidate, chat_id: "oc_wrong",
      target: "thread:oc_wrong:omt_canonical" }), /duplicate message_id conflicts/);
    assert.equal(store.readNdjson("inbox").length, 1);

    store.pollInbox({ target: candidate.target, limit: 1 });
    assert.deepEqual(store.appendCanonicalInboxOnce(candidate), { status: "duplicate_consumed", envelope: null });
    assert.deepEqual(store.readNdjson("inbox"), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("targeted Inbox poll binds implicit reminder source to the selected target", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-targeted-source-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_stateTargetedSourceA1");
    store.appendNdjson("inbox", { message_id: "om_source_a", target: "chat:oc_source_a", content: "A" });
    store.appendNdjson("inbox", { message_id: "om_source_b", target: "chat:oc_source_b", content: "B" });
    assert.deepEqual(store.resolveCurrentInboxSource(), { deliveryTarget: "chat:oc_source_b", deliveryAnchor: "om_source_b" });
    const polled = store.pollInbox({ target: "chat:oc_source_a", limit: 1 });
    assert.deepEqual(polled.envelopes.map((row) => row.message_id), ["om_source_a"]);
    assert.deepEqual(store.resolveCurrentInboxSource(), { deliveryTarget: "chat:oc_source_a", deliveryAnchor: "om_source_a" });
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), ["om_source_b"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("context-overflow rearm preserves Inbox bytes and delivery identities while changing only matching terminal records", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-context-recovery-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_contextRecoveryA1");
    const messages = ["om_overflow_1", "om_overflow_2", "om_overflow_3", "om_overflow_4"];
    for (const messageId of messages) store.appendNdjson("inbox", { message_id: messageId, chat_id: "oc_overflow", content: "synthetic" });
    const records = messages.map((messageId, index) => ({ deliveryId: `delivery-overflow-${index}`, messageId,
      status: "error", retryable: false, reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window", input: { inputId: `input-${index}`, deliveryId: `delivery-overflow-${index}`, kind: "wake", text: "redacted", attempt: 0 }, updatedAt: "before" }));
    records.push({ deliveryId: "delivery-unrelated", messageId: "om_terminal_unrelated", status: "error", errorCategory: "provider",
      input: { inputId: "input-unrelated", deliveryId: "delivery-unrelated", kind: "wake", text: "redacted", attempt: 0 }, updatedAt: "before" });
    store.writeJson("runtimeDeliveries", { version: 1, records });
    const inboxBytes = fs.readFileSync(store.paths.inbox, "utf8");
    const result = store.rearmContextOverflow();
    assert.deepEqual(result, { rearmedCount: 4, remainingPendingCount: 4 });
    assert.equal(fs.readFileSync(store.paths.inbox, "utf8"), inboxBytes);
    const after = store.readJson("runtimeDeliveries", { records: [] });
    assert.deepEqual(after.records.map((record) => [record.deliveryId, record.messageId, record.status]), [
      ["delivery-overflow-0", "om_overflow_1", "pending"], ["delivery-overflow-1", "om_overflow_2", "pending"],
      ["delivery-overflow-2", "om_overflow_3", "pending"], ["delivery-overflow-3", "om_overflow_4", "pending"],
      ["delivery-unrelated", "om_terminal_unrelated", "error"],
    ]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy context-overflow rearm covers eight Inbox rows across multiple targets and preserves stable identities", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-context-legacy-multi-target-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_contextLegacyMultiTargetA1");
    const rows = [
      { message_id: "om_legacy_chat_a", target: "chat:oc_legacy_a" },
      { message_id: "om_legacy_chat_b", target: "chat:oc_legacy_b" },
      { message_id: "om_legacy_thread_a", chat_id: "oc_legacy_a", thread_id: "omt_legacy_a" },
      { message_id: "om_legacy_thread_b", chat_id: "oc_legacy_b", thread_id: "omt_legacy_b" },
      { message_id: "om_legacy_doc_a", kind: "document_comment", target: "document-comment:docx_legacy_a:comment_a" },
      { message_id: "om_legacy_doc_b", kind: "document_comment", target: "document-comment:docx_legacy_b:comment_b" },
      { message_id: "rem_legacy_system", kind: "reminder", target: "runtime:reminder" },
      { message_id: "redeliver_legacy_system", kind: "redelivery", target: "runtime:redelivery" },
    ];
    for (const row of rows) store.appendNdjson("inbox", { ...row, content: "synthetic" });
    const records = rows.map((row, index) => ({ deliveryId: `legacy-delivery-${index}`, messageId: row.message_id,
      status: "error", retryable: false,
      reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.",
      ...(index >= 6 ? { errorCategory: "context_window" } : {}),
      input: { inputId: `legacy-input-${index}`, deliveryId: `legacy-delivery-${index}`, kind: "wake", text: "redacted", attempt: 0 }, updatedAt: "before" }));
    store.writeJson("runtimeDeliveries", { version: 1, records });
    const inboxBytes = fs.readFileSync(store.paths.inbox, "utf8");
    assert.deepEqual(store.rearmContextOverflow(), { rearmedCount: 8, remainingPendingCount: 8 });
    assert.equal(fs.readFileSync(store.paths.inbox, "utf8"), inboxBytes);
    const after = store.readJson("runtimeDeliveries", { records: [] });
    assert.deepEqual(after.records.map((record) => [record.messageId, record.deliveryId, record.input.inputId, record.status]),
      rows.map((row, index) => [row.message_id, `legacy-delivery-${index}`, `legacy-input-${index}`, "pending"]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("legacy context-overflow rearm accepts the exact Codex reason but refuses ambiguous wording, retryable rows, and conflicting categories without mutation", async () => {
  const cases = [
    ["ambiguous", { status: "error", retryable: false, reason: "The context policy token limit may apply", errorCategory: "context_window" }],
    ["projection-one-character", { status: "error", retryable: false, reason: "provider rejected the input because the context window was exceedeD", errorCategory: "context_window" }],
    ["projection-ambiguous", { status: "error", retryable: false, reason: "provider rejected the input because context overflow happened", errorCategory: "context_window" }],
    ["forged-category", { status: "error", retryable: false, reason: "provider reported a successful response", errorCategory: "context_window" }],
    ["retryable", { status: "error", retryable: true, reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again." }],
    ["conflicting-category", { status: "error", retryable: false, reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "quota" }],
  ];
  for (const [name, record] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-state-context-legacy-${name}-`));
    try {
      const { createAgentStateStore } = await import(moduleUrl);
      const store = createAgentStateStore(root, `cli_contextLegacy${name.replace(/-/g, "")}A1`);
      const messageId = `om_legacy_${name}`;
      store.appendNdjson("inbox", { message_id: messageId, target: `chat:oc_legacy_${name}`, content: "synthetic" });
      const original = { version: 1, records: [{ deliveryId: `legacy-${name}-delivery`, messageId, input: {
        inputId: `legacy-${name}-input`, deliveryId: `legacy-${name}-delivery`, kind: "wake", text: "redacted", attempt: 0 }, updatedAt: "before", ...record }] };
      store.writeJson("runtimeDeliveries", original);
      const inboxBefore = fs.readFileSync(store.paths.inbox, "utf8");
      assert.throws(() => store.rearmContextOverflow(), (error) => error.code === (name === "retryable" ? "delivery_not_terminal" : "delivery_not_context_window"));
      assert.equal(fs.readFileSync(store.paths.inbox, "utf8"), inboxBefore);
      assert.deepEqual(store.readJson("runtimeDeliveries", {}), original);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("legacy context-overflow rearm refuses a missing retryable=false proof and leaves all state unchanged", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-context-legacy-missing-retryable-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_contextLegacyMissingRetryableA1");
    const messageId = "om_legacy_missing_retryable";
    store.appendNdjson("inbox", { message_id: messageId, target: "chat:oc_legacy_missing_retryable", content: "synthetic" });
    const original = { version: 1, records: [{ deliveryId: "legacy-missing-retryable-delivery", messageId, status: "error",
      reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", input: { inputId: "legacy-missing-retryable-input", deliveryId: "legacy-missing-retryable-delivery" }, updatedAt: "before" }] };
    store.writeJson("runtimeDeliveries", original);
    const inboxBefore = fs.readFileSync(store.paths.inbox, "utf8");
    assert.throws(() => store.rearmContextOverflow(), (error) => error.code === "delivery_not_context_window");
    assert.equal(fs.readFileSync(store.paths.inbox, "utf8"), inboxBefore);
    assert.deepEqual(store.readJson("runtimeDeliveries", {}), original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("context-overflow rearm fails closed when reason is missing even with explicit category", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-context-missing-reason-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_contextMissingReasonA1");
    const messageId = "om_context_missing_reason";
    store.appendNdjson("inbox", { message_id: messageId, target: "chat:oc_context_missing_reason", content: "synthetic" });
    const original = { version: 1, records: [{ deliveryId: "d-context-missing-reason", messageId, status: "error",
      errorCategory: "context_window", input: { inputId: "i-context-missing-reason", deliveryId: "d-context-missing-reason" }, updatedAt: "before" }] };
    store.writeJson("runtimeDeliveries", original);
    assert.throws(() => store.rearmContextOverflow(), (error) => error.code === "delivery_not_context_window");
    assert.deepEqual(store.readJson("runtimeDeliveries", {}), original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("context-overflow rearm refuses a mixed terminal backlog before mutating ledger or Inbox", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-context-refuse-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_contextRefusalA1");
    store.appendNdjson("inbox", { message_id: "om_context_only", chat_id: "oc_context", content: "synthetic" });
    store.appendNdjson("inbox", { message_id: "om_quota_error", chat_id: "oc_context", content: "synthetic" });
    store.writeJson("runtimeDeliveries", { version: 1, records: [
      { deliveryId: "d-context", messageId: "om_context_only", status: "error", errorCategory: "context_window", input: { inputId: "i-context", deliveryId: "d-context" }, updatedAt: "before" },
      { deliveryId: "d-quota", messageId: "om_quota_error", status: "error", errorCategory: "quota", input: { inputId: "i-quota", deliveryId: "d-quota" }, updatedAt: "before" },
    ] });
    const before = fs.readFileSync(store.paths.inbox, "utf8");
    assert.throws(() => store.rearmContextOverflow(), (error) => error.code === "delivery_not_context_window");
    assert.equal(fs.readFileSync(store.paths.inbox, "utf8"), before);
    assert.deepEqual(store.readJson("runtimeDeliveries", { records: [] }).records.map((record) => record.status), ["error", "error"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("context-overflow rearm rolls back deleted and mutated matching rows while preserving unrelated concurrent rows", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-context-rollback-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_contextRollbackA1");
    const messages = ["om_context_rollback_a", "om_context_rollback_b"];
    for (const messageId of messages) store.appendNdjson("inbox", { message_id: messageId, chat_id: "oc_context_rollback", content: "synthetic" });
    const original = { version: 1, records: [
      { deliveryId: "d-rollback-a", messageId: messages[0], status: "error", retryable: false, reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window",
        input: { inputId: "i-rollback-a", deliveryId: "d-rollback-a", kind: "wake", text: "redacted", attempt: 0 }, updatedAt: "before-a" },
      { deliveryId: "d-rollback-b", messageId: messages[1], status: "error", retryable: false, reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window",
        input: { inputId: "i-rollback-b", deliveryId: "d-rollback-b", kind: "wake", text: "redacted", attempt: 0 }, updatedAt: "before-b" },
      { deliveryId: "d-unrelated", messageId: "om_unrelated", status: "error", errorCategory: "provider",
        input: { inputId: "i-unrelated", deliveryId: "d-unrelated", kind: "wake", text: "unrelated", attempt: 0 }, updatedAt: "before-unrelated" },
    ] };
    store.writeJson("runtimeDeliveries", original);
    assert.throws(() => store.rearmContextOverflow(() => {
      const current = store.readJson("runtimeDeliveries", {});
      current.records = current.records.filter((record) => record.deliveryId !== "d-rollback-a");
      current.records.find((record) => record.deliveryId === "d-rollback-b").status = "consumed";
      current.records.push({ deliveryId: "d-concurrent", messageId: "om_concurrent", status: "pending",
        input: { inputId: "i-concurrent", deliveryId: "d-concurrent" }, updatedAt: "concurrent" });
      store.writeJson("runtimeDeliveries", current);
      throw new Error("injected commit callback failure");
    }), /injected commit callback failure/);
    const after = store.readJson("runtimeDeliveries", {});
    assert.deepEqual(after.records, [...original.records.slice(0, 2), original.records[2], {
      deliveryId: "d-concurrent", messageId: "om_concurrent", status: "pending",
      input: { inputId: "i-concurrent", deliveryId: "d-concurrent" }, updatedAt: "concurrent",
    }], "rollback restores exact matching identities/state without losing an unrelated concurrent row");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("context-overflow rearm rejects a matching deliveryId collision with an unrelated ledger record", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-context-delivery-collision-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_contextDeliveryCollisionA1");
    store.appendNdjson("inbox", { message_id: "om_context_collision", chat_id: "oc_context_collision", content: "synthetic" });
    const before = { version: 1, records: [
      { deliveryId: "d-collision", messageId: "om_context_collision", status: "error", retryable: false, reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window", input: { inputId: "i-context-collision", deliveryId: "d-collision" }, updatedAt: "before" },
      { deliveryId: "d-collision", messageId: "om_unrelated_collision", status: "error", errorCategory: "provider", input: { inputId: "i-unrelated-collision", deliveryId: "d-collision" }, updatedAt: "unrelated" },
    ] };
    store.writeJson("runtimeDeliveries", before);
    assert.throws(() => store.rearmContextOverflow(), (error) => error.code === "delivery_duplicate");
    assert.deepEqual(store.readJson("runtimeDeliveries", {}), before);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("context-overflow rearm preserves existing Inbox freshness boundaries and is not repeatable after rearm", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-context-freshness-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_contextFreshnessA1");
    const messageId = "om_context_freshness";
    store.appendNdjson("inbox", { message_id: messageId, chat_id: "oc_context_freshness", content: "synthetic", target_seq: 8 });
    store.writeJson("inboxState", { version: 2, targets: { "chat:oc_context_freshness": { latest_received_seq: 8, model_seen_seq: 5 } }, messages: {
      [messageId]: { target: "chat:oc_context_freshness", seq: 8 },
    }, drafts: {}, intents: {} });
    const freshness = { version: 1, cursors: { "chat:oc_context_freshness": { generation: "external", cursor: { seq: 5 } } } };
    store.writeJson("freshnessState", freshness);
    store.writeJson("runtimeDeliveries", { version: 1, records: [{ deliveryId: "d-freshness", messageId, status: "error", retryable: false, reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window",
      input: { inputId: "i-freshness", deliveryId: "d-freshness" }, updatedAt: "before" }] });
    const inboxBefore = fs.readFileSync(store.paths.inbox, "utf8");
    const inboxStateBefore = store.readJson("inboxState", {});
    const freshnessBefore = store.readJson("freshnessState", {});
    store.rearmContextOverflow();
    assert.equal(fs.readFileSync(store.paths.inbox, "utf8"), inboxBefore);
    assert.deepEqual(store.readJson("inboxState", {}), inboxStateBefore);
    assert.deepEqual(store.readJson("freshnessState", {}), freshnessBefore);
    assert.throws(() => store.rearmContextOverflow(), (error) => error.code === "delivery_not_terminal");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("context-overflow rearm restores the original ledger after a post-write persistence failure", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-context-persist-failure-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_contextPersistFailureA1");
    store.appendNdjson("inbox", { message_id: "om_context_persist_failure", chat_id: "oc_context_persist", content: "synthetic" });
    const original = { version: 1, records: [{ deliveryId: "d-persist", messageId: "om_context_persist_failure", status: "error", retryable: false, reason: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.", errorCategory: "context_window",
      input: { inputId: "i-persist", deliveryId: "d-persist", kind: "wake", text: "redacted", attempt: 0 }, updatedAt: "before" }] };
    store.writeJson("runtimeDeliveries", original);
    const writeJson = store.writeJson.bind(store);
    let failAfterWrite = true;
    store.writeJson = (key, value) => {
      writeJson(key, value);
      if (key === "runtimeDeliveries" && failAfterWrite) { failAfterWrite = false; throw new Error("injected post-write persistence failure"); }
    };
    assert.throws(() => store.rearmContextOverflow(), /post-write persistence failure/);
    assert.deepEqual(store.readJson("runtimeDeliveries", {}), original);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("context-overflow rearm refuses missing, mismatched, or duplicate stable identities without mutation", async () => {
  const cases = [
    ["missing-input", { deliveryId: "d-identity", messageId: "om_identity", status: "error", errorCategory: "context_window", input: { deliveryId: "d-identity" } }],
    ["mismatched-delivery", { deliveryId: "d-identity", messageId: "om_identity", status: "error", errorCategory: "context_window", input: { inputId: "i-identity", deliveryId: "other" } }],
    ["duplicate-input", { deliveryId: "d-identity", messageId: "om_identity", status: "error", errorCategory: "context_window", input: { inputId: "i-shared", deliveryId: "d-identity" } }],
  ];
  for (const [name, record] of cases) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-state-context-${name}-`));
    try {
      const { createAgentStateStore } = await import(moduleUrl);
      const store = createAgentStateStore(root, `cli_context${name.replace(/-/g, "")}A1`);
      store.appendNdjson("inbox", { message_id: "om_identity", chat_id: "oc_identity", content: "synthetic" });
      const records = name === "duplicate-input" ? [record, { ...record, deliveryId: "d-identity-2", messageId: "om_identity_2", input: { inputId: "i-shared", deliveryId: "d-identity-2" } }] : [record];
      if (name === "duplicate-input") store.appendNdjson("inbox", { message_id: "om_identity_2", chat_id: "oc_identity", content: "synthetic" });
      store.writeJson("runtimeDeliveries", { version: 1, records });
      const before = store.readJson("runtimeDeliveries", {});
      assert.throws(() => store.rearmContextOverflow(), /identity/);
      assert.deepEqual(store.readJson("runtimeDeliveries", {}), before);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});

test("appendInboxOnce remembers a stable provider id after the Inbox row is consumed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-stable-inbox-id-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_stateStableInboxA1");
    const envelope = { kind: "document_comment", message_id: "doc_comment_stable",
      target: "document-comment:docx:file:comment:in-thread" };
    assert.equal(store.appendInboxOnce(envelope), true);
    store.pollInbox({ target: envelope.target, limit: 1 });
    assert.equal(store.readNdjson("inbox").length, 0);
    assert.equal(store.appendInboxOnce(envelope), false, "consumption must not erase durable event dedup history");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Inbox lock reclaims a verifiably dead owner record", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-dead-lock-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_stateDeadLockA1");
    store.writeJson("status", { prepared: true });
    const lockDir = `${store.paths.inbox}.lock`;
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
      version: 1, pid: 2_147_483_647, processStartToken: "dead-process", nonce: "00000000-0000-4000-8000-000000000000",
    })}\n`, { mode: 0o600 });
    store.appendNdjson("inbox", { message_id: "om_after_dead_lock", chat_id: "oc_lock" });
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), ["om_after_dead_lock"]);
    assert.equal(fs.existsSync(lockDir), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Inbox contender retries when the owner releases its lock directory during state inspection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-released-lock-race-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_stateReleasedLockRaceA1");
    store.writeJson("status", { prepared: true });
    const lockDir = `${store.paths.inbox}.lock`;
    fs.mkdirSync(lockDir, { mode: 0o700 });
    const readOwner = store.readInboxLockOwner.bind(store);
    let released = false;
    store.readInboxLockOwner = (candidate) => {
      const owner = readOwner(candidate);
      if (!released && candidate === lockDir && owner === null) {
        released = true;
        fs.rmdirSync(lockDir);
      }
      return owner;
    };

    store.appendNdjson("inbox", { message_id: "om_after_release_race", chat_id: "oc_lock" });

    assert.equal(released, true, "the lock owner must release between owner read and directory inspection");
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), ["om_after_release_race"]);
    assert.equal(fs.existsSync(lockDir), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("Inbox contender retries when the lock directory disappears after guarded reclaim inspection", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-guarded-reclaim-race-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_stateGuardedReclaimRaceA1");
    store.writeJson("status", { prepared: true });
    const lockDir = `${store.paths.inbox}.lock`;
    const ownerFile = path.join(lockDir, "owner.json");
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(ownerFile, `${JSON.stringify({
      version: 1, pid: 2_147_483_647, processStartToken: "dead-process",
      nonce: "00000000-0000-4000-8000-000000000003",
    })}\n`, { mode: 0o600 });
    const inspectState = store.inboxLockState.bind(store);
    let stateChecks = 0;
    let released = false;
    store.inboxLockState = (candidate) => {
      const state = inspectState(candidate);
      if (candidate === lockDir && state === "reclaimable" && ++stateChecks === 2) {
        fs.unlinkSync(ownerFile);
        fs.rmdirSync(lockDir);
        released = true;
      }
      return state;
    };

    store.appendNdjson("inbox", { message_id: "om_after_guarded_reclaim_race", chat_id: "oc_lock" });

    assert.equal(released, true, "the owner must release after guarded state inspection and before directory read");
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), ["om_after_guarded_reclaim_race"]);
    assert.equal(fs.existsSync(lockDir), false);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("EPERM inspection of a live Inbox owner fails closed without reclaim", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-eperm-lock-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const processState = await import(processStateUrl);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const childIdentity = processState.inspectProcess(child.pid);
    assert.equal(childIdentity.ok, true, childIdentity.reason);
    const store = createAgentStateStore(root, "cli_stateEpermLockA1", {
      inspectProcess(pid) {
        if (pid === child.pid) return { ok: false, reason: "kill(0) EPERM" };
        return processState.inspectProcess(pid);
      },
    });
    store.writeJson("status", { prepared: true });
    const lockDir = `${store.paths.inbox}.lock`;
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
      version: 1, pid: child.pid, processStartToken: childIdentity.startToken,
      nonce: "00000000-0000-4000-8000-000000000001",
    })}\n`, { mode: 0o600 });
    assert.throws(() => store.appendNdjson("inbox", { message_id: "om_eperm" }), /锁等待超时/);
    assert.equal(fs.existsSync(lockDir), true, "unknown live owner must not be reclaimed");
    assert.doesNotThrow(() => process.kill(child.pid, 0));
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("an active Inbox reclaimer is exclusive and its crash orphan is recoverable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-reclaim-owner-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 60_000)"], { stdio: "ignore" });
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const processState = await import(processStateUrl);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const childIdentity = processState.inspectProcess(child.pid);
    assert.equal(childIdentity.ok, true, childIdentity.reason);
    const store = createAgentStateStore(root, "cli_stateReclaimOwnerA1");
    store.writeJson("status", { prepared: true });
    const lockDir = `${store.paths.inbox}.lock`;
    const reclaimFile = `${lockDir}.reclaim`;
    fs.mkdirSync(lockDir, { mode: 0o700 });
    fs.writeFileSync(path.join(lockDir, "owner.json"), `${JSON.stringify({
      version: 1, pid: 2_147_483_647, processStartToken: "dead-target", nonce: "00000000-0000-4000-8000-000000000002",
    })}\n`, { mode: 0o600 });
    fs.writeFileSync(reclaimFile, `${JSON.stringify({
      pid: child.pid, processStartToken: childIdentity.startToken, commandToken: "setInterval",
      nonce: "active-reclaimer", startedAt: new Date().toISOString(),
    })}\n`, { mode: 0o600 });
    assert.throws(() => store.appendNdjson("inbox", { message_id: "om_double_reclaim" }), /锁等待超时/);
    assert.equal(fs.existsSync(lockDir), true);
    assert.equal(fs.existsSync(reclaimFile), true, "a second contender must not delete the active reclaimer");

    child.kill("SIGKILL");
    await once(child, "exit");
    store.appendNdjson("inbox", { message_id: "om_after_reclaimer_crash", chat_id: "oc_reclaim" });
    assert.deepEqual(store.readNdjson("inbox").map((row) => row.message_id), ["om_after_reclaimer_crash"]);
    assert.equal(fs.existsSync(lockDir), false);
    assert.equal(fs.existsSync(reclaimFile), false, "dead reclaimer poison must be removed");
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await once(child, "exit");
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
