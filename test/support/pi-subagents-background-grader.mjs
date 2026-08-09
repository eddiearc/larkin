import fs from "node:fs";
import path from "node:path";

/**
 * pi-subagents 后台行为 rubric。
 * 输入：场景定义 + 事件流 trace（原始 pi SDK 事件，含 tool_execution_start/end、
 * agent_end、message_update 等）。
 */

export function loadPiSubagentsEval(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw.version !== 1) throw new Error("pi-subagents eval version must be 1");
  if (typeof raw.model !== "string" || !raw.model) throw new Error("eval model must be set");
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) throw new Error("eval scenarios must be non-empty");
  return {
    model: raw.model,
    scenarios: raw.scenarios.map((scenario) => {
      if (!scenario || typeof scenario !== "object") throw new Error("scenario must be an object");
      if (!scenario.id || typeof scenario.id !== "string") throw new Error("scenario.id required");
      const hasSteps = Array.isArray(scenario.steps) && scenario.steps.length > 0;
      if (!hasSteps && (!scenario.prompt || typeof scenario.prompt !== "string")) throw new Error(`scenario ${scenario.id}.prompt required`);
      if (!scenario.task_bash || typeof scenario.task_bash !== "string") throw new Error(`scenario ${scenario.id}.task_bash required`);
      if (hasSteps) {
        scenario.steps.forEach((step, index) => {
          if (!step || typeof step.prompt !== "string" || !step.prompt) throw new Error(`scenario ${scenario.id}.steps[${index}].prompt required`);
        });
      }
      if (!scenario.expectations || typeof scenario.expectations !== "object") throw new Error(`scenario ${scenario.id}.expectations required`);
      for (const key of ["uses_agent_tool", "run_in_background", "immediate_job_id", "first_turn_ends_early", "notification_received", "final_summary", "no_shell_background", "parallel_agent_calls", "prompt_order_reply", "second_message_handled_promptly", "second_message_before_a_notification"]) {
        if (scenario.expectations[key] !== undefined && typeof scenario.expectations[key] !== "boolean") throw new Error(`scenario ${scenario.id}.expectations.${key} must be boolean`);
      }
      if (scenario.expectations.min_agent_calls !== undefined
          && (!Number.isInteger(scenario.expectations.min_agent_calls) || scenario.expectations.min_agent_calls < 1)) {
        throw new Error(`scenario ${scenario.id}.expectations.min_agent_calls must be a positive integer`);
      }
      return scenario;
    }),
  };
}

const isTextDelta = (event) => event?.type === "message_update"
  && /^text/.test(String(event.assistantMessageEvent?.type || ""));

function findToolCallEvents(trace, toolName) {
  return trace.filter((event) =>
    (event?.type === "tool_execution_start" || event?.type === "tool_execution_end")
    && event.toolName === toolName);
}

export function gradePiSubagentsTrace(scenario, trace) {
  const results = {};
  const expectations = scenario.expectations;

  const agentCalls = findToolCallEvents(trace, "Agent");
  results.uses_agent_tool = agentCalls.length > 0;
  const minAgentCalls = expectations.min_agent_calls ?? 1;
  results.min_agent_calls_ok = agentCalls.length >= minAgentCalls;

  const startCall = trace.find((event) => event?.type === "tool_execution_start" && event.toolName === "Agent");
  results.run_in_background = Boolean(startCall?.args?.run_in_background === true
    || (startCall?.args && JSON.stringify(startCall.args).includes("run_in_background")));

  const endCall = trace.find((event) => event?.type === "tool_execution_end" && event.toolName === "Agent");
  const endText = endCall?.result ? JSON.stringify(endCall.result) : "";
  results.immediate_job_id = /started in background/i.test(endText) || /Agent ID: [0-9a-f-]{8,}/i.test(endText);

  // First turn must end without the agent polling get_subagent_result or running the task itself.
  const turnEvents = trace.filter((event) => event?.type === "turn_end" || event?.type === "agent_settled");
  results.first_turn_ends_early = turnEvents.length > 0
    && !trace.some((event) => event?.type === "tool_execution_start" && event.toolName === "get_subagent_result");

  results.notification_received = trace.some((event) => {
    if (event?.type !== "agent_end" || !Array.isArray(event.messages)) return false;
    return JSON.stringify(event.messages).includes("subagent-notification");
  });

  results.parallel_agent_calls = agentCalls.length >= 2;

  const assistantTexts = trace.filter(isTextDelta)
    .map((event) => String(event.assistantMessageEvent?.content || event.assistantMessageEvent?.delta || ""))
    .join(" ");
  results.prompt_order_reply = /first.*then|then.*after|先.*后|第一步.*第二步|step one.*step two|step 1.*step 2|will.*(?:reply|do|report|run).*after|per your instruction|我会.*(?:完成后|接着|再)|等.*(?:完成|结束).*(?:再|后)/i.test(assistantTexts);

  // Split the trace into turns at agent_end boundaries for multi-message scenarios.
  const turnSegments = [];
  let current = [];
  for (const event of trace) {
    current.push(event);
    if (event?.type === "agent_end") { turnSegments.push(current); current = []; }
  }
  if (current.length > 0) turnSegments.push(current);
  const turnText = (segment) => segment.filter(isTextDelta)
    .map((event) => String(event.assistantMessageEvent?.content || event.assistantMessageEvent?.delta || ""))
    .join(" ");

  const wholeText = turnSegments.map(turnText).join(" ");
  console.error("[dep-txt]", scenario.id, JSON.stringify(wholeText.slice(-300)));
  results.second_message_handled_promptly = turnSegments.length >= 1
    && /b-done|\+b|\+dep|busy-b|second task|第二/i.test(wholeText);

  const notificationTurnIndex = trace.findIndex((event) => {
    if (event?.type !== "agent_end" || !Array.isArray(event.messages)) return false;
    return JSON.stringify(event.messages).includes("subagent-notification");
  });
  const notificationSegmentIndex = turnSegments.findIndex((segment) => segment.some((event) => event === trace[notificationTurnIndex]));
  results.second_message_before_a_notification = notificationSegmentIndex > 1 || notificationTurnIndex === -1;

  const bashCalls = trace.filter((event) => event?.type === "tool_execution_start" && event.toolName === "bash");
  results.no_shell_background = !bashCalls.some((event) => {
    const cmd = JSON.stringify(event.args || "");
    return /nohup|disown|(?<!&)&(?!&)\s*(?:echo|sh|sleep)|>\s*\/tmp\.*out/i.test(cmd);
  });

  const summaryText = trace.filter(isTextDelta)
    .map((event) => String(event.assistantMessageEvent?.content || event.assistantMessageEvent?.delta || ""))
    .join(" ");
  results.final_summary = /completed|result|output/i.test(summaryText)
    && summaryText.includes(scenario.task_bash.split(" ").pop().replace(/[^a-z0-9-]/gi, ""));

  const resultsWithMin = { ...results, min_agent_calls_ok: results.min_agent_calls_ok };
  const passed = Object.keys(expectations).every((key) => {
    if (key === "min_agent_calls") return resultsWithMin.min_agent_calls_ok === true;
    return resultsWithMin[key] === expectations[key];
  });
  return { passed, results, expectations };
}

export function summarizePiSubagentsEval(results) {
  const passed = results.filter((result) => result.passed).length;
  return { passed, total: results.length, rate: passed / results.length };
}
