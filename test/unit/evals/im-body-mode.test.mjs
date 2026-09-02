import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";
import { ContextPromptBuilder } from "../../../dist/agent/context-prompt.mjs";
import {
  PLAIN_MULTILINE_V27_GUIDANCE,
  gradeImBodyModeTrace,
  loadImBodyModeEval,
  summarizeImBodyModeEval,
  v26PlainMultilineCounterfactual,
} from "../../support/im-body-mode-grader.mjs";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const DATASET = loadImBodyModeEval(path.join(ROOT, "evals/im-body-mode/scenarios.json"));
const FAKE = path.join(ROOT, "test/support/im-body-mode-eval-cli.mjs");

function writeEvent(scenario, bodyFlag = scenario.expected_body_flag, body = scenario.body, overrides = {}) {
  const command = scenario.operation === "send" ? "+messages-send" : "+messages-reply";
  const targetFlag = overrides.target_flag ?? scenario.target_flag;
  const target = overrides.target ?? scenario.target;
  return {
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
    message_id: "om_eval_im_unit",
    error: null,
    ...overrides,
  };
}

function runFake(args, surface = "larkin") {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "im-body-mode-eval-"));
  const traceFile = path.join(temp, "trace.ndjson");
  fs.writeFileSync(traceFile, "", { mode: 0o600 });
  try {
    const result = spawnSync(process.execPath, [FAKE, ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH, IM_BODY_MODE_EVAL_TRACE_FILE: traceFile, IM_BODY_MODE_EVAL_SURFACE: surface },
    });
    const trace = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    return { result, trace };
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

test("IM body-mode dataset is fixed, fresh, versioned, and complete", () => {
  assert.equal(DATASET.dataset, "im-body-mode");
  assert.equal(DATASET.version, 1);
  assert.equal(DATASET.standing_prompt_version, "larkin-standing-v28");
  assert.equal(DATASET.threshold, 1);
  assert.equal(DATASET.session.initial_turns, 0);
  assert.equal(DATASET.session.fresh_per_scenario, true);
  assert.deepEqual(DATASET.scenarios.map(({ id }) => id), [
    "ordinary-plain-lines", "ordinary-plain-paragraphs", "intentional-markdown-heading",
    "intentional-markdown-list", "intentional-markdown-code", "intentional-markdown-link",
    "exact-verbatim-literal",
  ]);
});

test("golden final provider payloads enforce plain text, intentional Markdown, and exact literals", () => {
  const tracesById = {};
  for (const scenario of DATASET.scenarios) {
    const trace = [writeEvent(scenario)];
    tracesById[scenario.id] = trace;
    assert.deepEqual(gradeImBodyModeTrace(scenario, trace), { passed: true, failures: [] }, scenario.id);
  }
  const summary = summarizeImBodyModeEval(DATASET, tracesById);
  assert.equal(summary.passed, true);
  assert.equal(summary.pass_rate, 1);
});

test("final-payload grader rejects mode, body, target, duplicate, and trace-shape counterexamples", () => {
  const mutations = [];
  for (const scenario of DATASET.scenarios) {
    const wrongFlag = scenario.expected_body_flag === "--text" ? "--markdown" : "--text";
    mutations.push([`${scenario.id} wrong mode`, scenario, [writeEvent(scenario, wrongFlag)]]);
    mutations.push([`${scenario.id} body rewrite`, scenario, [writeEvent(scenario, scenario.expected_body_flag, `${scenario.body}\nextra`)]]);
  }
  const ordinary = DATASET.scenarios[0];
  const exact = DATASET.scenarios.at(-1);
  const golden = writeEvent(ordinary);
  const malformed = { ...golden }; delete malformed.error;
  mutations.push(
    ["missing write", ordinary, []],
    ["assistant prose only", ordinary, [{ action: "assistant_output", text: ordinary.body }]],
    ["duplicate writes", ordinary, [golden, golden]],
    ["wrong target", ordinary, [writeEvent(ordinary, ordinary.expected_body_flag, ordinary.body, {
      target: "oc_eval_im_other", argv: ["im", "+messages-send", "--chat-id", "oc_eval_im_other", ordinary.expected_body_flag, ordinary.body, "--json"],
    })]],
    ["unexpected argv", ordinary, [writeEvent(ordinary, ordinary.expected_body_flag, ordinary.body, { argv: [...golden.argv, "--profile"] })]],
    ["malformed schema", ordinary, [malformed]],
    ["exact Markdown conversion", exact, [writeEvent(exact, "--markdown")]],
  );
  for (const [label, scenario, trace] of mutations) {
    assert.equal(gradeImBodyModeTrace(scenario, trace).passed, false, label);
  }
});

test("fake sink exercises every final argv/body payload without provider or runtime imports", () => {
  for (const scenario of DATASET.scenarios) {
    const command = scenario.operation === "send" ? "+messages-send" : "+messages-reply";
    const args = ["im", command, scenario.target_flag, scenario.target, scenario.expected_body_flag, scenario.body, "--json"];
    const result = runFake(args);
    assert.equal(result.result.status, 0, `${scenario.id}: ${result.result.stderr}`);
    assert.deepEqual(gradeImBodyModeTrace(scenario, result.trace), { passed: true, failures: [] }, scenario.id);
  }
  const source = fs.readFileSync(FAKE, "utf8");
  assert.doesNotMatch(source, /node:child_process|@larksuite|from ["'][^"']*(?:dist|src)\//);
  assert.doesNotMatch(source, /\b(?:spawn|execFile|exec|fork)\s*\(/);
  assert.notEqual(runFake(["im", "+messages-send", "--chat-id", "oc_real", "--text", "no", "--json"]).result.status, 0);
  assert.notEqual(runFake(["im", "+chat-list", "--json"]).result.status, 0);
});

test("v26 counterfactual restores the old Markdown-default guidance without changing exact contracts", () => {
  const v27 = new ContextPromptBuilder().build({ agentId: "cli_imBodyModeEval", name: "IM Body Mode Eval", runtime: "codex" });
  for (const line of PLAIN_MULTILINE_V27_GUIDANCE) assert.equal(v27.content.split(line).length - 1, 1);
  const v26 = v26PlainMultilineCounterfactual(v27);
  assert.equal(v26.version, "larkin-standing-v26");
  assert.match(v26.hash, /^[a-f0-9]{64}$/);
  assert.notEqual(v26.hash, v27.hash);
  for (const line of PLAIN_MULTILINE_V27_GUIDANCE) assert.equal(v26.content.includes(line), false);
  assert.match(v26.content, /default to `--markdown`, including brief single-line replies/);
  assert.match(v26.content, /exact or verbatim direct literal uses `--text`/);
  assert.match(v27.content, /ordinary plain-text message bodies, use `--text`/);
  assert.match(v27.content, /exact or verbatim direct literal uses `--text`/);
});
