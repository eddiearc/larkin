import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import {
  completeInboxAuditTargets,
  hasPendingInboxAuditTargets,
  inboxAuditRegistryFile,
  MAX_INBOX_AUDIT_TARGETS,
  observeInboxAuditTarget,
  readInboxAuditTargets,
} from "../../../src/agent/missed-outbound-scan.ts";
import { InboxAuditHeartbeat, INBOX_AUDIT_CADENCE_MS } from "../../../src/agent/inbox-audit-heartbeat.ts";

const CHAT = "oc_7961b9d7be893b46520a926b90cf46eb";
const ROUTING_SINK = path.resolve(import.meta.dirname, "../../support/inbox-audit-routing-sink.mjs");
const WAKE = { chat_id: CHAT, chat_type: "group", wake: true, _scan_authority: true, _sender_is_bot: false };

function reportFindingToControlledSink(audit, finding, traceFile) {
  const source = finding && audit.targets.find((row) => row.target === finding.target && row.anchor === finding.anchor);
  if (!source) return null;
  return spawnSync(process.execPath, [ROUTING_SINK,
    "im", "+messages-reply", "--message-id", source.anchor,
    ...(source.target.startsWith("thread:") ? ["--reply-in-thread"] : []),
    "--markdown", "Audit finding: follow-up is needed.", "--json"], {
    encoding: "utf8",
    env: { ...process.env, INBOX_AUDIT_ROUTING_TRACE_FILE: traceFile, INBOX_AUDIT_ROUTING_ANCHOR: source.anchor },
  });
}

test("audit registry retains only originally wake=true human group/topic targets with their om_ anchor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-"));
  try {
    const file = inboxAuditRegistryFile(root);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, message_id: "om_chat" }), true);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, thread_id: "omt_topic", message_id: "om_topic" }), true);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, chat_type: "p2p", message_id: "om_dm" }), false);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, _sender_is_bot: true, message_id: "om_bot" }), false);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, wake: false, message_id: "om_unmentioned" }), false, "require unmentioned traffic must not enter audit");
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, wake: undefined, message_id: "om_missing_wake" }), false);
    const audit = readInboxAuditTargets(file, "cli_audit");
    assert.equal(audit.targets.length, 2);
    assert.equal(audit.targets.every((row) => row.target.startsWith("chat:") || row.target.startsWith("thread:")), true);
    assert.equal(audit.targets.some((row) => row.target === `thread:${CHAT}:omt_topic` && row.anchor === "om_topic"), true);
    assert.equal(audit.targets.every((row) => /existing guarded larkin im reply/.test(row.instruction)), true);
    assert.equal(audit.no_finding, "stay_silent");
    for (let index = 0; index < MAX_INBOX_AUDIT_TARGETS + 2; index += 1) {
      observeInboxAuditTarget(file, "cli_other", { ...WAKE, chat_id: `oc_${index}a`, message_id: `om_other${index}` });
    }
    const retained = readInboxAuditTargets(file, "cli_other");
    assert.equal(retained.targets.length, MAX_INBOX_AUDIT_TARGETS);
    assert.equal(retained.has_more, false, "all 96 retained audit targets are returned in one bounded result");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("controlled audit sink routes only a concrete thread finding to its om_ anchor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-route-"));
  try {
    const file = inboxAuditRegistryFile(root);
    const traceFile = path.join(root, "provider-writes.ndjson");
    fs.writeFileSync(traceFile, "", { mode: 0o600 });
    assert.equal(observeInboxAuditTarget(file, "cli_audit", {
      ...WAKE, thread_id: "omt_auditthread", message_id: "om_audit_thread_anchor",
    }), true);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", {
      ...WAKE, chat_type: "p2p", message_id: "om_dm_anchor",
    }), false, "DM sources must not enter audit routing");
    assert.equal(observeInboxAuditTarget(file, "cli_audit", {
      ...WAKE, message_id: "rem_invalid_anchor",
    }), false, "non-om_ anchors must not enter audit routing");

    const audit = readInboxAuditTargets(file, "cli_audit");
    const finding = { target: `thread:${CHAT}:omt_auditthread`, anchor: "om_audit_thread_anchor" };
    const positive = reportFindingToControlledSink(audit, finding, traceFile);
    assert.equal(positive.status, 0, positive.stderr);
    const writes = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].target, finding.anchor);
    assert.ok(writes[0].argv.includes("--reply-in-thread"));

    fs.truncateSync(traceFile, 0);
    assert.equal(reportFindingToControlledSink(audit, { target: `chat:${CHAT}`, anchor: "om_dm_anchor" }, traceFile), null);
    assert.equal(reportFindingToControlledSink(audit, { target: `chat:${CHAT}`, anchor: "rem_invalid_anchor" }, traceFile), null);
    assert.equal(reportFindingToControlledSink(audit, null, traceFile), null, "no finding must not write");
    assert.equal(fs.readFileSync(traceFile, "utf8"), "", "DM, invalid anchor, and no finding produce zero provider writes");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("completed and v1 audit targets are not returned or re-observed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-complete-"));
  try {
    const file = inboxAuditRegistryFile(root);
    fs.writeFileSync(file, `${JSON.stringify({
      version: 1,
      targets: [{ agent_id: "cli_audit", target: `chat:${CHAT}`, anchor: "om_legacy", observed_at: "2026-07-20T00:00:00.000Z" }],
    })}\n`, { mode: 0o600 });
    assert.equal(readInboxAuditTargets(file, "cli_audit").targets.length, 0, "v1 rows cannot prove originally-wake=true and must be discarded");
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, message_id: "om_pending" }), true);
    assert.equal(hasPendingInboxAuditTargets(file, "cli_audit"), true);
    assert.equal(completeInboxAuditTargets(file, "cli_audit", new Date("2026-07-21T00:00:00.000Z")), 1);
    assert.equal(readInboxAuditTargets(file, "cli_audit").targets.length, 0);
    assert.equal(hasPendingInboxAuditTargets(file, "cli_audit"), false);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, message_id: "om_pending" }), false, "same completed anchor must not reopen");
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, message_id: "om_new" }), true, "a new originally-wake=true anchor may reopen the target");
    assert.equal(readInboxAuditTargets(file, "cli_audit").targets[0].anchor, "om_new");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 2);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("one Host timer per Agent skips disabled or empty audits and uses configured cadence", async () => {
  const timers = [];
  const inbox = [];
  const deliveries = [];
  const pending = new Set(["cli_auditOne"]);
  const schedule = {
    cli_auditOne: { enabled: true, intervalMs: 60_000 },
    cli_auditTwo: { enabled: true, intervalMs: 120_000 },
    cli_auditOff: { enabled: false, intervalMs: INBOX_AUDIT_CADENCE_MS },
  };
  const heartbeat = new InboxAuditHeartbeat({
    agents: [{ agentId: "cli_auditOne" }, { agentId: "cli_auditTwo" }, { agentId: "cli_auditOff" }],
    stateStore: () => ({ appendCanonicalInboxOnce(envelope) { inbox.push(envelope); return { status: "appended", envelope }; } }),
    runtimeHost: { async deliver(agentId, envelope) { deliveries.push({ agentId, envelope }); } },
    now: () => 1234,
    setTimer(callback, delay) { timers.push({ callback, delay }); return { unref() {} }; },
    clearTimer() {},
    schedule(agent) { return schedule[agent.agentId]; },
    shouldDispatch(agent) { return pending.has(agent.agentId); },
  });
  heartbeat.start();
  heartbeat.start();
  assert.equal(timers.length, 3, "each Agent has its own Host timer");
  assert.deepEqual(timers.map((timer) => timer.delay).sort((left, right) => left - right), [60_000, 120_000, INBOX_AUDIT_CADENCE_MS]);
  await Promise.all([timers[0].callback(), timers[1].callback(), timers[2].callback()]);
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].agentId, "cli_auditOne");
  assert.equal(inbox[0].target, "runtime:reminder");
  assert.equal(Object.hasOwn(inbox[0], "deliveryTarget"), false);
  assert.equal(Object.hasOwn(inbox[0], "deliveryAnchor"), false);
  pending.delete("cli_auditOne");
  const rearmed = timers.filter((timer) => timer.delay === 60_000);
  assert.equal(rearmed.length, 2, "enabled Agent re-arms after fire");
  await rearmed[1].callback();
  assert.equal(deliveries.length, 1, "no pending originally-wake=true work must not wake the model");
  heartbeat.stop();
});
