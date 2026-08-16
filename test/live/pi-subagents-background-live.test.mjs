import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PiRpcClient } from "../../dist/runtime/pi-rpc-client.mjs";
import { bundledPiSubagentExtensionPath } from "../../dist/runtime/pi-subagent-injection.mjs";
import { extractCanonicalPiSubagentCompletionKeyFromMessages } from "../../dist/runtime/pi-subagents-notification.mjs";
import {
  gradePiSubagentsTrace,
  loadPiSubagentsEval,
  summarizePiSubagentsEval,
} from "../support/pi-subagents-background-grader.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATASET = loadPiSubagentsEval(path.join(ROOT, "evals/pi-subagents-background/scenarios.json"));

const enabled = process.env.LARKIN_RUN_PI_SUBAGENTS_EVAL === "1";
const repetitions = Number.parseInt(process.env.LARKIN_PI_SUBAGENTS_EVAL_REPETITIONS || "1", 10);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 5) {
  throw new Error("LARKIN_PI_SUBAGENTS_EVAL_REPETITIONS must be an integer from 1 to 5");
}
const scenarioFilter = new Set((process.env.LARKIN_PI_SUBAGENTS_EVAL_SCENARIOS || "")
  .split(",").map((item) => item.trim()).filter(Boolean));
const threshold = Number.parseFloat(process.env.LARKIN_PI_SUBAGENTS_EVAL_THRESHOLD || "0.8");
const EXPLORATORY = new Set([
  // Multi-message and dependent/order scenarios: model behavior varies
  // (deepseek-v4-flash sometimes skips the order message or a partial summary),
  // so they run at a lower threshold and are monitored, not gated.
  "message-b-while-a-background", "message-b-dependent-on-a",
  "sequential-dependent-tasks", "sequential-three-steps",
  "triple-parallel-tasks",
]);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-subagents-eval-"));
afterAll(() => { fs.rmSync(workDir, { recursive: true, force: true }); });

function waitFor(trace, predicate, timeoutMs = 300_000) {
  const existing = trace.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = trace.find(predicate);
      if (hit) { clearInterval(timer); resolve(hit); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("eval wait timeout")); }
    }, 500);
  });
}

async function runScenario(scenario) {
  const bundle = bundledPiSubagentExtensionPath();
  assert.ok(bundle, "pi-subagents bundle artifact must exist (run bun run build first)");
  const child = spawn("pi", ["--mode", "rpc", "-e", bundle, "--no-session"], {
    cwd: workDir, env: { ...process.env, NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"],
  });
  const trace = [];
  const client = new PiRpcClient(child, { requestTimeoutMs: 30_000 });
  client.subscribe((event) => trace.push(event));
  const steps = scenario.steps ?? [{ prompt: scenario.prompt }];
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const nextIsSteer = i + 1 < steps.length && steps[i + 1].steer === true;
      // Steer steps are delivered while the previous turn is still running,
      // mirroring Larkin's busyInput inbox_update path.
      if (step.steer) {
        // Wait until the previous task's first tool is actually executing (mirrors a
        // real busy-input arrival while the agent is working), then steer the second
        // message into that turn. Steering during the model's initial thinking phase
        // is a pi boundary case that can drop the message.
        const settledBefore = trace.filter((event) => event?.type === "agent_end").length;
        const toolStartedBefore = trace.filter((event) => event?.type === "tool_execution_start").length;
        await waitFor(trace, (event) => event?.type === "tool_execution_start"
          && trace.indexOf(event) >= toolStartedBefore);
        // Let the tool settle into its execution window; steering exactly at the
        // tool-start boundary is a pi race that can drop the message.
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        await client.request("prompt", { message: step.prompt, streamingBehavior: "steer" });
        // Wait for the current turn to finish so the steered message is consumed.
        await waitFor(trace, (event) => event?.type === "agent_end"
          && trace.indexOf(event) >= settledBefore + 1);
        continue;
      }
      await client.request("prompt", { message: step.prompt });
      if (nextIsSteer) {
        // The next message must be steered while this turn is still working, so
        // wait only for the first tool execution, not for the turn to finish.
        const toolStartedBefore = trace.filter((event) => event?.type === "tool_execution_start").length;
        await waitFor(trace, (event) => event?.type === "tool_execution_start"
          && trace.indexOf(event) >= toolStartedBefore);
      } else {
        await waitFor(trace, (event) => event?.type === "agent_end");
      }
    }
    // For background-delegation scenarios wait for the completion notification turn
    // with a generous timeout (provider latency varies); grade whatever arrived.
    const isNotification = (event) => {
      if (event?.type !== "agent_end") return false;
      return extractCanonicalPiSubagentCompletionKeyFromMessages(event.messages) !== null;
    };
    try {
      await waitFor(trace, isNotification, 180_000);
      // Give the parent a moment to produce the summary turn output.
      await new Promise((resolve) => setTimeout(resolve, 20_000));
    } catch {
      // No notification within the window; grade what we have (rubric decides).
    }
    return gradePiSubagentsTrace(scenario, trace);
  } finally {
    child.kill("SIGTERM");
  }
}

test("pi-subagents eval starts from the fixed scenario dataset", () => {
  assert.equal(DATASET.model, "opencode-go/deepseek-v4-flash");
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id),
    ["background-delegation", "background-with-foreground-confirmation", "background-no-shell-substitute", "parallel-independent-tasks", "sequential-dependent-tasks", "triple-parallel-tasks", "background-long-sleep", "sequential-three-steps", "message-b-while-a-background", "message-b-dependent-on-a", "busy-message-parallelizes", "busy-message-dependent-replies"]);
});

for (const scenario of DATASET.scenarios) {
  if (scenarioFilter.size > 0 && !scenarioFilter.has(scenario.id)) continue;
  test(`pi-subagents scenario ${scenario.id} (${repetitions}x, threshold ${threshold})`, async () => {
    if (!enabled) return; // default skip; enable via LARKIN_RUN_PI_SUBAGENTS_EVAL=1
    const graded = [];
    for (let i = 0; i < repetitions; i++) {
      graded.push(await runScenario(scenario));
    }
    const summary = summarizePiSubagentsEval(graded);
    console.log(`[eval] ${scenario.id}: ${summary.passed}/${summary.total} passed (rate ${summary.rate})`);
    for (const grade of graded) {
      if (!grade.passed) console.log(`[eval]   failed rubric: ${JSON.stringify(grade.results)}`);
    }
    const effectiveThreshold = EXPLORATORY.has(scenario.id)
      ? Math.min(threshold, 0.5) : threshold;
    assert.ok(summary.rate >= effectiveThreshold,
      `scenario ${scenario.id} pass rate ${summary.rate} below threshold ${effectiveThreshold}`);
  }, { timeout: 900_000 });
}
