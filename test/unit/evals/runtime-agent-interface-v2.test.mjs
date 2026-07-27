import assert from "node:assert/strict";
import path from "node:path";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  gradeRuntimeAgentInterfaceTrace,
  loadRuntimeAgentInterfaceEval,
  summarizeRuntimeAgentInterfaceEval,
} from "../../support/runtime-agent-interface-v2-grader.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const DATASET = loadRuntimeAgentInterfaceEval(path.join(ROOT, "evals", "runtime-agent-interface-v2", "scenarios.json"));

test("fixed runtime Agent interface eval registers dataset, rubric, grader, threshold, Runtime/model/version and six-plus scenarios", () => {
  assert.equal(DATASET.version, 1);
  assert.equal(DATASET.runtime.adapter, "codex");
  assert.equal(DATASET.model.standing_prompt_version, "larkin-standing-v4");
  assert.equal(DATASET.grader.version, 1);
  assert.equal(DATASET.grader.threshold, 1);
  assert.ok(DATASET.grader.rubric.length >= 5);
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id), [
    "new-message", "busy-update", "check-only", "poll-complete", "held-draft", "repeated-update", "target-isolation",
  ]);
  for (const scenario of DATASET.scenarios) {
    assert.deepEqual(scenario.required_actions, scenario.trace.map((event) => event.action));
  }
});

test("golden traces reach the registered threshold", () => {
  const traces = Object.fromEntries(DATASET.scenarios.map((scenario) => [scenario.id, scenario.trace]));
  assert.deepEqual(summarizeRuntimeAgentInterfaceEval(DATASET, traces), {
    passed: true,
    pass_rate: 1,
    threshold: 1,
    results: DATASET.scenarios.map((scenario) => ({ id: scenario.id, passed: true, failures: [] })),
  });
});

test("grader rejects check body disclosure, stale provider writes, busy cancellation, non-direct poll and target bleed", () => {
  const scenario = DATASET.scenarios.find((item) => item.id === "target-isolation");
  const result = gradeRuntimeAgentInterfaceTrace(scenario, [
    { action: "busy_start" },
    { action: "update", target: "chat:oc_eval_a", seq: 1 },
    { action: "update", target: "chat:oc_eval_b", seq: 1 },
    { action: "check", target: "chat:oc_eval_b", content_observed: true },
    { action: "poll", target: "chat:oc_eval_a", seq: 1, direct_ack: false },
    { action: "cancel" },
    { action: "provider_write", target: "chat:oc_eval_b", based_on_seq: 0 },
  ]);
  assert.deepEqual(new Set(result.failures.map((failure) => failure.rule)), new Set([
    "check_content_light", "poll_direct_ack", "busy_update_no_cancel", "freshness_before_provider", "required_actions",
  ]));
});

test("grader rejects empty traces even when a scenario expects no provider writes", () => {
  for (const id of ["check-only", "poll-complete"]) {
    const scenario = DATASET.scenarios.find((item) => item.id === id);
    const result = gradeRuntimeAgentInterfaceTrace(scenario, []);
    assert.equal(result.passed, false);
    assert.equal(result.failures.some((failure) => failure.rule === "required_actions"), true, id);
  }
  const empty = Object.fromEntries(DATASET.scenarios.map((scenario) => [scenario.id, []]));
  assert.equal(summarizeRuntimeAgentInterfaceEval(DATASET, empty).passed, false);
});
