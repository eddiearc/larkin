import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import {
  gradeAgentExperienceV6Trace,
  loadAgentExperienceV6Eval,
  summarizeAgentExperienceV6Eval,
} from "../../support/agent-experience-v6-grader.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DATASET = loadAgentExperienceV6Eval(path.join(ROOT, "evals/agent-experience-v6/scenarios.json"));

test("fixed Agent Experience v6 eval starts every selected scenario from an empty session", () => {
  assert.equal(DATASET.session.initial_turns, 0);
  assert.equal(DATASET.model.standing_prompt_version, "larkin-standing-v6");
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id), [
    "target-scoped-thread-read",
    "failed-thread-read-no-false-success",
    "exact-text-punctuation",
    "exclusive-other-agent-silence",
    "committed-unverified-no-retry",
  ]);
});

test("golden fresh-session traces satisfy the full deterministic rubric", () => {
  const traces = Object.fromEntries(DATASET.scenarios.map((scenario) => [scenario.id, scenario.trace]));
  const result = summarizeAgentExperienceV6Eval(DATASET, traces);
  assert.equal(result.passed, true);
  assert.equal(result.pass_rate, 1);
  assert.equal(result.results.every((item) => item.passed), true);
});

test("grader rejects chat-wide fallback, stderr merging, false success, text mutation, excluded replies, and duplicate retry", () => {
  const byId = Object.fromEntries(DATASET.scenarios.map((scenario) => [scenario.id, scenario]));
  const badThread = gradeAgentExperienceV6Trace(byId["target-scoped-thread-read"], [{
    action: "tool", command: "larkin im +chat-messages-list --chat-id oc_eval_thread 2>&1", exit_code: 0,
  }]);
  assert.deepEqual(new Set(badThread.failures.map((item) => item.rule)), new Set([
    "canonical_command", "forbidden_command", "stable_response_path",
  ]));

  const falseSuccess = gradeAgentExperienceV6Trace(byId["failed-thread-read-no-false-success"], [
    byId["failed-thread-read-no-false-success"].trace[0],
    { action: "provider_write", command: "larkin im +messages-send", transported_text: "remembered" },
  ]);
  assert.equal(falseSuccess.failures.some((item) => ["bounded_calls", "provider_write_count", "visible_failure", "no_memory_fallback"].includes(item.rule)), true);

  const changedText = structuredClone(byId["exact-text-punctuation"].trace);
  changedText[0].transported_text = "原文: \"修复 A/B\"; 不要改成 ASCII 引号。";
  changedText[0].shell_interpolation = true;
  assert.deepEqual(new Set(gradeAgentExperienceV6Trace(byId["exact-text-punctuation"], changedText).failures.map((item) => item.rule)),
    new Set(["exact_text", "shell_interpolation"]));

  assert.equal(gradeAgentExperienceV6Trace(byId["exclusive-other-agent-silence"], [{
    action: "provider_write", command: "larkin im +messages-send", exit_code: 0,
  }]).failures.some((item) => item.rule === "exclusive_silence"), true);

  const duplicated = [...byId["committed-unverified-no-retry"].trace, ...byId["committed-unverified-no-retry"].trace];
  const duplicateGrade = gradeAgentExperienceV6Trace(byId["committed-unverified-no-retry"], duplicated);
  assert.equal(duplicateGrade.failures.some((item) => item.rule === "no_retry"), true);
});
