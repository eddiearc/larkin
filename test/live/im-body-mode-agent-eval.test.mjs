import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { test } from "bun:test";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { createNativeRuntimeAdapter } from "../../dist/runtime/runtime-adapters.mjs";
import { gradeNativeCommandAudit, isolatedNativeEnv } from "../support/clickable-link-delivery-native-support.mjs";
import { gradeImBodyModeTrace, loadImBodyModeEval, v26PlainMultilineCounterfactual } from "../support/im-body-mode-grader.mjs";

const RUN = process.env.LARKIN_RUN_IM_BODY_MODE_EVAL === "1";
const ROOT = path.resolve(import.meta.dirname, "../..");
const FAKE = path.join(ROOT, "test/support/im-body-mode-eval-cli.mjs");
const DATASET = loadImBodyModeEval(path.join(ROOT, "evals/im-body-mode/scenarios.json"));
const PROMPT_VERSION = process.env.LARKIN_IM_BODY_MODE_PROMPT_VERSION || "v27";
const SCENARIO_ID = process.env.LARKIN_IM_BODY_MODE_SCENARIO || "ordinary-plain-lines";
const SCENARIO = DATASET.scenarios.find((scenario) => scenario.id === SCENARIO_ID);
const MAX_RUN_MS = 52_000;

function remaining(deadline) {
  const value = deadline - Date.now();
  if (value <= 0) throw new Error("native IM body-mode eval timed out after 52s");
  return value;
}

async function promptWhenReady(session, input, deadline) {
  for (;;) {
    const result = await session.prompt(input);
    if (result.status !== "deferred" || !/not initialized/i.test(result.reason || "")) return result;
    remaining(deadline);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function waitForTurnEnd(events, after, deadline) {
  return new Promise((resolve, reject) => {
    const find = () => events.items.slice(after).find((event) => event.type === "turn-end");
    if (find()) return resolve(find());
    const timer = setTimeout(() => reject(new Error("native IM body-mode eval timed out after 52s")), remaining(deadline));
    events.waiters.push(() => { const found = find(); if (found) { clearTimeout(timer); resolve(found); } });
  });
}

function writeShadow(file, surface) {
  fs.writeFileSync(file,
    `#!/bin/sh\nIM_BODY_MODE_EVAL_SURFACE=${surface} exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`,
    { mode: 0o700 });
}

if (RUN) {
  if (!SCENARIO) throw new Error(`unknown IM body-mode scenario: ${SCENARIO_ID}`);
  if (!["v26", "v27"].includes(PROMPT_VERSION)) throw new Error(`unknown IM body-mode prompt version: ${PROMPT_VERSION}`);
}

test.skipIf(!RUN)(`native IM body-mode final-payload eval (${PROMPT_VERSION}/${SCENARIO_ID})`, { timeout: 55_000 }, async () => {
  const deadline = Date.now() + MAX_RUN_MS;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-im-body-mode-native-eval-"));
  const workspaceDir = path.join(temp, "workspace");
  const stateDir = path.join(temp, "state");
  const binDir = path.join(temp, "bin");
  const traceFile = path.join(temp, "trace.ndjson");
  const fakeLarkin = path.join(binDir, "larkin");
  const fakeLarkCli = path.join(binDir, "lark-cli");
  let session;
  let model = null;
  let evidenceWritten = false;
  const commandAudit = [];
  try {
    for (const dir of [workspaceDir, stateDir, binDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(traceFile, "", { mode: 0o600 });
    fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), [
      "# Controlled IM body-mode payload evaluation",
      "Use only the absolute fake larkin command supplied by the task. Both larkin and lark-cli on PATH are inert fake sinks.",
      "Never inspect files or environment, use network tools, or invoke any other command.",
      "The targets beginning oc_eval_im_/om_eval_im_ are synthetic and no Feishu write is possible.",
      "Stop immediately after the single fake write result.", "",
    ].join("\n"), { mode: 0o600 });
    writeShadow(fakeLarkin, "larkin");
    writeShadow(fakeLarkCli, "lark-cli");
    const codexCommand = execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8", timeout: 2_000 }).trim();
    assert.ok(codexCommand, "native Codex executable is unavailable");
    const nativeEnv = isolatedNativeEnv(process.env, { temp, binDir, codexCommand, traceFile });
    nativeEnv.IM_BODY_MODE_EVAL_TRACE_FILE = traceFile;
    const captureSpawn = (command, args, options) => {
      const child = spawn(command, args, options);
      const stdout = new PassThrough(); let pending = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout.write(chunk); pending += chunk;
        for (;;) {
          const newline = pending.indexOf("\n"); if (newline < 0) break;
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          try {
            const message = JSON.parse(line); const item = message.params?.item;
            if (message.method === "item/completed" && item?.type === "commandExecution") {
              commandAudit.push({ item_type: item.type, command: item.command, exit_code: item.exitCode });
            } else if (message.method === "item/completed" && item?.type && !["userMessage", "agentMessage", "reasoning"].includes(item.type)) {
              commandAudit.push({ item_type: item.type, command: `[${item.type}]`, exit_code: null });
            }
          } catch { /* only app-server protocol frames contribute evidence */ }
        }
      });
      child.stdout.on("end", () => stdout.end());
      return { stdin: child.stdin, stdout, stderr: child.stderr, pid: child.pid,
        once: child.once.bind(child), on: child.on.bind(child), kill: child.kill.bind(child) };
    };
    const v27 = new ContextPromptBuilder().build({ agentId: "cli_imBodyModeEval", name: "IM Body Mode Eval", runtime: "codex" });
    const standingPrompt = PROMPT_VERSION === "v26" ? v26PlainMultilineCounterfactual(v27) : v27;
    const adapter = createNativeRuntimeAdapter("codex", { codexCommand, spawn: captureSpawn, env: nativeEnv });
    session = await adapter.createSession({ agentId: "cli_imBodyModeEval", workspaceDir, stateDir, standingPrompt, env: nativeEnv });
    const events = { items: [], waiters: [] };
    session.subscribe((event) => { if (event.type === "session-init") model = event.model || null; events.items.push(event); for (const waiter of events.waiters) waiter(event); });
    const after = events.items.length;
    const accepted = await promptWhenReady(session, {
      inputId: `${PROMPT_VERSION}-${SCENARIO.id}`, kind: "initial", attempt: 0,
      text: `${SCENARIO.prompt}\nUse only ${JSON.stringify(fakeLarkin)} for the Larkin command and include --json.`,
    }, deadline);
    assert.equal(accepted.status, "accepted", accepted.reason);
    await waitForTurnEnd(events, after, deadline);
    const runtimeError = events.items.slice(after).find((event) => ["error", "configuration-error", "input-error"].includes(event.type));
    assert.equal(runtimeError, undefined, runtimeError?.message);
    const trace = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const payloadGrade = gradeImBodyModeTrace(SCENARIO, trace);
    const auditGrade = gradeNativeCommandAudit(commandAudit, fakeLarkin, fakeLarkCli);
    const grade = { passed: payloadGrade.passed && auditGrade.passed, failures: [...payloadGrade.failures, ...auditGrade.failures] };
    process.stderr.write(`# IM body-mode native eval: ${JSON.stringify({ dataset: DATASET.dataset, scenario: SCENARIO.id, runtime: "codex", model: model || DATASET.runtime.selection, model_id_exposed: Boolean(model), prompt: { version: standingPrompt.version, hash: standingPrompt.hash }, trace, grade, real_provider_write_possible: false })}\n`);
    evidenceWritten = true;
    assert.equal(grade.passed, true, JSON.stringify(grade.failures));
  } catch (error) {
    if (!evidenceWritten) process.stderr.write(`# IM body-mode native eval blocker: ${JSON.stringify({ dataset: DATASET.dataset, scenario: SCENARIO?.id || SCENARIO_ID, runtime: "codex", model: model || DATASET.runtime.selection, prompt_version: PROMPT_VERSION, blocker: error instanceof Error ? error.message : String(error), real_provider_write_possible: false })}\n`);
    throw error;
  } finally {
    await session?.close("IM body-mode eval complete");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
