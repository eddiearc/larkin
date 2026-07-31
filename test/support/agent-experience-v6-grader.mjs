import fs from "node:fs";

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function loadAgentExperienceV6Eval(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.dataset !== "agent-experience-v6" || value.version !== 4) throw new Error("eval dataset/version mismatch");
  if (value.model?.standing_prompt_version !== "larkin-standing-v6") throw new Error("standing prompt version mismatch");
  if (value.session?.initial_turns !== 0) throw new Error("eval scenarios must start from a fresh empty session");
  if (value.grader?.name !== "agent-experience-v6-trace-grader" || value.grader.version !== 4 || value.grader.threshold !== 1) {
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
  if (Number.isSafeInteger(scenario.expected.exact_tool_calls) && tools.length !== scenario.expected.exact_tool_calls) {
    fail("tool_call_count", `${tools.length} != ${scenario.expected.exact_tool_calls}`);
  }
  if (writes.length !== scenario.expected.provider_writes) fail("provider_write_count", `${writes.length} != ${scenario.expected.provider_writes}`);
  if (Number.isInteger(scenario.expected.write_exit_code)
    && writes.some((event) => event.exit_code !== scenario.expected.write_exit_code)) {
    fail("provider_write_result", `expected every provider write to exit ${scenario.expected.write_exit_code}`);
  }
  const commands = tools.map((event) => event.command || "");
  if (scenario.expected.required_command && !commands.includes(scenario.expected.required_command)) {
    fail("canonical_command", scenario.expected.required_command);
  }
  for (const required of scenario.expected.required_commands || []) {
    if (!commands.includes(required)) fail("canonical_command", required);
  }
  if (Array.isArray(scenario.expected.ordered_commands)) {
    const orderedIndexes = scenario.expected.ordered_commands.map((required) => commands.indexOf(required));
    if (orderedIndexes.some((index) => index < 0)
      || orderedIndexes.some((index, position) => position > 0 && index <= orderedIndexes[position - 1])) {
      fail("canonical_order", scenario.expected.ordered_commands.join(" -> "));
    }
    if (Number.isInteger(scenario.expected.ordered_command_exit_code)
      && orderedIndexes.some((index) => index < 0 || tools[index]?.exit_code !== scenario.expected.ordered_command_exit_code)) {
      fail("canonical_result", `expected every ordered command to exit ${scenario.expected.ordered_command_exit_code}`);
    }
  }
  if (scenario.expected.reply_anchor) {
    const anchor = scenario.expected.reply_anchor;
    const poll = tools.find((event) => event.action === "tool" && event.command === anchor.poll_command);
    const write = writes.find((event) => event.command === anchor.write_command);
    const pollMessageId = poll?.message_id;
    if (typeof pollMessageId !== "string" || !/^om_[A-Za-z0-9_]+$/.test(pollMessageId)
      || write?.message_id !== pollMessageId
      || !String(write?.command || "").includes(`--message-id ${pollMessageId} `)) {
      fail("reply_anchor", "reply was not bound to the real om_ message id returned by the canonical poll");
    }
  }
  for (const fragment of scenario.expected.forbidden_command_fragments || []) {
    if (commands.some((command) => command.includes(fragment))) fail("forbidden_command", fragment);
  }
  for (const fragment of scenario.expected.forbidden_read_path_fragments || []) {
    if (tools.some((event) => (event.tool_name === "read" || String(event.command || "").startsWith("read "))
      && `${event.resource_path || ""} ${event.command || ""}`.includes(fragment))) {
      fail("redundant_discovery_read", fragment);
    }
  }
  if (scenario.expected.response_path && !trace.some((event) => event.read_path === scenario.expected.response_path)) {
    fail("stable_response_path", scenario.expected.response_path);
  }
  const final = trace.findLast((event) => event.action === "final");
  if (scenario.expected.visible_failure === true && final?.visible_failure !== true) fail("visible_failure", "missing");
  if (scenario.expected.reused_memory === false && final?.reused_memory !== false) fail("no_memory_fallback", "memory use was not rejected");
  if (scenario.expected.exact_text) {
    let sourceText = scenario.expected.exact_text;
    if (scenario.expected.exact_text_source) {
      const source = scenario.expected.exact_text_source;
      const sourceEvents = trace.filter((event) => event.action === "tool"
        && event.command === source.command && event.read_path === source.read_path);
      if (sourceEvents.length !== 1 || sourceEvents[0].source_text !== scenario.expected.exact_text) {
        fail("exact_text_source", "exact text was not bound to the unique canonical scoped-history result");
        sourceText = undefined;
      } else sourceText = sourceEvents[0].source_text;
    }
    if (typeof sourceText !== "string" || !writes.some((event) => event.transported_text === sourceText)) {
      fail("exact_text", "provider text changed from the exact source");
    }
    if (scenario.expected.argv_text_from_source === true
      && (typeof sourceText !== "string" || !writes.some((event) => event.argv_text === sourceText))) {
      fail("argv_source_binding", "planned argv literal changed from the exact source before execution");
    }
  }
  if (scenario.expected.shell_interpolation === false && writes.some((event) => event.shell_interpolation !== false)) {
    fail("shell_interpolation", "exact text used shell interpolation");
  }
  if (scenario.expected.poll_before_write === true) {
    const pollIndex = trace.findIndex((event) => event.action === "tool" && String(event.command || "").startsWith("larkin inbox poll "));
    const writeIndex = trace.findIndex((event) => event.action === "provider_write");
    if (pollIndex < 0 || writeIndex < 0 || pollIndex >= writeIndex) fail("poll_before_write", `${pollIndex} !< ${writeIndex}`);
  }
  if (scenario.expected.precommit_retry) {
    const expected = scenario.expected.precommit_retry;
    const precommitAttempts = trace
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.action === "tool" && typeof event.subtype === "string");
    const precommit = precommitAttempts[0]?.event;
    const precommitIndex = precommitAttempts[0]?.index ?? -1;
    const writeIndex = trace.findIndex((event) => event.action === "provider_write");
    const allowed = Array.isArray(expected.allowed_subtypes) ? expected.allowed_subtypes : [];
    if (precommitAttempts.length !== 1 || !precommit || precommitIndex >= writeIndex
      || !Number.isInteger(precommit.exit_code) || precommit.exit_code === 0
      || !allowed.includes(precommit.subtype) || precommit.provider_reached !== expected.provider_reached
      || (expected.same_command === true && precommit.command !== writes[0]?.command)) {
      fail("safe_precommit_retry", "retry was not proven pre-commit with the same canonical command");
    }
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
