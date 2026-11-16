import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { test } from "bun:test";
const {
  completeInboxAuditTarget,
  hasPendingInboxAuditTargets,
  inboxAuditRegistryFile,
  inboxAuditRetryFile,
  MAX_INBOX_AUDIT_TARGETS,
  observeInboxAuditTarget,
  enqueueInboxAuditTargetRetry,
  reconcileInboxAuditTargetRetries,
  readInboxAuditTargets,
} = await import(pathToFileURL(path.join(import.meta.dirname, "../../../dist/agent/missed-outbound-scan.mjs")).href);
import { InboxAuditHeartbeat, INBOX_AUDIT_CADENCE_MS } from "../../../src/agent/inbox-audit-heartbeat.ts";

const configApi = createRequire(import.meta.url)("../../../dist/platform/config.cjs");

const CHAT = "oc_7961b9d7be893b46520a926b90cf46eb";
const ROUTING_SINK = path.resolve(import.meta.dirname, "../../support/inbox-audit-routing-sink.mjs");
const WAKE = { chat_id: CHAT, chat_type: "group", source_seq: 1, wake: true, _scan_authority: true, _sender_is_bot: false };

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
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, source_seq: 2, thread_id: "omt_topic", message_id: "om_topic" }), true);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, chat_type: "p2p", message_id: "om_dm" }), false);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, _sender_is_bot: true, message_id: "om_bot" }), false);
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, wake: false, message_id: "om_unmentioned" }), false, "require unmentioned traffic must not enter audit");
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, wake: undefined, message_id: "om_missing_wake" }), false);
    const audit = readInboxAuditTargets(file, "cli_audit");
    assert.equal(audit.targets.length, 2);
    assert.equal(audit.targets.every((row) => row.target.startsWith("chat:") || row.target.startsWith("thread:")), true);
    assert.equal(audit.targets.some((row) => row.target === `thread:${CHAT}:omt_topic` && row.anchor === "om_topic"), true);
    assert.equal(audit.targets.every((row) => /^1\. Read this /.test(row.instruction) && /audit complete --receipt .* --outcome handled/.test(row.instruction)), true);
    const topic = audit.targets.find((row) => row.target.startsWith("thread:"));
    const chat = audit.targets.find((row) => row.target.startsWith("chat:"));
    assert.match(topic.instruction, /\+threads-messages-list --thread omt_topic /);
    assert.match(topic.instruction, /\+messages-reply --message-id <om_id> --text '<reply>' --reply-in-thread --json/);
    assert.match(topic.instruction, /2\. Answer each finding/);
    assert.match(audit.steps, /unanswered human ask/);
    assert.match(chat.instruction, new RegExp(`\\+chat-messages-list --chat-id ${CHAT} `));
    assert.match(chat.instruction, /\+messages-reply --message-id <om_id> --text '<reply>' --json/);
    assert.match(audit.steps, /only way a reply reaches the chat/);
    assert.doesNotMatch(chat.instruction, /unanswered human ask/, "the finding definition is stated once, in steps");
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

test("read is completion-free; scoped completion rejects stale receipts and legacy rows stay ignored", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-complete-"));
  try {
    const file = inboxAuditRegistryFile(root);
    fs.writeFileSync(file, `${JSON.stringify({
      version: 1,
      targets: [{ agent_id: "cli_audit", target: `chat:${CHAT}`, anchor: "om_legacy", observed_at: "2026-07-20T00:00:00.000Z" }],
    })}\n`, { mode: 0o600 });
    assert.equal(readInboxAuditTargets(file, "cli_audit").targets.length, 0, "v1 rows cannot prove originally-wake=true and must be discarded");
    fs.writeFileSync(file, `${JSON.stringify({ version: 2, targets: [{ agent_id: "cli_audit", target: `chat:${CHAT}`, anchor: "om_legacy_v2", observed_at: "2026-07-20T00:00:00.000Z", status: "pending" }] })}\n`, { mode: 0o600 });
    assert.equal(readInboxAuditTargets(file, "cli_audit").targets.length, 0, "v2 rows lack a durable generation and cannot fabricate one");
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, message_id: "om_pending" }), true);
    assert.equal(hasPendingInboxAuditTargets(file, "cli_audit"), true);
    const firstRead = readInboxAuditTargets(file, "cli_audit");
    assert.equal(firstRead.targets.length, 1, "a caller failure after a read must leave the target pending");
    assert.equal(readInboxAuditTargets(file, "cli_audit").targets.length, 1, "a later configured tick sees the same uncompleted target");
    assert.deepEqual(completeInboxAuditTarget(file, "cli_audit", firstRead.targets[0].receipt, "no-finding", new Date("2026-07-21T00:00:00.000Z")), { completed: true, reason: "completed" });
    assert.equal(readInboxAuditTargets(file, "cli_audit").targets.length, 0);
    assert.equal(hasPendingInboxAuditTargets(file, "cli_audit"), false);
    assert.deepEqual(completeInboxAuditTarget(file, "cli_audit", firstRead.targets[0].receipt, "no-finding"), { completed: false, reason: "already_completed" });
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, message_id: "om_pending" }), false, "same completed anchor must not reopen");
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...WAKE, source_seq: 2, message_id: "om_new" }), true, "a new originally-wake=true anchor may reopen the target");
    assert.equal(readInboxAuditTargets(file, "cli_audit").targets[0].anchor, "om_new");
    assert.deepEqual(completeInboxAuditTarget(file, "cli_audit", firstRead.targets[0].receipt, "handled"), { completed: false, reason: "stale" }, "an ABA-style old receipt cannot retire new evidence");
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).version, 4);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("same-timestamp A to B to A creates a new generation and rejects the first receipt", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-aba-generation-"));
  const now = new Date("2026-07-21T00:00:00.000Z");
  try {
    const file = inboxAuditRegistryFile(root);
    observeInboxAuditTarget(file, "cli_audit", { ...WAKE, message_id: "om_aba_a" }, now);
    const first = readInboxAuditTargets(file, "cli_audit").targets[0];
    observeInboxAuditTarget(file, "cli_audit", { ...WAKE, source_seq: 2, message_id: "om_aba_b" }, now);
    observeInboxAuditTarget(file, "cli_audit", { ...WAKE, source_seq: 3, message_id: "om_aba_a" }, now);
    const current = readInboxAuditTargets(file, "cli_audit").targets[0];
    assert.notEqual(current.revision, first.revision, "new observation identity cannot depend on wall-clock precision");
    assert.deepEqual(completeInboxAuditTarget(file, "cli_audit", first.receipt, "no-finding"), { completed: false, reason: "stale" });
    assert.equal(readInboxAuditTargets(file, "cli_audit").targets[0].anchor, "om_aba_a");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("completion for one Agent preserves another Agent and a concurrent newer anchor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-race-"));
  try {
    const file = inboxAuditRegistryFile(root);
    assert.equal(observeInboxAuditTarget(file, "cli_auditA", { ...WAKE, message_id: "om_a" }), true);
    assert.equal(observeInboxAuditTarget(file, "cli_auditB", { ...WAKE, chat_id: "oc_other", message_id: "om_b" }), true);
    const a = readInboxAuditTargets(file, "cli_auditA").targets[0];
    // This is the observer/completer interleaving: completion must reload under
    // the lock and cannot overwrite B or a later pending target.
    assert.equal(observeInboxAuditTarget(file, "cli_auditA", { ...WAKE, source_seq: 2, message_id: "om_a_new" }), true);
    assert.deepEqual(completeInboxAuditTarget(file, "cli_auditA", a.receipt, "handled"), { completed: false, reason: "stale" });
    assert.deepEqual(readInboxAuditTargets(file, "cli_auditA").targets.map((row) => row.anchor), ["om_a_new"]);
    assert.deepEqual(readInboxAuditTargets(file, "cli_auditB").targets.map((row) => row.anchor), ["om_b"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("registry refuses a symlink instead of following it during observer mutation", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-symlink-"));
  try {
    const file = inboxAuditRegistryFile(root);
    const victim = path.join(root, "victim.json");
    fs.writeFileSync(victim, "preserve", { mode: 0o600 });
    fs.symlinkSync(victim, file);
    assert.throws(() => observeInboxAuditTarget(file, "cli_audit", { ...WAKE, message_id: "om_symlink" }), /regular file/);
    assert.equal(fs.readFileSync(victim, "utf8"), "preserve");
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("durable retry intent rebuilds an eligible registry target without a new inbound event", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-retry-"));
  try {
    const registry = inboxAuditRegistryFile(root);
    const retry = inboxAuditRetryFile(root);
    assert.equal(enqueueInboxAuditTargetRetry(retry, "cli_audit", { ...WAKE, message_id: "om_retry" }), true);
    assert.deepEqual(reconcileInboxAuditTargetRetries(registry, retry), { recovered: 1, remaining: 0 });
    assert.deepEqual(readInboxAuditTargets(registry, "cli_audit").targets.map((row) => row.anchor), ["om_retry"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("canonical target sequence prevents old retries from overwriting newer pending or completed work", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-retry-order-"));
  const now = new Date("2026-07-21T00:00:00.000Z");
  try {
    const registry = inboxAuditRegistryFile(root);
    const retry = inboxAuditRetryFile(root);
    enqueueInboxAuditTargetRetry(retry, "cli_audit", { ...WAKE, source_seq: 1, message_id: "om_old" }, now);
    observeInboxAuditTarget(registry, "cli_audit", { ...WAKE, source_seq: 2, message_id: "om_new" }, now);
    reconcileInboxAuditTargetRetries(registry, retry);
    assert.deepEqual(readInboxAuditTargets(registry, "cli_audit").targets.map((row) => row.anchor), ["om_new"]);
    const current = readInboxAuditTargets(registry, "cli_audit").targets[0];
    completeInboxAuditTarget(registry, "cli_audit", current.receipt, "no-finding", now);
    enqueueInboxAuditTargetRetry(retry, "cli_audit", { ...WAKE, source_seq: 1, message_id: "om_old" }, now);
    reconcileInboxAuditTargetRetries(registry, retry);
    assert.equal(readInboxAuditTargets(registry, "cli_audit").targets.length, 0, "old retry cannot reopen a newer completed anchor");
    enqueueInboxAuditTargetRetry(retry, "cli_audit", { ...WAKE, source_seq: 3, message_id: "om_newer" }, now);
    assert.deepEqual(reconcileInboxAuditTargetRetries(registry, retry), { recovered: 1, remaining: 0 });
    assert.deepEqual(readInboxAuditTargets(registry, "cli_audit").targets.map((row) => row.anchor), ["om_newer"]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("one Host timer per enabled Agent skips empty audits and reacts to disabled/gap refresh", async () => {
  const timers = [];
  const cleared = [];
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
    clearTimer(timer) { cleared.push(timer); },
    schedule(agent) { return schedule[agent.agentId]; },
    shouldDispatch(agent) { return pending.has(agent.agentId); },
  });
  heartbeat.start();
  heartbeat.start();
  assert.equal(timers.length, 2, "default-off/disabled Agents do not retain a future audit timer");
  assert.deepEqual(timers.map((timer) => timer.delay).sort((left, right) => left - right), [60_000, 120_000]);
  timers[0].callback();
  timers[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].agentId, "cli_auditOne");
  assert.equal(inbox[0].target, "runtime:reminder");
  assert.equal(Object.hasOwn(inbox[0], "deliveryTarget"), false);
  assert.equal(Object.hasOwn(inbox[0], "deliveryAnchor"), false);
  pending.delete("cli_auditOne");
  const rearmed = timers.filter((timer) => timer.delay === 60_000);
  assert.equal(rearmed.length, 2, "enabled Agent re-arms after fire");
  rearmed[1].callback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deliveries.length, 1, "no pending originally-wake=true work must not wake the model");
  schedule.cli_auditOne.intervalMs = 1_000;
  heartbeat.refresh();
  assert.ok(cleared.length >= 1, "a shorter saved gap cancels the obsolete long timer");
  assert.equal(timers.some((timer) => timer.delay === 1_000), true);
  schedule.cli_auditOne.enabled = false;
  heartbeat.refresh();
  assert.ok(cleared.length >= 2, "disable cancels the future audit timer without a Runtime reset");
  heartbeat.stop();
});

test("actual config saves coalesce watcher refreshes and stale timer callbacks cannot wake after gap/disable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-config-watch-"));
  const agentId = "cli_auditTimerA1";
  const env = { LARKIN_CONFIG_DIR: root };
  const timers = [];
  const cleared = [];
  const deliveries = [];
  let watchCallback;
  try {
    fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
      version: 4, serverId: "server-audit-timer", mentionPolicy: "require", activeAgent: agentId,
      agents: { [agentId]: { runtime: "codex", model: "gpt-5.6-sol" } },
    })}\n`, { mode: 0o600 });
    const heartbeat = new InboxAuditHeartbeat({
      agents: [{ agentId }],
      stateStore: () => ({ appendCanonicalInboxOnce(envelope) { return { status: "appended", envelope }; } }),
      runtimeHost: { async deliver(id, envelope) { deliveries.push({ id, envelope }); } },
      schedule: (agent) => configApi.resolveInboxAuditSchedule(configApi.loadConfig(env).config, agent.agentId),
      shouldDispatch: () => true,
      configFile: path.join(root, "config.json"),
      setTimer(callback, delay) { const timer = { callback, delay, unref() {} }; timers.push(timer); return timer; },
      clearTimer(timer) { cleared.push(timer); },
      watch(_directory, callback) { watchCallback = callback; return { close() {} }; },
    });
    heartbeat.start();
    assert.equal(timers.length, 0, "default-off creates no Host audit timer");

    configApi.mutateConfig(env, { kind: "set-global-inbox-audit", enabled: true, intervalMs: 60 * 60_000 }, { kind: "user" });
    watchCallback("rename", "config.json");
    watchCallback("change", "config.json");
    const firstRefresh = timers.find((timer) => timer.delay === 30);
    assert.ok(firstRefresh, "atomic config save schedules one debounced refresh");
    firstRefresh.callback();
    const oldLongTimer = timers.find((timer) => timer.delay === 60 * 60_000);
    assert.ok(oldLongTimer, "enabled config arms the configured cadence");

    configApi.mutateConfig(env, { kind: "set-global-inbox-audit", intervalMs: 60_000 }, { kind: "user" });
    watchCallback("rename", "config.json");
    const secondRefresh = timers.filter((timer) => timer.delay === 30).at(-1);
    secondRefresh.callback();
    assert.ok(cleared.includes(oldLongTimer), "shortening a gap cancels the old long timer immediately");
    assert.equal(timers.some((timer) => timer.delay === 60_000), true);
    oldLongTimer.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deliveries.length, 0, "the pre-change callback is generation-stale and cannot wake a model");

    configApi.mutateConfig(env, { kind: "set-global-inbox-audit", enabled: false }, { kind: "user" });
    watchCallback("rename", "config.json");
    timers.filter((timer) => timer.delay === 30).at(-1).callback();
    const currentTimer = timers.filter((timer) => timer.delay === 60_000).at(-1);
    assert.ok(cleared.includes(currentTimer), "disable cancels future audit work");
    currentTimer.callback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(deliveries.length, 0, "disabled stale callback cannot wake without replacing a Runtime session");
    heartbeat.stop();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
