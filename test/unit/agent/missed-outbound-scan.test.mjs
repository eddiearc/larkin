import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  inboxAuditRegistryFile,
  MAX_INBOX_AUDIT_TARGETS,
  observeInboxAuditTarget,
  readInboxAuditTargets,
} from "../../../src/agent/missed-outbound-scan.ts";
import { InboxAuditHeartbeat } from "../../../src/agent/inbox-audit-heartbeat.ts";

const CHAT = "oc_7961b9d7be893b46520a926b90cf46eb";

test("audit registry retains only authoritative human group/topic targets with their om_ anchor", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-inbox-audit-"));
  try {
    const file = inboxAuditRegistryFile(root);
    const common = { chat_id: CHAT, chat_type: "group", _scan_authority: true, _sender_is_bot: false };
    assert.equal(observeInboxAuditTarget(file, "cli_audit", { ...common, message_id: "om_chat" }), true);
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
    assert.equal(readInboxAuditTargets(file, "cli_other").targets.length, MAX_INBOX_AUDIT_TARGETS);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("one Host timer callback delivers targetless runtime audit wakes to multiple agents", async () => {
  const timers = [];
  const inbox = [];
  const deliveries = [];
  const heartbeat = new InboxAuditHeartbeat({
    agents: [{ agentId: "cli_auditOne" }, { agentId: "cli_auditTwo" }],
    stateStore: () => ({ appendCanonicalInboxOnce(envelope) { inbox.push(envelope); return { status: "appended", envelope }; } }),
    runtimeHost: { async deliver(agentId, envelope) { deliveries.push({ agentId, envelope }); } },
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
  assert.equal(deliveries.length, 2);
  assert.equal(inbox.every((row) => row.target === "runtime:reminder" && row.kind === "reminder"), true);
  assert.equal(inbox.every((row) => !Object.hasOwn(row, "deliveryTarget") && !Object.hasOwn(row, "deliveryAnchor")), true);
  heartbeat.stop();
});
