import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { registerLarkinTmuxExtension } from "../../../src/runtime/pi-tmux-extension.ts";
import { LARKIN_TMUX_COMPLETION_TYPE, tmuxAvailable } from "../../../src/runtime/pi-tmux.ts";

function restoreEnv(name, previous) {
  if (previous === undefined) delete process.env[name];
  else process.env[name] = previous;
}

test("missing tmux leaves native bash unregistered", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-ext-no-tmux-"));
  const previous = process.env.PATH;
  const tools = [];
  try {
    process.env.PATH = empty;
    const registered = registerLarkinTmuxExtension({
      registerTool(tool) { tools.push(tool.name); },
      on() {},
      sendMessage() {},
    });
    assert.equal(registered, false);
    assert.deepEqual(tools, []);
  } finally {
    process.env.PATH = previous;
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("session_shutdown stops watchers and does not send a completion", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-ext-watch-"));
  const previous = {
    LARKIN_STATE_DIR: process.env.LARKIN_STATE_DIR,
    LARKIN_AGENT_ID: process.env.LARKIN_AGENT_ID,
    LARKIN_TMUX_INSTANCE_ID: process.env.LARKIN_TMUX_INSTANCE_ID,
  };
  const tools = new Map();
  const messages = [];
  let shutdown;
  try {
    process.env.LARKIN_STATE_DIR = path.join(root, "state");
    process.env.LARKIN_AGENT_ID = "cli_tmuxWatchA1";
    process.env.LARKIN_TMUX_INSTANCE_ID = "inst-watch";
    assert.equal(registerLarkinTmuxExtension({
      registerTool(tool) { tools.set(tool.name, tool); },
      on(event, handler) { if (event === "session_shutdown") shutdown = handler; },
      sendMessage(message) { messages.push(message); },
    }), true);
    const bash = tools.get("bash");
    const result = await bash.execute(
      "call-1",
      { command: "sleep 0.4; printf done\\n", timeout: 0, background: false },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.equal(result.details.status, "running");
    assert.match(result.content[0].text, /taskId=/);
    shutdown();
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(messages.length, 0);
    const tmux = tools.get("tmux");
    const peek = await tmux.execute("call-2", { action: "peek", taskId: result.details.taskId });
    assert.ok(["running", "completed"].includes(peek.details.status));
    const killed = await tmux.execute("call-3", { action: "kill", taskId: result.details.taskId });
    assert.ok(["cancelled", "completed"].includes(killed.details.status));
    const foreign = await tmux.execute("call-4", { action: "peek", taskId: "deadbeefdeadbeef" });
    assert.match(foreign.content[0].text, /not owned/);
    assert.equal(LARKIN_TMUX_COMPLETION_TYPE, "larkin-tmux-completion");
  } finally {
    restoreEnv("LARKIN_STATE_DIR", previous.LARKIN_STATE_DIR);
    restoreEnv("LARKIN_AGENT_ID", previous.LARKIN_AGENT_ID);
    restoreEnv("LARKIN_TMUX_INSTANCE_ID", previous.LARKIN_TMUX_INSTANCE_ID);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
