import fs from "node:fs";
import path from "node:path";

/**
 * pi bash 60s 超时护栏 rubric（issue #55/#56）。
 * 输入：场景定义 + 事件流 trace（含 tool_execution_start/end、agent_end），
 * 以及 bash 调用实测时长（毫秒，供"不阻塞回合"断言）。
 */

export function loadPiBashTimeoutEval(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  if (raw.version !== 1) throw new Error("pi-bash-timeout eval version must be 1");
  if (typeof raw.model !== "string" || !raw.model) throw new Error("eval model must be set");
  if (!Array.isArray(raw.scenarios) || raw.scenarios.length === 0) throw new Error("eval scenarios must be non-empty");
  return {
    model: raw.model,
    scenarios: raw.scenarios.map((scenario) => {
      if (!scenario || typeof scenario !== "object") throw new Error("scenario must be an object");
      if (!scenario.id || typeof scenario.id !== "string") throw new Error("scenario.id required");
      if (!scenario.prompt || typeof scenario.prompt !== "string") throw new Error(`scenario ${scenario.id}.prompt required`);
      if (!scenario.task_bash || typeof scenario.task_bash !== "string") throw new Error(`scenario ${scenario.id}.task_bash required`);
      if (!scenario.expectations || typeof scenario.expectations !== "object") throw new Error(`scenario ${scenario.id}.expectations required`);
      for (const key of ["uses_bash", "uses_agent_tool", "bash_timed_out", "bash_timeout_bounded", "bash_rejected_oversize", "no_bash_oversize_timeout", "steered_to_subagent", "run_in_background", "max_command_wait_seconds", "no_foreground_retry_loop", "turn_completed"]) {
        if (scenario.expectations[key] !== undefined && typeof scenario.expectations[key] !== "boolean") {
          throw new Error(`scenario ${scenario.id}.expectations.${key} must be boolean`);
        }
      }
      if (scenario.expectations.min_agent_calls !== undefined
          && (!Number.isInteger(scenario.expectations.min_agent_calls) || scenario.expectations.min_agent_calls < 1)) {
        throw new Error(`scenario ${scenario.id}.expectations.min_agent_calls must be a positive integer`);
      }
      if (scenario.expectations.max_bash_duration_s !== undefined
          && (typeof scenario.expectations.max_bash_duration_s !== "number" || scenario.expectations.max_bash_duration_s <= 0)) {
        throw new Error(`scenario ${scenario.id}.expectations.max_bash_duration_s must be a positive number`);
      }
      return scenario;
    }),
  };
}

export function gradePiBashTimeoutTrace(scenario, trace, bashRuns = []) {
  const results = {};
  const expectations = scenario.expectations;

  const bashStarts = trace.filter((event) => event?.type === "tool_execution_start" && event.toolName === "bash");
  const bashEnds = trace.filter((event) => event?.type === "tool_execution_end" && event.toolName === "bash");
  const agentStarts = trace.filter((event) => event?.type === "tool_execution_start" && event.toolName === "Agent");

  results.uses_bash = bashStarts.length > 0;
  results.uses_agent_tool = agentStarts.length > 0;
  results.min_agent_calls_ok = agentStarts.length >= (expectations.min_agent_calls ?? 1);
  results.run_in_background = agentStarts.some((event) =>
    Boolean(event?.args && JSON.stringify(event.args).includes("run_in_background")));
  results.max_command_wait_seconds = agentStarts.some((event) =>
    Boolean(event?.args && JSON.stringify(event.args).includes("max_command_wait_seconds")));

  // bashRuns: 每次 bash 调用的 {durationMs, isError, resultText}。
  const runs = Array.isArray(bashRuns) ? bashRuns : [];
  // 1) 跑满后超时：isError 且含 "timed out after"，且时长有界（确实跑了但被掐断）。
  const timedOutRun = runs.find((run) => run?.isError && /timed out after/i.test(run.resultText || ""));
  results.bash_timed_out = Boolean(timedOutRun);
  const maxBashDurationMs = expectations.max_bash_duration_s !== undefined
    ? expectations.max_bash_duration_s * 1000 : 15_000;
  const maxSeen = runs.length > 0 ? Math.max(...runs.map((run) => run.durationMs)) : 0;
  results.bash_timeout_bounded = runs.length > 0 && maxSeen <= maxBashDurationMs;

  // 2) 超上限即拒绝（模型显式传 timeout > 上限）：isError 且含 "exceeds the ... hard limit"，
  //    且时长极短（没有真的跑长命令）。
  const rejectedRun = runs.find((run) =>
    run?.isError && /exceeds the .*foreground hard limit/i.test(run.resultText || ""));
  results.bash_rejected_oversize = Boolean(rejectedRun)
    && (rejectedRun.durationMs === undefined || rejectedRun.durationMs < 3_000);
  // 模型从未尝试给 bash 传 >上限 的 timeout（prompt 约束生效，避免触发拒绝路径）。
  results.no_bash_oversize_timeout = !results.bash_rejected_oversize;

  // 超时后模型改用后台 subagent（Agent 工具）而非前台重试。
  const timeoutEnd = bashEnds.find((event) =>
    event?.isError === true && /timed out after/i.test(String(event.result ? JSON.stringify(event.result) : "")));
  const rejectionEnd = bashEnds.find((event) =>
    event?.isError === true && /exceeds the .*foreground hard limit/i.test(String(event.result ? JSON.stringify(event.result) : "")));
  const triggerIndex = (rejectionEnd || timeoutEnd) ? trace.indexOf(rejectionEnd || timeoutEnd) : -1;
  const agentAfterTrigger = agentStarts.find((event) => trace.indexOf(event) > triggerIndex);
  results.steered_to_subagent = Boolean(agentAfterTrigger);

  // 不无限前台重试长命令：bash 调用次数受控（<= 3）。
  results.no_foreground_retry_loop = bashStarts.length <= 3;

  results.turn_completed = trace.some((event) => event?.type === "agent_end");

  const resultsWithMin = { ...results, min_agent_calls_ok: results.min_agent_calls_ok };
  const passed = Object.keys(expectations).every((key) => {
    if (key === "min_agent_calls") return resultsWithMin.min_agent_calls_ok === true;
    return resultsWithMin[key] === expectations[key];
  });
  return { passed, results, expectations };
}

export function summarizePiBashTimeoutEval(results) {
  const passed = results.filter((result) => result.passed).length;
  return { passed, total: results.length, rate: passed / results.length };
}
