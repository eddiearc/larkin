import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { test } from "bun:test";
import { ContextPromptBuilder } from "../../dist/agent/context-prompt.mjs";
import { createNativeRuntimeAdapter } from "../../dist/runtime/runtime-adapters.mjs";
import {
  gradeMentionConstructionTrace,
  loadMentionConstructionEval,
} from "../support/mention-construction-grader.mjs";

const RUN = process.env.LARKIN_RUN_MENTION_CONSTRUCTION_EVAL === "1";
const ROOT = path.resolve(import.meta.dirname, "../..");
const FAKE = path.join(ROOT, "test/support/mention-construction-eval-cli.mjs");
const DATASET = loadMentionConstructionEval(path.join(ROOT, "evals/mention-construction/scenarios.json"));
const SCENARIO = DATASET.scenarios.find((scenario) => scenario.id === "wake-other-agent-with-real-mention");

function waitForTurnEnd(events, after, timeoutMs = 9 * 60_000) {
  return new Promise((resolve, reject) => {
    const find = () => events.items.slice(after).find((event) => event.type === "turn-end");
    if (find()) return resolve(find());
    const timer = setTimeout(() => reject(new Error("native mention-construction eval timed out")), timeoutMs);
    events.waiters.push(() => { const found = find(); if (found) { clearTimeout(timer); resolve(found); } });
  });
}

async function promptWhenReady(session, input, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await session.prompt(input);
    if (result.status !== "deferred" || !/not initialized/i.test(result.reason || "")) return result;
    if (Date.now() >= deadline) throw new Error("native mention-construction eval initialization timed out");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test.skipIf(!RUN)("native Runtime constructs a real Feishu mention element to wake another Agent", { timeout: 10 * 60_000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-mention-construction-native-eval-"));
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
      "# Controlled mention-construction eval",
      "Use only larkin commands explicitly requested by the task; never invoke bare lark-cli.",
      "Do not inspect or edit files or environment state.",
      "A real Feishu mention element is required to wake another Agent; plain-text @ never produces a mention event.", "",
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
      agentId: "cli_mentionEvalA1", workspaceDir, stateDir,
      standingPrompt: new ContextPromptBuilder().build({ agentId: "cli_mentionEvalA1", name: "Mention Eval", runtime: "codex" }),
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
      inputId: "wake-other-agent-with-real-mention", kind: "initial", attempt: 0,
      text: SCENARIO.prompt.replaceAll("{larkin}", JSON.stringify(path.join(binDir, "larkin"))),
    });
    assert.equal(accepted.status, "accepted");
    await waitForTurnEnd(events, after);
    const runtimeError = events.items.slice(after).find((event) => ["error", "configuration-error", "input-error"].includes(event.type));
    assert.equal(runtimeError, undefined, runtimeError?.message);
    const trace = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
    const grade = gradeMentionConstructionTrace(SCENARIO, trace);
    process.stderr.write(`# mention-construction native eval: ${JSON.stringify({
      runtime: "codex", model, grade, trace,
      event_types: events.items.slice(after).map((event) => event.type),
      output_tail: events.items.slice(after).filter((event) => typeof event.text === "string").map((event) => event.text).slice(-5),
      command_audit: { count: commandAudit.length, commands: commandAudit.map((event) => event.command) },
    })}\n`);
    assert.equal(grade.passed, true, JSON.stringify(grade.failures));
  } finally {
    await session?.close("mention-construction eval complete");
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
