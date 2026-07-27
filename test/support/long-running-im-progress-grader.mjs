import fs from "node:fs";
import path from "node:path";

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function parseLongRunningImScenario(value, source = "scenario") {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${source} must be an object`);
  if (value.version !== 1) throw new Error(`${source}.version must be 1`);
  if (!Array.isArray(value.steps)) throw new Error(`${source}.steps must be an array`);
  if (!value.im_target || typeof value.im_target !== "object" || Array.isArray(value.im_target)
      || value.im_target.type !== "chat_id") {
    throw new Error(`${source}.im_target.type must be chat_id`);
  }
  const imTarget = { type: "chat_id", id: requiredString(value.im_target.id, `${source}.im_target.id`) };
  const steps = value.steps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`${source}.steps[${index}] must be an object`);
    if (typeof step.slow !== "boolean") throw new Error(`${source}.steps[${index}].slow must be boolean`);
    if (step.outcome !== "success" && step.outcome !== "failure") throw new Error(`${source}.steps[${index}].outcome is invalid`);
    return {
      id: requiredString(step.id, `${source}.steps[${index}].id`),
      phase: step.phase === undefined ? null : requiredString(step.phase, `${source}.steps[${index}].phase`),
      slow: step.slow,
      outcome: step.outcome,
      output: requiredString(step.output, `${source}.steps[${index}].output`),
    };
  });
  if (new Set(steps.map((step) => step.id)).size !== steps.length) throw new Error(`${source}.steps ids must be unique`);
  const expected = value.expectations;
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) throw new Error(`${source}.expectations must be an object`);
  for (const key of ["ack_before_first_slow_work", "terminal_im_after_work", "progress_after_repeated_failure", "short_task_terminal_only"]) {
    if (typeof expected[key] !== "boolean") throw new Error(`${source}.expectations.${key} must be boolean`);
  }
  if (!Number.isInteger(expected.max_im_messages) || expected.max_im_messages < 1) {
    throw new Error(`${source}.expectations.max_im_messages must be a positive integer`);
  }
  if (!Array.isArray(expected.forbidden_sentinels) || expected.forbidden_sentinels.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${source}.expectations.forbidden_sentinels must contain non-empty strings`);
  }
  const silentFailureRetryPairs = expected.silent_failure_retry_pairs ?? [];
  if (!Array.isArray(silentFailureRetryPairs)) {
    throw new Error(`${source}.expectations.silent_failure_retry_pairs must be an array`);
  }
  const stepById = new Map(steps.map((step, index) => [step.id, { step, index }]));
  const parsedSilentFailureRetryPairs = silentFailureRetryPairs.map((pair, index) => {
    if (!pair || typeof pair !== "object" || Array.isArray(pair)) {
      throw new Error(`${source}.expectations.silent_failure_retry_pairs[${index}] must be an object`);
    }
    const failureStepId = requiredString(pair.failure_step_id,
      `${source}.expectations.silent_failure_retry_pairs[${index}].failure_step_id`);
    const retryStepId = requiredString(pair.retry_step_id,
      `${source}.expectations.silent_failure_retry_pairs[${index}].retry_step_id`);
    const failure = stepById.get(failureStepId);
    const retry = stepById.get(retryStepId);
    if (!failure || !retry || failure.index >= retry.index || failure.step.outcome !== "failure"
        || retry.step.outcome !== "success" || !failure.step.phase || failure.step.phase !== retry.step.phase) {
      throw new Error(`${source}.expectations.silent_failure_retry_pairs[${index}] must reference an ordered same-phase failure then success`);
    }
    return { failure_step_id: failureStepId, retry_step_id: retryStepId };
  });
  const progressBeforeSteps = expected.progress_before_steps ?? [];
  if (!Array.isArray(progressBeforeSteps)
      || progressBeforeSteps.some((stepId) => typeof stepId !== "string" || !stepId.trim())) {
    throw new Error(`${source}.expectations.progress_before_steps must contain non-empty step ids`);
  }
  if (new Set(progressBeforeSteps).size !== progressBeforeSteps.length
      || progressBeforeSteps.some((stepId) => !stepById.has(stepId) || stepById.get(stepId).index === 0)) {
    throw new Error(`${source}.expectations.progress_before_steps must contain unique non-first scenario step ids`);
  }
  return {
    version: 1,
    id: requiredString(value.id, `${source}.id`),
    title: requiredString(value.title, `${source}.title`),
    task: requiredString(value.task, `${source}.task`),
    im_target: imTarget,
    steps,
    expectations: {
      ack_before_first_slow_work: expected.ack_before_first_slow_work,
      terminal_im_after_work: expected.terminal_im_after_work,
      progress_after_repeated_failure: expected.progress_after_repeated_failure,
      max_im_messages: expected.max_im_messages,
      short_task_terminal_only: expected.short_task_terminal_only,
      silent_failure_retry_pairs: parsedSilentFailureRetryPairs,
      progress_before_steps: [...progressBeforeSteps],
      forbidden_sentinels: [...expected.forbidden_sentinels],
    },
  };
}

export function loadLongRunningImScenarios(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .sort((left, right) => left.name.localeCompare(right.name, "en"))
    .map((entry) => {
      const file = path.join(directory, entry.name);
      return parseLongRunningImScenario(JSON.parse(fs.readFileSync(file, "utf8")), entry.name);
    });
}

export function gradeLongRunningImTrace(scenario, trace) {
  const failures = [];
  const fail = (rule, message) => { failures.push({ rule, message }); };
  const ordered = [...trace].sort((left, right) => left.order - right.order);
  if (ordered.some((item, index) => item.order !== trace[index]?.order || !Number.isInteger(item.order) || item.order < 1)
      || new Set(ordered.map((item) => item.order)).size !== ordered.length) {
    fail("trace_order", "trace order must be unique, positive, and increasing");
  }
  if (ordered.some((item) => item.case_id !== scenario.id)) {
    fail("case_id", `every trace event must belong to case ${scenario.id}`);
  }
  const imEvents = ordered.filter((item) => item.type === "im");
  const nonemptyImEvents = imEvents.filter((item) => typeof item.body === "string" && item.body.trim().length > 0);
  const targetedImEvents = imEvents.filter((item) =>
    item.target_type === scenario.im_target.type && item.target_id === scenario.im_target.id);
  const eligibleImEvents = targetedImEvents.filter((item) => typeof item.body === "string" && item.body.trim().length > 0);
  const workEvents = ordered.filter((item) => item.type === "work");
  const workContractMatches = workEvents.length === scenario.steps.length && workEvents.every((event, index) => {
    const expectedStep = scenario.steps[index];
    return event.step_id === expectedStep.id && event.slow === expectedStep.slow && event.outcome === expectedStep.outcome;
  });
  if (!workContractMatches) {
    fail("work_steps_complete", `expected exact work step id/slow/outcome contracts in scenario order`);
  }
  if (!scenario.expectations.short_task_terminal_only && imEvents.length > scenario.expectations.max_im_messages) {
    fail("im_message_limit", `expected at most ${scenario.expectations.max_im_messages} IM messages, got ${imEvents.length}`);
  }
  if (nonemptyImEvents.length !== imEvents.length) {
    fail("nonempty_im_body", "every IM used for feedback must have a non-empty body after trimming");
  }
  if (targetedImEvents.length !== imEvents.length) {
    fail("im_target", `every IM must target ${scenario.im_target.type}:${scenario.im_target.id}`);
  }
  if (scenario.expectations.short_task_terminal_only && (imEvents.length !== 1 || eligibleImEvents.length !== 1 || workEvents.length !== 0)) {
    fail("short_task_terminal_only", "short task must use exactly one terminal IM and no work call");
  }
  const firstSlow = ordered.find((item) => item.type === "work" && item.slow === true);
  if (scenario.expectations.ack_before_first_slow_work && (!firstSlow || !eligibleImEvents.some((item) => item.order < firstSlow.order))) {
    fail("ack_before_slow_work", "an IM acknowledgement must precede the first slow work event");
  }
  const lastWork = workEvents.at(-1);
  const terminalIm = eligibleImEvents.at(-1);
  if (scenario.expectations.terminal_im_after_work && (!lastWork || !terminalIm || terminalIm.order < lastWork.order)) {
    fail("terminal_im_after_work", "the final IM must follow the last work event");
  }
  if (scenario.expectations.progress_after_repeated_failure) {
    const failedWork = workEvents.filter((item) => item.outcome === "failure");
    const firstFailure = failedWork[0];
    if (failedWork.length >= 2 && (!terminalIm || !firstFailure
        || !eligibleImEvents.some((item) => item.order > firstFailure.order && item.order < terminalIm.order))) {
      fail("progress_after_failure", "repeated failures require a progress IM before the terminal IM");
    }
  }
  for (const pair of scenario.expectations.silent_failure_retry_pairs) {
    const failureWork = workEvents.find((item) => item.step_id === pair.failure_step_id);
    const retryWork = workEvents.find((item) => item.step_id === pair.retry_step_id);
    if (failureWork && retryWork && imEvents.some((item) => item.order > failureWork.order && item.order < retryWork.order)) {
      fail("im_during_silent_retry", `no IM is allowed between ${pair.failure_step_id} and ${pair.retry_step_id}`);
    }
  }
  for (const stepId of scenario.expectations.progress_before_steps) {
    const expectedIndex = scenario.steps.findIndex((step) => step.id === stepId);
    const priorStepId = scenario.steps[expectedIndex - 1]?.id;
    const priorWork = workEvents.find((item) => item.step_id === priorStepId);
    const nextWork = workEvents.find((item) => item.step_id === stepId);
    if (priorWork && nextWork
        && !eligibleImEvents.some((item) => item.order > priorWork.order && item.order < nextWork.order)) {
      fail("progress_before_step", `a targeted non-empty IM must precede ${stepId} after ${priorStepId}`);
    }
  }
  const leaked = scenario.expectations.forbidden_sentinels.find((sentinel) =>
    imEvents.some((item) => String(item.body || "").includes(sentinel)));
  if (leaked) fail("forbidden_sentinel", `an IM body leaked forbidden sentinel ${leaked}`);
  return { passed: failures.length === 0, failures };
}
