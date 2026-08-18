import fs from "node:fs";

const EVENT_KEYS = [
  "schema_version", "action", "surface", "operation", "target_flag", "target",
  "body_flag", "body", "argv", "success", "message_id", "error",
].sort();
const BODY_FLAGS = new Set(["--text", "--markdown", "--content"]);

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonempty(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
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
  nonempty(event.target, "provider write target");
  if (!BODY_FLAGS.has(event.body_flag)) throw new Error("provider write body flag mismatch");
  if (typeof event.body !== "string") throw new Error("provider write body must be a string");
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
  if (event.target_flag !== expectedTargetFlag || event.argv[0] !== "im" || event.argv[1] !== expectedCommand) {
    throw new Error("provider write argv command mismatch");
  }
  const targetIndexes = occurrences(event.argv, event.target_flag);
  const bodyIndexes = [...BODY_FLAGS].flatMap((flag) => occurrences(event.argv, flag));
  const jsonIndexes = occurrences(event.argv, "--json");
  if (targetIndexes.length !== 1 || event.argv[targetIndexes[0] + 1] !== event.target) throw new Error("provider write argv target mismatch");
  if (bodyIndexes.length !== 1 || event.argv[bodyIndexes[0]] !== event.body_flag || event.argv[bodyIndexes[0] + 1] !== event.body) {
    throw new Error("provider write argv body mismatch");
  }
  const consumed = new Set([0, 1, targetIndexes[0], targetIndexes[0] + 1,
    bodyIndexes[0], bodyIndexes[0] + 1, jsonIndexes[0]]);
  if (jsonIndexes.length !== 1 || event.argv.length !== 7 || consumed.size !== 7) {
    throw new Error("provider write argv contains missing, overlapping, or unexpected arguments");
  }
  return event;
}

function stripMarkdownLinkSpans(body) {
  return body.replace(/!?\[[^\]\r\n]*\]\([^\s)]+(?:\s+['"][^'"\r\n]*['"])?\)/g, "");
}

function hasBoundedVisibleUrl(body, expectedUrl) {
  const visible = stripMarkdownLinkSpans(body);
  let from = 0;
  for (;;) {
    const index = visible.indexOf(expectedUrl, from);
    if (index < 0) return false;
    const before = index === 0 ? "" : visible[index - 1];
    const afterIndex = index + expectedUrl.length;
    const after = afterIndex === visible.length ? "" : visible[afterIndex];
    const leftBoundary = !before || /[\s([{"'“‘<]/u.test(before);
    const rightBoundary = !after || /[\s)\]}>,.!?;:"'”’]/u.test(after);
    if (leftBoundary && rightBoundary) return true;
    from = index + 1;
  }
}

export function loadClickableLinkDeliveryEval(file) {
  const value = JSON.parse(fs.readFileSync(file, "utf8"));
  if (value.dataset !== "clickable-link-delivery" || value.version !== 1) throw new Error("eval dataset/version mismatch");
  if (value.standing_prompt_version !== "larkin-standing-v21") throw new Error("standing prompt version mismatch");
  if (value.threshold !== 1 || value.grader?.name !== "clickable-link-delivery-trace-grader"
      || value.grader.version !== 1 || value.grader.threshold !== 1) throw new Error("eval grader metadata mismatch");
  if (value.session?.initial_turns !== 0 || value.session?.fresh_per_scenario !== true) throw new Error("eval requires fresh sessions");
  if (!Array.isArray(value.grader.rubric) || value.grader.rubric.length !== 4) throw new Error("eval rubric mismatch");
  if (!Array.isArray(value.scenarios) || value.scenarios.length !== 2) throw new Error("eval requires exactly two scenarios");
  const [ordinary, exact] = value.scenarios;
  if (ordinary?.id !== "ordinary-openable-link" || ordinary.operation !== "send"
      || ordinary.target_flag !== "--chat-id" || ordinary.target !== "oc_eval_clickable"
      || ordinary.url !== "https://github.com/eddiearc/larkin/issues/115") throw new Error("ordinary scenario mismatch");
  if (exact?.id !== "exact-markdown-link-body" || exact.operation !== "reply"
      || exact.target_flag !== "--message-id" || exact.target !== "om_eval_clickable_exact"
      || exact.exact_body !== "[Issue 115](https://github.com/eddiearc/larkin/issues/115)") throw new Error("exact scenario mismatch");
  for (const scenario of value.scenarios) {
    nonempty(scenario.task, `${scenario.id}.task`);
    nonempty(scenario.prompt, `${scenario.id}.prompt`);
  }
  return value;
}

export function gradeClickableLinkDeliveryTrace(scenario, trace) {
  const failures = [];
  const fail = (rule, detail) => failures.push({ rule, detail });
  const raw = Array.isArray(trace) ? trace : [];
  const writes = raw.filter((event) => object(event) && event.action === "provider_write");
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
  if (scenario.id === "ordinary-openable-link") {
    if (!["--text", "--markdown"].includes(write.body_flag)) fail("ordinary_body_flag", "ordinary body must use --text or --markdown");
    if (!hasBoundedVisibleUrl(write.body, scenario.url)) {
      fail("visible_https_url", "complete HTTPS URL is not visible outside Markdown-link spans with URL boundaries");
    }
  } else if (scenario.id === "exact-markdown-link-body") {
    if (write.body_flag !== "--text") fail("exact_body_flag", "exact direct literal must use --text");
    if (write.body !== scenario.exact_body) fail("exact_body", "body is not byte-equal to the supplied exact body");
  } else {
    fail("scenario", "unsupported scenario");
  }
  return { passed: failures.length === 0, failures };
}

export function summarizeClickableLinkDeliveryEval(dataset, tracesById) {
  const results = dataset.scenarios.map((scenario) => ({ id: scenario.id,
    ...gradeClickableLinkDeliveryTrace(scenario, tracesById[scenario.id] || []) }));
  const passRate = results.filter((result) => result.passed).length / results.length;
  return { passed: passRate >= dataset.threshold, pass_rate: passRate, threshold: dataset.threshold, results };
}
