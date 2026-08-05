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

test.skipIf(!ENABLED)("authorized real Feishu @Bot comment closes event -> Inbox -> Runtime -> bound reply", () => {
  const configDir = path.resolve(required("LARKIN_CONFIG_DIR"));
  const agentId = required("LARKIN_AGENT_ID");
  const evidence = JSON.parse(fs.readFileSync(path.resolve(required("LARKIN_DOCUMENT_COMMENT_LIVE_EVIDENCE")), "utf8"));
  assert.deepEqual(Object.keys(evidence).sort(), [
    "agent_id_hash", "cleanup", "comment_id_hash", "event_at", "event_count", "file_type", "inbox_count",
    "inbox_kind", "operator_id_hash", "reply_at", "reply_count", "reply_mode", "runtime_delivery_count", "schema_version",
  ].sort());
  assert.equal(evidence.schema_version, 1);
  for (const key of ["agent_id_hash", "comment_id_hash", "operator_id_hash"]) assert.match(evidence[key], /^[0-9a-f]{16}$/);
  assert.equal(["doc", "docx", "sheet", "file"].includes(evidence.file_type), true);
  assert.equal(evidence.inbox_kind, "document_comment");
  assert.equal(["in-thread", "top-level-fallback"].includes(evidence.reply_mode), true);
  assert.deepEqual([evidence.event_count, evidence.inbox_count, evidence.runtime_delivery_count, evidence.reply_count], [1, 1, 1, 1]);
  assert.equal(evidence.cleanup, "completed");
  const eventAt = iso(evidence.event_at, "event_at");
  const replyAt = iso(evidence.reply_at, "reply_at");
  assert.ok(replyAt >= eventAt && replyAt - eventAt < 10 * 60_000, "reply must follow the observed event within ten minutes");
  const status = JSON.parse(fs.readFileSync(path.join(configDir, "state", "agents", agentId, "status.json"), "utf8"));
  assert.ok(iso(status.documentCommentEventAt, "status.documentCommentEventAt") >= eventAt,
    "local Host status must independently prove a real comment event arrived in this run");
  assert.ok(iso(status.documentCommentLastAcceptedAt, "status.documentCommentLastAcceptedAt") >= eventAt,
    "local Host status must independently prove the comment was accepted into the delivery path");
});
