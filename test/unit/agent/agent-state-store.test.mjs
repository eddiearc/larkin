import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const moduleUrl = pathToFileURL(path.join(ROOT, "dist/agent/agent-state-store.mjs")).href;

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
    const envelope = { message_id: "interaction_run_1", wake: true };
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
