import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterAll, describe, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { resolveAgentCliExecutable } from "../../dist/agent/agent-cli-capabilities.mjs";
import {
  gradeLongRunningImTrace,
  loadLongRunningImScenarios,
} from "../support/long-running-im-progress-grader.mjs";
import { reconcileAgentWorkspace } from "../../dist/platform/workspace-service.mjs";
import { createNativeRuntimeAdapter } from "../../dist/runtime/runtime-adapters.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CASE_DIR = path.join(ROOT, "evals", "long-running-im-progress");
const FAKE_CLI = path.join(ROOT, "test", "support", "long-running-im-eval-cli.mjs");
const enabled = process.env.LARKIN_RUN_LONG_RUNNING_IM_EVAL === "1";
const runtime = (process.env.LARKIN_LONG_RUNNING_IM_EVAL_RUNTIME || "pi").trim();
if (runtime !== "pi" && runtime !== "codex") {
  throw new Error("LARKIN_LONG_RUNNING_IM_EVAL_RUNTIME must be pi or codex");
}
const repetitions = Number.parseInt(process.env.LARKIN_LONG_RUNNING_IM_EVAL_REPETITIONS || "1", 10);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
  throw new Error("LARKIN_LONG_RUNNING_IM_EVAL_REPETITIONS must be an integer from 1 to 10");
}

function readTrace(file) {
  try {
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function waitFor(controlEvents, predicate, timeoutMs = 180_000) {
  const existing = controlEvents.items.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`native ${runtime} eval timed out`)), timeoutMs);
    controlEvents.waiters.push((event) => {
      if (!predicate(event)) return;
      clearTimeout(timer);
      resolve(event);
    });
  });
}

function createEvalAdapter() {
  if (runtime === "pi") return createNativeRuntimeAdapter("pi");
  const codexCommand = execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim();
  assert.ok(codexCommand, "codex executable is required");
  return createNativeRuntimeAdapter("codex", { codexCommand });
}

async function runScenario(scenario, repetition) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `larkin-im-eval-${scenario.id}-`));
  const workspaceDir = path.join(root, "workspace");
  const stateDir = path.join(root, "state");
  const traceFile = path.join(stateDir, "trace.ndjson");
  const scenarioFile = path.join(CASE_DIR, `${scenario.id}.json`);
  let session;
  try {
    fs.mkdirSync(workspaceDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), [
      "# Eval isolation",
      "Only use the exact eval CLI command listed in Larkin standing instructions.",
      "Never invoke lark-cli, a globally installed larkin command, Feishu, or any network messaging tool.",
      "Do not read or print environment variables. Do not include tool output verbatim in IM.",
      "",
    ].join("\n"), { mode: 0o600 });
    reconcileAgentWorkspace({
      workspaceDir,
      trustedWorkspaceRoot: root,
      lockDir: stateDir,
      agentId: "cli_evalRuntimeA1",
    });
    const executable = resolveAgentCliExecutable(FAKE_CLI, process.execPath);
    const prompt = new ContextPromptBuilder().buildStandingPrompt({
      agent: { id: "cli_evalRuntimeA1", name: "Long-running IM Eval" },
      runtime,
      cli: {
        executable,
        commands: [
          { command: "im +messages-send --chat-id <chat-id> --markdown <message>", purpose: "Send through the fake identity-locked IM sink." },
          { command: "work run --step <step-id>", purpose: "Run one scenario work step and return its controlled result." },
        ],
      },
    });
    const adapter = createEvalAdapter();
    const isolatedMessagingEnv = Object.fromEntries(Object.keys(process.env)
      .filter((key) => /(?:LARK|FEISHU)/i.test(key))
      .map((key) => [key, undefined]));
    session = await adapter.createSession({
      agentId: "cli_evalRuntimeA1",
      workspaceDir,
      stateDir,
      standingPrompt: prompt,
      ...(process.env.LARKIN_LONG_RUNNING_IM_EVAL_MODEL?.trim()
        ? { model: process.env.LARKIN_LONG_RUNNING_IM_EVAL_MODEL.trim() }
        : {}),
      env: {
        ...isolatedMessagingEnv,
        PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LARKIN_EVAL_SCENARIO_FILE: scenarioFile,
        LARKIN_EVAL_TRACE_FILE: traceFile,
        LARKIN_CONFIG_DIR: path.join(root, "no-feishu-config"),
        LARKIN_AGENT_ID: "cli_evalRuntimeA1",
      },
    });
    const controlEvents = { items: [], waiters: [] };
    session.subscribe((event) => {
      if (event.type === "activity") return;
      const safe = event.type === "error" || event.type === "configuration-error" || event.type === "input-error"
        ? { type: event.type, message: event.message }
        : event.type === "session-init"
          ? { type: event.type, model: event.model || null, reasoning_effort: event.reasoningEffort || null }
          : { type: event.type };
      controlEvents.items.push(safe);
      for (const waiter of controlEvents.waiters) waiter(safe);
    });
    const sessionInit = await waitFor(controlEvents, (event) => event.type === "session-init", 60_000);
    const stepInstruction = scenario.steps.length
      ? `Run these exact fake work steps in order: ${scenario.steps.map((step) => `${executable} work run --step ${step.id}`).join("; ")}.`
      : "This task has no work step.";
    const input = await session.prompt({
      inputId: `${scenario.id}-${repetition}`,
      kind: "initial",
      attempt: 0,
      text: [
        `Current fake chat id: ${scenario.im_target.id}. ${scenario.task}`,
        stepInstruction,
        `Use ${executable} im +messages-send --chat-id ${scenario.im_target.id} --markdown <message> for every user-visible message. Complete the task now.`,
      ].join("\n"),
    });
    assert.equal(input.status, "accepted");
    await waitFor(controlEvents, (event) => event.type === "turn-end");
    const runtimeError = controlEvents.items.find((event) => ["error", "configuration-error", "input-error"].includes(event.type));
    assert.equal(runtimeError, undefined, runtimeError?.message);
    const trace = readTrace(traceFile);
    const grade = gradeLongRunningImTrace(scenario, trace);
    return {
      case_id: scenario.id,
      repetition,
      runtime,
      model: sessionInit.model,
      reasoning_effort: sessionInit.reasoning_effort,
      passed: grade.passed,
      failure_rules: grade.failures.map((failure) => failure.rule),
      im_messages: trace.filter((item) => item.type === "im").length,
      event_sequence: trace.filter((item) => item.type === "im" || item.type === "work")
        .map((item) => item.type === "im"
          ? { type: "im" }
          : { type: "work", step_id: item.step_id, outcome: item.outcome }),
      work_steps: trace.filter((item) => item.type === "work")
        .map((item) => ({ step_id: item.step_id, outcome: item.outcome })),
    };
  } finally {
    await session?.close("long-running IM eval complete");
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe.skipIf(!enabled)(`production native ${runtime} follows long-running IM trace contracts`, () => {
  const summaries = [];
  for (const scenario of loadLongRunningImScenarios(CASE_DIR)) {
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      test(`${scenario.id} repetition ${repetition}`, { timeout: 15 * 60_000 }, async () => {
        const result = await runScenario(scenario, repetition);
        summaries.push(result);
        assert.equal(result.passed, true, `${scenario.id} grade failed: ${result.failure_rules.join(", ")}`);
      });
    }
  }
  afterAll(() => process.stderr.write(`# code grades: ${JSON.stringify(summaries)}\n`));
});
