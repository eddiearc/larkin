import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "bun:test";
import {
  createLarkinTmux,
  ForeignTmuxTaskError,
  formatTmuxTaskText,
  tmuxAvailable,
} from "../../../src/runtime/pi-tmux.ts";

const leftovers = [];

afterEach(() => {
  for (const session of leftovers.splice(0)) {
    spawnSync("tmux", ["kill-session", "-t", session], { encoding: "utf8", timeout: 5_000 });
  }
});

function track(tmux, snapshot) {
  const meta = JSON.parse(fs.readFileSync(path.join(tmux.root, snapshot.taskId, "meta.json"), "utf8"));
  leftovers.push(meta.session);
  return snapshot;
}

function makeTmux(root, instanceId, agentId = "cli_tmuxSameA1") {
  return createLarkinTmux({
    stateDir: path.join(root, "state"),
    agentId,
    instanceId,
    env: process.env,
  });
}

test.skipIf(process.platform === "win32")("tmux capability probe refuses versions without the required session environment support", () => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-version-"));
  fs.writeFileSync(path.join(bin, "tmux"), "#!/bin/sh\nprintf 'tmux %s\\n' \"$LARKIN_TEST_TMUX_VERSION\"\n", { mode: 0o700 });
  try {
    for (const [version, expected] of [["2.9a", false], ["3.1c", false], ["3.2a", true], ["3.6a", true], ["4.0", true], ["unknown", false]]) {
      assert.equal(tmuxAvailable({ PATH: bin, LARKIN_TEST_TMUX_VERSION: version }, "linux"), expected, version);
    }
  } finally { fs.rmSync(bin, { recursive: true, force: true }); }
});

test.skipIf(!tmuxAvailable())("BASH_ENV runs once for the user command, never in the internal runner", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-bashenv-"));
  const hook = path.join(root, "hook.sh");
  const hits = path.join(root, "hits");
  fs.writeFileSync(hook, "printf 'hit\\n' >> \"$LARKIN_HOOK_LOG\"\n", { mode: 0o600 });
  const manager = createLarkinTmux({ stateDir: path.join(root, "state"), agentId: "hook-test", env: {
    ...process.env, TMUX_TMPDIR: root, BASH_ENV: hook, LARKIN_HOOK_LOG: hits,
  } });
  let task;
  try {
    task = manager.start("printf 'user-command\\n'", root);
    const done = await manager.wait(task.taskId, 5);
    assert.equal(done.exitCode, 0);
    assert.equal(done.output.trim(), "user-command");
    assert.equal(fs.readFileSync(hits, "utf8"), "hit\n");
  } finally {
    if (task && manager.peek(task.taskId).status === "running") manager.kill(task.taskId);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("an absent owned session never resolves to another session with its name as a prefix", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-prefix-"));
  const manager = makeTmux(root, "prefix");
  let neighbor;
  try {
    const task = track(manager, manager.start("sleep 30", root));
    const meta = JSON.parse(fs.readFileSync(path.join(manager.root, task.taskId, "meta.json"), "utf8"));
    spawnSync("tmux", ["kill-session", "-t", `=${meta.session}`]);
    neighbor = `${meta.session}-neighbor`;
    assert.equal(spawnSync("tmux", ["new-session", "-d", "-s", neighbor, "sleep 30"]).status, 0);
    assert.equal(manager.peek(task.taskId).status, "failed");
    manager.kill(task.taskId);
    assert.equal(spawnSync("tmux", ["has-session", "-t", `=${neighbor}`]).status, 0);
  } finally {
    if (neighbor) spawnSync("tmux", ["kill-session", "-t", `=${neighbor}`]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("terminal exit metadata is not rewritten as cancelled while the pane is still closing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-terminal-"));
  const manager = makeTmux(root, "terminal");
  let session;
  try {
    const task = manager.start("sleep 30", root);
    const dir = path.join(manager.root, task.taskId);
    session = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")).session;
    // Stage the producer's terminal-metadata/session-close race deterministically.
    fs.writeFileSync(path.join(dir, "exit_code"), "0\n");
    assert.equal(manager.kill(task.taskId).status, "completed");
    assert.equal(fs.existsSync(path.join(dir, "cancelled")), false);
    assert.equal(spawnSync("tmux", ["has-session", "-t", `=${session}`]).status, 0);
  } finally {
    if (session) spawnSync("tmux", ["kill-session", "-t", `=${session}`]);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("start refuses a symlink owned tree before writing env secrets", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-owned-link-"));
  const secret = "larkin-tmux-boundary-secret";
  const assertNoLeak = (outside) => {
    assert.equal(fs.readdirSync(outside).length, 0);
    const leaked = spawnSync("grep", ["-R", secret, outside], { encoding: "utf8", timeout: 5_000 });
    assert.notEqual(leaked.status, 0);
  };
  try {
    const stateDir = path.join(root, "state-root");
    fs.mkdirSync(stateDir, { recursive: true });
    const outside = path.join(root, "outside-root");
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(stateDir, "pi-tmux"));
    const tmux = createLarkinTmux({
      stateDir,
      agentId: "cli_tmuxSameA1",
      instanceId: "inst-owned",
      env: { ...process.env, LARKIN_TMUX_TEST_SECRET: secret },
    });
    assert.throws(() => tmux.start("true", root), /unsafe private directory/);
    assert.equal(fs.lstatSync(path.join(stateDir, "pi-tmux")).isSymbolicLink(), true);
    assertNoLeak(outside);

    const nested = path.join(root, "state-inst");
    const agentDir = path.join(nested, "pi-tmux", "cli_tmuxSameA1");
    fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
    const outsideInst = path.join(root, "outside-inst");
    fs.mkdirSync(outsideInst);
    fs.symlinkSync(outsideInst, path.join(agentDir, "inst-owned"));
    const nestedTmux = createLarkinTmux({
      stateDir: nested,
      agentId: "cli_tmuxSameA1",
      instanceId: "inst-owned",
      env: { ...process.env, LARKIN_TMUX_TEST_SECRET: secret },
    });
    assert.throws(() => nestedTmux.start("true", root), /unsafe private directory/);
    assert.equal(fs.lstatSync(path.join(agentDir, "inst-owned")).isSymbolicLink(), true);
    assertNoLeak(outsideInst);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("start accepts a symlink cwd without treating it as an owned-tree escape", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-cwdlink-"));
  const realCwd = path.join(root, "real cwd");
  const cwd = path.join(root, "link cwd");
  fs.mkdirSync(realCwd, { recursive: true });
  fs.symlinkSync(realCwd, cwd);
  const tmux = makeTmux(root, "inst-cwdlink");
  try {
    const started = track(tmux, tmux.start("printf '%s\\n' \"$PWD\" > marker.txt", cwd));
    const done = await tmux.wait(started.taskId, 5);
    assert.equal(done.status, "completed");
    assert.equal(fs.readFileSync(path.join(realCwd, "marker.txt"), "utf8").trim(), cwd);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("tmuxAvailable is false when PATH has no tmux binary", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-no-tmux-"));
  try {
    assert.equal(tmuxAvailable({ ...process.env, PATH: empty }, "linux"), false);
    assert.equal(tmuxAvailable(process.env, "win32"), false);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("owned bash keeps a spaced non-git cwd and records a real exit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-cwd-"));
  const cwd = path.join(root, "work dir");
  fs.mkdirSync(cwd, { recursive: true });
  const tmux = makeTmux(root, "inst-cwd");
  try {
    const started = track(tmux, tmux.start("pwd; printf '%s\\n' \"$PWD\" > marker.txt", cwd));
    const done = await tmux.wait(started.taskId, 5);
    assert.equal(done.status, "completed");
    assert.equal(done.exitCode, 0);
    assert.match(done.output, /work dir/);
    assert.equal(fs.readFileSync(path.join(cwd, "marker.txt"), "utf8").trim(), cwd);
    assert.equal(fs.existsSync(path.join(cwd, ".git")), false);
    assert.match(formatTmuxTaskText(done), /taskId=/);
    assert.match(formatTmuxTaskText(done), /status=completed/);
    assert.ok(done.startedAt);
    assert.ok(done.endedAt);
    const dir = path.join(tmux.root, started.taskId);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, "run.sh")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(dir, "env.sh")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("user command keeps Bash arrays, [[, and pipefail", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-bash-"));
  const tmux = makeTmux(root, "inst-bash");
  try {
    const arrays = track(tmux, tmux.start("arr=(alpha beta)\n[[ ${arr[1]} == beta ]] && printf '%s\\n' \"${arr[0]}\"", root));
    const done = await tmux.wait(arrays.taskId, 5);
    assert.equal(done.status, "completed");
    assert.match(done.output, /alpha/);
    const piped = track(tmux, tmux.start("false | true", root));
    const failed = await tmux.wait(piped.taskId, 5);
    assert.equal(failed.status, "failed");
    assert.equal(failed.exitCode, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("wait timeout hands off a still-running job without killing it", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-handoff-"));
  const tmux = makeTmux(root, "inst-handoff");
  try {
    const started = track(tmux, tmux.start("sleep 2; printf '%s\\n' handed-off", root));
    const waiting = await tmux.wait(started.taskId, 0.4);
    assert.equal(waiting.status, "running");
    assert.equal(waiting.exitCode, null);
    const done = await tmux.wait(started.taskId, 5);
    assert.equal(done.status, "completed");
    assert.match(done.output, /handed-off/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("kill proves the owned session is gone and rejects foreign ids", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-kill-"));
  const tmux = makeTmux(root, "inst-kill");
  const otherAgent = createLarkinTmux({
    stateDir: path.join(root, "state"),
    agentId: "cli_tmuxOtherA1",
    instanceId: "inst-kill",
    env: process.env,
  });
  try {
    const started = track(tmux, tmux.start("sleep 30", root));
    const running = await tmux.wait(started.taskId, 0.3);
    assert.equal(running.status, "running");
    const killed = tmux.kill(started.taskId);
    assert.equal(killed.status, "cancelled");
    const meta = JSON.parse(fs.readFileSync(path.join(tmux.root, started.taskId, "meta.json"), "utf8"));
    assert.notEqual(spawnSync("tmux", ["has-session", "-t", meta.session], { encoding: "utf8", timeout: 5_000 }).status, 0);
    assert.throws(() => tmux.peek("deadbeefdeadbeef"), ForeignTmuxTaskError);
    assert.throws(() => otherAgent.peek(started.taskId), ForeignTmuxTaskError);
    assert.throws(() => otherAgent.kill(started.taskId), ForeignTmuxTaskError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("kill ends a Bash command that ignores TERM and HUP", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-trap-"));
  const cwd = path.join(root, "ordinary folder");
  fs.mkdirSync(cwd, { recursive: true });
  const tmux = makeTmux(root, "inst-trap");
  try {
    const started = track(tmux, tmux.start("trap '' HUP TERM\nprintf '%s\\n' \"$$\" > cancelled.pid\nsleep 120", cwd));
    const pidFile = path.join(cwd, "cancelled.pid");
    let cancelPid = NaN;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        cancelPid = Number(fs.readFileSync(pidFile, "utf8").trim());
        if (Number.isInteger(cancelPid) && cancelPid > 1) break;
      } catch { /* 尚未落盘 */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(Number.isInteger(cancelPid) && cancelPid > 1);
    const cancelled = tmux.kill(started.taskId);
    assert.equal(cancelled.status, "cancelled");
    const gone = spawnSync("ps", ["-p", String(cancelPid), "-o", "stat="], { encoding: "utf8", timeout: 5_000 });
    assert.ok(gone.status !== 0 || !gone.stdout.trim() || gone.stdout.trim().startsWith("Z"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}, { timeout: 15_000 });

test.skipIf(!tmuxAvailable())("same-agent instances cannot peek or kill one another", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-inst-"));
  const first = makeTmux(root, "inst-one");
  const second = makeTmux(root, "inst-two");
  try {
    const started = track(first, first.start("sleep 30", root));
    assert.throws(() => second.peek(started.taskId), ForeignTmuxTaskError);
    assert.throws(() => second.kill(started.taskId), ForeignTmuxTaskError);
    assert.deepEqual(second.list(), []);
    const killed = first.kill(started.taskId);
    assert.equal(killed.status, "cancelled");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("external tmux disappearance is failed, not running", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-gone-"));
  const tmux = makeTmux(root, "inst-gone");
  try {
    const started = track(tmux, tmux.start("sleep 30", root));
    const running = await tmux.wait(started.taskId, 0.3);
    assert.equal(running.status, "running");
    const meta = JSON.parse(fs.readFileSync(path.join(tmux.root, started.taskId, "meta.json"), "utf8"));
    assert.equal(spawnSync("tmux", ["kill-session", "-t", meta.session], { encoding: "utf8", timeout: 5_000 }).status, 0);
    const gone = tmux.peek(started.taskId);
    assert.equal(gone.status, "failed");
    assert.equal(gone.exitCode, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("kill of a completed task does not signal a reused pid file", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-pidreuse-"));
  const tmux = makeTmux(root, "inst-pid");
  const decoy = spawn("sleep", ["60"], { stdio: "ignore" });
  try {
    const started = track(tmux, tmux.start("printf done\\n", root));
    const done = await tmux.wait(started.taskId, 5);
    assert.equal(done.status, "completed");
    fs.writeFileSync(path.join(tmux.root, started.taskId, "pid"), `${decoy.pid}\n`);
    const after = tmux.kill(started.taskId);
    assert.equal(after.status, "completed");
    process.kill(decoy.pid, 0);
  } finally {
    try { process.kill(decoy.pid, "SIGKILL"); } catch { /* already gone */ }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("symlink env script is rejected as foreign", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-link-"));
  const tmux = makeTmux(root, "inst-link");
  try {
    const started = track(tmux, tmux.start("printf linked\\n", root));
    await tmux.wait(started.taskId, 5);
    const envFile = path.join(tmux.root, started.taskId, "env.sh");
    const decoy = path.join(root, "decoy-env.sh");
    fs.writeFileSync(decoy, "export LEAK=1\n");
    fs.rmSync(envFile);
    fs.symlinkSync(decoy, envFile);
    assert.throws(() => tmux.peek(started.taskId), ForeignTmuxTaskError);
    assert.throws(() => tmux.kill(started.taskId), ForeignTmuxTaskError);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!tmuxAvailable())("child env is applied without inherited TMUX coordinates or secrets on argv", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-tmux-env-"));
  const secret = "larkin-tmux-secret-value";
  const inherited = "inherited-parent-socket,1,0";
  const env = { ...process.env, LARKIN_TMUX_TEST_SECRET: secret, TMUX: inherited, TMUX_PANE: "%99" };
  const tmux = createLarkinTmux({
    stateDir: path.join(root, "state"),
    agentId: "cli_tmuxSameA1",
    instanceId: "inst-env",
    env,
  });
  try {
    const started = track(tmux, tmux.start("printf '%s\\n' \"$LARKIN_TMUX_TEST_SECRET\"; printf 'TMUX=%s\\n' \"${TMUX-}\"", root));
    const done = await tmux.wait(started.taskId, 5);
    assert.equal(done.status, "completed");
    assert.match(done.output, new RegExp(secret));
    assert.doesNotMatch(done.output, /inherited-parent-socket/);
    const envScript = fs.readFileSync(path.join(tmux.root, started.taskId, "env.sh"), "utf8");
    assert.doesNotMatch(envScript, /inherited-parent-socket/);
    assert.match(envScript, new RegExp(secret));
    const run = fs.readFileSync(path.join(tmux.root, started.taskId, "run.sh"), "utf8");
    assert.match(run, /\/bin\/bash -o pipefail/);
    assert.doesNotMatch(run, new RegExp(secret));
    const argv = spawnSync("ps", ["-ax", "-o", "command="], { encoding: "utf8", timeout: 5_000 });
    assert.doesNotMatch(argv.stdout || "", new RegExp(secret));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
