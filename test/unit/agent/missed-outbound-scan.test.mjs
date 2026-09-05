import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import {
  hasInboxAuditTargets,
  inboxAuditRegistryFile,
  MAX_INBOX_AUDIT_REGISTRY_BYTES,
  MAX_INBOX_AUDIT_REGISTRY_ROWS,
  MAX_INBOX_AUDIT_TARGETS,
  observeInboxAuditTarget,
  readInboxAuditTargets,
} from "../../../src/agent/missed-outbound-scan.ts";
import {
  InboxAuditHeartbeat,
  MAX_INBOX_AUDIT_DIAGNOSTIC_CHARS,
} from "../../../src/agent/inbox-audit-heartbeat.ts";

const CHAT = "oc_7961b9d7be893b46520a926b90cf46eb";
const ROUTING_SINK = path.resolve(import.meta.dirname, "../../support/inbox-audit-routing-sink.mjs");

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

test("audit registry retains only authoritative human group/topic targets with their om_ anchor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-"));
  try {
    const file = inboxAuditRegistryFile(root);
    const common = { chat_id: CHAT, chat_type: "group", wake: true, _scan_authority: true, _sender_is_bot: false };
    assert.equal(hasInboxAuditTargets(file, "cli_audit"), false);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...common, wake: false, message_id: "om_unmentioned" }), false);
    assert.equal(hasInboxAuditTargets(file, "cli_audit"), false);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...common, message_id: "om_chat" }), true);
    assert.equal(hasInboxAuditTargets(file, "cli_audit"), true);
    assert.equal(hasInboxAuditTargets(file, "cli_unrelated"), false);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...common, thread_id: "omt_topic", message_id: "om_topic" }), true);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...common, chat_type: "p2p", message_id: "om_dm" }), false);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...common, _sender_is_bot: true, message_id: "om_bot" }), false);
    const audit = readInboxAuditTargets(file, "cli_audit");
    assert.equal(audit.targets.length, 2);
    assert.equal(audit.targets.every((row) => row.target.startsWith("chat:") || row.target.startsWith("thread:")), true);
    assert.equal(audit.targets.some((row) => row.target === `thread:${CHAT}:omt_topic` && row.anchor === "om_topic"), true);
    assert.equal(audit.targets.every((row) => /existing guarded larkin im reply/.test(row.instruction)), true);
    assert.equal(audit.no_finding, "stay_silent");
    for (let index = 0; index < MAX_INBOX_AUDIT_TARGETS + 2; index += 1) {
      observeInboxAuditTarget(file, "cli_other", { ...common, chat_id: `oc_${index}a`, message_id: `om_other${index}` });
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
    const common = { chat_id: CHAT, chat_type: "group", wake: true, _scan_authority: true, _sender_is_bot: false };
    assert.equal(observeInboxAuditTarget(file, "cli_audit", {
      ...common, thread_id: "omt_auditthread", message_id: "om_audit_thread_anchor",
    }), true);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", {
      ...common, chat_type: "p2p", message_id: "om_dm_anchor",
    }), false, "DM sources must not enter audit routing");
    assert.equal(observeInboxAuditTarget(file, "cli_audit", {
      ...common, message_id: "rem_invalid_anchor",
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

test("one Host timer callback wakes only Agents with an eligible audit target", async () => {
  const timers = [];
  const inbox = [];
  const deliveries = [];
  const heartbeat = new InboxAuditHeartbeat({
    agents: [{ agentId: "cli_auditOne" }, { agentId: "cli_auditTwo" }],
    stateStore: () => ({ appendCanonicalInboxOnce(envelope) { inbox.push(envelope); return { status: "appended", envelope }; } }),
    runtimeHost: { async deliver(agentId, envelope) { deliveries.push({ agentId, envelope }); } },
    shouldDispatch: (agent) => agent.agentId === "cli_auditTwo",
    now: () => 1234,
    setTimer(callback, delay) { timers.push({ callback, delay }); return { unref() {} }; },
    clearTimer() {},
  });
  heartbeat.start();
  heartbeat.start();
  assert.equal(timers.length, 1, "multiple agents still share one Host timer");
  assert.equal(timers[0].delay, 15 * 60_000);
  await timers[0].callback();
  assert.equal(timers.length, 2, "callback re-arms one successor timer");
  assert.deepEqual(deliveries.map((row) => row.agentId), ["cli_auditTwo"]);
  assert.equal(inbox.length, 1, "an Agent without an eligible audit target receives no model wake");
  assert.equal(inbox.every((row) => row.target === "runtime:reminder" && row.kind === "reminder"), true);
  assert.equal(inbox.every((row) => !Object.hasOwn(row, "deliveryTarget") && !Object.hasOwn(row, "deliveryAnchor")), true);
  heartbeat.stop();
});

test("an Agent-scoped audit predicate failure fails closed and does not block a healthy sibling", async () => {
  const timers = [];
  const inbox = [];
  const deliveries = [];
  const logs = [];
  const heartbeat = new InboxAuditHeartbeat({
    agents: [{ agentId: "cli_brokenAudit" }, { agentId: "cli_healthyAudit" }],
    stateStore: () => ({ appendCanonicalInboxOnce(envelope) { inbox.push(envelope); return { status: "appended", envelope }; } }),
    runtimeHost: { async deliver(agentId) { deliveries.push(agentId); } },
    shouldDispatch(agent) {
      if (agent.agentId === "cli_brokenAudit") throw new Error("fixture registry unavailable");
      return true;
    },
    log: (...parts) => logs.push(parts.join(" ")),
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    clearTimer() {},
  });
  heartbeat.start();
  await timers[0]();
  assert.deepEqual(deliveries, ["cli_healthyAudit"]);
  assert.equal(inbox.length, 1);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /cli_brokenAudit.*fixture registry unavailable/);
  heartbeat.stop();
});

test("hasInboxAuditTargets fails closed on oversized bytes without truncating the registry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-bytes-"));
  try {
    const file = inboxAuditRegistryFile(root);
    const padding = "x".repeat(MAX_INBOX_AUDIT_REGISTRY_BYTES);
    const original = `${JSON.stringify({ version: 1, targets: [], padding })}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, original, { mode: 0o600 });
    assert.ok(fs.statSync(file).size > MAX_INBOX_AUDIT_REGISTRY_BYTES);
    assert.throws(() => hasInboxAuditTargets(file, "cli_audit"), /bounded byte limit/);
    assert.equal(fs.readFileSync(file, "utf8"), original, "oversized registry bytes must stay intact");
    assert.throws(() => readInboxAuditTargets(file, "cli_audit"), /bounded byte limit/);
    assert.throws(() => observeInboxAuditTarget(file, "cli_audit", {
      chat_id: CHAT, chat_type: "group", wake: true, _scan_authority: true, _sender_is_bot: false, message_id: "om_keep",
    }), /bounded byte limit/);
    assert.equal(fs.readFileSync(file, "utf8"), original, "failed observe must not rewrite an oversized registry");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("hasInboxAuditTargets fails closed on oversized rows without rewriting the registry", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-rows-"));
  try {
    const file = inboxAuditRegistryFile(root);
    const original = `${JSON.stringify({
      version: 1,
      targets: Array.from({ length: MAX_INBOX_AUDIT_REGISTRY_ROWS + 1 }, (_row, index) => ({
        agent_id: "cli_audit",
        target: `chat:${CHAT}`,
        anchor: `om_row${index}`,
        observed_at: "2026-09-05T00:00:00.000Z",
      })),
    })}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, original, { mode: 0o600 });
    assert.throws(() => hasInboxAuditTargets(file, "cli_audit"), /bounded row limit/);
    assert.equal(fs.readFileSync(file, "utf8"), original, "oversized registry rows must stay intact");
    assert.throws(() => observeInboxAuditTarget(file, "cli_audit", {
      chat_id: CHAT, chat_type: "group", wake: true, _scan_authority: true, _sender_is_bot: false, message_id: "om_keep",
    }), /bounded row limit/);
    assert.equal(fs.readFileSync(file, "utf8"), original, "failed observe must not slice or rewrite extra rows");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("heartbeat diagnostics stay bounded when a registry error message is huge", async () => {
  const timers = [];
  const logs = [];
  const marker = "secret-should-not-repeat";
  const huge = `registry boom ${"x".repeat(8_000)} ${marker}`;
  const heartbeat = new InboxAuditHeartbeat({
    agents: [{ agentId: "cli_brokenAudit" }, { agentId: "cli_healthyAudit" }],
    stateStore: () => ({ appendCanonicalInboxOnce(envelope) { return { status: "appended", envelope }; } }),
    runtimeHost: { async deliver() {} },
    shouldDispatch(agent) {
      if (agent.agentId === "cli_brokenAudit") throw new Error(huge);
      return false;
    },
    log: (...parts) => logs.push(parts.join(" ")),
    setTimer(callback) { timers.push(callback); return { unref() {} }; },
    clearTimer() {},
  });
  heartbeat.start();
  await timers[0]();
  assert.equal(logs.length, 1);
  assert.match(logs[0], /cli_brokenAudit/);
  assert.ok(logs[0].length <= `inbox audit heartbeat failed agent=cli_brokenAudit: `.length + MAX_INBOX_AUDIT_DIAGNOSTIC_CHARS);
  assert.equal(logs[0].includes(marker), false);
  assert.equal(logs[0].includes("x".repeat(200)), false);
  heartbeat.stop();
});
