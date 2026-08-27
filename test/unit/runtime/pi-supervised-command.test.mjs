import assert from "node:assert/strict";
import { afterAll, test } from "bun:test";
import {
  cancelSupervisedCommand,
  resolveSupervisedCwd,
  startSupervisedCommand,
  waitSupervisedCommand,
} from "../../../src/runtime/pi-supervised-command.ts";

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

test("supervised cwd cannot escape the session root", () => {
  assert.throws(() => resolveSupervisedCwd(process.cwd(), ".."), /escapes|symlink/);
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

afterAll(() => {
  if (priorWait === undefined) delete process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS;
  else process.env.LARKIN_PI_SUPERVISED_WAIT_SECONDS = priorWait;
  if (priorLife === undefined) delete process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS;
  else process.env.LARKIN_PI_SUPERVISED_LIFE_SECONDS = priorLife;
});
