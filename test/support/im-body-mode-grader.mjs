import { createHash } from "node:crypto";
import fs from "node:fs";

export const PLAIN_MULTILINE_V27_GUIDANCE = [
  "For ordinary plain-text message bodies, use `--text`, including brief one-line replies, multiline status lines, and paragraphs. Use `--markdown` only when you intentionally need Markdown rendering, such as headings, lists, emphasis, blockquotes, fenced code, or Markdown links.",
  "Use native `--text` for ordinary plain text and for verbatim preservation, such as logs, literal code, or exact whitespace. Both `--markdown` and `--text` remain supported in the Larkin Runtime.",
  "An explicit exact or verbatim direct literal uses `--text` and overrides the ordinary-body guidance.",
];

const V26_GUIDANCE = [
  "For regular textual message bodies, default to `--markdown`, including brief single-line replies, so Feishu renders Markdown structure instead of showing its markers literally.",
  "Use native `--text` only when plain text or verbatim preservation is explicitly needed, such as logs, code, or exact whitespace. Both `--markdown` and `--text` remain supported in the Larkin Runtime.",
  "An explicit exact or verbatim direct literal uses `--text` and overrides the regular markdown default.",
];

const EVENT_KEYS = [
  "schema_version", "action", "surface", "operation", "target_flag", "target",
  "body_flag", "body", "argv", "success", "message_id", "error",
].sort();
const BODY_FLAGS = new Set(["--text", "--markdown", "--content"]);
const SCENARIO_IDS = [
  "ordinary-plain-lines", "ordinary-plain-paragraphs", "intentional-markdown-heading",
  "intentional-markdown-list", "intentional-markdown-code", "intentional-markdown-link",
  "exact-verbatim-literal",
];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} fields mismatch`);
  }
}

function occurrences(argv, flag) {
  return argv.reduce((indexes, value, index) => value === flag ? [...indexes, index] : indexes, []);
}

function validateProviderWrite(event) {
  if (!object(event)) throw new Error("provider write must be an object");
  exactKeys(event, EVENT_KEYS, "provider write");
  if (event.schema_version !== 1 || event.action !== "provider_write") throw new Error("provider write identity mismatch");
  if (!["larkin", "lark-cli"].includes(event.surface)) throw new Error("provider write surface mismatch");
  if (!["send", "reply"].includes(event.operation)) throw new Error("provider write operation mismatch");
  if (!["--chat-id", "--message-id"].includes(event.target_flag)) throw new Error("provider write target flag mismatch");
  if (typeof event.target !== "string" || !event.target) throw new Error("provider write target mismatch");
  if (!BODY_FLAGS.has(event.body_flag) || typeof event.body !== "string") throw new Error("provider write body mismatch");
  if (!Array.isArray(event.argv) || event.argv.some((part) => typeof part !== "string")) throw new Error("provider write argv mismatch");
  if (typeof event.success !== "boolean") throw new Error("provider write success mismatch");
  if (event.success ? !/^om_eval_[A-Za-z0-9_]+$/.test(event.message_id || "") : event.message_id !== null) {
    throw new Error("provider write message_id mismatch");
  }
  if (event.success ? event.error !== null : typeof event.error !== "string" || !event.error) {
    throw new Error("provider write error mismatch");
  }
  const expectedCommand = event.operation === "send" ? "+messages-send" : "+messages-reply";
  const expectedTargetFlag = event.operation === "send" ? "--chat-id" : "--message-id";
  const targetIndexes = occurrences(event.argv, event.target_flag);
  const bodyIndexes = [...BODY_FLAGS].flatMap((flag) => occurrences(event.argv, flag));
  const jsonIndexes = occurrences(event.argv, "--json");
  if (event.target_flag !== expectedTargetFlag || event.argv[0] !== "im" || event.argv[1] !== expectedCommand) {
    throw new Error("provider write argv command mismatch");
  }
  if (targetIndexes.length !== 1 || event.argv[targetIndexes[0] + 1] !== event.target) throw new Error("provider write argv target mismatch");
  if (bodyIndexes.length !== 1 || event.argv[bodyIndexes[0]] !== event.body_flag || event.argv[bodyIndexes[0] + 1] !== event.body) {
    throw new Error("provider write argv body mismatch");
  }
  const consumed = new Set([0, 1, targetIndexes[0], targetIndexes[0] + 1, bodyIndexes[0], bodyIndexes[0] + 1, jsonIndexes[0]]);
  if (jsonIndexes.length !== 1 || event.argv.length !== 7 || consumed.size !== 7) {
    throw new Error("provider write argv contains missing, overlapping, or unexpected arguments");
  }
  return event;
}

export function loadImBodyModeEval(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.dataset !== "im-body-mode" || value.version !== 1 || value.standing_prompt_version !== "larkin-standing-v27") {
    throw new Error("eval dataset/version mismatch");
  }
  if (value.threshold !== 1 || value.grader?.name !== "im-body-mode-final-payload-grader" || value.grader.version !== 1 || value.grader.threshold !== 1) {
    throw new Error("eval grader metadata mismatch");
  }
  if (value.session?.initial_turns !== 0 || value.session?.fresh_per_scenario !== true || !Array.isArray(value.grader.rubric) || value.grader.rubric.length !== 5) {
    throw new Error("eval session/rubric mismatch");
  }
  if (!Array.isArray(value.scenarios) || value.scenarios.length !== SCENARIO_IDS.length
      || value.scenarios.map((scenario) => scenario.id).some((id, index) => id !== SCENARIO_IDS[index])) {
    throw new Error("eval scenarios mismatch");
  }
  for (const scenario of value.scenarios) {
    const expectedOperation = scenario.operation === "send" ? "--chat-id" : scenario.operation === "reply" ? "--message-id" : "";
    if (scenario.target_flag !== expectedOperation || typeof scenario.target !== "string" || !scenario.target
        || !["--text", "--markdown"].includes(scenario.expected_body_flag)
        || typeof scenario.body !== "string" || !scenario.body || typeof scenario.prompt !== "string" || !scenario.prompt) {
      throw new Error(`${scenario.id} shape mismatch`);
    }
  }
  return value;
}

export function gradeImBodyModeTrace(scenario, trace) {
  const failures = [];
  const fail = (rule, detail) => failures.push({ rule, detail });
  const writes = (Array.isArray(trace) ? trace : []).filter((event) => object(event) && event.action === "provider_write");
  const validated = [];
  for (const [index, write] of writes.entries()) {
    try { validated.push(validateProviderWrite(write)); }
    catch (error) { fail("trace_schema", `write ${index + 1}: ${error.message}`); }
  }
  if (writes.length !== 1) fail("write_count", `expected exactly one provider write, observed ${writes.length}`);
  const successful = validated.filter((event) => event.success);
  if (successful.length !== 1) fail("successful_write_count", `expected exactly one successful write, observed ${successful.length}`);
  const write = successful.length === 1 ? successful[0] : null;
  if (!write) return { passed: false, failures };
  if (write.surface !== "larkin") fail("surface", "write must use the PATH-shadowed larkin surface");
  if (write.operation !== scenario.operation || write.target_flag !== scenario.target_flag || write.target !== scenario.target) {
    fail("target", "write did not reach the expected synthetic operation and target");
  }
  if (write.body_flag !== scenario.expected_body_flag) fail("body_flag", `expected ${scenario.expected_body_flag}, observed ${write.body_flag}`);
  if (write.body !== scenario.body) fail("body", "final provider body is not byte-equal to the fixed scenario body");
  return { passed: failures.length === 0, failures };
}

export function summarizeImBodyModeEval(dataset, tracesById) {
  const results = dataset.scenarios.map((scenario) => ({ id: scenario.id,
    ...gradeImBodyModeTrace(scenario, tracesById[scenario.id] || []) }));
  const passRate = results.filter((result) => result.passed).length / results.length;
  return { passed: passRate >= dataset.threshold, pass_rate: passRate, threshold: dataset.threshold, results };
}

export function v26PlainMultilineCounterfactual(standingPrompt) {
  if (standingPrompt?.version !== "larkin-standing-v27" || typeof standingPrompt.content !== "string") {
    throw new Error("v26 counterfactual requires a v27 standing prompt");
  }
  let content = standingPrompt.content;
  for (let index = 0; index < PLAIN_MULTILINE_V27_GUIDANCE.length; index += 1) {
    const guidance = PLAIN_MULTILINE_V27_GUIDANCE[index];
    const count = content.split(guidance).length - 1;
    if (count !== 1 || !content.includes(`${guidance}\n`)) throw new Error("v27 multiline guidance must occur exactly once");
    content = content.replace(`${guidance}\n`, `${V26_GUIDANCE[index]}\n`);
  }
  if (PLAIN_MULTILINE_V27_GUIDANCE.some((guidance) => content.includes(guidance)) || V26_GUIDANCE.some((guidance) => !content.includes(guidance))) {
    throw new Error("v26 counterfactual guidance mismatch");
  }
  return { version: "larkin-standing-v26", content, hash: createHash("sha256").update(content).digest("hex") };
}
