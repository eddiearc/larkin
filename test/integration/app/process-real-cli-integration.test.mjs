import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import crypto from "node:crypto";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { readProcessState } from "../../../dist/platform/process-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENABLED = process.env.LARKIN_RUN_REAL_PROCESS_TEST === "1";

test.skipIf(!ENABLED)("real CLI one-start, reuse, and dashboard recovery preserve daemon ownership", {
  timeout: 60_000,
}, async () => {
const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-real-process-"));
const larkinHome = temp;
const eventFile = path.join(temp, "events.ndjson");
fs.mkdirSync(larkinHome, { recursive: true });
fs.writeFileSync(eventFile, "");
fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({
  version: 3,
  serverId: "00000000-0000-0000-0000-000000000001",
  activeAgent: "cli_test",
  agents: { cli_test: { runtime: "codex", model: "gpt-5.5" } },
}, null, 2));
const botsDir = path.join(temp, "bots");
fs.mkdirSync(botsDir, { mode: 0o700 });
fs.writeFileSync(path.join(botsDir, "cli_test.json"), JSON.stringify({ appId: "cli_test", appSecret: "fixture-secret", tenant: "feishu" }), { mode: 0o600 });
const binDir = path.join(temp, "bin");
fs.mkdirSync(binDir);
fs.writeFileSync(path.join(binDir, "lark-cli"), `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args.includes("+chat-list")) console.log(JSON.stringify({ok:true,identity:"bot",data:{chats:[]}}));
`, { mode: 0o755 });
const attachmentDir = path.join(larkinHome, "computer", "servers", "00000000-0000-0000-0000-000000000001");
fs.mkdirSync(attachmentDir, { recursive: true });
fs.writeFileSync(path.join(attachmentDir, "runner.state.json"), JSON.stringify({
  kind: "computer-attachment",
  serverId: "00000000-0000-0000-0000-000000000001",
  serverSlug: "feishu",
  serverMachineId: crypto.randomUUID(),
  machineId: crypto.randomUUID(),
  apiKey: "sk_computer_local_test_only",
  serverUrl: "http://127.0.0.1:8787",
  attachedAt: new Date().toISOString(),
}, null, 2), { mode: 0o600 });

const env = {
  ...process.env,
  LARKIN_CONFIG_DIR: temp,
  LARKIN_FEISHU_EVENT_FILE: eventFile,
  LARKIN_FEISHU_DRYRUN: "1",
  PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
};
const args = [path.join(ROOT, "dist/app/run.mjs"), "--agent", "cli_test", "--dry-run"];
const first = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
let output = "";
first.stdout.on("data", (chunk) => { output += chunk; });
first.stderr.on("data", (chunk) => { output += chunk; });

try {
  const deadline = Date.now() + 15_000;
  let daemon;
  while (Date.now() < deadline) {
    daemon = readProcessState(larkinHome).daemon;
    if (daemon.state === "owned") break;
    if (first.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.equal(daemon?.state, "owned", `真实 daemon 未建立 ownership record：${output}`);
  const initialState = readProcessState(larkinHome);
  assert.equal(initialState.supervisor.state, "owned", `统一 supervisor 未建立 ownership：${output}`);
  assert.equal(initialState.dashboard.state, "owned", `dashboard 未随 start 启动：${output}`);
  assert.equal(daemon.pid > 0, true);
  assert.equal(daemon.commandToken, "app/runtime-process.mjs");
  assert.equal(typeof daemon.processStartToken, "string");
  const authority = JSON.parse(fs.readFileSync(path.join(larkinHome, "daemon-control-auth.json"), "utf8"));
  assert.equal(fs.lstatSync(authority.daemonSocketPath).isSocket(), true);
  assert.equal(fs.lstatSync(authority.supervisorSocketPath).isSocket(), true);

  const second = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(second.status, 0, second.stderr || second.stdout);
  assert.match(second.stdout, /统一 supervisor 运行.*不重复启动/);
  assert.equal(readProcessState(larkinHome).daemon.pid, daemon.pid);

  const oldDashboardPid = initialState.dashboard.pid;
  process.kill(oldDashboardPid, "SIGTERM");
  const restartDeadline = Date.now() + 5_000;
  let restartedDashboard;
  while (Date.now() < restartDeadline) {
    restartedDashboard = readProcessState(larkinHome).dashboard;
    if (restartedDashboard.state === "owned" && restartedDashboard.pid !== oldDashboardPid) break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(restartedDashboard?.state, "owned", `dashboard crash 后未恢复：${output}`);
  assert.notEqual(restartedDashboard.pid, oldDashboardPid, "dashboard must restart with a new PID");
  assert.equal(readProcessState(larkinHome).daemon.pid, daemon.pid, "dashboard recovery must not restart daemon");

  let currentDashboard = restartedDashboard;
  for (let crash = 2; crash <= 3; crash += 1) {
    const priorPid = currentDashboard.pid;
    process.kill(priorPid, "SIGTERM");
    const recovery = Date.now() + 5_000;
    while (Date.now() < recovery) {
      currentDashboard = readProcessState(larkinHome).dashboard;
      if (currentDashboard.state === "owned" && currentDashboard.pid !== priorPid) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(currentDashboard.state, "owned", `dashboard crash ${crash} 后未恢复：${output}`);
  }
  process.kill(currentDashboard.pid, "SIGTERM");
  const exhaustedDeadline = Date.now() + 3_000;
  while (Date.now() < exhaustedDeadline && !/连续退出超过 3 次/.test(output)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(output, /连续退出超过 3 次/);
  assert.notEqual(readProcessState(larkinHome).dashboard.state, "owned");
  const repair = spawnSync(process.execPath, args, { cwd: ROOT, env, encoding: "utf8", timeout: 10_000 });
  assert.equal(repair.status, 0, repair.stderr || repair.stdout);
  assert.match(repair.stdout, /已通过认证控制面请求 dashboard.*不重复启动 daemon/);
  const repairDeadline = Date.now() + 5_000;
  let repairedDashboard;
  while (Date.now() < repairDeadline) {
    repairedDashboard = readProcessState(larkinHome).dashboard;
    if (repairedDashboard.state === "owned") break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(repairedDashboard?.state, "owned", `重复 start 未补拉 dashboard：${output}`);
  assert.equal(readProcessState(larkinHome).daemon.pid, daemon.pid, "补拉 dashboard must preserve daemon PID");

  first.kill("SIGTERM");
  await once(first, "exit");
  assert.notEqual(readProcessState(larkinHome).daemon.state, "owned");
  assert.equal(fs.existsSync(authority.daemonSocketPath), false, "normal daemon teardown must remove its socket");
  assert.equal(fs.existsSync(authority.supervisorSocketPath), false, "normal supervisor teardown must remove its socket");
  assert.equal(fs.existsSync(authority.socketRoot), false, "normal teardown must remove the empty control root");
  console.log("  ✓ real CLI one-start、重复复用、dashboard crash/budget exhaustion/repeated-start 补拉均保持 daemon PID");
} finally {
  if (first.exitCode === null) {
    first.kill("SIGTERM");
    await Promise.race([once(first, "exit"), new Promise((resolve) => setTimeout(resolve, 3_000))]);
    if (first.exitCode === null) first.kill("SIGKILL");
  }
  fs.rmSync(temp, { recursive: true, force: true });
}
});
