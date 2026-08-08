import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PiRpcClient } from "../../dist/runtime/pi-rpc-client.mjs";
import { bundledPiSubagentExtensionPath } from "../../dist/runtime/pi-subagent-injection.mjs";
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
  try {
    // prompt 响应无 data（resolve undefined）；拒绝/超时会 reject，此处 await 即验收。
    await client.request("prompt", { message: scenario.prompt });
    await waitFor(trace, (event) => {
      if (event?.type !== "agent_end" || !Array.isArray(event.messages)) return false;
      return JSON.stringify(event.messages).includes("subagent-notification");
    });
    // Give the parent a moment to produce the summary turn output.
    await new Promise((resolve) => setTimeout(resolve, 25_000));
    return gradePiSubagentsTrace(scenario, trace);
  } finally {
    child.kill("SIGTERM");
  }
}

test("pi-subagents eval starts from the fixed scenario dataset", () => {
  assert.equal(DATASET.model, "opencode-go/deepseek-v4-flash");
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id),
    ["background-delegation", "background-with-foreground-confirmation"]);
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
    assert.ok(summary.rate >= threshold,
      `scenario ${scenario.id} pass rate ${summary.rate} below threshold ${threshold}`);
  }, { timeout: 900_000 });
}
