import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "bun:test";

// Opt-in real local CLI workflow: no model, network, credentials or Feishu.
const enabled = process.env.LARKIN_RUN_TMUX_WORKFLOW === "1";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.skipIf(!enabled)("real tmux preserves non-Git Bash cwd, >60s command lifetime, ownership and cancellation", async () => {
  const { createLarkinTmux, tmuxAvailable } = await import("../../../src/runtime/pi-tmux.ts");
  assert.equal(tmuxAvailable(), true, "explicit real workflow requires tmux");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-real-"));
  const cwd = path.join(root, "ordinary folder with spaces");
  fs.mkdirSync(cwd, { mode: 0o700 });
  assert.equal(fs.existsSync(path.join(cwd, ".git")), false);
  const shared = { stateDir: path.join(root, "state"), agentId: "tmux-workflow" };
  const first = createLarkinTmux({ ...shared, instanceId: "first" });
  const second = createLarkinTmux({ ...shared, instanceId: "second" });
  const owned = [];
  try {
    const command = [
      "parts=(ordinary directory)",
      "[[ ${parts[1]} == directory ]] || exit 41",
      "printf '%s\\n' \"$PWD\" > cwd.txt",
      "printf '%s\\n' \"$$\" > command.pid",
      "date +%s > started.txt",
      "sleep 65",
      "date +%s > finished.txt",
      "printf '%s\\n' LARKIN_TMUX_REAL_DONE",
    ].join("\n");
    const task = first.start(command, cwd);
    owned.push(task.taskId);
    const startedWaiting = Date.now();
    const initial = await first.wait(task.taskId, 0.25);
    assert.equal(initial.status, "running");
    assert.ok(Date.now() - startedWaiting < 5_000, "foreground wait must return early");
    for (let attempt = 0; !fs.existsSync(path.join(cwd, "started.txt")) && attempt < 100; attempt++) await sleep(50);
    assert.equal(fs.readFileSync(path.join(cwd, "cwd.txt"), "utf8").trim(), cwd);
    const startedSeconds = Number(fs.readFileSync(path.join(cwd, "started.txt"), "utf8").trim());
    const pid = Number(fs.readFileSync(path.join(cwd, "command.pid"), "utf8").trim());
    assert.ok(Number.isInteger(pid) && pid > 1);
    assert.throws(() => second.peek(task.taskId), /not owned|foreign/i);
    assert.throws(() => second.kill(task.taskId), /not owned|foreign/i);
    assert.deepEqual(second.list(), []);

    // Timestamp is produced inside the command, not before model/tool startup.
    await sleep(Math.max(0, startedSeconds * 1_000 + 61_100 - Date.now()));
    assert.equal(fs.existsSync(path.join(cwd, "finished.txt")), false, "command must still be executing after 60 seconds");
    const alive = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8" });
    assert.equal(alive.status, 0, "original Bash process must still exist");
    assert.ok(alive.stdout.trim() && !alive.stdout.trim().startsWith("Z"), "original process must not be a zombie");
    assert.equal(first.peek(task.taskId).status, "running");

    const finished = await first.wait(task.taskId, 15);
    assert.equal(finished.status, "completed");
    assert.equal(finished.exitCode, 0);
    assert.match(finished.output, /LARKIN_TMUX_REAL_DONE/);
    const finishedSeconds = Number(fs.readFileSync(path.join(cwd, "finished.txt"), "utf8").trim());
    assert.ok(finishedSeconds - startedSeconds >= 65, "real command lifetime must exceed 60 seconds");

    const cancellable = first.start("trap '' HUP TERM\nprintf '%s\\n' \"$$\" > cancelled.pid\nsleep 120", cwd);
    owned.push(cancellable.taskId);
    for (let attempt = 0; !fs.existsSync(path.join(cwd, "cancelled.pid")) && attempt < 100; attempt++) await sleep(50);
    const cancelPid = Number(fs.readFileSync(path.join(cwd, "cancelled.pid"), "utf8").trim());
    const cancelled = first.kill(cancellable.taskId);
    assert.equal(cancelled.status, "cancelled");
    for (let attempt = 0; attempt < 40; attempt++) {
      const probe = spawnSync("ps", ["-p", String(cancelPid), "-o", "stat="], { encoding: "utf8" });
      if (probe.status !== 0 || !probe.stdout.trim() || probe.stdout.trim().startsWith("Z")) break;
      await sleep(50);
    }
    const gone = spawnSync("ps", ["-p", String(cancelPid), "-o", "stat="], { encoding: "utf8" });
    assert.ok(gone.status !== 0 || !gone.stdout.trim() || gone.stdout.trim().startsWith("Z"), "cancel must end original command, including ignored TERM");
    console.log(`[real-tmux] command lived ${finishedSeconds - startedSeconds}s; non-Git cwd, Bash syntax, ownership and cancellation passed`);
  } finally {
    let cleanupComplete = true;
    for (const id of owned) {
      try { if (first.peek(id).status === "running") first.kill(id); } catch { cleanupComplete = false; }
    }
    if (cleanupComplete) fs.rmSync(root, { recursive: true, force: true });
    else console.error(`[real-tmux] cleanup failed; task state retained at ${root}`);
  }
}, { timeout: 100_000 });
