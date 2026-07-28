import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { createNativeRuntimeAdapter } from "../../dist/runtime/runtime-adapters.mjs";
import {
  loadRuntimeAgentInterfaceEval,
  summarizeRuntimeAgentInterfaceEval,
} from "../support/runtime-agent-interface-v2-grader.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DATASET_FILE = path.join(ROOT, "evals", "runtime-agent-interface-v2", "scenarios.json");
const FAKE_CLI = path.join(ROOT, "test", "support", "runtime-agent-interface-v2-eval-cli.mjs");
const RUN = process.env.LARKIN_RUN_RUNTIME_AGENT_INTERFACE_V2_EVAL === "1";

function readTrace(file) {
  try { return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
}

function waitForTurnEnd(events, afterCount, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const existing = events.items.slice(afterCount).find((event) => event.type === "turn-end");
    if (existing) return resolve(existing);
    const timer = setTimeout(() => reject(new Error("native Codex eval timed out")), timeoutMs);
    events.waiters.push(() => {
      const found = events.items.slice(afterCount).find((event) => event.type === "turn-end");
      if (!found) return;
      clearTimeout(timer);
      resolve(found);
    });
  });
}

async function promptWhenReady(session, input, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await session.prompt(input);
    if (result.status !== "deferred" || !/not initialized/i.test(result.reason || "")) return result;
    if (Date.now() >= deadline) throw new Error("native Codex eval initialization timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function initialState(scenario) {
  const targets = {};
  const trace = [];
  const update = (target, seq) => { targets[target] = { latest: seq, seen: 0 }; trace.push({ action: "update", target, seq }); };
  if (scenario.id === "target-isolation") {
    update("chat:oc_eval_a", 1);
    update("chat:oc_eval_b", 1);
  } else update(scenario.target, 1);
  if (scenario.id === "busy-update") trace.unshift({ action: "busy_start" });
  if (scenario.id === "busy-update") trace.push({ action: "safe_boundary" });
  return {
    state: {
      scenario_id: scenario.id,
      targets,
      drafts: {},
      ...(scenario.id === "repeated-update" ? { inject_after_poll: { target: scenario.target, seq: 2, done: false } } : {}),
    },
    trace,
  };
}

function scenarioInstruction(scenario, binDir) {
  const chatId = scenario.target.replace(/^chat:/, "");
  const larkin = JSON.stringify(path.join(binDir, "larkin"));
  const larkCli = JSON.stringify(path.join(binDir, "lark-cli"));
  const exactSend = `${larkCli} im +messages-send --chat-id ${chatId} --markdown "controlled reply"`;
  const exactPoll = `${larkin} inbox poll --target ${scenario.target}`;
  if (scenario.id === "held-draft") return `${scenario.task} First run ${exactSend}; after it reports held, run ${exactPoll} and send one revised reply with ${larkCli}.`;
  if (scenario.id === "repeated-update") return `${scenario.task} First run ${exactPoll}, then run ${exactSend}; the controlled launcher will expose the second update and hold that send, so run ${exactPoll} again and send one revised reply with ${larkCli}.`;
  if (scenario.id === "target-isolation") return `${scenario.task} Use only ${larkin} and ${larkCli}. Poll chat:oc_eval_a and send exactly one reply to oc_eval_a. Then attempt one reply to oc_eval_b without polling it; accept the held result and stop.`;
  if (scenario.id === "check-only") return `${scenario.task} Run exactly ${larkin} inbox check --target ${scenario.target} and stop.`;
  if (scenario.id === "poll-complete") return `${scenario.task} Run exactly ${exactPoll} and stop.`;
  return `${scenario.task} Run ${exactPoll}, then run ${exactSend}.`;
}

test.skipIf(!RUN)("native Codex Agent reaches the registered runtime-interface eval threshold", { timeout: 20 * 60_000 }, async () => {
  const dataset = loadRuntimeAgentInterfaceEval(DATASET_FILE);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-runtime-interface-eval-"));
  const workspaceDir = path.join(temp, "workspace");
  const stateDir = path.join(temp, "runtime-state");
  const controlFile = path.join(temp, "eval-state.json");
  const traceFile = path.join(temp, "eval-trace.ndjson");
  const binDir = path.join(temp, "bin");
  let session;
  try {
    for (const directory of [workspaceDir, stateDir, binDir]) fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), [
      "# Isolated runtime-interface eval",
      "Use only larkin and lark-cli commands named in the standing instructions.",
      "Do not inspect environment variables, files, network services, or global command installations.",
      "The controlled CLI output is authoritative for this eval.",
      "",
    ].join("\n"), { mode: 0o600 });
    for (const surface of ["larkin", "lark-cli"]) {
      fs.writeFileSync(path.join(binDir, surface), `#!/bin/sh\nLARKIN_EVAL_SURFACE=${surface} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_CLI)} "$@"\n`, { mode: 0o700 });
    }
    const codexCommand = execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim();
    assert.ok(codexCommand, "codex executable is required");
    const prompt = new ContextPromptBuilder().build({
      agentId: "cli_runtimeInterfaceEvalA1", name: "Runtime Interface Eval", runtime: "codex",
    });
    // Supplying the same native spawn implementation skips the unrelated readiness
    // probe while retaining the real app-server session and its authenticated model.
    const adapter = createNativeRuntimeAdapter("codex", { codexCommand, spawn });
    const isolatedMessagingEnv = Object.fromEntries(Object.keys(process.env)
      .filter((key) => /(?:LARK|FEISHU)/i.test(key)).map((key) => [key, undefined]));
    session = await adapter.createSession({
      agentId: "cli_runtimeInterfaceEvalA1", workspaceDir, stateDir, standingPrompt: prompt,
      env: {
        ...isolatedMessagingEnv,
        // The installed Codex entry resolves Node through its environment; keep
        // its own directory in the isolated PATH so that interpreter is available.
        PATH: `${binDir}:${path.dirname(codexCommand)}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
        LARKIN_EVAL_STATE_FILE: controlFile,
        LARKIN_EVAL_TRACE_FILE: traceFile,
      },
    });
    const events = { items: [], waiters: [] };
    let model = null;
    session.subscribe((event) => {
      if (event.type === "session-init") model = event.model || null;
      events.items.push(event);
      for (const waiter of events.waiters) waiter(event);
    });
    const traces = {};
    for (const scenario of dataset.scenarios) {
      const initial = initialState(scenario);
      fs.writeFileSync(controlFile, `${JSON.stringify(initial.state)}\n`, { mode: 0o600 });
      fs.writeFileSync(traceFile, `${initial.trace.map((event) => JSON.stringify(event)).join("\n")}\n`, { mode: 0o600 });
      const afterCount = events.items.length;
      const accepted = await promptWhenReady(session, {
        inputId: `eval-${scenario.id}`, kind: "initial", attempt: 0,
        text: `${scenarioInstruction(scenario, binDir)} Execute the controlled scenario now and stop after its requested outcome.`,
      });
      assert.equal(accepted.status, "accepted");
      await waitForTurnEnd(events, afterCount);
      const runtimeError = events.items.slice(afterCount).find((event) => ["error", "configuration-error", "input-error"].includes(event.type));
      assert.equal(runtimeError, undefined, runtimeError?.message);
      traces[scenario.id] = readTrace(traceFile);
    }
    const summary = summarizeRuntimeAgentInterfaceEval(dataset, traces);
    process.stderr.write(`# runtime-agent-interface-v2 eval: ${JSON.stringify({ runtime: "codex", model, ...summary })}\n`);
    assert.equal(summary.passed, true, JSON.stringify(summary.results.filter((result) => !result.passed)));
  } finally {
    await session?.close("runtime-interface eval complete");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
