import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { afterAll, test } from "bun:test";
import {
  cancelSupervisedCommand,
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
  const leftover = spawnSync("ps", ["-p", String(started.pid)], { encoding: "utf8" });
  assert.ok(!/node/.test(leftover.stdout || "") || leftover.status !== 0);
});

test("sibling owner cannot wait on another session handle", async () => {
  const owner = {};
  const started = startSupervisedCommand({
    owner,
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 2000)"],
  });
  await assert.rejects(waitSupervisedCommand({}, started.handle, 1), /not found/);
  await cancelSupervisedCommand(owner, started.handle);
});

test("wait above the 60s cap is rejected even when env is raised", async () => {
  const owner = {};
  const started = startSupervisedCommand({
    owner,
    executable: process.execPath,
    args: ["-e", "setTimeout(() => {}, 500)"],
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
