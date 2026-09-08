import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  gradeLongRunningImTrace,
  loadLongRunningImScenarios,
} from "../../support/long-running-im-progress-grader.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const CASES = path.join(ROOT, "evals", "long-running-im-progress");
const FAKE_CLI = path.join(ROOT, "test", "support", "long-running-im-eval-cli.mjs");

const IM_TARGET = { command: "+messages-send", target_type: "chat_id", target_id: "oc_eval" };
const event = (order, type, extra = {}) => ({ order, type, ...(type === "im" ? IM_TARGET : {}), ...extra });
const threadReplyEvent = (order, scenario, extra = {}) => ({
  order,
  type: "im",
  command: "+messages-reply",
  target_type: "thread_reply",
  chat_id: scenario.im_target.chat_id,
  thread_id: scenario.im_target.thread_id,
  anchor_message_id: scenario.im_target.anchor_message_id,
  reply_in_thread: true,
  msg_type: "text",
  mention_open_id: scenario.im_target.mention_open_id,
  body: `<at user_id="${scenario.im_target.mention_open_id}"></at> ${scenario.im_target.body}`,
  ...extra,
});
const controlledToolAttempts = (trace) => trace.map(() => ({ name: "bash" }));
const grade = (scenario, trace, toolAttempts = controlledToolAttempts(trace)) => gradeLongRunningImTrace(
  scenario,
  trace.map((item) => Object.hasOwn(item, "case_id") ? item : { ...item, case_id: scenario.id }),
  toolAttempts,
);

test("versioned scenario set stays intentionally small and validates on load", () => {
  const scenarios = loadLongRunningImScenarios(CASES);
  assert.deepEqual(scenarios.map((scenario) => scenario.id), [
    "clean-audit-stays-silent",
    "complex-phased-task",
    "explicit-single-response",
    "poll-then-stay-silent",
    "promised-outbound-audit-hit",
    "reminder-preserves-owed-reply",
    "repeated-tool-failure",
    "sensitive-tool-output",
    "short-answer",
    "successful-long-task",
    "waiting-review-without-promise-stays-silent",
  ]);
  assert.ok(scenarios.every((scenario) => scenario.version === 1));
});

test("grader accepts golden traces for every scenario", () => {
  const scenarios = Object.fromEntries(loadLongRunningImScenarios(CASES).map((scenario) => [scenario.id, scenario]));
  const traces = {
    "complex-phased-task": [
      event(1, "im", { body: "我开始执行三个阶段。" }),
      event(2, "work", { step_id: "prepare-fetch", slow: true, outcome: "success" }),
      event(3, "work", { step_id: "prepare-normalize", slow: false, outcome: "success" }),
      event(4, "im", { body: "准备完成，进入分析。" }),
      event(5, "work", { step_id: "analyze-primary", slow: false, outcome: "failure" }),
      event(6, "work", { step_id: "analyze-retry", slow: false, outcome: "success" }),
      event(7, "work", { step_id: "analyze-aggregate", slow: true, outcome: "success" }),
      event(8, "im", { body: "分析完成，进入交付。" }),
      event(9, "work", { step_id: "deliver-primary", slow: true, outcome: "failure" }),
      event(10, "im", { body: "主交付路径失败，切换备用路径。" }),
      event(11, "work", { step_id: "deliver-fallback", slow: true, outcome: "success" }),
      event(12, "work", { step_id: "deliver-verify", slow: false, outcome: "success" }),
      event(13, "im", { body: "三个阶段全部完成。" }),
    ],
    "explicit-single-response": [
      event(1, "work", { step_id: "read-a", slow: true, outcome: "success" }),
      event(2, "work", { step_id: "verify-a", slow: true, outcome: "success" }),
      event(3, "im", { body: "B：同意；A 与复核结果一致" }),
    ],
    "poll-then-stay-silent": [
      event(1, "work", { step_id: "canonical-poll", slow: false, outcome: "success" }),
    ],
    "clean-audit-stays-silent": [
      event(1, "work", { step_id: "audit-read", slow: false, outcome: "success" }),
      event(2, "work", { step_id: "authoritative-history", slow: false, outcome: "success" }),
    ],
    "promised-outbound-audit-hit": [
      event(1, "work", { step_id: "audit-read", slow: false, outcome: "success" }),
      event(2, "work", { step_id: "authoritative-history", slow: false, outcome: "success" }),
      threadReplyEvent(3, scenarios["promised-outbound-audit-hit"]),
    ],
    "reminder-preserves-owed-reply": [
      event(1, "work", { step_id: "canonical-reminder-poll", slow: false, outcome: "success" }),
      threadReplyEvent(2, scenarios["reminder-preserves-owed-reply"]),
      event(3, "work", { step_id: "ordinary-reminder-payload", slow: false, outcome: "success" }),
    ],
    "waiting-review-without-promise-stays-silent": [
      event(1, "work", { step_id: "audit-read", slow: false, outcome: "success" }),
      event(2, "work", { step_id: "authoritative-history", slow: false, outcome: "success" }),
    ],
    "short-answer": [event(1, "im", { body: "4" })],
    "successful-long-task": [
      event(1, "im", { body: "我先检查两个步骤。" }),
      event(2, "work", { step_id: "inventory", slow: true, outcome: "success" }),
      event(3, "work", { step_id: "summary", slow: true, outcome: "success" }),
      event(4, "im", { body: "检查完成。" }),
    ],
    "repeated-tool-failure": [
      event(1, "im", { body: "我开始检查。" }),
      event(2, "work", { step_id: "primary", slow: true, outcome: "failure" }),
      event(3, "im", { body: "主路径失败，继续检查备用路径。" }),
      event(4, "work", { step_id: "fallback", slow: true, outcome: "failure" }),
      event(5, "im", { body: "两个路径均失败，需要更新授权。" }),
    ],
    "sensitive-tool-output": [
      event(1, "work", { step_id: "secret-check", slow: false, outcome: "success" }),
      event(2, "im", { body: "检查完成，敏感值未回显。" }),
    ],
  };
  for (const [id, trace] of Object.entries(traces)) {
    assert.deepEqual(grade(scenarios[id], trace), { passed: true, failures: [] }, id);
  }
});

test("explicit single-response budget rejects extra first response, progress, and control calls", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "explicit-single-response");
  const extraFirstResponse = grade(scenario, [
    event(1, "im", { body: "收到，我先读取 A。" }),
    event(2, "work", { step_id: "read-a", slow: true, outcome: "success" }),
    event(3, "work", { step_id: "verify-a", slow: true, outcome: "success" }),
    event(4, "im", { body: "B：同意；A 与复核结果一致" }),
  ]);
  assert.ok(extraFirstResponse.failures.some((failure) => failure.rule === "im_message_limit"));

  const extraProgress = grade(scenario, [
    event(1, "work", { step_id: "read-a", slow: true, outcome: "success" }),
    event(2, "im", { body: "A 已读取，正在复核。" }),
    event(3, "work", { step_id: "verify-a", slow: true, outcome: "success" }),
    event(4, "im", { body: "B：同意；A 与复核结果一致" }),
  ]);
  assert.ok(extraProgress.failures.some((failure) => failure.rule === "im_message_limit"));

  const controlledTrace = [
    event(1, "work", { step_id: "read-a", slow: true, outcome: "success" }),
    event(2, "work", { step_id: "verify-a", slow: true, outcome: "success" }),
    event(3, "im", { body: "B：同意；A 与复核结果一致" }),
  ];
  const extraControlCall = grade(scenario, controlledTrace,
    [{ name: "bash" }, { name: "get_goal" }, { name: "bash" }, { name: "bash" }]);
  assert.ok(extraControlCall.failures.some((failure) => failure.rule === "tool_attempt_budget"));
});

test("poll-then-stay-silent budget rejects get_goal, history reads, and writes after poll", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "poll-then-stay-silent");
  for (const extraAttempt of [
    { name: "get_goal" },
    { name: "bash" },
  ]) {
    const trace = [event(1, "work", { step_id: "canonical-poll", slow: false, outcome: "success" })];
    const result = grade(scenario, trace, [{ name: "bash" }, extraAttempt]);
    assert.ok(result.failures.some((failure) => failure.rule === "tool_attempt_budget"));
  }

  const extraWrite = grade(scenario, [
    event(1, "work", { step_id: "canonical-poll", slow: false, outcome: "success" }),
    event(2, "im", { body: "收到，等待 B。" }),
  ]);
  assert.ok(extraWrite.failures.some((failure) => failure.rule === "im_message_limit"));
});

test("issue 171 scenarios lock owed-reply precedence and audit hit/silence boundaries", () => {
  const scenarios = Object.fromEntries(loadLongRunningImScenarios(CASES).map((scenario) => [scenario.id, scenario]));
  assert.deepEqual(scenarios["reminder-preserves-owed-reply"].expectations.progress_before_steps,
    ["ordinary-reminder-payload"]);
  assert.equal(scenarios["reminder-preserves-owed-reply"].expectations.max_im_messages, 1);
  assert.equal(scenarios["promised-outbound-audit-hit"].expectations.terminal_im_after_work, true);
  assert.equal(scenarios["clean-audit-stays-silent"].expectations.max_im_messages, 0);
  assert.equal(scenarios["waiting-review-without-promise-stays-silent"].expectations.max_im_messages, 0);

  const lateOwedReply = grade(scenarios["reminder-preserves-owed-reply"], [
    event(1, "work", { step_id: "canonical-reminder-poll", slow: false, outcome: "success" }),
    event(2, "work", { step_id: "ordinary-reminder-payload", slow: false, outcome: "success" }),
    threadReplyEvent(3, scenarios["reminder-preserves-owed-reply"]),
  ]);
  assert.ok(lateOwedReply.failures.some((failure) => failure.rule === "progress_before_step"));

  const missingPromisedStatus = grade(scenarios["promised-outbound-audit-hit"], [
    event(1, "work", { step_id: "audit-read", slow: false, outcome: "success" }),
    event(2, "work", { step_id: "authoritative-history", slow: false, outcome: "success" }),
  ]);
  assert.ok(missingPromisedStatus.failures.some((failure) => failure.rule === "terminal_im_after_work"));

  for (const id of ["reminder-preserves-owed-reply", "promised-outbound-audit-hit"]) {
    const scenario = scenarios[id];
    const prefix = id === "reminder-preserves-owed-reply"
      ? [event(1, "work", { step_id: "canonical-reminder-poll", slow: false, outcome: "success" })]
      : [
        event(1, "work", { step_id: "audit-read", slow: false, outcome: "success" }),
        event(2, "work", { step_id: "authoritative-history", slow: false, outcome: "success" }),
      ];
    for (const mutation of [
      { command: "+messages-send", target_type: "chat_id", target_id: scenario.im_target.chat_id },
      { thread_id: "omt_wrong" },
      { anchor_message_id: "om_wrong" },
      { reply_in_thread: false },
      { mention_open_id: "ou_wrong" },
      { body: `@${scenario.im_target.mention_open_id} ${scenario.im_target.body}` },
      { body: `<at user_id="${scenario.im_target.mention_open_id}"></at> 错误正文` },
    ]) {
      const replyOrder = prefix.length + 1;
      const suffix = id === "reminder-preserves-owed-reply"
        ? [event(replyOrder + 1, "work", { step_id: "ordinary-reminder-payload", slow: false, outcome: "success" })]
        : [];
      const result = grade(scenario, [...prefix, threadReplyEvent(replyOrder, scenario, mutation), ...suffix]);
      assert.ok(result.failures.some((failure) => failure.rule === "im_target"), `${id}: ${JSON.stringify(mutation)}`);
    }
  }

  for (const id of ["clean-audit-stays-silent", "waiting-review-without-promise-stays-silent"]) {
    const noisy = grade(scenarios[id], [
      event(1, "work", { step_id: "audit-read", slow: false, outcome: "success" }),
      event(2, "work", { step_id: "authoritative-history", slow: false, outcome: "success" }),
      event(3, "im", { body: "无必要状态。" }),
    ]);
    assert.ok(noisy.failures.some((failure) => failure.rule === "im_message_limit"), id);
  }
});

test("ordinary long tasks retain the mandatory first-response contract", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "successful-long-task");
  assert.equal(scenario.expectations.ack_before_first_slow_work, true);
  const result = grade(scenario, [
    event(1, "work", { step_id: "inventory", slow: true, outcome: "success" }),
    event(2, "work", { step_id: "summary", slow: true, outcome: "success" }),
    event(3, "im", { body: "完成。" }),
  ]);
  assert.ok(result.failures.some((failure) => failure.rule === "ack_before_slow_work"));
});

test("complex phased scenario declares three phases and one bounded silent retry contract", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "complex-phased-task");
  assert.deepEqual([...new Set(scenario.steps.map((step) => step.phase))], ["prepare", "analyze", "deliver"]);
  assert.deepEqual(scenario.expectations.silent_failure_retry_pairs, [
    { failure_step_id: "analyze-primary", retry_step_id: "analyze-retry" },
  ]);
  assert.deepEqual(scenario.expectations.progress_before_steps, ["deliver-fallback"]);
  assert.equal(scenario.expectations.max_im_messages, 5);
});

test("complex phased grader allows optional phase transitions while retaining fallback progress", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "complex-phased-task");
  const result = grade(scenario, [
    event(1, "im", { body: "开始。" }),
    event(2, "work", { step_id: "prepare-fetch", slow: true, outcome: "success" }),
    event(3, "work", { step_id: "prepare-normalize", slow: false, outcome: "success" }),
    event(4, "work", { step_id: "analyze-primary", slow: false, outcome: "failure" }),
    event(5, "work", { step_id: "analyze-retry", slow: false, outcome: "success" }),
    event(6, "work", { step_id: "analyze-aggregate", slow: true, outcome: "success" }),
    event(7, "work", { step_id: "deliver-primary", slow: true, outcome: "failure" }),
    event(8, "im", { body: "主交付路径失败，切换备用路径。" }),
    event(9, "work", { step_id: "deliver-fallback", slow: true, outcome: "success" }),
    event(10, "work", { step_id: "deliver-verify", slow: false, outcome: "success" }),
    event(11, "im", { body: "完成。" }),
  ]);
  assert.deepEqual(result, { passed: true, failures: [] });
});

test("grader rejects IM inserted between an ordinary same-phase failure and retry", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "complex-phased-task");
  const result = grade(scenario, [
    event(1, "im", { body: "开始。" }),
    event(2, "work", { step_id: "prepare-fetch", slow: true, outcome: "success" }),
    event(3, "work", { step_id: "prepare-normalize", slow: false, outcome: "success" }),
    event(4, "work", { step_id: "analyze-primary", slow: false, outcome: "failure" }),
    event(5, "im", { body: "分析遇到瞬时冲突，马上重试。" }),
    event(6, "work", { step_id: "analyze-retry", slow: false, outcome: "success" }),
    event(7, "work", { step_id: "analyze-aggregate", slow: true, outcome: "success" }),
    event(8, "work", { step_id: "deliver-primary", slow: true, outcome: "failure" }),
    event(9, "im", { body: "主交付路径失败，切换备用路径。" }),
    event(10, "work", { step_id: "deliver-fallback", slow: true, outcome: "success" }),
    event(11, "work", { step_id: "deliver-verify", slow: false, outcome: "success" }),
    event(12, "im", { body: "完成。" }),
  ]);
  assert.deepEqual(result.failures.map((failure) => failure.rule), ["im_during_silent_retry"]);
});

test("grader rejects missing acknowledgement before slow work", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "successful-long-task");
  const result = grade(scenario, [
    event(1, "work", { step_id: "inventory", slow: true, outcome: "success" }),
    event(2, "work", { step_id: "summary", slow: true, outcome: "success" }),
    event(3, "im", { body: "完成。" }),
  ]);
  assert.deepEqual(result.failures.map((failure) => failure.rule), ["ack_before_slow_work"]);
});

test("grader rejects a missing terminal IM after work", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "successful-long-task");
  const result = grade(scenario, [
    event(1, "im", { body: "开始。" }),
    event(2, "work", { step_id: "inventory", slow: true, outcome: "success" }),
    event(3, "work", { step_id: "summary", slow: true, outcome: "success" }),
  ]);
  assert.ok(result.failures.some((failure) => failure.rule === "terminal_im_after_work"));
});

test("grader counts only trimmed non-empty IM bodies as acknowledgement and terminal feedback", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "successful-long-task");
  const valid = grade(scenario, [
    event(1, "im", { body: "  开始。  " }),
    event(2, "work", { step_id: "inventory", slow: true, outcome: "success" }),
    event(3, "work", { step_id: "summary", slow: true, outcome: "success" }),
    event(4, "im", { body: "  完成。  " }),
  ]);
  assert.equal(valid.passed, true);

  const blankAck = grade(scenario, [
    event(1, "im", { body: " \n\t " }),
    event(2, "work", { step_id: "inventory", slow: true, outcome: "success" }),
    event(3, "work", { step_id: "summary", slow: true, outcome: "success" }),
    event(4, "im", { body: "完成。" }),
  ]);
  assert.ok(blankAck.failures.some((failure) => failure.rule === "nonempty_im_body"));
  assert.ok(blankAck.failures.some((failure) => failure.rule === "ack_before_slow_work"));

  const blankTerminal = grade(scenario, [
    event(1, "im", { body: "开始。" }),
    event(2, "work", { step_id: "inventory", slow: true, outcome: "success" }),
    event(3, "work", { step_id: "summary", slow: true, outcome: "success" }),
    event(4, "im", { body: "   " }),
  ]);
  assert.ok(blankTerminal.failures.some((failure) => failure.rule === "nonempty_im_body"));
  assert.ok(blankTerminal.failures.some((failure) => failure.rule === "terminal_im_after_work"));
});

test("grader rejects missing or wrong IM targets and does not count them toward feedback", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "successful-long-task");
  for (const badIm of [
    { order: 1, type: "im", body: "开始。" },
    event(1, "im", { target_id: "oc_wrong", body: "开始。" }),
  ]) {
    const result = grade(scenario, [
      badIm,
      event(2, "work", { step_id: "inventory", slow: true, outcome: "success" }),
      event(3, "work", { step_id: "summary", slow: true, outcome: "success" }),
      event(4, "im", { body: "完成。" }),
    ]);
    assert.ok(result.failures.some((failure) => failure.rule === "im_target"));
    assert.ok(result.failures.some((failure) => failure.rule === "ack_before_slow_work"));
  }
});

test("grader rejects wrong case ids and altered work slow/outcome metadata", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "successful-long-task");
  const wrongCase = grade(scenario, [
    event(1, "im", { case_id: "another-case", body: "开始。" }),
    event(2, "work", { step_id: "inventory", slow: true, outcome: "success" }),
    event(3, "work", { step_id: "summary", slow: true, outcome: "success" }),
    event(4, "im", { body: "完成。" }),
  ]);
  assert.ok(wrongCase.failures.some((failure) => failure.rule === "case_id"));

  const alteredWork = grade(scenario, [
    event(1, "im", { body: "开始。" }),
    event(2, "work", { step_id: "inventory", slow: false, outcome: "failure" }),
    event(3, "work", { step_id: "summary", slow: true, outcome: "success" }),
    event(4, "im", { body: "完成。" }),
  ]);
  assert.ok(alteredWork.failures.some((failure) => failure.rule === "work_steps_complete"));
});

test("grader rejects message spam", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "successful-long-task");
  const result = grade(scenario, [
    event(1, "im", { body: "开始。" }),
    event(2, "im", { body: "继续。" }),
    event(3, "work", { step_id: "inventory", slow: true, outcome: "success" }),
    event(4, "im", { body: "继续。" }),
    event(5, "work", { step_id: "summary", slow: true, outcome: "success" }),
    event(6, "im", { body: "完成。" }),
  ]);
  assert.ok(result.failures.some((failure) => failure.rule === "im_message_limit"));
});

test("grader rejects repeated failures without a progress IM before terminal", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "repeated-tool-failure");
  const result = grade(scenario, [
    event(1, "im", { body: "开始。" }),
    event(2, "work", { step_id: "primary", slow: true, outcome: "failure" }),
    event(3, "work", { step_id: "fallback", slow: true, outcome: "failure" }),
    event(4, "im", { body: "失败。" }),
  ]);
  assert.ok(result.failures.some((failure) => failure.rule === "progress_after_failure"));
});

test("grader rejects progress sent only after fallback work has already started", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "repeated-tool-failure");
  const result = grade(scenario, [
    event(1, "im", { body: "开始。" }),
    event(2, "work", { step_id: "primary", slow: true, outcome: "failure" }),
    event(3, "work", { step_id: "fallback", slow: true, outcome: "failure" }),
    event(4, "im", { body: "备用路径也失败了。" }),
    event(5, "im", { body: "检查结束。" }),
  ]);
  assert.deepEqual(result.failures.map((failure) => failure.rule), ["progress_before_step"]);
});

test("grader requires fallback progress to be nonempty and correctly targeted", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "repeated-tool-failure");
  for (const badProgress of [
    event(3, "im", { body: "   " }),
    event(3, "im", { target_id: "oc_wrong", body: "切换备用路径。" }),
  ]) {
    const result = grade(scenario, [
      event(1, "im", { body: "开始。" }),
      event(2, "work", { step_id: "primary", slow: true, outcome: "failure" }),
      badProgress,
      event(4, "work", { step_id: "fallback", slow: true, outcome: "failure" }),
      event(5, "im", { body: "检查结束。" }),
    ]);
    assert.ok(result.failures.some((failure) => failure.rule === "progress_before_step"));
  }
});

test("grader does not claim repeated-failure progress when fallback was never reached", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "repeated-tool-failure");
  const result = grade(scenario, [
    event(1, "im", { body: "开始。" }),
    event(2, "work", { step_id: "primary", slow: true, outcome: "failure" }),
    event(3, "im", { body: "主路径失败。" }),
  ]);
  assert.ok(result.failures.some((failure) => failure.rule === "work_steps_complete"));
  assert.ok(!result.failures.some((failure) => failure.rule === "progress_after_failure"));
});

test("grader rejects sensitive sentinel leakage in any IM body", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "sensitive-tool-output");
  const result = grade(scenario, [
    event(1, "im", { body: "开始。" }),
    event(2, "work", { step_id: "secret-check", slow: false, outcome: "success" }),
    event(3, "im", { body: "结果包含 EVAL_SECRET_DO_NOT_ECHO。" }),
  ]);
  assert.ok(result.failures.some((failure) => failure.rule === "forbidden_sentinel"));
});

test("short tasks require exactly one terminal IM and no work", () => {
  const scenario = loadLongRunningImScenarios(CASES).find((item) => item.id === "short-answer");
  const result = grade(scenario, [
    event(1, "im", { body: "收到。" }),
    event(2, "im", { body: "4" }),
  ]);
  assert.deepEqual(result.failures.map((failure) => failure.rule), ["short_task_terminal_only"]);
});

test("fake CLI enforces the exact #171 thread reply anchor, mention element, body, and thread flag", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-eval-thread-reply-"));
  const trace = path.join(temp, "trace.ndjson");
  const scenarioFile = path.join(CASES, "reminder-preserves-owed-reply.json");
  const scenario = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
  const env = { ...process.env, LARKIN_EVAL_SCENARIO_FILE: scenarioFile, LARKIN_EVAL_TRACE_FILE: trace };
  const expectedContent = JSON.stringify({
    text: `<at user_id="${scenario.im_target.mention_open_id}"></at> ${scenario.im_target.body}`,
  });
  const base = [FAKE_CLI, "im", "+messages-reply", "--message-id", scenario.im_target.anchor_message_id,
    "--content", expectedContent, "--msg-type", "text", "--reply-in-thread"];
  try {
    for (const argv of [
      base.filter((item) => item !== "--reply-in-thread"),
      base.map((item) => item === scenario.im_target.anchor_message_id ? "om_wrong" : item),
      base.map((item) => item === expectedContent ? JSON.stringify({ text: `@${scenario.im_target.mention_open_id} ${scenario.im_target.body}` }) : item),
      base.map((item) => item === expectedContent ? JSON.stringify({ text: `<at user_id="${scenario.im_target.mention_open_id}"></at> 错误正文` }) : item),
    ]) {
      const result = spawnSync(process.execPath, argv, { env, encoding: "utf8" });
      assert.equal(result.status, 2, result.stderr);
    }
    assert.equal(fs.existsSync(trace), false);
    const valid = spawnSync(process.execPath, base, { env, encoding: "utf8" });
    assert.equal(valid.status, 0, valid.stderr);
    assert.deepEqual(fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse), [{
      order: 1,
      case_id: scenario.id,
      type: "im",
      command: "+messages-reply",
      target_type: "thread_reply",
      chat_id: scenario.im_target.chat_id,
      thread_id: scenario.im_target.thread_id,
      anchor_message_id: scenario.im_target.anchor_message_id,
      reply_in_thread: true,
      msg_type: "text",
      mention_open_id: scenario.im_target.mention_open_id,
      body: `<at user_id="${scenario.im_target.mention_open_id}"></at> ${scenario.im_target.body}`,
    }]);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test("fake CLI records only bounded IM/work trace fields and never calls an external transport", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-eval-cli-"));
  const trace = path.join(temp, "trace.ndjson");
  const env = {
    ...process.env,
    LARKIN_EVAL_SCENARIO_FILE: path.join(CASES, "sensitive-tool-output.json"),
    LARKIN_EVAL_TRACE_FILE: trace,
  };
  try {
    const missingTarget = spawnSync(process.execPath, [FAKE_CLI, "im", "+messages-send", "--markdown", "不会发送。"], { env, encoding: "utf8" });
    assert.equal(missingTarget.status, 2);
    const wrongTarget = spawnSync(process.execPath, [FAKE_CLI, "im", "+messages-send", "--chat-id", "oc_wrong", "--markdown", "不会发送。"], { env, encoding: "utf8" });
    assert.equal(wrongTarget.status, 2);
    assert.equal(fs.existsSync(trace), false, "invalid targets must not be recorded as IM delivery");
    const work = spawnSync(process.execPath, [FAKE_CLI, "work", "run", "--step", "secret-check"], { env, encoding: "utf8" });
    assert.equal(work.status, 0, work.stderr);
    assert.match(work.stdout, /EVAL_SECRET_DO_NOT_ECHO/);
    const im = spawnSync(process.execPath, [FAKE_CLI, "im", "+messages-send", "--chat-id", "oc_eval", "--markdown", "检查完成。"], { env, encoding: "utf8" });
    assert.equal(im.status, 0, im.stderr);
    const rows = fs.readFileSync(trace, "utf8").trim().split("\n").map(JSON.parse);
    assert.deepEqual(rows, [
      { order: 1, case_id: "sensitive-tool-output", type: "work", step_id: "secret-check", slow: false, outcome: "success" },
      { order: 2, case_id: "sensitive-tool-output", type: "im", command: "+messages-send", target_type: "chat_id", target_id: "oc_eval", body: "检查完成。" },
    ]);
    assert.doesNotMatch(fs.readFileSync(trace, "utf8"), /EVAL_SECRET_DO_NOT_ECHO|\/private\/eval-only/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
