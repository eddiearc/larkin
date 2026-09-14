import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import {
  createLarkinTmux,
  formatTmuxTaskText,
  tmuxAvailable,
  tmuxSessionName,
  tmuxSocketName,
} from "../../../src/runtime/pi-tmux.ts";

const SOCKET = `larkin-test-${process.pid}-${Date.now()}`;

test("tmux socket name validation accepts names, treats blank as unset, and rejects unsafe values", () => {
  assert.equal(tmuxSocketName({}), null);
  assert.equal(tmuxSocketName({ LARKIN_TMUX_SOCKET: "   " }), null);
  assert.equal(tmuxSocketName({ LARKIN_TMUX_SOCKET: " larkin-prod_1.x " }), "larkin-prod_1.x");
  assert.throws(() => tmuxSocketName({ LARKIN_TMUX_SOCKET: "bad name" }), /LARKIN_TMUX_SOCKET/);
  assert.throws(() => tmuxSocketName({ LARKIN_TMUX_SOCKET: "a".repeat(65) }), /LARKIN_TMUX_SOCKET/);
  assert.throws(() => tmuxSocketName({ LARKIN_TMUX_SOCKET: "." }), /LARKIN_TMUX_SOCKET/);
  assert.throws(() => tmuxSocketName({ LARKIN_TMUX_SOCKET: ".." }), /LARKIN_TMUX_SOCKET/);
});

test("task text carries an attach hint only when a socket is configured", () => {
  const snapshot = { taskId: "t1", status: "running", exitCode: null, output: "", startedAt: null, endedAt: null };
  assert.equal(formatTmuxTaskText(snapshot), "taskId=t1 status=running exitCode=null");
  assert.equal(
    formatTmuxTaskText(snapshot, { attachHint: "tmux -L larkin attach -t lkn-x" }),
    "taskId=t1 status=running exitCode=null\nattach: tmux -L larkin attach -t lkn-x",
  );
});

test.skipIf(!tmuxAvailable())("a dedicated socket keeps task sessions off the default server", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-socket-"));
  const env = { ...process.env, LARKIN_TMUX_SOCKET: SOCKET };
  try {
    const tmux = createLarkinTmux({ stateDir: path.join(root, "state"), agentId: "cli_tmuxSocketA1", instanceId: "inst-socket", env });

    // While a task runs, its session exists on the dedicated socket and nowhere else.
    // (Completed tasks are killed by larkin, so the check has to happen mid-flight.)
    const running = tmux.start("sleep 30", root);
    const runningSession = tmuxSessionName("cli_tmuxSocketA1", "inst-socket", running.taskId);
    const onSocket = spawnSync("tmux", ["-L", SOCKET, "has-session", "-t", `=${runningSession}`], { encoding: "utf8", timeout: 5_000 });
    const onDefault = spawnSync("tmux", ["has-session", "-t", `=${runningSession}`], { encoding: "utf8", timeout: 5_000 });
    assert.equal(onSocket.status, 0, onSocket.stderr || onSocket.stdout);
    assert.notEqual(onDefault.status, 0, "the default server must not know this session");
    tmux.kill(running.taskId);

    // The task lifecycle itself is unchanged on the dedicated socket.
    const quick = tmux.start("echo socket-ok", root);
    const finished = await tmux.wait(quick.taskId, 15);
    assert.equal(finished.status, "completed", JSON.stringify(finished));
    assert.match(finished.output, /socket-ok/);
  } finally {
    spawnSync("tmux", ["-L", SOCKET, "kill-server"], { encoding: "utf8", timeout: 5_000 });
    fs.rmSync(root, { recursive: true, force: true });
  }
});
