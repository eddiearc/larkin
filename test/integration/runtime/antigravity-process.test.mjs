import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "bun:test";
import { createNativeRuntimeAdapter } from "../../../dist/runtime/runtime-adapters.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const FAKE_AGY = String.raw`
const fs = require("node:fs");
const log = (entry) => fs.appendFileSync(process.env.FAKE_AGY_LOG, JSON.stringify(entry) + "\n");
const args = process.argv.slice(2);
log({ args, cwd: process.cwd() });
if (args[0] === "--version") { console.log("agy 1.5.7-fake"); process.exit(0); }
if (args[0] === "models") {
  console.log([
    "gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)",
    "gemini-4-neon-high             Gemini 4 Neon (High)",
    "gemini-4-neon-medium           Gemini 4 Neon (Medium) (default)",
    "gemini-4-neon-low              Gemini 4 Neon (Low)",
    "gemini-pro-orchestrator-neon   Orchestrator (Neon)",
  ].join("\n"));
  process.exit(0);
}
if (!args.includes("stream-json")) process.exit(2);
const send = (message) => process.stdout.write(JSON.stringify(message) + "\n");
const modelFlag = args.indexOf("--model");
const model = modelFlag >= 0 ? args[modelFlag + 1] : undefined;
const convFlag = args.indexOf("--conversation");
const conversationId = convFlag >= 0 ? args[convFlag + 1] : "agy-session-1";
let turns = 0;
let buffer = "";
send({ event: "init", conversation_id: conversationId, init: { cwd: process.cwd(), permission_mode: "always-proceed", ...(model ? { model } : {}) } });
process.stdin.on("end", () => process.exit(0));
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    log({ received: message });
    turns += 1;
    const content = message.message?.content;
    const text = Array.isArray(content) ? content.map((b) => b.text).join("") : String(content || "");
    send({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turns * 10, state: "DONE", step_type: "user_input" } });
    send({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turns * 10 + 1, state: "ACTIVE", step_type: "agent_response", text_delta: "收到：" } });
    send({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turns * 10 + 1, state: "DONE", step_type: "agent_response", text_delta: text } });
    send({ event: "step_update", step_update: { conversation_id: conversationId, step_index: turns * 10 + 2, state: "DONE", step_type: "tool", tool_name: "run_command", tool_info: { name: "run_command", parameters: { CommandLine: "echo ok" }, output: "ok\n" } } });
    send({ event: "result", result: { conversation_id: conversationId, status: "SUCCESS", response: "收到：" + text, num_turns: turns } });
  }
});
`;

function fakeAgyInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-agy-"));
  roots.push(root);
  const bin = path.join(root, "bin", "agy");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!${process.execPath}\n${FAKE_AGY}`, { mode: 0o755 });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return { root, bin, workspace, log: path.join(root, "agy.log") };
}

const readLog = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("an Antigravity Agent probes, writes standing prompt rule, and completes multi-turn stream-json with effort", { timeout: 20_000 }, async () => {
  const { root, bin, workspace, log } = fakeAgyInstall();
  const env = { LARKIN_ANTIGRAVITY_COMMAND: bin, FAKE_AGY_LOG: log };
  const adapter = createNativeRuntimeAdapter("antigravity", { env });
  const readiness = await adapter.probe({ agentId: "cli_agy", workspaceDir: workspace, stateDir: path.join(root, "state"), env });
  assert.equal(readiness.state, "ready");
  assert.equal(readiness.executable, bin);
  assert.equal(readiness.version, "agy 1.5.7-fake");

  const session = await adapter.createSession({
    agentId: "cli_agy",
    workspaceDir: workspace,
    stateDir: path.join(root, "state"),
    env,
    standingPrompt: { version: "v-test", content: "Larkin standing prompt body", hash: "h" },
    model: "gemini-4-neon-medium",
    reasoningEffort: "high",
  });
  const events = [];
  let turnEnds = 0;
  let resolveSecond;
  const secondEnded = new Promise((resolve) => { resolveSecond = resolve; });
  session.subscribe((event) => {
    events.push(event);
    if (event.type === "turn-end") {
      turnEnds += 1;
      if (turnEnds === 2) resolveSecond();
    }
  });

  while (!session.sessionId) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(await session.prompt({ inputId: "i1", kind: "initial", text: "你好" }), { status: "accepted", inputId: "i1" });
  assert.deepEqual(await session.busyInput({ inputId: "i2", kind: "inbox_update", text: "补充一句" }), { status: "accepted", inputId: "i2" });
  await secondEnded;
  await session.close("test done");

  const rule = fs.readFileSync(path.join(workspace, ".agents", "rules", "larkin-standing-prompt.md"), "utf8");
  assert.equal(rule, "---\ntrigger: always_on\ndescription: \"Larkin standing prompt\"\n---\nLarkin standing prompt body\n");

  const entries = readLog(log);
  const launch = entries.find((entry) => entry.args?.includes("stream-json"));
  assert.deepEqual(launch.args, [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--dangerously-skip-permissions",
    "--disable-slash-commands",
    "--model", "gemini-4-neon-high",
    "--effort", "high",
  ]);
  assert.equal(fs.realpathSync(launch.cwd), fs.realpathSync(workspace));
  assert.equal(session.sessionId, "agy-session-1");
  assert.deepEqual(
    events.filter((event) => event.type === "text-delta").map((event) => event.text),
    ["收到：", "你好", "收到：", "补充一句"],
  );
  assert.equal(events.filter((event) => event.type === "tool-result" && event.ok).length, 2);
});

test("a missing agy binary is reported as not installed with the install hint", async () => {
  const { root, workspace } = fakeAgyInstall();
  const env = { LARKIN_ANTIGRAVITY_COMMAND: path.join(root, "bin", "no-such-agy") };
  const readiness = await createNativeRuntimeAdapter("antigravity", { env }).probe({ agentId: "cli_agy", workspaceDir: workspace, env });
  assert.equal(readiness.state, "missing");
  assert.match(readiness.nextAction, /agy.*LARKIN_ANTIGRAVITY_COMMAND/);
});
