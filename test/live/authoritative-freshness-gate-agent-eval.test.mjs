import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { test } from "bun:test";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { createNativeRuntimeAdapter } from "../../dist/runtime/runtime-adapters.mjs";
import { gradeConflictRedecision, gradeNativeCommandAudit, loadAuthoritativeFreshnessEval } from "../support/authoritative-freshness-gate-grader.mjs";

const RUN = process.env.LARKIN_RUN_AUTHORITATIVE_FRESHNESS_EVAL === "1";
const ROOT = path.resolve(import.meta.dirname, "../..");
const FAKE = path.join(ROOT, "test/support/authoritative-freshness-gate-eval-cli.mjs");
const DATASET = loadAuthoritativeFreshnessEval(path.join(ROOT, "evals/authoritative-freshness-gate/scenarios.json"));
const SCENARIO = DATASET.scenarios.find((scenario) => scenario.id === "model-conflict-redecision");

function waitForTurnEnd(events, after, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const find = () => events.items.slice(after).find((event) => event.type === "turn-end");
    if (find()) return resolve(find());
    const timer = setTimeout(() => reject(new Error("native authoritative freshness eval timed out")), timeoutMs);
    events.waiters.push(() => { const found = find(); if (found) { clearTimeout(timer); resolve(found); } });
  });
}

async function promptWhenReady(session, input, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await session.prompt(input);
    if (result.status !== "deferred" || !/not initialized/i.test(result.reason || "")) return result;
    if (Date.now() >= deadline) throw new Error("native authoritative freshness eval initialization timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test.skipIf(!RUN)("native Runtime/model redecides after nonzero conflict without draft or cursor bypass", { timeout: 10 * 60_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-authoritative-native-eval-"));
  const workspaceDir = path.join(temp, "workspace");
  const stateDir = path.join(temp, "state");
  const binDir = path.join(temp, "bin");
  const traceFile = path.join(temp, "trace.ndjson");
  let session;
  const commandAudit = [];
  try {
    for (const dir of [workspaceDir, stateDir, binDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(traceFile, "", { mode: 0o600 });
    fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), [
      "# Controlled authoritative freshness eval",
      "Use only larkin commands explicitly requested by the task; never invoke bare lark-cli.",
      "Do not inspect or edit files, environment, cursor state, or use larkin-draft.",
      "A nonzero JSON conflict is authoritative context, not a shell failure to bypass.", "",
    ].join("\n"), { mode: 0o600 });
    fs.writeFileSync(path.join(binDir, "larkin"),
      `#!/bin/sh\nLARKIN_EVAL_SURFACE=larkin exec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE)} "$@"\n`, { mode: 0o700 });
    const codexCommand = execFileSync("sh", ["-c", "command -v codex"], { encoding: "utf8" }).trim();
    assert.ok(codexCommand);
    const captureSpawn = (command, args, options) => {
      const child = spawn(command, args, options);
      const stdout = new PassThrough();
      let pending = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout.write(chunk);
        pending += chunk;
        for (;;) {
          const newline = pending.indexOf("\n");
          if (newline < 0) break;
          const line = pending.slice(0, newline); pending = pending.slice(newline + 1);
          try {
            const message = JSON.parse(line);
            const item = message.params?.item;
            if (message.method === "item/completed" && item?.type === "commandExecution") {
              commandAudit.push({ item_type: item.type, command: item.command, exit_code: item.exitCode });
            } else if (message.method === "item/completed" && item?.type
                && !["userMessage", "agentMessage", "reasoning"].includes(item.type)) {
              commandAudit.push({ item_type: item.type, command: `[${item.type}]`, exit_code: null });
            }
          } catch { /* only valid app-server protocol frames contribute evidence */ }
        }
      });
      child.stdout.on("end", () => stdout.end());
      return { stdin: child.stdin, stdout, stderr: child.stderr, pid: child.pid,
        once: child.once.bind(child), on: child.on.bind(child), kill: child.kill.bind(child) };
    };
    const adapter = createNativeRuntimeAdapter("codex", { codexCommand, spawn: captureSpawn });
    session = await adapter.createSession({
      agentId: "cli_authoritativeEvalA1", workspaceDir, stateDir,
      standingPrompt: new ContextPromptBuilder().build({ agentId: "cli_authoritativeEvalA1", name: "Freshness Eval", runtime: "codex" }),
      env: {
        PATH: `${binDir}:${path.dirname(codexCommand)}:${path.dirname(process.execPath)}:/usr/bin:/bin`,
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
    const after = events.items.length;
    const accepted = await promptWhenReady(session, {
      inputId: "authoritative-conflict-redecision", kind: "initial", attempt: 0,
      text: SCENARIO.prompt.replaceAll("{larkin}", JSON.stringify(path.join(binDir, "larkin"))),
    });
    assert.equal(accepted.status, "accepted");
    await waitForTurnEnd(events, after);
    const runtimeError = events.items.slice(after).find((event) => ["error", "configuration-error", "input-error"].includes(event.type));
    assert.equal(runtimeError, undefined, runtimeError?.message);
    const trace = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const traceGrade = gradeConflictRedecision(trace);
    const auditGrade = gradeNativeCommandAudit(commandAudit, path.join(binDir, "larkin"));
    const grade = { passed: traceGrade.passed && auditGrade.passed,
      failures: [...traceGrade.failures, ...auditGrade.failures] };
    process.stderr.write(`# authoritative-freshness native eval: ${JSON.stringify({
      runtime: "codex", model, grade, trace,
      event_types: events.items.slice(after).map((event) => event.type),
      output_tail: events.items.slice(after).filter((event) => typeof event.text === "string").map((event) => event.text).slice(-5),
      command_audit: { count: commandAudit.length, exit_codes: commandAudit.map((event) => event.exit_code) },
    })}\n`);
    assert.equal(grade.passed, true, JSON.stringify(grade.failures));
  } finally {
    await session?.close("authoritative freshness eval complete");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
