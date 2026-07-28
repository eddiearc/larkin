import fs from "node:fs";

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function loadAgentExperienceV6Eval(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.dataset !== "agent-experience-v6" || value.version !== 1) throw new Error("eval dataset/version mismatch");
  if (value.model?.standing_prompt_version !== "larkin-standing-v6") throw new Error("standing prompt version mismatch");
  if (value.session?.initial_turns !== 0) throw new Error("eval scenarios must start from a fresh empty session");
  if (value.grader?.name !== "agent-experience-v6-trace-grader" || value.grader.version !== 1 || value.grader.threshold !== 1) {
    throw new Error("eval grader metadata mismatch");
  }
  if (!Array.isArray(value.grader.rubric) || value.grader.rubric.length < 6) throw new Error("eval rubric is incomplete");
  if (!Array.isArray(value.scenarios) || value.scenarios.length < 5) throw new Error("eval requires five selected scenarios");
  const ids = new Set();
  for (const [index, scenario] of value.scenarios.entries()) {
    const label = `scenarios[${index}]`;
    const id = nonempty(scenario.id, `${label}.id`);
    if (ids.has(id)) throw new Error(`duplicate scenario id: ${id}`);
    ids.add(id);
    nonempty(scenario.task, `${label}.task`);
    if (!scenario.expected || !Number.isSafeInteger(scenario.expected.max_tool_calls)) throw new Error(`${label}.expected.max_tool_calls is required`);
    if (!Number.isSafeInteger(scenario.expected.provider_writes)) throw new Error(`${label}.expected.provider_writes is required`);
    if (!Array.isArray(scenario.trace)) throw new Error(`${label}.trace must be an array`);
  }
  return value;
}

export function gradeAgentExperienceV6Trace(scenario, trace) {
  const failures = [];
  const fail = (rule, detail) => failures.push({ rule, detail });
  const tools = trace.filter((event) => event.action === "tool" || event.action === "provider_write");
  const writes = trace.filter((event) => event.action === "provider_write");
  if (tools.length > scenario.expected.max_tool_calls) fail("bounded_calls", `${tools.length} > ${scenario.expected.max_tool_calls}`);
  if (writes.length !== scenario.expected.provider_writes) fail("provider_write_count", `${writes.length} != ${scenario.expected.provider_writes}`);
  const commands = tools.map((event) => event.command || "");
  if (scenario.expected.required_command && !commands.includes(scenario.expected.required_command)) {
    fail("canonical_command", scenario.expected.required_command);
  }
  for (const fragment of scenario.expected.forbidden_command_fragments || []) {
    if (commands.some((command) => command.includes(fragment))) fail("forbidden_command", fragment);
  }
  if (scenario.expected.response_path && !trace.some((event) => event.read_path === scenario.expected.response_path)) {
    fail("stable_response_path", scenario.expected.response_path);
  }
  const final = trace.findLast((event) => event.action === "final");
  if (scenario.expected.visible_failure === true && final?.visible_failure !== true) fail("visible_failure", "missing");
  if (scenario.expected.reused_memory === false && final?.reused_memory !== false) fail("no_memory_fallback", "memory use was not rejected");
  if (scenario.expected.exact_text && !writes.some((event) => event.transported_text === scenario.expected.exact_text)) {
    fail("exact_text", "provider text changed");
  }
  if (scenario.expected.shell_interpolation === false && writes.some((event) => event.shell_interpolation !== false)) {
    fail("shell_interpolation", "exact text used shell interpolation");
  }
  if (scenario.expected.stay_silent === true && trace.length !== 0) fail("exclusive_silence", "excluded Agent acted");
  if (scenario.expected.committed_result) {
    const event = writes[0];
    const expected = scenario.expected.committed_result;
    for (const field of ["exit_code", "stdout_documents", "stderr"]) {
      if (event?.[field] !== expected[field]) fail("committed_result", `${field} mismatch`);
    }
    for (const field of ["committed", "verified", "cursor_advanced"]) {
      if (event?.result?.[field] !== expected[field]) fail("committed_result", `${field} mismatch`);
    }
    if (scenario.expected.agent_retried === false && writes.length !== 1) fail("no_retry", `writes=${writes.length}`);
  }
  return { passed: failures.length === 0, failures };
}

export function summarizeAgentExperienceV6Eval(dataset, tracesById) {
  const results = dataset.scenarios.map((scenario) => ({ id: scenario.id,
    ...gradeAgentExperienceV6Trace(scenario, tracesById[scenario.id] || []) }));
  const passRate = results.filter((result) => result.passed).length / results.length;
  return { passed: passRate >= dataset.grader.threshold, pass_rate: passRate, threshold: dataset.grader.threshold, results };
}
