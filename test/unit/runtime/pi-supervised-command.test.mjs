import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterAll, test } from "bun:test";
import {
  cancelSupervisedCommand,
  reapSupervisedCommands,
  resolveSupervisedCwd,
  startSupervisedCommand,
  waitSupervisedCommand,
} from "../../../src/runtime/pi-supervised-command.ts";
import supervisedExtension from "../../../src/runtime/pi-supervised-command-extension.ts";

const priorWait = process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS;
const priorLife = process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS;
process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS = "1";
process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS = "8";

test("supervised start+wait keeps pid and does not kill on wait timeout", async () => {
  const owner = {};
  const started = startSupervisedCommand({
    owner,
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 4000)"],
    cwd: process.cwd(),
  });
  assert.ok(started.handle);
  assert.ok(started.pid > 0);
  const first = await waitSupervisedCommand(owner, started.handle, 1);
  assert.equal(first.status, "running");
  assert.equal(first.pid, started.pid);
  const second = await waitSupervisedCommand(owner, started.handle, 1);
  assert.equal(second.pid, started.pid);
  const cancelled = await cancelSupervisedCommand(owner, started.handle);
  assert.ok(cancelled.status === "killed" || cancelled.status === "exited");
  let alive = true;
  try { process.kill(started.pid, 0); } catch { alive = false; }
  assert.equal(alive, false);
});

test("sibling owner cannot wait on another session handle", async () => {
  const owner = {};
  const started = startSupervisedCommand({
    owner,
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 2000)"],
    cwd: process.cwd(),
  });
  await assert.rejects(waitSupervisedCommand({}, started.handle, 1), /not found/);
  await cancelSupervisedCommand(owner, started.handle);
});

test("split utf-8 euro is not replaced then dropped", async () => {
  const owner = {};
  const started = startSupervisedCommand({
    owner,
    executable: process.execPath,
    args: ["-e", "process.stdout.write(Buffer.from([0xe2])); setTimeout(() => process.stdout.write(Buffer.from([0x82, 0xac])), 1200); setTimeout(() => {}, 2500);"],
    cwd: process.cwd(),
  });
  const first = await waitSupervisedCommand(owner, started.handle, 1);
  assert.equal(first.stdout.includes("\uFFFD"), false);
  const second = await waitSupervisedCommand(owner, started.handle, 1);
  assert.ok(first.stdout.includes("€") || second.stdout.includes("€"));
  await cancelSupervisedCommand(owner, started.handle).catch(() => {});
});

test("ring buffer keeps the newest 64KiB across two 40KiB chunks", async () => {
  const owner = {};
  const started = startSupervisedCommand({
    owner,
    executable: process.execPath,
    args: ["-e", "process.stdout.write('A'.repeat(40000)); process.stdout.write('B'.repeat(40000));"],
    cwd: process.cwd(),
  });
  const done = await waitSupervisedCommand(owner, started.handle, 1);
  assert.ok(done.status === "exited" || done.status === "running");
  const text = done.stdout;
  assert.ok(Buffer.byteLength(text) <= 64 * 1024);
  assert.ok(text.endsWith("B".repeat(100)));
  assert.match(text, /A/);
  await cancelSupervisedCommand(owner, started.handle).catch(() => {});
});

test("cancel is idempotent after wait consumes the terminal", async () => {
  const owner = {};
  const started = startSupervisedCommand({
    owner,
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 5000)"],
    cwd: process.cwd(),
  });
  const pending = waitSupervisedCommand(owner, started.handle, 1);
  await cancelSupervisedCommand(owner, started.handle).catch((error) => {
    assert.match(String(error), /consumed|not found|killed/i);
  });
  await pending.catch(() => {});
  const again = await cancelSupervisedCommand(owner, started.handle);
  assert.ok(again.status === "killed" || again.status === "exited");
  let alive = true;
  try { process.kill(started.pid, 0); } catch { alive = false; }
  assert.equal(alive, false);
});

test("missing executable fails without an unhandled spawn error", async () => {
  const owner = {};
  const unhandled = [];
  const onError = (error) => { unhandled.push(error); };
  process.on("uncaughtException", onError);
  process.on("unhandledRejection", onError);
  try {
    assert.throws(() => startSupervisedCommand({
      owner,
      executable: path.join(os.tmpdir(), "larkin-missing-supervised-bin"),
      args: [],
      cwd: process.cwd(),
    }), /failed to spawn|ENOENT|not found/i);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled.length, 0, String(unhandled[0]));
  } finally {
    process.off("uncaughtException", onError);
    process.off("unhandledRejection", onError);
  }
});

test("supervised cwd cannot escape the session root", () => {
  assert.throws(() => resolveSupervisedCwd(process.cwd(), ".."), /escapes|symlink/);
});

test("cancel reaps non-detached descendants before returning", async () => {
  const owner = {};
  const started = startSupervisedCommand({
    owner,
    executable: process.execPath,
    args: ["-e", "const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'}); process.stdout.write(String(child.pid)); setTimeout(()=>{},30000);"],
    cwd: process.cwd(),
  });
  const first = await waitSupervisedCommand(owner, started.handle, 1);
  const childPid = Number.parseInt(first.stdout, 10);
  assert.ok(childPid > 0);
  await cancelSupervisedCommand(owner, started.handle);
  let leaderAlive = true;
  let childAlive = true;
  try { process.kill(started.pid, 0); } catch { leaderAlive = false; }
  try { process.kill(childPid, 0); } catch { childAlive = false; }
  assert.equal(leaderAlive, false);
  assert.equal(childAlive, false);
});

test.skipIf(process.platform !== "win32")("cancel reaps the windows process tree", async () => {
  const owner = {};
  const started = startSupervisedCommand({
    owner,
    executable: process.execPath,
    args: ["-e", "const {spawn}=require('child_process'); const child=spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore',windowsHide:true}); process.stdout.write(String(child.pid)); setTimeout(()=>{},30000);"],
    cwd: process.cwd(),
  });
  const first = await waitSupervisedCommand(owner, started.handle, 1);
  const childPid = Number.parseInt(first.stdout, 10);
  assert.ok(childPid > 0);
  await cancelSupervisedCommand(owner, started.handle);
  for (const pid of [started.pid, childPid]) {
    const listed = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true });
    const text = String(listed.stdout || "");
    assert.equal(/\"\d+\"/.test(text) && text.includes(String(pid)), false, text);
  }
});

test("cancel empties the unix process group", async () => {
  if (process.platform === "win32") return;
  const owner = {};
  const started = startSupervisedCommand({
    owner,
    executable: process.execPath,
    args: ["-e", "const {spawn}=require('child_process'); spawn(process.execPath,['-e','setTimeout(()=>{},30000)'],{stdio:'ignore'}); setTimeout(()=>{},30000);"],
    cwd: process.cwd(),
  });
  await waitSupervisedCommand(owner, started.handle, 1);
  await cancelSupervisedCommand(owner, started.handle);
  const listed = spawnSync("pgrep", ["-g", String(started.pid)], { encoding: "utf8" });
  const pids = String(listed.stdout || "").trim().split(/\s+/).filter(Boolean);
  assert.equal(pids.length, 0, `process group still has ${pids.join(",")}`);
});

test("reap returns only after the pid is gone", async () => {
  const owner = {};
  const started = startSupervisedCommand({
    owner,
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 30000)"],
    cwd: process.cwd(),
  });
  await reapSupervisedCommands(owner);
  let alive = true;
  try { process.kill(started.pid, 0); } catch { alive = false; }
  assert.equal(alive, false);
});

test("wait above the 60s cap is rejected even when env is raised", async () => {
  const owner = {};
  const started = startSupervisedCommand({
    owner,
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 500)"],
    cwd: process.cwd(),
  });
  await assert.rejects(waitSupervisedCommand(owner, started.handle, 61), /exceeds the \d+s supervised wait limit/);
  await cancelSupervisedCommand(owner, started.handle);
});

test("supervised_wait resets only on turn_end", async () => {
  const listeners = {};
  const tools = {};
  supervisedExtension({
    on(event, handler) { listeners[event] = handler; },
    registerTool(tool) { tools[tool.name] = tool; },
  });
  assert.equal(listeners.agent_start, undefined);
  assert.equal(typeof listeners.turn_end, "function");
  const ctx = { sessionManager: {}, cwd: process.cwd() };
  const started = await tools.supervised_start.execute("c1", {
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 4000)"],
  }, new AbortController().signal, () => {}, ctx);
  const handle = JSON.parse(started.content[0].text).handle;
  await tools.supervised_wait.execute("c2", { handle, timeout: 1 }, new AbortController().signal, () => {}, ctx);
  await assert.rejects(
    tools.supervised_wait.execute("c3", { handle, timeout: 1 }, new AbortController().signal, () => {}, ctx),
    /once per turn/,
  );
  await listeners.turn_end();
  const second = await tools.supervised_wait.execute("c4", { handle, timeout: 1 }, new AbortController().signal, () => {}, ctx);
  assert.equal(JSON.parse(second.content[0].text).pid > 0, true);
  await tools.supervised_cancel.execute("c5", { handle }, new AbortController().signal, () => {}, ctx);
});

afterAll(() => {
  if (priorWait === undefined) delete process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS;
  else process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS = priorWait;
  if (priorLife === undefined) delete process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS;
  else process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS = priorLife;
});
