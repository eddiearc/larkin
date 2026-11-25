import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "bun:test";
import { createNativeRuntimeAdapter } from "../../../dist/runtime/runtime-adapters.mjs";

const roots = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

const FAKE_CURSOR = String.raw`
const fs = require("node:fs");
const log = (entry) => fs.appendFileSync(process.env.FAKE_CURSOR_LOG, JSON.stringify(entry) + "\n");
const args = process.argv.slice(2);
log({ args, cwd: process.cwd() });
if (args[0] === "--version") { console.log("2026.11.22-fake"); process.exit(0); }
if (args[0] === "models") { console.log("Available models\n\nauto - Auto (default)\ngpt-5.5 - GPT-5.5"); process.exit(0); }
if (args.at(-1) !== "acp") process.exit(2);
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });
let buffer = "";
let pendingPermission = null;
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) >= 0) {
    const message = JSON.parse(buffer.slice(0, newline));
    buffer = buffer.slice(newline + 1);
    log({ received: message });
    if (message.method === "initialize") send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } });
    if (message.method === "session/new") send({ id: message.id, result: { sessionId: "fake-session", models: { currentModelId: "auto" } } });
    if (message.method === "session/prompt") {
      const sessionId = message.params.sessionId;
      update(sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "收到：" + message.params.prompt[0].text } });
      update(sessionId, { sessionUpdate: "tool_call", toolCallId: "t1", kind: "execute", title: "echo", status: "pending", rawInput: { command: "echo ok" } });
      pendingPermission = { promptId: message.id, sessionId };
      send({ id: 77, method: "session/request_permission", params: { sessionId, toolCall: { toolCallId: "t1" },
        options: [{ optionId: "deny", kind: "reject_once" }, { optionId: "allow", kind: "allow_once" }] } });
    }
    if (message.id === 77 && pendingPermission) {
      const { promptId, sessionId } = pendingPermission;
      pendingPermission = null;
      update(sessionId, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: message.result.outcome.optionId === "allow" ? "completed" : "failed" });
      send({ id: promptId, result: { stopReason: "end_turn" } });
    }
  }
});
`;

function fakeCursorInstall() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-cursor-acp-"));
  roots.push(root);
  const bin = path.join(root, "bin", "cursor-agent");
  fs.mkdirSync(path.dirname(bin), { recursive: true });
  fs.writeFileSync(bin, `#!${process.execPath}\n${FAKE_CURSOR}`, { mode: 0o755 });
  const workspace = path.join(root, "workspace");
  fs.mkdirSync(workspace, { recursive: true });
  return { root, bin, workspace, log: path.join(root, "cursor.log") };
}

const readLog = (file) => fs.readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line));

test("a Cursor Agent runs a real turn through the cursor-agent acp process", { timeout: 20_000 }, async () => {
  const { root, bin, workspace, log } = fakeCursorInstall();
  const env = { LARKIN_CURSOR_COMMAND: bin, FAKE_CURSOR_LOG: log };
  const adapter = createNativeRuntimeAdapter("cursor", { env });
  const readiness = await adapter.probe({ agentId: "cli_cursor", workspaceDir: workspace, stateDir: path.join(root, "state"), env });
  assert.equal(readiness.state, "ready");
  assert.equal(readiness.executable, bin);

  const session = await adapter.createSession({
    agentId: "cli_cursor", workspaceDir: workspace, stateDir: path.join(root, "state"), env,
    standingPrompt: { version: "v-test", content: "Larkin standing prompt body", hash: "h" }, model: "default",
  });
  const events = [];
  const ended = new Promise((resolve) => session.subscribe((event) => { events.push(event); if (event.type === "turn-end") resolve(); }));
  const initialized = async () => { while (!session.sessionId) await new Promise((resolve) => setTimeout(resolve, 10)); };
  await initialized();
  assert.deepEqual(await session.prompt({ inputId: "i1", kind: "initial", text: "你好" }), { status: "accepted", inputId: "i1" });
  await ended;
  await session.close("test done");

  const rule = fs.readFileSync(path.join(workspace, ".cursor", "rules", "larkin-standing-prompt.mdc"), "utf8");
  assert.equal(rule, "---\ndescription: Larkin standing prompt\nalwaysApply: true\n---\nLarkin standing prompt body\n");
  const entries = readLog(log);
  const launch = entries.find((entry) => entry.args?.at(-1) === "acp");
  assert.deepEqual(launch.args, ["acp"], "an unpinned model leaves the user's Cursor default alone");
  assert.equal(fs.realpathSync(launch.cwd), fs.realpathSync(workspace));
  assert.deepEqual(entries.find((entry) => entry.received?.id === 77)?.received.result, { outcome: { outcome: "selected", optionId: "allow" } });
  assert.deepEqual(events.filter((event) => event.type !== "activity" || event.activity === "tool").map((event) => event.type === "activity" ? `tool:${event.text}` : event.type), [
    "session-init", "turn-start", "text-delta", "tool:echo ok", "tool-result", "turn-end",
  ]);
  assert.equal(events.find((event) => event.type === "text-delta").text, "收到：你好");
  assert.equal(events.find((event) => event.type === "tool-result").ok, true);
});

test("a missing cursor-agent is reported as not installed with the install hint", async () => {
  const { root, workspace } = fakeCursorInstall();
  const env = { LARKIN_CURSOR_COMMAND: path.join(root, "bin", "no-such-cursor-agent") };
  const readiness = await createNativeRuntimeAdapter("cursor", { env }).probe({ agentId: "cli_cursor", workspaceDir: workspace, env });
  assert.equal(readiness.state, "missing");
  assert.match(readiness.nextAction, /cursor-agent.*LARKIN_CURSOR_COMMAND/);
});
