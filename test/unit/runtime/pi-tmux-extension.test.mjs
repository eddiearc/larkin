import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

test.skipIf(!tmuxAvailable())("a configured socket adds an attach hint only while the task runs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-ext-socket-"));
  const socket = `larkin-ext-${process.pid}-${Date.now()}`;
  const previous = {
    LARKIN_STATE_DIR: process.env.LARKIN_STATE_DIR,
    LARKIN_AGENT_ID: process.env.LARKIN_AGENT_ID,
    LARKIN_TMUX_INSTANCE_ID: process.env.LARKIN_TMUX_INSTANCE_ID,
    LARKIN_TMUX_SOCKET: process.env.LARKIN_TMUX_SOCKET,
  };
  const tools = new Map();
  try {
    process.env.LARKIN_STATE_DIR = path.join(root, "state");
    process.env.LARKIN_AGENT_ID = "cli_tmuxSocketExtA1";
    process.env.LARKIN_TMUX_INSTANCE_ID = "inst-socket-ext";
    process.env.LARKIN_TMUX_SOCKET = socket;
    assert.equal(registerLarkinTmuxExtension({
      registerTool(tool) { tools.set(tool.name, tool); },
      on() {},
      sendMessage() {},
    }), true);
    const bash = tools.get("bash");
    const running = await bash.execute(
      "socket-call-1",
      { command: "sleep 30", background: true },
      undefined,
      undefined,
      { cwd: root },
    );
    assert.equal(running.details.status, "running");
    assert.match(running.content[0].text, new RegExp(`attach: tmux -L ${socket} attach -t =lkn-`));
    const tmux = tools.get("tmux");
    const list = await tmux.execute("socket-call-2", { action: "list" });
    assert.equal(list.content[0].text.includes("attach:"), false);
    const killed = await tmux.execute("socket-call-3", { action: "kill", taskId: running.details.taskId });
    assert.equal(killed.details.status, "cancelled");
    assert.equal(killed.content[0].text.includes("attach:"), false, "a finished task must not advertise an attach hint");
  } finally {
    restoreEnv("LARKIN_STATE_DIR", previous.LARKIN_STATE_DIR);
    restoreEnv("LARKIN_AGENT_ID", previous.LARKIN_AGENT_ID);
    restoreEnv("LARKIN_TMUX_INSTANCE_ID", previous.LARKIN_TMUX_INSTANCE_ID);
    restoreEnv("LARKIN_TMUX_SOCKET", previous.LARKIN_TMUX_SOCKET);
    spawnSync("tmux", ["-L", socket, "kill-server"], { encoding: "utf8", timeout: 5_000 });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
