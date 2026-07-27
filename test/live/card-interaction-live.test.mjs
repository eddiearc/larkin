import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createAgentStateStore } from "../../dist/agent/agent-state-store.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENABLED = process.env.LARKIN_RUN_FEISHU_CARD_INTERACTION_TEST === "1";
const required = (name) => {
  const value = process.env[name];
  assert.ok(value, `${name} is required by the enabled live harness`);
  return value;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const findMessageId = (value) => {
  if (typeof value === "string" && /^om_[A-Za-z0-9_-]+$/.test(value)) return value;
  if (!value || typeof value !== "object") return null;
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    const found = findMessageId(child);
    if (found) return found;
  }
  return null;
};

async function waitForPlatformEvidence(file, instanceId, deadline) {
  let lastError = "evidence file has not appeared";
  while (Date.now() < deadline) {
    try {
      const evidence = readJson(file);
      if (evidence.instance_id !== instanceId) throw new Error(`stale instance_id ${String(evidence.instance_id)}`);
      return evidence;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      await sleep(250);
    }
  }
  throw new Error(`missing platform-observed callback evidence at ${file}: ${lastError}. `
    + "The enabled harness requires instance_id, backend callback/Reflex timing and response, accepted/duplicate/illegal event IDs, "
    + "all action IDs, explicit Owner UI Toast/processing confirmation, duplicate response, and illegal-click responses.");
}

function validatePlatformEvidence(evidence, instanceId) {
  assert.equal(evidence.instance_id, instanceId);
  assert.equal(evidence.real_click_source, "owner-confirmed-feishu-ui+durable-host-run");
  assert.equal(evidence.ui_observer?.source, "owner-live-ui-confirmation");
  assert.ok(Number.isFinite(Date.parse(evidence.ui_observer?.confirmed_at)), "UI confirmation requires a recorded timestamp");
  assert.equal(evidence.duplicate_source, "production-orchestrator-replay");
  assert.equal(evidence.illegal_source, "production-orchestrator-replay");
  const callbackReceivedAt = Date.parse(evidence.backend_callback_received_at);
  const reflexCompletedAt = Date.parse(evidence.backend_reflex_completed_at);
  assert.ok(Number.isFinite(callbackReceivedAt) && Number.isFinite(reflexCompletedAt), "backend evidence requires valid callback/Reflex timestamps");
  const backendLatency = reflexCompletedAt - callbackReceivedAt;
  assert.ok(backendLatency >= 0 && backendLatency < 3_000, `durable backend Reflex exceeded 3s: ${backendLatency}ms`);
  assert.match(String(evidence.ui_observer.toast_text || ""), /已受理.*Agent 正在处理|Agent.*processing/i, "Owner-confirmed UI Toast is missing processing feedback");
  assert.match(String(evidence.ui_observer.processing_text || ""), /当前状态不代表业务已经完成|Agent.*processing|处理中/i, "Owner-confirmed processing card is missing truthful feedback");
  assert.match(String(evidence.duplicate_response || ""), /已受理|processing/i, "same-event callback replay must expose the durable duplicate response");
  assert.match(String(evidence.backend_processing_response || ""), /当前状态不代表业务已经完成|Agent.*processing/i, "backend processing response is missing");
  assert.deepEqual(new Set(evidence.action_ids), new Set(["confirm", "alternate", "defer"]), "platform hook must observe all three action IDs");
  assert.ok(typeof evidence.accepted_event_id === "string" && evidence.accepted_event_id);
  assert.equal(evidence.duplicate_event_id, evidence.accepted_event_id, "duplicate evidence must replay the exact accepted event_id");
  assert.deepEqual(Object.keys(evidence.illegal_event_ids || {}).sort(), ["alternate", "defer"]);
  assert.deepEqual(Object.keys(evidence.illegal_clicks || {}).sort(), ["alternate", "defer"]);
  for (const actionId of ["alternate", "defer"]) {
    const eventId = evidence.illegal_event_ids[actionId];
    assert.ok(typeof eventId === "string" && eventId && eventId !== evidence.accepted_event_id, `${actionId} requires a distinct illegal callback event_id`);
    assert.match(String(evidence.illegal_clicks[actionId] || ""), /无法受理|active run|stale|not allowed/i, `${actionId} illegal-next-state evidence is missing`);
  }
  assert.notEqual(evidence.illegal_event_ids.alternate, evidence.illegal_event_ids.defer);
}

function removeLocalInteraction(store, instanceId) {
  if (!fs.existsSync(store.paths.interactions)) return;
  store.mutateJson("interactions", { version: 1, definitions: [], instances: [], runs: [], action_refs: [], outbox: [] }, (state) => {
    const instance = state.instances.find((item) => item.instance_id === instanceId);
    if (!instance) return;
    const runIds = new Set(state.runs.filter((item) => item.instance_id === instanceId).map((item) => item.run_id));
    state.instances = state.instances.filter((item) => item.instance_id !== instanceId);
    state.definitions = state.definitions.filter((item) => item.definition_id !== instance.definition_id);
    state.action_refs = state.action_refs.filter((item) => item.instance_id !== instanceId);
    state.runs = state.runs.filter((item) => item.instance_id !== instanceId);
    state.outbox = state.outbox.filter((item) => !runIds.has(item.run_id));
  });
}

test.skipIf(!ENABLED)("real Feishu click closes reminder Reflex -> Agent resolve -> exact original-card projection", {
  timeout: 480_000,
}, async () => {
  const configDir = required("LARKIN_CONFIG_DIR");
  const agentId = required("LARKIN_AGENT_ID");
  const chatId = required("LARKIN_FEISHU_CARD_TEST_CHAT_ID");
  const operatorOpenId = required("LARKIN_FEISHU_CARD_TEST_OPERATOR_OPEN_ID");
  const evidenceFile = required("LARKIN_FEISHU_CARD_TEST_PLATFORM_EVIDENCE_FILE");
  assert.equal(required("LARKIN_FEISHU_CARD_TEST_ALLOW_CLEANUP"), "1", "authorized live harness must explicitly allow reminder/message cleanup");
  const stateFile = path.join(configDir, "state", "agents", agentId, "interactions.json");
  const deliveryFile = path.join(path.dirname(stateFile), "runtime-deliveries.json");
  const reminderFile = path.join(path.dirname(stateFile), "reminders.json");
  const cli = path.join(ROOT, "dist", "app", "agent-cli.mjs");
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-live-card-"));
  const store = createAgentStateStore(configDir, agentId);
  const env = { ...process.env, LARKIN_CONFIG_DIR: configDir, LARKIN_AGENT_ID: agentId };
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: temp, env, encoding: "utf8", timeout: 30_000 });
  const cleanupErrors = [];
  const reminderIds = new Set();
  let instanceId = null;
  let runId = null;
  let sentMessageId = null;
  try {
    const specFile = path.join(temp, "card.json");
    const nonce = Date.now().toString(36);
    fs.writeFileSync(specFile, JSON.stringify({
      schema_version: 1, initial_state: "pending", expires_in_seconds: 600,
      audience: { open_ids: [operatorOpenId] },
      states: {
        pending: { title: `Larkin interaction ${nonce}`, markdown: "Click Confirm once, then keep this card visible to verify the Toast and processing state. The evidence driver replays stale actions separately." },
        processing: { title: `Larkin interaction ${nonce}`, markdown: "Accepted; Agent is processing." },
        done: { title: `Larkin interaction ${nonce}`, markdown: "Live interaction completed.", terminal: true },
        failed: { title: `Larkin interaction ${nonce}`, markdown: "Live interaction failed.", terminal: true },
      },
      actions: {
        confirm: {
          from: ["pending"], label: "Confirm live test", processing_state: "processing", success_state: "done", failure_state: "failed", timeout_state: "failed",
          reflex: { toast: "Accepted. Agent is processing.", effect: { id: "reminder.schedule", args: { title: `Live interaction ${nonce}`, delay_seconds: 900 } } },
          agent: { instruction: "This is an authorized live harness. Inspect the run, then use interaction resolve with the expected version, succeeded status, and an empty data object. Do not wait for the test process to resolve it." },
          result_schema: { properties: {}, required: [], additional_properties: false },
        },
        alternate: {
          from: ["pending"], label: "Alternate live test", processing_state: "processing", success_state: "done", failure_state: "failed", timeout_state: "failed",
          reflex: { toast: "Accepted. Agent is processing." },
          agent: { instruction: "Resolve this alternate live-harness action after inspecting its run." },
          result_schema: { properties: {}, required: [], additional_properties: false },
        },
        defer: {
          from: ["pending"], label: "Defer live test", processing_state: "processing", success_state: "done", failure_state: "failed", timeout_state: "failed",
          reflex: { toast: "Accepted. Agent is processing." },
          agent: { instruction: "Resolve this deferred live-harness action after inspecting its run." },
          result_schema: { properties: {}, required: [], additional_properties: false },
        },
      },
    }));
    const created = run(["interaction", "create", "--spec-file", specFile, "--chat-id", chatId]);
    assert.equal(created.status, 0, created.stderr);
    const payload = JSON.parse(created.stdout);
    instanceId = payload.instance.instance_id;
    const initialButtons = JSON.parse(payload.message_content).body.elements.filter((item) => item.tag === "button");
    assert.equal(initialButtons.length, 3, "live harness card must render exactly three buttons");
    assert.deepEqual(initialButtons.map((button) => button.text.content), ["Confirm live test", "Alternate live test", "Defer live test"]);
    const sent = run(["im", "+messages-send", "--chat-id", chatId, "--msg-type", "interactive", "--content", payload.message_content, "--json"]);
    assert.equal(sent.status, 0, sent.stderr);
    sentMessageId = findMessageId(JSON.parse(sent.stdout));
    assert.ok(sentMessageId, `message send result did not expose an om_ message_id: ${sent.stdout.slice(0, 500)}`);
    process.stderr.write(`[live-card] sent instance=${instanceId} message=${sentMessageId}; submit “Confirm live test” once. Use this full instance ID for LARKIN_FEISHU_CARD_TEST_INSTANCE_ID. The authorized evidence driver must then replay that exact callback event_id and the two stale action refs through the production Orchestrator, confirm Toast/processing in the real UI, and write ${evidenceFile}.\n`);

    const callbackDeadline = Date.now() + 120_000;
    let runRecord;
    while (Date.now() < callbackDeadline) {
      const state = readJson(stateFile);
      runRecord = state.runs.find((candidate) => candidate.instance_id === instanceId);
      if (runRecord && runRecord.reflex?.status !== "pending") break;
      await sleep(500);
    }
    assert.ok(runRecord, "no real card callback arrived before timeout");
    runId = runRecord.run_id;
    const deliveryDeadline = Date.now() + 30_000;
    while (Date.now() < deliveryDeadline && runRecord.agent_delivery_status !== "delivered") {
      await sleep(250);
      runRecord = readJson(stateFile).runs.find((candidate) => candidate.run_id === runId);
      if (!runRecord) break;
    }
    assert.ok(runRecord, "real callback run disappeared while waiting for Agent delivery");
    assert.equal(runRecord.agent_delivery_status, "delivered");
    assert.equal(runRecord.reflex.status, "succeeded");
    const reflexLatency = Date.parse(runRecord.reflex_completed_at) - Date.parse(runRecord.callback_received_at);
    assert.ok(reflexLatency >= 0 && reflexLatency < 3_000, `durable Reflex exceeded callback budget: ${reflexLatency}ms`);
    const evidenceDeadline = Date.now() + 180_000;
    const evidence = await waitForPlatformEvidence(evidenceFile, instanceId, evidenceDeadline);
    validatePlatformEvidence(evidence, instanceId);

    await sleep(1_500);
    const snapshotAfterClicks = readJson(stateFile);
    assert.equal(snapshotAfterClicks.runs.filter((candidate) => candidate.instance_id === instanceId).length, 1);
    const reminders = readJson(reminderFile).reminders.filter((item) => item.payload?.run_id === runId);
    assert.equal(reminders.length, 1, "reminder Reflex must be exactly-once under illegal clicks");
    for (const reminder of reminders) reminderIds.add(reminder.reminderId);
    for (const reminderId of reminderIds) {
      const canceled = run(["reminder", "cancel", "--id", reminderId]);
      assert.equal(canceled.status, 0, canceled.stderr);
    }
    reminderIds.clear();
    const delivery = readJson(deliveryFile).records.filter((item) => item.messageId === `interaction_${runId}`);
    assert.equal(delivery.length, 1, "stable interaction wake must own exactly one Runtime ledger record");

    let resolvedByAgent = false;
    const resolveDeadline = Date.now() + 90_000;
    while (Date.now() < resolveDeadline) {
      const state = readJson(stateFile);
      const candidate = state.runs.find((item) => item.run_id === runId);
      if (candidate?.resolve?.status === "succeeded") { resolvedByAgent = true; break; }
      await sleep(500);
    }
    assert.equal(resolvedByAgent, true, "the real Agent did not inspect and resolve the wake before timeout");
    let projected = false;
    const projectionDeadline = Date.now() + 30_000;
    while (Date.now() < projectionDeadline) {
      const state = readJson(stateFile);
      const instance = state.instances.find((candidate) => candidate.instance_id === instanceId);
      if (instance?.current_state === "done" && instance.projected_version === instance.desired_projection_version) { projected = true; break; }
      await sleep(500);
    }
    assert.equal(projected, true, "resolved business state did not reach the original card projection");
  } finally {
    if (!runId && instanceId && fs.existsSync(stateFile)) {
      try { runId = readJson(stateFile).runs.find((item) => item.instance_id === instanceId)?.run_id || null; }
      catch (error) { cleanupErrors.push(`recover cleanup run id: ${String(error)}`); }
    }
    if (fs.existsSync(reminderFile)) {
      try {
        const candidates = readJson(reminderFile).reminders.filter((item) => runId && item.payload?.run_id === runId && item.status !== "canceled");
        for (const reminder of candidates) reminderIds.add(reminder.reminderId);
      } catch (error) { cleanupErrors.push(`scan reminders: ${String(error)}`); }
      for (const reminderId of reminderIds) {
        const canceled = run(["reminder", "cancel", "--id", reminderId]);
        if (canceled.status !== 0) cleanupErrors.push(`cancel reminder ${reminderId}: ${canceled.stderr}`);
      }
    }
    if (sentMessageId) {
      const deleted = run(["im", "messages", "delete", "--message-id", sentMessageId, "--yes", "--json"]);
      if (deleted.status !== 0) cleanupErrors.push(`delete remote card ${sentMessageId}: ${deleted.stderr}`);
    }
    if (instanceId) {
      try { removeLocalInteraction(store, instanceId); }
      catch (error) { cleanupErrors.push(`remove local interaction ${instanceId}: ${String(error)}`); }
    }
    fs.rmSync(temp, { recursive: true, force: true });
    assert.deepEqual(cleanupErrors, [], `live harness cleanup failed:\n${cleanupErrors.join("\n")}`);
  }
});
