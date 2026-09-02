import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import { gradeProtectedRecallTrace, loadProtectedMessageRecallEval } from "../../support/protected-message-recall-grader.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const dataset = loadProtectedMessageRecallEval(path.join(ROOT, "evals/protected-message-recall/scenarios.json"));

test("protected recall eval is versioned and covers positive, negative, conflict, and recovery contracts", () => {
  assert.equal(dataset.dataset, "protected-message-recall");
  assert.equal(dataset.standing_prompt_version, "larkin-standing-v28");
  assert.deepEqual(dataset.scenarios.map((scenario) => scenario.id), [
    "missing-confirmation", "own-chat-message", "own-thread-message", "third-party-message",
    "cross-agent-message", "freshness-conflict", "committed-duplicate", "ambiguous-retry",
  ]);
  assert.ok(dataset.scenarios.filter((scenario) => scenario.provider_delete_calls === 0).length >= 6);
  assert.ok(dataset.scenarios.some((scenario) => scenario.target_kind === "thread" && scenario.provider_delete_calls === 1));

  const scenario = dataset.scenarios.find((row) => row.id === "own-chat-message");
  const valid = {
    exitCode: 0,
    messageId: "om_recall",
    calls: [
      ["im", "+messages-mget", "--message-ids", "om_recall", "--no-reactions", "--json", "--as", "bot"],
      ["api", "GET", "/open-apis/im/v1/messages", "--params", JSON.stringify({
        container_id_type: "chat", container_id: "oc_recall", sort_type: "ByCreateTimeDesc", page_size: 20,
      }), "--as", "bot"],
      ["im", "messages", "delete", "--message-id", "om_recall", "--yes", "--json", "--as", "bot"],
    ],
  };
  assert.deepEqual(gradeProtectedRecallTrace(valid, scenario), { passed: true, failures: [] });
  assert.equal(gradeProtectedRecallTrace({ ...valid, calls: [...valid.calls, valid.calls[2]] }, scenario).passed, false,
    "duplicate provider mutation must fail the payload grader");
  assert.equal(gradeProtectedRecallTrace({ ...valid, calls: valid.calls.map((call) => call.filter((value) => value !== "--yes")) }, scenario).passed, false,
    "missing provider confirmation must fail the payload grader");
});
