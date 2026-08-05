// Opt-in verifier for an authorized real Feishu document-comment run. The run itself
// must use a dedicated document and Bot, then save only the sanitized observations
// described below. CI never enables this test and it never performs external writes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";

const ENABLED = process.env.LARKIN_RUN_DOCUMENT_COMMENT_LIVE === "1";
const required = (name) => {
  const value = process.env[name];
  assert.ok(value, `${name} is required by the enabled live verifier`);
  return value;
};
const iso = (value, label) => {
  const parsed = Date.parse(value);
  assert.equal(Number.isFinite(parsed), true, `${label} must be an ISO timestamp`);
  return parsed;
};

test.skipIf(!ENABLED)("authorized real Feishu mention-policy matrix proves accepted and rejected document comments", () => {
  const configDir = path.resolve(required("LARKIN_CONFIG_DIR"));
  const agentId = required("LARKIN_AGENT_ID");
  const evidence = JSON.parse(fs.readFileSync(path.resolve(required("LARKIN_DOCUMENT_COMMENT_LIVE_EVIDENCE")), "utf8"));
  assert.deepEqual(Object.keys(evidence).sort(), [
    "agent_id_hash", "cases", "cleanup", "file_type", "schema_version",
  ].sort());
  assert.equal(evidence.schema_version, 2);
  assert.match(evidence.agent_id_hash, /^[0-9a-f]{16}$/);
  assert.equal(["doc", "docx", "sheet", "file"].includes(evidence.file_type), true);
  assert.equal(evidence.cleanup, "completed");
  assert.equal(Array.isArray(evidence.cases), true);
  assert.deepEqual(evidence.cases.map((entry) => entry.case), [
    "require_mentioned_accept",
    "free_unmentioned_accept",
    "require_unmentioned_reject",
  ]);
  const expectedPolicy = [
    ["require", true, "accepted"],
    ["free", false, "accepted"],
    ["require", false, "rejected"],
  ];
  const eventTimes = [];
  const acceptedEventTimes = [];
  for (const [index, entry] of evidence.cases.entries()) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "case", "comment_id_hash", "event_at", "event_count", "expected", "inbox_count", "inbox_kind",
      "mention_policy", "mention_policy_source", "mentioned_bot", "operator_id_hash", "reply_at", "reply_count",
      "reply_mode", "runtime_delivery_count",
    ].sort());
    for (const key of ["comment_id_hash", "operator_id_hash"]) assert.match(entry[key], /^[0-9a-f]{16}$/);
    assert.deepEqual([entry.mention_policy, entry.mentioned_bot, entry.expected], expectedPolicy[index]);
    assert.equal(["agent", "global"].includes(entry.mention_policy_source), true,
      `${entry.case} must record whether Agent or global policy was applied`);
    assert.equal(entry.event_count, 1);
    const eventAt = iso(entry.event_at, `${entry.case}.event_at`);
    eventTimes.push(eventAt);
    if (entry.expected === "accepted") {
      acceptedEventTimes.push(eventAt);
      assert.deepEqual([entry.inbox_count, entry.runtime_delivery_count, entry.reply_count], [1, 1, 1]);
      assert.equal(entry.inbox_kind, "document_comment");
      assert.equal(["in-thread", "top-level-fallback"].includes(entry.reply_mode), true);
      const replyAt = iso(entry.reply_at, `${entry.case}.reply_at`);
      assert.ok(replyAt >= eventAt && replyAt - eventAt < 10 * 60_000,
        `${entry.case} reply must follow the observed event within ten minutes`);
    } else {
      assert.deepEqual([entry.inbox_count, entry.runtime_delivery_count, entry.reply_count], [0, 0, 0]);
      assert.deepEqual([entry.inbox_kind, entry.reply_at, entry.reply_mode], [null, null, null]);
    }
  }
  const status = JSON.parse(fs.readFileSync(path.join(configDir, "state", "agents", agentId, "status.json"), "utf8"));
  assert.ok(iso(status.documentCommentEventAt, "status.documentCommentEventAt") >= Math.max(...eventTimes),
    "local Host status must independently prove all real comment events arrived in this run");
  assert.ok(iso(status.documentCommentLastAcceptedAt, "status.documentCommentLastAcceptedAt") >= Math.max(...acceptedEventTimes),
    "local Host status must independently prove both accepted cases reached the delivery path");
});
