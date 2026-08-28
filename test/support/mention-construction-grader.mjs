import fs from "node:fs";

function nonempty(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

export function loadMentionConstructionEval(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.dataset !== "mention-construction" || value.version !== 1) throw new Error("eval dataset/version mismatch");
  if (value.standing_prompt_version !== "larkin-standing-v25") throw new Error("standing prompt version mismatch");
  if (value.session?.initial_turns !== 0) throw new Error("eval scenarios must start from a fresh empty session");
  if (value.grader?.name !== "mention-construction-trace-grader" || value.grader.version !== 1 || value.grader.threshold !== 1) {
    throw new Error("eval grader metadata mismatch");
  }
  if (!Array.isArray(value.grader.rubric) || value.grader.rubric.length < 4) throw new Error("eval rubric is incomplete");
  if (!Array.isArray(value.scenarios) || value.scenarios.length !== 1) throw new Error("eval requires exactly one scenario");
  const scenario = value.scenarios[0];
  if (scenario.id !== "wake-other-agent-with-real-mention") throw new Error("eval scenario id mismatch");
  nonempty(scenario.task, "scenario.task");
  nonempty(scenario.prompt, "scenario.prompt");
  if (typeof scenario.target_open_id !== "string" || !/^ou_[A-Za-z0-9_]+$/.test(scenario.target_open_id)) {
    throw new Error("scenario.target_open_id must be a valid ou_ open_id");
  }
  if (typeof scenario.target_chat_id !== "string" || !/^oc_[A-Za-z0-9_-]+$/.test(scenario.target_chat_id)) {
    throw new Error("scenario.target_chat_id must be a valid oc_ chat id");
  }
  return value;
}

export function gradeMentionConstructionTrace(scenario, trace) {
  const failures = [];
  const fail = (rule, detail) => failures.push({ rule, detail });
  const target = scenario.target_open_id;
  const targetChat = scenario.target_chat_id;
  const rawTrace = Array.isArray(trace) ? trace : [];
  const events = rawTrace.filter((event) => event && typeof event === "object" && !Array.isArray(event));
  // 模型执行的 send/reply 命令：活体 eval 由 fake CLI 记录为 provider_write 事件，
  // 也兼容 agent-experience-v6 风格的 tool 事件（command 含 +messages-send/reply）。
  const writes = events.filter((event) => event.action === "provider_write"
    || (event.action === "tool" && /(?:^|\s)im \+messages-(?:send|reply)\b/.test(String(event.command || ""))));
  const realAtText = new RegExp(`<at user_id=["']${target}["']`);
  const realAtPost = new RegExp(`\\{"tag"\\s*:\\s*"at"[^}]*"user_id"\\s*:\\s*"${target}"\\}`);
  const contentOf = (event) => {
    if (typeof event.content_argument === "string" && event.content_argument) return event.content_argument;
    if (typeof event.content === "string" && event.content) return event.content;
    return String(event.command || "");
  };
  // 合法 JSON 里 at 属性引号带 \ 转义（shell 单引号内原样保留）；两种写法都算真实 mention 元素。
  const hasRealAt = (event) => {
    const normalized = contentOf(event).replaceAll("\\", "");
    return realAtText.test(normalized) || realAtPost.test(normalized);
  };
  const commandOf = (event) => String(event.command || "");
  const targetedWrites = writes.filter((event) => {
    const content = contentOf(event);
    return content.includes(target) || commandOf(event).includes(target);
  });
  if (writes.length === 0) {
    fail("provider_write_count", "no send/reply command reached the provider");
    fail("real_mention", "no message was sent to the target Agent");
    return { passed: false, failures };
  }
  for (const event of targetedWrites) {
    const content = contentOf(event);
    const command = commandOf(event);
    const wrongChat = command.includes("--chat-id")
      && !command.includes(`--chat-id ${targetChat} `) && !command.includes(`--chat-id ${targetChat}`);
    if (wrongChat) {
      fail("target_chat", "message was not sent to the partner chat oc_eval_partner_group");
      continue;
    }
    if (hasRealAt(event)) {
      continue; // 这一条是真实 mention 元素，通过。
    }
    if (content.includes("@") || content.includes(target)) {
      fail("real_mention", `plain-text @ without a real at element does not wake the target: ${command.slice(0, 200)}`);
    }
  }
  if (!targetedWrites.some(hasRealAt)) {
    fail("real_mention", "no message embedded a real Feishu mention element with the target open_id");
  }
  if (writes.some((event) => !targetedWrites.includes(event))) {
    fail("target_open_id", "a send/reply did not reference the target open_id at all");
  }
  return { passed: failures.length === 0, failures };
}

export function summarizeMentionConstructionEval(dataset, tracesById) {
  const results = dataset.scenarios.map((scenario) => ({ id: scenario.id,
    ...gradeMentionConstructionTrace(scenario, tracesById[scenario.id] || []) }));
  const passRate = results.filter((result) => result.passed).length / results.length;
  return { passed: passRate >= dataset.grader.threshold, pass_rate: passRate, threshold: dataset.grader.threshold, results };
}
