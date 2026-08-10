import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterAll, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { PiRpcClient } from "../../dist/runtime/pi-rpc-client.mjs";
import { bundledPiBashTimeoutExtensionPath } from "../../dist/runtime/pi-bash-timeout-injection.mjs";
import { bundledPiSubagentExtensionPath } from "../../dist/runtime/pi-subagent-injection.mjs";
import {
  gradePiBashTimeoutTrace,
  loadPiBashTimeoutEval,
  summarizePiBashTimeoutEval,
} from "../support/pi-bash-timeout-grader.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATASET = loadPiBashTimeoutEval(path.join(ROOT, "evals/pi-bash-timeout/scenarios.json"));

const enabled = process.env.LARKIN_RUN_PI_BASH_TIMEOUT_EVAL === "1";
const repetitions = Number.parseInt(process.env.LARKIN_PI_BASH_TIMEOUT_EVAL_REPETITIONS || "1", 10);
if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 3) {
  throw new Error("LARKIN_PI_BASH_TIMEOUT_EVAL_REPETITIONS must be an integer from 1 to 3");
}
const scenarioFilter = new Set((process.env.LARKIN_PI_BASH_TIMEOUT_EVAL_SCENARIOS || "")
  .split(",").map((item) => item.trim()).filter(Boolean));
const threshold = Number.parseFloat(process.env.LARKIN_PI_BASH_TIMEOUT_EVAL_THRESHOLD || "0.6");
// 模型侧行为（是否主动改走 subagent）随模型波动，标记为 exploratory 的场景用较低阈值，
// 只护栏/不阻塞/有界返回这些运行时强制保证项按阈值卡。
const EXPLORATORY = new Set([
  // 不强制“超时后必须调 Agent”；只要求不前台重试、回合结束、进程已清理。
  "long-bash-with-huge-model-timeout", "long-bash-no-foreground-retry", "long-bash-process-reclaimed",
  // 并行双 subagent：模型是否精确 spawn 2 个 Agent 波动，作为监测项。
  "two-long-tasks-parallel-subagents",
]);
// eval 用更短生效上限加速；默认 6s（sleep 10 会在 ~6s 被掐断）。生产默认仍为 60s。
const evalTimeoutSec = Number.parseInt(process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS || "6", 10);

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bash-timeout-eval-"));
afterAll(() => { fs.rmSync(workDir, { recursive: true, force: true }); });

function waitFor(trace, predicate, timeoutMs = 240_000) {
  const existing = trace.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      const hit = trace.find(predicate);
      if (hit) { clearInterval(timer); resolve(hit); return; }
      if (Date.now() - started > timeoutMs) { clearInterval(timer); reject(new Error("eval wait timeout")); }
    }, 250);
  });
}

async function runScenario(scenario) {
  const bundle = bundledPiBashTimeoutExtensionPath();
  assert.ok(bundle, "pi-bash-timeout bundle artifact must exist (run bun run build first)");
  const subagentsBundle = bundledPiSubagentExtensionPath();
  assert.ok(subagentsBundle, "pi-subagents bundle artifact must exist (run bun run build first)");
  // 与真实 larkin 运行时一致：同时注入 pi-subagents（Agent 工具）和 pi-bash-timeout（bash 护栏）。
  const child = spawn("pi", ["--mode", "rpc", "-e", bundle, "-e", subagentsBundle, "--no-session"], {
    cwd: workDir,
    env: { ...process.env, NO_COLOR: "1", LARKIN_PI_BASH_TIMEOUT_SECONDS: String(evalTimeoutSec) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const trace = [];
  // 记录每个 bash 调用的实测时长 + 错误信息，供"不阻塞回合 / 拒绝 vs 超时"断言。
  const startedAt = new Map();
  const bashRuns = [];
  const client = new PiRpcClient(child, { requestTimeoutMs: 30_000 });
  client.subscribe((event) => {
    trace.push(event);
    if (event?.type === "tool_execution_start") startedAt.set(event.toolCallId, Date.now());
    else if (event?.type === "tool_execution_end" && startedAt.has(event.toolCallId)) {
      const run = {
        toolName: event.toolName,
        durationMs: Date.now() - startedAt.get(event.toolCallId),
        isError: event.isError,
        resultText: event.result ? JSON.stringify(event.result) : "",
      };
      if (run.toolName === "bash") bashRuns.push(run);
      startedAt.delete(event.toolCallId);
    }
  });
  try {
    await client.request("prompt", { message: scenario.prompt });
    // 等到回合结束：若 bash 一直阻塞，这里会超时失败 → 直接证明"回合被占住"。
    await waitFor(trace, (event) => event?.type === "agent_end");
    return gradePiBashTimeoutTrace(scenario, trace, bashRuns);
  } finally {
    child.kill("SIGTERM");
  }
}

test("pi-bash-timeout eval starts from the fixed scenario dataset", () => {
  assert.equal(DATASET.model, "opencode-go/deepseek-v4-flash");
  assert.deepEqual(DATASET.scenarios.map((scenario) => scenario.id),
    ["long-bash-steers-to-subagent", "long-bash-with-huge-model-timeout", "oversize-timeout-rejected-immediately",
      "proactive-subagent-for-known-long", "long-bash-no-foreground-retry", "deploy-style-long-bash",
      "long-bash-process-reclaimed", "two-long-tasks-parallel-subagents"]);
});

for (const scenario of DATASET.scenarios) {
  if (scenarioFilter.size > 0 && !scenarioFilter.has(scenario.id)) continue;
  test(`pi-bash-timeout scenario ${scenario.id} (${repetitions}x, threshold ${threshold}, bash cap ${evalTimeoutSec}s)`, async () => {
    if (!enabled) return; // default skip; enable via LARKIN_RUN_PI_BASH_TIMEOUT_EVAL=1
    const graded = [];
    for (let i = 0; i < repetitions; i++) {
      graded.push(await runScenario(scenario));
    }
    const summary = summarizePiBashTimeoutEval(graded);
    console.log(`[eval] ${scenario.id}: ${summary.passed}/${summary.total} passed (rate ${summary.rate})`);
    for (const grade of graded) {
      if (!grade.passed) console.log(`[eval]   failed rubric: ${JSON.stringify(grade.results)}`);
    }
    const effectiveThreshold = EXPLORATORY.has(scenario.id)
      ? Math.min(threshold, 0.4) : threshold;
    assert.ok(summary.rate >= effectiveThreshold,
      `scenario ${scenario.id} pass rate ${summary.rate} below threshold ${effectiveThreshold}`);
  }, { timeout: 600_000 });
}
