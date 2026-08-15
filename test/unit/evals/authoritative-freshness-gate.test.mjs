import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { gradeConflictRedecision, gradeNativeCommandAudit, loadAuthoritativeFreshnessEval } from "../../support/authoritative-freshness-gate-grader.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const dataset = loadAuthoritativeFreshnessEval(path.join(ROOT, "evals/authoritative-freshness-gate/scenarios.json"));

test("authoritative freshness eval is versioned, reproducible, and covers the critical rubric", () => {
  assert.equal(dataset.dataset, "authoritative-freshness-gate");
  assert.equal(dataset.version, 1);
  assert.equal(dataset.standing_prompt_version, "larkin-standing-v20");
  assert.equal(dataset.threshold, 1);
  assert.deepEqual(dataset.scenarios.map((scenario) => scenario.id), [
    "missing-inbox-history", "direct-ack-retry", "same-ms-new-id", "edited-message",
    "empty-first-touch", "probe-unavailable", "target-isolation", "thread-isolation", "model-conflict-redecision",
  ]);
  for (const scenario of dataset.scenarios) {
    assert.equal(typeof scenario.provider_write, "boolean");
    if (scenario.expected.startsWith("freshness_")) assert.equal(scenario.provider_write, false);
  }
  assert.equal(dataset.grader.threshold, 1);
  assert.equal(dataset.grader.rubric.length, 5);
  const modelScenario = dataset.scenarios.find((scenario) => scenario.id === "model-conflict-redecision");
  assert.equal(modelScenario.prompt.includes("{larkin}"), true);
  const nativeHarness = fs.readFileSync(path.join(ROOT, "test/live/authoritative-freshness-gate-agent-eval.test.mjs"), "utf8");
  assert.match(nativeHarness, /replaceAll\("\{larkin\}", JSON\.stringify\(path\.join\(binDir, "larkin"\)\)\)/);
  assert.deepEqual(gradeConflictRedecision(modelScenario.trace), { passed: true, failures: [] });
  assert.equal(gradeConflictRedecision(modelScenario.trace.slice(0, 1)).passed, false);
  const controlled = "/tmp/controlled/bin/larkin";
  const audit = [
    { item_type: "commandExecution", command: `/bin/zsh -lc "\\"${controlled}\\" im +messages-send --chat-id oc_eval_freshness --text 'stale red status'"`, exit_code: 3 },
    { item_type: "commandExecution", command: `/bin/zsh -lc "\\"${controlled}\\" im +messages-send --chat-id oc_eval_freshness --text 'green revised status'"`, exit_code: 0 },
  ];
  assert.deepEqual(gradeNativeCommandAudit(audit, controlled), { passed: true, failures: [] });
  assert.equal(gradeNativeCommandAudit([...audit, {
    item_type: "commandExecution", command: `/bin/zsh -lc "cat freshness-state.json"`, exit_code: 0,
  }], controlled).passed, false);
});
