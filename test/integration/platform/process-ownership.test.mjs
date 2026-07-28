import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const processState = await import("../../../dist/platform/process-state.mjs");
assert.equal(typeof processState.readOwnedProcessRecord, "function", "必须提供带进程所有权校验的状态读取");
assert.equal(typeof processState.acquireProcessLock, "function", "必须提供原子 setup lock");

process.env.LARKIN_BUN_TEST_RUNNER = "1";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-process-owner-"));
const statusFile = path.join(temp, "owner.json");
const commandToken = processState.currentProcessMetadata(path.basename(process.argv[1])).commandToken;
const actual = processState.inspectProcess(process.pid);
assert.equal(actual.ok, true, actual.reason);
assert.equal(processState.pidAlive(123, () => { throw Object.assign(new Error("not permitted"), { code: "EPERM" }); }), true,
  "EPERM must remain possibly alive");
assert.equal(processState.pidAlive(123, () => { throw Object.assign(new Error("missing"), { code: "ESRCH" }); }), false,
  "only ESRCH proves the process is dead");

try {
  fs.writeFileSync(statusFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), processStartToken: actual.startToken, commandToken }));
  const owned = processState.readOwnedProcessRecord(statusFile, commandToken);
  assert.equal(owned.alive, true);
  assert.equal(owned.state, "owned", owned.reason);
  assert.equal(owned.running, true);

  fs.writeFileSync(statusFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), processStartToken: "2000-01-01T00:00:00.000Z", commandToken }));
  const reused = processState.readOwnedProcessRecord(statusFile, commandToken);
  assert.equal(reused.alive, true);
  assert.equal(reused.state, "mismatch");
  assert.equal(reused.running, false);

  fs.writeFileSync(statusFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), processStartToken: actual.startToken, commandToken: "not-this-process.mjs" }));
  const wrongCommand = processState.readOwnedProcessRecord(statusFile, "not-this-process.mjs");
  assert.equal(wrongCommand.state, "mismatch");

  const unknown = processState.readOwnedProcessRecord(statusFile, "not-this-process.mjs", { inspect: () => ({ ok: false, reason: "probe failed" }) });
  assert.equal(unknown.alive, true);
  assert.equal(unknown.state, "unknown", "探测失败必须阻断，不能假装进程不存在");
  assert.throws(() => processState.assertProcessCanStart(unknown, "daemon"), /拒绝|停止|无法确认/);

  const exited = processState.readOwnedProcessRecord(statusFile, commandToken, { inspect: () => ({ ok: false, dead: true, reason: "process exited" }) });
  assert.equal(exited.state, "dead", "已退出或 zombie 进程不能阻塞安全替换");

  const missingCommand = processState.readOwnedProcessRecord(statusFile, "not-this-process.mjs", {
    inspect: () => ({ ok: true, startToken: actual.startToken }),
  });
  assert.equal(missingCommand.state, "unknown", "缺少 command 的探测结果必须 fail closed");
  assert.throws(() => processState.assertProcessCanStart(missingCommand, "daemon"), /拒绝|停止|无法确认/);

  const missingStartToken = processState.readOwnedProcessRecord(statusFile, "not-this-process.mjs", {
    inspect: () => ({ ok: true, command: "not-this-process.mjs" }),
  });
  assert.equal(missingStartToken.state, "unknown", "缺少 startToken 的探测结果必须 fail closed");
  assert.throws(() => processState.assertProcessCanStart(missingStartToken, "daemon"), /拒绝|停止|无法确认/);

  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const sleeperInfo = processState.inspectProcess(sleeper.pid);
  assert.equal(sleeperInfo.ok, true, sleeperInfo.reason);
  fs.writeFileSync(statusFile, JSON.stringify({
    pid: sleeper.pid,
    startedAt: new Date().toISOString(),
    processStartToken: "2000-01-01T00:00:00.000Z",
    commandToken: "setInterval",
  }));
  const unrelated = processState.readOwnedProcessRecord(statusFile, "setInterval");
  assert.equal(unrelated.state, "mismatch");
  assert.throws(() => processState.terminateOwnedProcess(unrelated), /拒绝/);
  assert.doesNotThrow(() => process.kill(sleeper.pid, 0), "ownership mismatch 时无关进程必须仍存活");
  sleeper.kill("SIGKILL");
  await once(sleeper, "exit");

  const ownedSleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 60000)"], { stdio: "ignore" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  const ownedSleeperInfo = processState.inspectProcess(ownedSleeper.pid);
  assert.equal(ownedSleeperInfo.ok, true, ownedSleeperInfo.reason);
  fs.writeFileSync(statusFile, JSON.stringify({
    pid: ownedSleeper.pid,
    startedAt: new Date().toISOString(),
    processStartToken: ownedSleeperInfo.startToken,
    commandToken: "setInterval",
  }));
  const ownedSleeperRecord = processState.readOwnedProcessRecord(statusFile, "setInterval");
  assert.equal(ownedSleeperRecord.state, "owned");
  const ownedSleeperExited = once(ownedSleeper, "exit");
  processState.terminateOwnedProcess(ownedSleeperRecord);
  assert.equal(await processState.waitForProcessExit(ownedSleeperRecord), true, "owned 进程终止后必须被 wait 观察到");
  await ownedSleeperExited;

  fs.writeFileSync(statusFile, JSON.stringify({
    pid: process.pid,
    processStartToken: actual.startToken,
    commandToken,
  }));
  await assert.rejects(
    processState.waitForProcessExit(
      { ...processState.readOwnedProcessRecord(statusFile, commandToken), file: statusFile },
      100,
      { inspect: () => ({ ok: false, reason: "probe failed while waiting" }) },
    ),
    /无法确认所有权.*probe failed while waiting/,
  );

  const lockFile = path.join(temp, "setup.lock.json");
  const first = processState.acquireProcessLock(lockFile, commandToken);
  assert.throws(() => processState.acquireProcessLock(lockFile, commandToken), /正在运行|占用|lock/i);
  const replacement = { ...first.record, nonce: "replacement-owner" };
  fs.writeFileSync(lockFile, JSON.stringify(replacement));
  first.release();
  assert.equal(fs.existsSync(lockFile), true, "旧 owner release 不得删除后来者 lock");
  fs.rmSync(lockFile);
  const second = processState.acquireProcessLock(lockFile, commandToken);
  second.release();
  assert.equal(fs.existsSync(lockFile), false);

  fs.writeFileSync(lockFile, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), processStartToken: "2000-01-01T00:00:00.000Z", commandToken }));
  const recovered = processState.acquireProcessLock(lockFile, commandToken);
  recovered.release();

  fs.writeFileSync(lockFile, "{");
  assert.throws(() => processState.acquireProcessLock(lockFile, commandToken), /正在创建|接管/);
  const old = new Date(Date.now() - 10_000);
  fs.utimesSync(lockFile, old, old);
  const malformedRecovered = processState.acquireProcessLock(lockFile, commandToken);
  malformedRecovered.release();

  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const holder = spawn(process.execPath, [path.join(ROOT, "test/support/process-lock-holder.mjs"), lockFile], { stdio: ["ignore", "pipe", "inherit"] });
  let ready = "";
  while (!ready.includes("READY")) ready += await new Promise((resolve) => holder.stdout.once("data", (chunk) => resolve(chunk.toString())));
  assert.throws(() => processState.acquireProcessLock(lockFile, commandToken), /正在运行|占用|lock/i, "真实并发 child 持锁时必须阻断");
  holder.kill("SIGTERM");
  await once(holder, "exit");
  const afterCrash = processState.acquireProcessLock(lockFile, commandToken);
  afterCrash.release();
  console.log("  ✓ 进程 ownership 为 owned/mismatch/unknown 三态，setup lock 排他且可恢复 stale 记录");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
