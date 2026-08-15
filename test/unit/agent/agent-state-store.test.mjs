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

test("appendInboxOnce remembers a stable provider id after the Inbox row is consumed", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-state-stable-inbox-id-"));
  try {
    const { createAgentStateStore } = await import(moduleUrl);
    const store = createAgentStateStore(root, "cli_stateStableInboxA1");
    const envelope = { message_id: "doc_comment_stable", target: "document-comment:docx:file:comment:in-thread" };
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
