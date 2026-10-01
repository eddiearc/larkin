import fs from "node:fs";

export function loadAuthoritativeFreshnessEval(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.dataset !== "authoritative-freshness-gate" || value.version !== 1) throw new Error("eval dataset/version mismatch");
  if (value.standing_prompt_version !== "larkin-standing-v34") throw new Error("standing prompt version mismatch");
  if (value.runtime?.adapter !== "codex" || !value.runtime.selection) throw new Error("native runtime metadata is required");
  if (value.grader?.name !== "authoritative-freshness-trace-grader" || value.grader.version !== 1) throw new Error("grader metadata mismatch");
  if (!(value.grader.threshold > 0 && value.grader.threshold <= 1)) throw new Error("grader threshold must be in (0,1]");
  if (!Array.isArray(value.grader.rubric) || value.grader.rubric.length < 5) throw new Error("grader rubric is incomplete");
  const modelScenario = value.scenarios?.find((scenario) => scenario.id === "model-conflict-redecision");
  if (typeof modelScenario?.prompt !== "string" || !modelScenario.prompt.trim()) throw new Error("native model scenario prompt is required");
  if (!modelScenario.prompt.includes("{larkin}")) throw new Error("native model scenario must bind the controlled larkin executable");
  return value;
}

export function gradeConflictRedecision(trace) {
  const failures = [];
  const writes = trace.filter((event) => event.action === "provider_write");
  const notice = trace.find((event) => event.action === "freshness_notice");
  if (writes.length !== 1 || writes[0].intent !== "stale" || !["+messages-send", "+messages-reply"].includes(writes[0].command)) {
    failures.push("exactly one ordinary provider write is required");
  }
  if (!notice || notice.target !== "feishu.im/chat/oc_eval_freshness" || notice.newer_messages !== 1) {
    failures.push("a post-write freshness notice is required");
  }
  if (trace.some((event) => event.action === "draft" || event.action === "manual_cursor" || event.action === "file_state")) {
    failures.push("draft/manual cursor/file-state bypass is forbidden");
  }
  if (trace.indexOf(notice) <= trace.indexOf(writes[0])) failures.push("freshness notice must follow the provider write");
  return { passed: failures.length === 0, failures };
}

export function gradeNativeCommandAudit(audit, controlledExecutable) {
  const failures = [];
  if (!Array.isArray(audit) || audit.length !== 1) failures.push(`exactly one command execution is required; got ${audit?.length ?? "invalid"}`);
  const expectedExitCodes = [0];
  for (const [index, event] of (Array.isArray(audit) ? audit : []).entries()) {
    if (event.item_type !== "commandExecution") failures.push(`audit item ${index} was an extra non-command tool action`);
    const command = typeof event.command === "string" ? event.command : "";
    if (command.split(controlledExecutable).length - 1 !== 1) failures.push(`command ${index} did not bind exactly one controlled executable`);
    if (/(^|[\s"'])lark-cli(?:[\s"']|$)/.test(command)) failures.push(`command ${index} bypassed larkin with bare lark-cli`);
    if (!command.includes(" im +messages-send --chat-id oc_eval_freshness --text ")) failures.push(`command ${index} was not the allowed ordinary send`);
    if (/[;<>\n]|&&|\|\||\$\(/.test(command)) failures.push(`command ${index} contained extra shell operations`);
    if (/larkin-draft|freshness-state|cursor|\b(?:cat|sed|awk|grep|rg|jq|python|node)\b/i.test(command)) {
      failures.push(`command ${index} attempted forbidden draft/file/cursor tooling`);
    }
    if (event.exit_code !== expectedExitCodes[index]) failures.push(`command ${index} exit code mismatch`);
  }
  return { passed: failures.length === 0, failures };
}
