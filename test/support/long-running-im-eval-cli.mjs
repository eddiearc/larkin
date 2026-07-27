#!/usr/bin/env bun

import fs from "node:fs";

const scenarioFile = process.env.LARKIN_EVAL_SCENARIO_FILE;
const traceFile = process.env.LARKIN_EVAL_TRACE_FILE;
if (!scenarioFile || !traceFile) {
  process.stderr.write("eval CLI requires LARKIN_EVAL_SCENARIO_FILE and LARKIN_EVAL_TRACE_FILE\n");
  process.exit(2);
}

const scenario = JSON.parse(fs.readFileSync(scenarioFile, "utf8"));
const argv = process.argv.slice(2);

function option(name) {
  const equals = argv.find((item) => item.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
}

function append(event) {
  let count = 0;
  try { count = fs.readFileSync(traceFile, "utf8").split("\n").filter(Boolean).length; } catch {}
  fs.appendFileSync(traceFile, `${JSON.stringify({ order: count + 1, case_id: scenario.id, ...event })}\n`, { mode: 0o600 });
}

if (argv[0] === "im" && argv[1] === "+messages-send") {
  const body = option("--markdown") ?? option("--text");
  const chatId = option("--chat-id");
  if (typeof body !== "string" || !body.trim()) {
    process.stderr.write("fake IM requires a non-empty --markdown or --text body\n");
    process.exit(2);
  }
  if (chatId !== scenario.im_target?.id || scenario.im_target?.type !== "chat_id") {
    process.stderr.write(`fake IM requires --chat-id ${scenario.im_target?.id || "<scenario chat>"}\n`);
    process.exit(2);
  }
  append({ type: "im", target_type: "chat_id", target_id: chatId, body });
  process.stdout.write(`${JSON.stringify({ ok: true, data: { message_id: `om_eval_${Date.now()}` } })}\n`);
  process.exit(0);
}

if (argv[0] === "work" && argv[1] === "run") {
  const stepId = option("--step");
  const step = scenario.steps.find((item) => item.id === stepId);
  if (!step) {
    process.stderr.write(`unknown eval work step: ${stepId || "missing"}\n`);
    process.exit(2);
  }
  append({ type: "work", step_id: step.id, slow: step.slow, outcome: step.outcome });
  const output = `${JSON.stringify({ step_id: step.id, outcome: step.outcome, output: step.output })}\n`;
  if (step.outcome === "failure") {
    process.stderr.write(output);
    process.exit(1);
  }
  process.stdout.write(output);
  process.exit(0);
}

process.stderr.write("fake eval CLI only supports im +messages-send and work run\n");
process.exit(2);
