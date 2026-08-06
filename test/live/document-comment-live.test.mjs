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
const MAX_OBSERVATION_MS = 10 * 60_000;

export function validateDocumentCommentLiveEvidence(evidence, status) {
  assert.deepEqual(Object.keys(evidence).sort(), [
    "agent_id_hash", "cases", "cleanup", "file_type", "schema_version",
  ].sort());
  assert.equal(evidence.schema_version, 4);
  assert.match(evidence.agent_id_hash, /^[0-9a-f]{16}$/);
  assert.equal(["doc", "docx", "sheet", "file"].includes(evidence.file_type), true);
  assert.equal(evidence.cleanup, "completed");
  assert.equal(Array.isArray(evidence.cases), true);
  assert.deepEqual(evidence.cases.map((entry) => entry.case), [
    "none_mentioned_accept",
    "subscribed_unmentioned_accept",
    "none_unmentioned_reject",
  ]);
  const expectedSubscription = [
    ["none", "safe-default", "setup-default", null, true, "accepted"],
    ["subscribed", "platform-verified", "platform-status", "application", false, "accepted"],
    ["none", "safe-default", "setup-default", null, false, "rejected"],
  ];
  const eventTimes = [];
  const acceptedEventTimes = [];
  for (const [index, entry] of evidence.cases.entries()) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "case", "comment_id_hash", "event_at", "event_count", "expected", "inbox_count", "inbox_kind",
      "comment_subscription_dimension", "comment_subscription_mode", "comment_subscription_source",
      "comment_subscription_status", "mentioned_bot", "observation_ended_at", "observation_started_at",
      "operator_id_hash", "reply_at", "reply_count", "reply_mode", "runtime_delivery_count",
    ].sort());
    for (const key of ["comment_id_hash", "operator_id_hash"]) assert.match(entry[key], /^[0-9a-f]{16}$/);
    assert.deepEqual([
      entry.comment_subscription_mode, entry.comment_subscription_status, entry.comment_subscription_source,
      entry.comment_subscription_dimension, entry.mentioned_bot, entry.expected,
    ], expectedSubscription[index]);
    const observationStartedAt = iso(entry.observation_started_at, `${entry.case}.observation_started_at`);
    const observationEndedAt = iso(entry.observation_ended_at, `${entry.case}.observation_ended_at`);
    assert.ok(observationEndedAt > observationStartedAt && observationEndedAt - observationStartedAt <= MAX_OBSERVATION_MS,
      `${entry.case} observation window must be positive and at most ten minutes`);
    const positive = entry.expected === "accepted";
    if (positive) assert.equal(entry.event_count, 1);
    else assert.equal(entry.event_count === 0 || entry.event_count === 1, true,
      "none_unmentioned_reject may be suppressed by the platform or delivered once for Host filtering");
    if (entry.event_count === 1) {
      const eventAt = iso(entry.event_at, `${entry.case}.event_at`);
      assert.ok(eventAt >= observationStartedAt && eventAt <= observationEndedAt,
        `${entry.case}.event_at must fall inside the observation window`);
      eventTimes.push(eventAt);
      if (positive) acceptedEventTimes.push(eventAt);
    } else {
      assert.equal(entry.event_at, null);
    }
    if (positive) {
      assert.deepEqual([entry.inbox_count, entry.runtime_delivery_count, entry.reply_count], [1, 1, 1]);
      assert.equal(entry.inbox_kind, "document_comment");
      assert.equal(["in-thread", "top-level-fallback"].includes(entry.reply_mode), true);
      const replyAt = iso(entry.reply_at, `${entry.case}.reply_at`);
      assert.ok(replyAt >= eventTimes.at(-1) && replyAt - eventTimes.at(-1) < 10 * 60_000,
        `${entry.case} reply must follow the observed event within ten minutes`);
    } else {
      assert.deepEqual([entry.inbox_count, entry.runtime_delivery_count, entry.reply_count], [0, 0, 0]);
      assert.deepEqual([entry.inbox_kind, entry.reply_at, entry.reply_mode], [null, null, null]);
    }
  }
  assert.ok(iso(status.documentCommentEventAt, "status.documentCommentEventAt") >= Math.max(...eventTimes),
    "local Host status must independently prove every actually delivered comment event arrived in this run");
  assert.ok(iso(status.documentCommentLastAcceptedAt, "status.documentCommentLastAcceptedAt") >= Math.max(...acceptedEventTimes),
    "local Host status must independently prove both accepted cases reached the delivery path");
}

test.skipIf(!ENABLED)("authorized real Feishu subscription matrix proves accepted and rejected document comments", () => {
  const configDir = path.resolve(required("LARKIN_CONFIG_DIR"));
  const agentId = required("LARKIN_AGENT_ID");
  const evidence = JSON.parse(fs.readFileSync(path.resolve(required("LARKIN_DOCUMENT_COMMENT_LIVE_EVIDENCE")), "utf8"));
  const status = JSON.parse(fs.readFileSync(path.join(configDir, "state", "agents", agentId, "status.json"), "utf8"));
  validateDocumentCommentLiveEvidence(evidence, status);
});

const fixtureCase = (overrides) => ({
  case: "none_mentioned_accept", comment_id_hash: "a".repeat(16), operator_id_hash: "b".repeat(16),
  comment_subscription_mode: "none", comment_subscription_status: "safe-default",
  comment_subscription_source: "setup-default", comment_subscription_dimension: null,
  mentioned_bot: true, expected: "accepted", event_count: 1,
  observation_started_at: "2026-08-06T00:00:00.000Z", event_at: "2026-08-06T00:00:10.000Z",
  observation_ended_at: "2026-08-06T00:00:30.000Z", inbox_count: 1, inbox_kind: "document_comment",
  runtime_delivery_count: 1, reply_count: 1, reply_at: "2026-08-06T00:00:20.000Z", reply_mode: "in-thread",
  ...overrides,
});

const fixtureEvidence = (negativeOverrides = {}) => ({
  schema_version: 4, agent_id_hash: "c".repeat(16), file_type: "docx", cleanup: "completed",
  cases: [
    fixtureCase({}),
    fixtureCase({
      case: "subscribed_unmentioned_accept", comment_id_hash: "d".repeat(16),
      comment_subscription_mode: "subscribed", comment_subscription_status: "platform-verified",
      comment_subscription_source: "platform-status", comment_subscription_dimension: "application",
      mentioned_bot: false, observation_started_at: "2026-08-06T00:01:00.000Z",
      event_at: "2026-08-06T00:01:10.000Z", reply_at: "2026-08-06T00:01:20.000Z",
      observation_ended_at: "2026-08-06T00:01:30.000Z",
    }),
    fixtureCase({
      case: "none_unmentioned_reject", comment_id_hash: "e".repeat(16), mentioned_bot: false, expected: "rejected",
      event_count: 0, event_at: null, observation_started_at: "2026-08-06T00:02:00.000Z",
      observation_ended_at: "2026-08-06T00:02:30.000Z", inbox_count: 0, inbox_kind: null,
      runtime_delivery_count: 0, reply_count: 0, reply_at: null, reply_mode: null,
      ...negativeOverrides,
    }),
  ],
});
const fixtureStatus = {
  documentCommentEventAt: "2026-08-06T00:01:15.000Z",
  documentCommentLastAcceptedAt: "2026-08-06T00:01:25.000Z",
};

test("live evidence schema accepts platform-suppressed or Host-filtered negative events within a bounded window", () => {
  assert.doesNotThrow(() => validateDocumentCommentLiveEvidence(fixtureEvidence(), fixtureStatus));
  assert.doesNotThrow(() => validateDocumentCommentLiveEvidence(fixtureEvidence({
    event_count: 1, event_at: "2026-08-06T00:02:10.000Z",
  }), { ...fixtureStatus, documentCommentEventAt: "2026-08-06T00:02:15.000Z" }));
  assert.throws(() => validateDocumentCommentLiveEvidence(fixtureEvidence({ event_count: 2 }), fixtureStatus));
  assert.throws(() => validateDocumentCommentLiveEvidence(fixtureEvidence({
    observation_ended_at: "2026-08-06T00:12:01.000Z",
  }), fixtureStatus), /at most ten minutes/);
});
