import fs from "node:fs";

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function correctionBoundaryIssue(scenario) {
  if (!Object.hasOwn(scenario, "inbox_batch") && !Object.hasOwn(scenario, "effective_message_id")) return null;
  const rows = scenario.inbox_batch;
  if (!Array.isArray(rows) || rows.length !== 2) return "inbox_batch must contain exactly the adjacent older/newer envelopes";
  const allowed = new Set(["message_id", "sender_type", "sender_id", "target", "target_seq", "content"]);
  if (typeof scenario.recipient_agent_id !== "string" || !scenario.recipient_agent_id) {
    return "recipient_agent_id must identify the eval's per-Agent Inbox context";
  }
  for (const row of rows) {
    if (!row || typeof row !== "object" || Array.isArray(row)
      || Object.keys(row).length !== allowed.size || Object.keys(row).some((field) => !allowed.has(field))) {
      return "inbox_batch envelope shape is invalid";
    }
    if (typeof row.message_id !== "string" || !/^om_[A-Za-z0-9_]+$/.test(row.message_id)
      || row.sender_type !== "human" || typeof row.sender_id !== "string" || !row.sender_id
      || typeof row.target !== "string" || !row.target || !Number.isSafeInteger(row.target_seq) || row.target_seq < 1
      || typeof row.content !== "string" || !row.content) {
      return "inbox_batch envelope identity, order, or content is invalid";
    }
  }
  const [older, newer] = rows;
  if (older.message_id === newer.message_id || older.sender_id !== newer.sender_id
    || older.target !== newer.target || newer.target_seq !== older.target_seq + 1) {
    return "correction envelopes must be strictly adjacent for the same human and target";
  }
  if (older.content !== "Read chat:oc_canceled and reply OLD."
    || newer.content !== "更正：撤销前一条跨群读取；固定输出 NEW。") {
    return "fixed correction envelopes must preserve the explicit older task and newer cancellation/replacement";
  }
  if (scenario.effective_message_id !== newer.message_id) return "effective_message_id must select the strictly newer envelope";
  return null;
}

export function loadAgentExperienceV6Eval(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.dataset !== "agent-experience-v6" || value.version !== 6) throw new Error("eval dataset/version mismatch");
  if (value.model?.standing_prompt_version !== "larkin-standing-v6") throw new Error("standing prompt version mismatch");
  if (value.session?.initial_turns !== 0) throw new Error("eval scenarios must start from a fresh empty session");
  if (value.grader?.name !== "agent-experience-v6-trace-grader" || value.grader.version !== 6 || value.grader.threshold !== 1) {
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
    const correctionIssue = correctionBoundaryIssue(scenario);
    if (correctionIssue) throw new Error(`${label}.inbox_batch: ${correctionIssue}`);
    const dataflow = scenario.expected.exact_source_dataflow;
    if (dataflow && (!["thread", "message"].includes(dataflow.source_selector)
      || dataflow.post_poll_model_tool_calls !== 1 || dataflow.total_source_reads !== 1
      || dataflow.composite_internal_commands !== 2 || dataflow.content_key !== "text"
      || dataflow.source_read_path !== "data.messages" || dataflow.source_read_count !== 1
      || dataflow.source_exit_code !== 0 || dataflow.source_field !== "content"
      || dataflow.shell_substitution !== "quoted")) {
      throw new Error(`${label}.expected.exact_source_dataflow selector/count contract is invalid`);
    }
  }
  return value;
}

export function gradeAgentExperienceV6Trace(scenario, trace) {
  const failures = [];
  const fail = (rule, detail) => failures.push({ rule, detail });
  const rawTrace = Array.isArray(trace) ? trace : [];
  if (!Array.isArray(trace)) fail("trace_action_schema", "trace must be an array");
  const allowedActions = new Set(["tool", "provider_write", "final"]);
  const allowedFields = {
    tool: new Set(["action", "command", "exit_code", "message_id", "provider_reached", "read_path",
      "resource_path", "stderr", "stdout_documents", "subtype", "tool_name"]),
    provider_write: new Set(["action", "command", "composite_internal_commands", "content_argument", "exit_code",
      "literal_prefix", "message_id", "result", "shell_interpolation", "shell_substitution", "source_command",
      "source_exit_code", "source_field", "source_msg_type", "source_read_count", "source_read_path",
      "source_selector", "source_target", "source_text", "stderr", "stdout_documents", "transported_text"]),
    final: new Set(["action", "visible_failure", "reused_memory"]),
  };
  const optionalFieldsHaveType = (event, fields, type) => fields.every((field) =>
    !Object.hasOwn(event, field) || typeof event[field] === type);
  const optionalIntegerFields = (event, fields) => fields.every((field) =>
    !Object.hasOwn(event, field) || Number.isInteger(event[field]));
  const validResult = (result) => result === undefined || (result && typeof result === "object" && !Array.isArray(result)
    && Object.keys(result).length === 4
    && ["ok", "committed", "verified", "cursor_advanced"].every((field) => typeof result[field] === "boolean"));
  const validActionFields = (event) => {
    if (!event || typeof event !== "object" || Array.isArray(event) || !allowedActions.has(event.action)) return false;
    if (Object.keys(event).some((field) => !allowedFields[event.action].has(field))) return false;
    if (event.action === "final") {
      return optionalFieldsHaveType(event, ["visible_failure", "reused_memory"], "boolean");
    }
    if (typeof event.command !== "string" || !event.command || !Number.isInteger(event.exit_code)) return false;
    if (event.action === "tool") {
      return optionalFieldsHaveType(event,
        ["message_id", "read_path", "resource_path", "stderr", "subtype", "tool_name"], "string")
        && optionalFieldsHaveType(event, ["provider_reached"], "boolean")
        && optionalIntegerFields(event, ["stdout_documents"]);
    }
    return optionalFieldsHaveType(event, ["content_argument", "literal_prefix", "message_id", "shell_substitution",
      "source_command", "source_field", "source_msg_type", "source_read_path", "source_selector", "source_target",
      "source_text", "stderr", "transported_text"], "string")
      && optionalFieldsHaveType(event, ["shell_interpolation"], "boolean")
      && optionalIntegerFields(event, ["composite_internal_commands", "source_exit_code", "source_read_count", "stdout_documents"])
      && validResult(event.result);
  };
  const invalidActions = rawTrace.filter((event) => !validActionFields(event));
  if (invalidActions.length) {
    fail("trace_action_schema", `unrecognized or disguised trace actions: ${invalidActions.map((event) => event?.action ?? "missing").join(", ")}`);
  }
  const events = rawTrace.filter((event) => validActionFields(event));
  const tools = events.filter((event) => event.action === "tool" || event.action === "provider_write");
  const writes = events.filter((event) => event.action === "provider_write");
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
  if (Object.hasOwn(scenario, "inbox_batch") || Object.hasOwn(scenario, "effective_message_id")) {
    const correctionIssue = correctionBoundaryIssue(scenario);
    const canonicalCommand = `larkin im +messages-reply --message-id ${scenario.effective_message_id} --text 'NEW' --json`;
    const write = writes[0];
    if (correctionIssue || scenario.expected.exact_text !== "NEW"
      || scenario.expected.required_command !== canonicalCommand
      || write?.message_id !== scenario.effective_message_id || write?.command !== canonicalCommand) {
      fail("human_correction_scope", correctionIssue || "post-poll decision did not use the effective newer envelope exactly");
    }
  }
  if (scenario.expected.response_path && !events.some((event) => event.read_path === scenario.expected.response_path)) {
    fail("stable_response_path", scenario.expected.response_path);
  }
  const final = events.findLast((event) => event.action === "final");
  if (scenario.expected.visible_failure === true && final?.visible_failure !== true) fail("visible_failure", "missing");
  if (scenario.expected.reused_memory === false && final?.reused_memory !== false) fail("no_memory_fallback", "memory use was not rejected");
  if (scenario.expected.exact_source_dataflow) {
    const expected = scenario.expected.exact_source_dataflow;
    const shellSafePrefix = JSON.stringify(expected.literal_prefix).replaceAll("'", "'\\''");
    const threadTarget = /^thread:[A-Za-z0-9_-]+:([A-Za-z0-9_-]+)$/.exec(expected.source_target);
    const messageTarget = /^message:(om_[A-Za-z0-9_]+)$/.exec(expected.source_target);
    const canonicalSourceCommand = expected.source_selector === "thread" && threadTarget
      ? `larkin im +threads-messages-list --thread ${threadTarget[1]} --order desc --page-size 10 --no-reactions --jq '(first(.data.messages[] | select(.sender.sender_type == "user" and (.content | type == "string"))) // error("missing exact text source")) | {text: (${shellSafePrefix} + .content)}' --json`
      : expected.source_selector === "message" && messageTarget
        ? `larkin im +messages-mget --message-ids ${messageTarget[1]} --no-reactions --jq '(first(.data.messages[] | select(.message_id == "${messageTarget[1]}" and (.content | type == "string"))) // error("missing exact text source")) | {text: (${shellSafePrefix} + .content)}' --json`
        : null;
    const pollCommand = scenario.expected.reply_anchor?.poll_command;
    const pollTargetMatch = /^larkin inbox poll --target (chat:[A-Za-z0-9_-]+|thread:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+) --limit 1$/.exec(pollCommand || "");
    const pollTarget = pollTargetMatch?.[1] || null;
    const sourceTargetBound = expected.source_selector === "thread"
      ? pollTarget === expected.source_target
      : messageTarget !== null && pollTarget !== null;
    const pollIndex = tools.findIndex((tool) => tool.action === "tool" && tool.command === pollCommand);
    const postPollTools = pollIndex >= 0 ? tools.slice(pollIndex + 1) : [];
    const observedWrite = writes[0];
    const canonicalWriteCommand = canonicalSourceCommand
      ? `larkin im +messages-reply --message-id ${observedWrite?.message_id} --content "$(${canonicalSourceCommand})" --json`
      : null;
    const exactCompositeShape = canonicalSourceCommand !== null
      && expected.source_command === canonicalSourceCommand
      && observedWrite?.source_command === canonicalSourceCommand
      && observedWrite?.command === canonicalWriteCommand;
    const exclusiveSelector = observedWrite?.source_selector === expected.source_selector
      && exactCompositeShape
      && sourceTargetBound
      && tools.length === 2
      && pollIndex === 0
      && postPollTools.length === expected.post_poll_model_tool_calls
      && postPollTools[0] === observedWrite
      && expected.total_source_reads === 1
      && observedWrite?.composite_internal_commands === expected.composite_internal_commands
      && expected.composite_internal_commands === 2;
    if (!exclusiveSelector) {
      fail("exclusive_source_selector", "source selector switched, previewed, or exceeded the one-read/one-write composite budget");
    }
    const candidates = writes.filter((event) => event.source_command === expected.source_command
      && event.source_target === expected.source_target && event.source_read_path === expected.source_read_path);
    const event = candidates[0];
    let content = null;
    try { content = JSON.parse(event?.content_argument); } catch { /* graded below */ }
    const sourceOccurrences = event
      ? String(event.command || "").split(expected.source_command).length - 1
      : 0;
    const exactSource = typeof scenario.expected.exact_text === "string"
      && scenario.expected.exact_text.startsWith(expected.literal_prefix)
      ? scenario.expected.exact_text.slice(expected.literal_prefix.length)
      : null;
    const exactContent = content && typeof content === "object" && !Array.isArray(content)
      && Object.keys(content).length === 1 && content.text === scenario.expected.exact_text;
    const quotedSubstitution = event?.shell_substitution === "quoted"
      && String(event.command || "").includes(`--content "$(${expected.source_command})"`);
    const unsafeShell = /(?:\beval\b|\becho\b|\bmktemp\b|2>&1|\/tmp\/)/.test(String(event?.command || ""));
    const normalizedSchema = expected.source_field === "content" && event?.source_field === "content"
      && String(expected.source_command).includes(".content") && !String(expected.source_command).includes(".body");
    const safelyEmbeddedPrefix = String(expected.source_command).includes(shellSafePrefix);
    const fixedStructuralContract = expected.content_key === "text" && expected.source_read_path === "data.messages"
      && expected.source_read_count === 1 && expected.source_exit_code === 0 && expected.source_field === "content"
      && expected.shell_substitution === "quoted";
    if (!fixedStructuralContract || candidates.length !== 1 || event?.literal_prefix !== expected.literal_prefix
      || event?.source_text !== exactSource || event?.source_msg_type !== expected.source_msg_type
      || event?.source_read_path !== "data.messages" || event?.source_read_count !== 1
      || event?.source_exit_code !== 0 || sourceOccurrences !== 1 || !normalizedSchema || !safelyEmbeddedPrefix
      || !exactContent || !quotedSubstitution || unsafeShell) {
      fail("exact_source_dataflow", "exact source did not flow through one safe quoted JSON projection");
    }
  }
  if (scenario.expected.exact_text
    && !writes.some((event) => event.transported_text === scenario.expected.exact_text)) {
    fail("exact_text", "provider text changed from the exact source");
  }
  if (scenario.expected.shell_interpolation === false && writes.some((event) => event.shell_interpolation !== false)) {
    fail("shell_interpolation", "exact text used shell interpolation");
  }
  if (scenario.expected.poll_before_write === true) {
    const pollIndex = events.findIndex((event) => event.action === "tool" && String(event.command || "").startsWith("larkin inbox poll "));
    const writeIndex = events.findIndex((event) => event.action === "provider_write");
    if (pollIndex < 0 || writeIndex < 0 || pollIndex >= writeIndex) fail("poll_before_write", `${pollIndex} !< ${writeIndex}`);
  }
  if (scenario.expected.precommit_retry) {
    const expected = scenario.expected.precommit_retry;
    const precommitAttempts = events
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.action === "tool" && typeof event.subtype === "string");
    const precommit = precommitAttempts[0]?.event;
    const precommitIndex = precommitAttempts[0]?.index ?? -1;
    const writeIndex = events.findIndex((event) => event.action === "provider_write");
    const allowed = Array.isArray(expected.allowed_subtypes) ? expected.allowed_subtypes : [];
    if (precommitAttempts.length !== 1 || !precommit || precommitIndex >= writeIndex
      || !Number.isInteger(precommit.exit_code) || precommit.exit_code === 0
      || !allowed.includes(precommit.subtype) || precommit.provider_reached !== expected.provider_reached
      || (expected.same_command === true && precommit.command !== writes[0]?.command)) {
      fail("safe_precommit_retry", "retry was not proven pre-commit with the same canonical command");
    }
  }
  if (scenario.expected.stay_silent === true && events.length !== 0) fail("exclusive_silence", "excluded Agent acted");
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
