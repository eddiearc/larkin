import fs from "node:fs";

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function loadRuntimeAgentInterfaceEval(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.dataset !== "runtime-agent-interface-v2" || value.version !== 1) throw new Error("eval dataset/version mismatch");
  if (value.runtime?.adapter !== "codex") throw new Error("eval runtime.adapter must be codex");
  nonempty(value.runtime.minimum_cli_version, "runtime.minimum_cli_version");
  if (value.model?.standing_prompt_version !== "larkin-standing-v15") throw new Error("eval standing prompt version mismatch");
  nonempty(value.model.selection, "model.selection");
  if (value.grader?.name !== "runtime-agent-interface-v2-trace-grader" || value.grader.version !== 1) {
    throw new Error("eval grader metadata mismatch");
  }
  if (!(value.grader.threshold > 0 && value.grader.threshold <= 1)) throw new Error("eval threshold must be in (0, 1]");
  if (!Array.isArray(value.grader.rubric) || value.grader.rubric.length < 5) throw new Error("eval rubric must have at least five rules");
  if (!Array.isArray(value.scenarios) || value.scenarios.length < 6) throw new Error("eval requires at least six scenarios");
  const ids = new Set();
  for (const [index, scenario] of value.scenarios.entries()) {
    const prefix = `scenarios[${index}]`;
    const id = nonempty(scenario.id, `${prefix}.id`);
    if (ids.has(id)) throw new Error(`duplicate scenario id: ${id}`);
    ids.add(id);
    nonempty(scenario.task, `${prefix}.task`);
    nonempty(scenario.target, `${prefix}.target`);
    if (!Array.isArray(scenario.required_actions) || !scenario.required_actions.length
        || scenario.required_actions.some((action) => typeof action !== "string" || !action)) {
      throw new Error(`${prefix}.required_actions must be a non-empty action list`);
    }
    if (!Array.isArray(scenario.trace) || !scenario.trace.length) throw new Error(`${prefix}.trace must be non-empty`);
    if (!Number.isSafeInteger(scenario.expected_provider_writes) || scenario.expected_provider_writes < 0) {
      throw new Error(`${prefix}.expected_provider_writes must be a non-negative integer`);
    }
    if (scenario.expected_body !== undefined) {
      nonempty(scenario.expected_body, `${prefix}.expected_body`);
      if (!scenario.expected_body.includes("\n")) throw new Error(`${prefix}.expected_body must contain a real newline`);
      if (!["--markdown", "--text"].includes(scenario.expected_content_flag)) {
        throw new Error(`${prefix}.expected_content_flag must be --markdown or --text`);
      }
    }
  }
  return value;
}

export function gradeRuntimeAgentInterfaceTrace(scenario, trace) {
  const failures = [];
  const fail = (rule, detail) => failures.push({ rule, detail });
  const targets = new Map();
  let busy = false;
  let providerWrites = 0;
  const actualActions = new Map();
  for (const [index, event] of trace.entries()) {
    actualActions.set(event.action, (actualActions.get(event.action) || 0) + 1);
    const target = event.target || scenario.target;
    const state = targets.get(target) || { latest: 0, seen: 0 };
    if (event.action === "update") {
      if (!Number.isSafeInteger(event.seq) || event.seq <= state.latest) fail("monotonic_update", `event ${index}`);
      else state.latest = event.seq;
    } else if (event.action === "check") {
      if (event.content_observed !== false) fail("check_content_light", `event ${index}`);
    } else if (event.action === "poll") {
      if (event.direct_ack !== true) fail("poll_direct_ack", `event ${index}`);
      if (!Number.isSafeInteger(event.seq) || event.seq < state.seen || event.seq > state.latest) fail("poll_sequence", `event ${index}`);
      else state.seen = event.seq;
    } else if (event.action === "write_attempt") {
      const stale = state.latest > state.seen;
      if (stale && (event.outcome !== "held" || event.provider_reached !== false)) fail("stale_write_hold", `event ${index}`);
      if (!stale && event.outcome === "held") fail("fresh_write_not_held", `event ${index}`);
    } else if (event.action === "provider_write") {
      providerWrites += 1;
      if (state.latest > state.seen || event.based_on_seq !== state.seen) fail("freshness_before_provider", `event ${index}`);
      if (scenario.expected_body !== undefined
          && (event.content_flag !== scenario.expected_content_flag || event.body !== scenario.expected_body)) {
        fail("multiline_body_transport", `event ${index}`);
      }
    } else if (event.action === "busy_start") busy = true;
    else if (event.action === "safe_boundary") busy = false;
    else if (event.action === "cancel") {
      if (busy) fail("busy_update_no_cancel", `event ${index}`);
    } else fail("known_action", `event ${index}: ${event.action}`);
    targets.set(target, state);
  }
  if (providerWrites !== scenario.expected_provider_writes) {
    fail("provider_write_count", `expected ${scenario.expected_provider_writes}, got ${providerWrites}`);
  }
  const requiredActions = new Map();
  for (const action of scenario.required_actions || []) requiredActions.set(action, (requiredActions.get(action) || 0) + 1);
  for (const [action, count] of requiredActions) {
    const actual = actualActions.get(action) || 0;
    if (actual < count) fail("required_actions", `${action}: expected at least ${count}, got ${actual}`);
  }
  return { passed: failures.length === 0, failures };
}

export function summarizeRuntimeAgentInterfaceEval(dataset, tracesById) {
  const results = dataset.scenarios.map((scenario) => {
    const grade = gradeRuntimeAgentInterfaceTrace(scenario, tracesById[scenario.id] || []);
    return { id: scenario.id, ...grade };
  });
  const passRate = results.filter((result) => result.passed).length / results.length;
  return { passed: passRate >= dataset.grader.threshold, pass_rate: passRate, threshold: dataset.grader.threshold, results };
}
