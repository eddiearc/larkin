import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";
import {
  gradeClickableLinkDeliveryTrace,
  loadClickableLinkDeliveryEval,
  summarizeClickableLinkDeliveryEval,
} from "../../support/clickable-link-delivery-grader.mjs";
import {
  CLICKABLE_LINK_V20_GUIDANCE,
  gradeNativeCommandAudit,
  isolatedNativeEnv,
  v19Counterfactual,
} from "../../support/clickable-link-delivery-native-support.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DATASET = loadClickableLinkDeliveryEval(path.join(ROOT, "evals/clickable-link-delivery/scenarios.json"));
const FAKE = path.join(ROOT, "test/support/clickable-link-delivery-eval-cli.mjs");
const [ORDINARY, EXACT] = DATASET.scenarios;

function writeEvent(scenario, bodyFlag, body, overrides = {}) {
  const command = scenario.operation === "send" ? "+messages-send" : "+messages-reply";
  const targetFlag = overrides.target_flag ?? scenario.target_flag;
  const target = overrides.target ?? scenario.target;
  const event = {
    schema_version: 1,
    action: "provider_write",
    surface: "larkin",
    operation: scenario.operation,
    target_flag: targetFlag,
    target,
    body_flag: bodyFlag,
    body,
    argv: ["im", command, targetFlag, target, bodyFlag, body, "--json"],
    success: true,
    message_id: "om_eval_clickable_unit",
    error: null,
    ...overrides,
  };
  return event;
}

function runFake(args, surface = "larkin") {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clickable-eval-cli-"));
  const traceFile = path.join(temp, "trace.ndjson");
  fs.writeFileSync(traceFile, "", { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, [FAKE, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, CLICKABLE_EVAL_TRACE_FILE: traceFile, CLICKABLE_EVAL_SURFACE: surface },
    });
    const trace = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    return { result, trace };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test("clickable-link delivery dataset is fixed, fresh, versioned, and thresholded", () => {
  assert.equal(DATASET.dataset, "clickable-link-delivery");
  assert.equal(DATASET.version, 1);
  assert.equal(DATASET.standing_prompt_version, "larkin-standing-v25");
  assert.equal(DATASET.threshold, 1);
  assert.equal(DATASET.session.initial_turns, 0);
  assert.equal(DATASET.session.fresh_per_scenario, true);
  assert.deepEqual(DATASET.scenarios.map(({ id }) => id), ["ordinary-openable-link", "exact-markdown-link-body"]);
  assert.equal(DATASET.scenarios.length, 2);
});

test("golden structured provider writes pass both payload behaviors", () => {
  const ordinary = writeEvent(ORDINARY, "--markdown", `Issue 115: ${ORDINARY.url}`);
  const exact = writeEvent(EXACT, "--text", EXACT.exact_body);
  assert.deepEqual(gradeClickableLinkDeliveryTrace(ORDINARY, [ordinary]), { passed: true, failures: [] });
  assert.deepEqual(gradeClickableLinkDeliveryTrace(EXACT, [exact]), { passed: true, failures: [] });
  assert.equal(summarizeClickableLinkDeliveryEval(DATASET, {
    [ORDINARY.id]: [ordinary], [EXACT.id]: [exact],
  }).passed, true);
});

test("26 adversarial payload/trace mutations fail closed", () => {
  const ordinaryGolden = writeEvent(ORDINARY, "--markdown", `Issue 115: ${ORDINARY.url}`);
  const exactGolden = writeEvent(EXACT, "--text", EXACT.exact_body);
  const malformed = { ...ordinaryGolden, injected_prompt: ORDINARY.prompt };
  const missingField = { ...ordinaryGolden }; delete missingField.error;
  const extraArgv = { ...ordinaryGolden, argv: [...ordinaryGolden.argv, "--profile"] };
  const argvMismatch = { ...ordinaryGolden, argv: [...ordinaryGolden.argv] };
  argvMismatch.argv[argvMismatch.argv.indexOf("--markdown") + 1] = "different body";
  const unsuccessful = { ...ordinaryGolden, success: false, message_id: null, error: "rejected" };
  const wrongOperation = writeEvent(EXACT, "--text", EXACT.exact_body);
  const adversarial = [
    ["ordinary missing", ORDINARY, []],
    ["ordinary assistant output only", ORDINARY, [{ action: "assistant_output", text: ORDINARY.url }]],
    ["ordinary label only", ORDINARY, [writeEvent(ORDINARY, "--markdown", `[Issue 115](${ORDINARY.url})`)]],
    ["ordinary truncated", ORDINARY, [writeEvent(ORDINARY, "--markdown", "https://github.com/eddiearc/larkin/issues/11")]],
    ["ordinary http", ORDINARY, [writeEvent(ORDINARY, "--markdown", ORDINARY.url.replace("https://", "http://"))]],
    ["ordinary left boundary", ORDINARY, [writeEvent(ORDINARY, "--markdown", `x${ORDINARY.url}`)]],
    ["ordinary right boundary", ORDINARY, [writeEvent(ORDINARY, "--markdown", `${ORDINARY.url}x`)]],
    ["ordinary Markdown span", ORDINARY, [writeEvent(ORDINARY, "--markdown", `See [link](${ORDINARY.url}) now`)]],
    ["ordinary duplicate", ORDINARY, [ordinaryGolden, ordinaryGolden]],
    ["ordinary wrong target", ORDINARY, [writeEvent(ORDINARY, "--markdown", ORDINARY.url, { target: "oc_eval_other",
      argv: ["im", "+messages-send", "--chat-id", "oc_eval_other", "--markdown", ORDINARY.url, "--json"] })]],
    ["ordinary wrong operation", ORDINARY, [wrongOperation]],
    ["ordinary unsuccessful", ORDINARY, [unsuccessful]],
    ["ordinary content flag", ORDINARY, [writeEvent(ORDINARY, "--content", JSON.stringify({ text: ORDINARY.url }))]],
    ["ordinary extra trace field", ORDINARY, [malformed]],
    ["ordinary missing trace field", ORDINARY, [missingField]],
    ["ordinary unexpected argv", ORDINARY, [extraArgv]],
    ["ordinary argv/body mismatch", ORDINARY, [argvMismatch]],
    ["ordinary prompt text only", ORDINARY, [{ action: "tool", prompt: ORDINARY.prompt, body: ORDINARY.url }]],
    ["exact markdown flag", EXACT, [writeEvent(EXACT, "--markdown", EXACT.exact_body)]],
    ["exact prefix", EXACT, [writeEvent(EXACT, "--text", `See ${EXACT.exact_body}`)]],
    ["exact suffix", EXACT, [writeEvent(EXACT, "--text", `${EXACT.exact_body}.`)]],
    ["exact injected URL", EXACT, [writeEvent(EXACT, "--text", `${EXACT.exact_body} ${ORDINARY.url}`)]],
    ["exact newline", EXACT, [writeEvent(EXACT, "--text", `${EXACT.exact_body}\n`)]],
    ["exact wrong target", EXACT, [writeEvent(EXACT, "--text", EXACT.exact_body, { target: "om_eval_other",
      argv: ["im", "+messages-reply", "--message-id", "om_eval_other", "--text", EXACT.exact_body, "--json"] })]],
    ["exact duplicate", EXACT, [exactGolden, exactGolden]],
    ["exact missing", EXACT, []],
  ];
  assert.equal(adversarial.length, 26);
  for (const [label, scenario, trace] of adversarial) {
    assert.equal(gradeClickableLinkDeliveryTrace(scenario, trace).passed, false, label);
  }
});

test("fake sink accepts only the two synthetic writes and emits gradeable argv/body traces", () => {
  const ordinaryArgs = ["im", "+messages-send", "--chat-id", ORDINARY.target, "--markdown", `Issue 115: ${ORDINARY.url}`, "--json"];
  const ordinary = runFake(ordinaryArgs);
  assert.equal(ordinary.result.status, 0, ordinary.result.stderr);
  assert.equal(gradeClickableLinkDeliveryTrace(ORDINARY, ordinary.trace).passed, true);
  const exactArgs = ["im", "+messages-reply", "--message-id", EXACT.target, "--text", EXACT.exact_body, "--json"];
  const exact = runFake(exactArgs);
  assert.equal(exact.result.status, 0, exact.result.stderr);
  assert.equal(gradeClickableLinkDeliveryTrace(EXACT, exact.trace).passed, true);
  assert.notEqual(runFake(ordinaryArgs.toSpliced(3, 1, "oc_real_or_other")).result.status, 0);
  assert.notEqual(runFake(ordinaryArgs, "lark-cli").result.status, 0);
  assert.notEqual(runFake(["im", "+chat-list", "--json"]).result.status, 0);
});

test("fake sink has no provider/runtime import or process invocation surface", () => {
  const source = fs.readFileSync(FAKE, "utf8");
  assert.doesNotMatch(source, /node:child_process|@larksuite|from ["'][^"']*(?:dist|src)\//);
  assert.doesNotMatch(source, /\b(?:spawn|execFile|exec|fork)\s*\(/);
  assert.match(source, /synthetic: true/);
});

test("v19 counterfactual removes exactly the two v20 lines and restores version/hash in memory", () => {
  const v20 = new ContextPromptBuilder().build({ agentId: "cli_clickableEvalA1", name: "Clickable Eval", runtime: "codex" });
  for (const line of CLICKABLE_LINK_V20_GUIDANCE) assert.equal(v20.content.split(line).length - 1, 1);
  const v19 = v19Counterfactual(v20);
  assert.equal(v19.version, "larkin-standing-v19");
  assert.match(v19.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(v19.hash, v20.hash);
  assert.equal(v20.content.split("\n").length - v19.content.split("\n").length, 2);
  for (const line of CLICKABLE_LINK_V20_GUIDANCE) assert.equal(v19.content.includes(line), false);
});

test("native eval environment and command audit fail closed around the fake sink", () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "clickable-native-isolation-"));
  try {
    const binDir = path.join(temp, "bin");
    const codexHome = path.join(temp, "codex-home");
    fs.mkdirSync(binDir, { recursive: true }); fs.mkdirSync(codexHome);
    const env = isolatedNativeEnv({ HOME: temp, CODEX_HOME: codexHome, LARK_TEST_VALUE: "fixture", FEISHU_TEST_VALUE: "fixture" }, {
      temp, binDir, codexCommand: "/usr/bin/false", traceFile: path.join(temp, "trace.ndjson"),
    });
    assert.equal(Object.entries(env).some(([key, value]) => /^(?:LARK|FEISHU)/i.test(key) && value !== undefined), false);
    assert.equal(fs.existsSync(path.join(env.HOME, ".larkin")), false);
    const fakeLarkin = path.join(binDir, "larkin"); const fakeLarkCli = path.join(binDir, "lark-cli");
    assert.equal(gradeNativeCommandAudit([{ item_type: "commandExecution", command: `/bin/zsh -lc '${fakeLarkin} im +messages-send'`, exit_code: 0 }],
      fakeLarkin, fakeLarkCli).passed, true);
    assert.equal(gradeNativeCommandAudit([{ item_type: "commandExecution", command: "lark-cli im +messages-send", exit_code: 0 }],
      fakeLarkin, fakeLarkCli).passed, false);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
