import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createAgentStateStore } from "../../dist/agent/agent-state-store.mjs";
import { HostInteractionOrchestrator } from "../../dist/feishu/interaction-orchestrator.mjs";

const required = (name) => {
  const value = process.env[name];
  assert.ok(value, `${name} is required`);
  return value;
};

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

function callbackEvent({ eventId, ref, version, operatorOpenId, chatId, messageId }) {
  return {
    messageId,
    chatId,
    operator: { openId: operatorOpenId, name: "authorized-live-operator" },
    action: { tag: "button", value: { interaction_ref: ref, interaction_version: version } },
    raw: { header: { event_id: eventId } },
  };
}

async function capture() {
  const configDir = required("LARKIN_CONFIG_DIR");
  const agentId = required("LARKIN_AGENT_ID");
  const instanceId = required("LARKIN_FEISHU_CARD_TEST_INSTANCE_ID");
  const operatorOpenId = required("LARKIN_FEISHU_CARD_TEST_OPERATOR_OPEN_ID");
  const draftFile = required("LARKIN_FEISHU_CARD_TEST_DRAFT_EVIDENCE_FILE");
  const store = createAgentStateStore(configDir, agentId);
  const state = readJson(store.paths.interactions);
  const instance = state.instances.find((item) => item.instance_id === instanceId);
  assert.ok(instance, `interaction instance ${instanceId} not found`);
  const run = state.runs.find((item) => item.instance_id === instanceId);
  assert.ok(run, `real callback run for ${instanceId} not found`);
  assert.equal(run.action_id, "confirm", "the real Feishu click must be the confirm action");
  assert.equal(run.reflex.status, "succeeded", "real Reflex must complete before evidence replay");
  assert.equal(run.agent_delivery_status, "delivered", "real Agent wake must be delivered before evidence replay");
  assert.match(run.callback_id, /^card:.+/, "real callback must have a durable platform event_id");
  const acceptedEventId = run.callback_id.slice("card:".length);
  const refs = new Map(state.action_refs.filter((item) => item.instance_id === instanceId).map((item) => [item.action_id, item.ref]));
  assert.deepEqual([...refs.keys()].sort(), ["alternate", "confirm", "defer"]);

  const agent = { agentId, name: agentId, stateDir: path.dirname(store.paths.interactions) };
  const orchestrator = new HostInteractionOrchestrator({
    agents: [agent],
    stateStore: () => store,
    deliveryTarget: { async deliver() { throw new Error("evidence replay must not deliver Runtime input"); } },
    channelFor: () => undefined,
  });
  // Replays exercise the production callback path only. The real Host already owns
  // asynchronous delivery/projection, so the evidence process must not compete for outbox work.
  orchestrator.flushPending = async () => {};

  const base = {
    version: run.source_version,
    operatorOpenId,
    chatId: run.chat_id,
    messageId: run.message_id,
  };
  const duplicate = await orchestrator.handleCardAction(agent, callbackEvent({
    ...base, eventId: acceptedEventId, ref: refs.get("confirm"),
  }));
  const illegalEventIds = {
    alternate: `replay_${randomUUID().replaceAll("-", "")}`,
    defer: `replay_${randomUUID().replaceAll("-", "")}`,
  };
  const illegalResponses = {};
  for (const actionId of ["alternate", "defer"]) {
    illegalResponses[actionId] = await orchestrator.handleCardAction(agent, callbackEvent({
      ...base, eventId: illegalEventIds[actionId], ref: refs.get(actionId),
    }));
  }

  const evidence = {
    instance_id: instanceId,
    real_click_source: "durable-host-run-awaiting-ui-confirmation",
    duplicate_source: "production-orchestrator-replay",
    illegal_source: "production-orchestrator-replay",
    backend_callback_received_at: run.callback_received_at,
    backend_reflex_completed_at: run.reflex_completed_at,
    accepted_event_id: acceptedEventId,
    duplicate_event_id: acceptedEventId,
    illegal_event_ids: illegalEventIds,
    action_ids: [...refs.keys()],
    duplicate_response: duplicate.toast?.content || "",
    backend_processing_response: JSON.stringify(duplicate.card?.data || {}),
    illegal_clicks: {
      alternate: illegalResponses.alternate?.toast?.content || "",
      defer: illegalResponses.defer?.toast?.content || "",
    },
    captured_at: new Date().toISOString(),
  };
  writeJsonAtomic(draftFile, evidence);
  process.stdout.write(`${JSON.stringify({ ok: true, mode: "capture", instance_id: instanceId, draft_file: draftFile })}\n`);
}

function confirm() {
  const draftFile = required("LARKIN_FEISHU_CARD_TEST_DRAFT_EVIDENCE_FILE");
  const evidenceFile = required("LARKIN_FEISHU_CARD_TEST_PLATFORM_EVIDENCE_FILE");
  const toastText = required("LARKIN_FEISHU_CARD_TEST_UI_TOAST_TEXT");
  const processingText = required("LARKIN_FEISHU_CARD_TEST_UI_PROCESSING_TEXT");
  assert.match(toastText, /已受理.*Agent 正在处理|Agent.*processing/i, "UI Toast confirmation does not contain processing feedback");
  assert.match(processingText, /当前状态不代表业务已经完成|Agent.*processing|处理中/i, "UI card confirmation does not contain truthful processing feedback");
  const evidence = readJson(draftFile);
  evidence.real_click_source = "owner-confirmed-feishu-ui+durable-host-run";
  evidence.ui_observer = {
    source: "owner-live-ui-confirmation",
    confirmed_at: new Date().toISOString(),
    toast_text: toastText,
    processing_text: processingText,
  };
  writeJsonAtomic(evidenceFile, evidence);
  process.stdout.write(`${JSON.stringify({ ok: true, mode: "confirm", instance_id: evidence.instance_id, evidence_file: evidenceFile })}\n`);
}

const mode = process.argv[2];
if (mode === "capture") await capture();
else if (mode === "confirm") confirm();
else {
  process.stderr.write("usage: node test/live/card-interaction-evidence-driver.mjs capture|confirm\n");
  process.exitCode = 2;
}
