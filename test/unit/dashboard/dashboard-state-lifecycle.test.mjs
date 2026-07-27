import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { onTestFinished, test } from "bun:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LIFECYCLE = pathToFileURL(path.join(ROOT, "dist/dashboard/dashboard-lifecycle.mjs")).href;
const VIEW_MODEL = pathToFileURL(path.join(ROOT, "dist/dashboard/dashboard-view-model.mjs")).href;

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  await new Promise((resolve) => server.close(resolve));
  return address.port;
}

test("dashboard build fingerprint is content-derived and lifecycle replacement fails closed", async () => {
  const { dashboardBuildFingerprint, dashboardReuseDecision, reconcileDashboardRecord } = await import(LIFECYCLE);
  const fingerprint = dashboardBuildFingerprint(ROOT);
  assert.match(fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(dashboardReuseDecision({ state: "dead" }, fingerprint), { action: "start", reason: "dashboard not running" });
  assert.equal(dashboardReuseDecision({ state: "owned", buildFingerprint: fingerprint }, fingerprint).action, "reuse");
  assert.equal(dashboardReuseDecision({ state: "owned" }, fingerprint).action, "replace", "first rollout must replace an owned legacy dashboard without a fingerprint");
  assert.equal(dashboardReuseDecision({ state: "owned", buildFingerprint: "sha256:old" }, fingerprint).action, "replace");
  assert.equal(dashboardReuseDecision({ state: "unknown", pid: 11 }, fingerprint).action, "refuse");
  assert.equal(dashboardReuseDecision({ state: "mismatch", pid: 12 }, fingerprint).action, "refuse");

  const calls = [];
  const stale = { state: "owned", pid: 13, buildFingerprint: "sha256:old", file: "/tmp/dashboard-status.json" };
  const replaced = await reconcileDashboardRecord(stale, fingerprint, {
    terminate(record) { calls.push(["terminate", record.pid]); },
    async wait(record) { calls.push(["wait", record.pid]); return true; },
  });
  assert.equal(replaced.action, "start");
  assert.deepEqual(calls, [["terminate", 13], ["wait", 13]]);

  for (const state of ["unknown", "mismatch"]) {
    const guardedCalls = [];
    await assert.rejects(
      reconcileDashboardRecord({ state, pid: 99, reason: "fixture" }, fingerprint, {
        terminate() { guardedCalls.push("terminate"); },
        async wait() { guardedCalls.push("wait"); return true; },
      }),
      /拒绝|refus|无法确认|不匹配/i,
    );
    assert.deepEqual(guardedCalls, [], `${state} process must never be killed`);
  }
});

test("agent channel, inbound verification, and daemon process state stay independent", async () => {
  const { projectAgentHealth } = await import(VIEW_MODEL);
  const connectedAt = "2026-07-18T07:00:00.000Z";
  const daemon = { state: "owned", reason: null, running: true, startedAt: "2026-07-18T06:59:00.000Z", agents: ["cli_agent"] };
  const pending = projectAgentHealth({ agentId: "cli_agent", connectedAt, inboundVerifiedAt: "2026-07-18T06:58:00.000Z" }, daemon);
  assert.equal(pending.connection.state, "connected");
  assert.equal(pending.inbound.state, "pending");
  assert.equal(pending.issue, false, "connected + waiting for current-connection inbound is neutral");

  const verified = projectAgentHealth({ agentId: "cli_agent", connectedAt, inboundVerifiedAt: connectedAt }, daemon);
  assert.equal(verified.inbound.state, "verified");
  assert.equal(verified.issue, false);

  const uncertain = projectAgentHealth({ agentId: "cli_agent", connectedAt }, { ...daemon, state: "unknown", reason: "process inspection failed", running: false });
  assert.equal(uncertain.connection.state, "unknown");
  assert.match(uncertain.connection.reason, /process inspection failed/);
  assert.equal(uncertain.inbound.state, "unavailable");
  assert.equal(uncertain.issue, false, "daemon inspection uncertainty must not be multiplied into per-Agent disconnect issues");

  const missingDaemonEpoch = projectAgentHealth(
    { agentId: "cli_agent", connectedAt },
    { ...daemon, startedAt: undefined },
  );
  assert.equal(missingDaemonEpoch.connection.state, "unknown", "owned daemon without a valid epoch cannot prove disconnect");
  assert.match(missingDaemonEpoch.connection.reason, /startedAt|epoch/i);
  assert.equal(missingDaemonEpoch.issue, false, "invalid daemon metadata must remain one daemon-level issue");

  const disconnected = projectAgentHealth({ agentId: "cli_agent", connectedAt: null }, daemon);
  assert.equal(disconnected.connection.state, "disconnected");
  assert.equal(disconnected.issue, true);
});

test("dashboard timeline ignores delivery lifecycle rows and trusts current activity freshness", async () => {
  const { projectStatusTimeline } = await import(VIEW_MODEL);
  const message = { at: "2026-07-23T08:39:00.001Z", from: "Sender", target: "#chat" };
  const currentActivity = { at: "2026-07-23T08:39:00.005Z", state: "working", activityKind: "text" };
  const projected = projectStatusTimeline({
    deliverLog: [
      { at: "2026-07-23T08:39:00.000Z", deliveryId: "delivery-1", status: "accepted" },
      message,
      { at: "2026-07-23T08:39:00.002Z", deliveryId: "delivery-1", status: "consumed" },
    ],
    activityLog: [
      { at: "2026-07-23T08:38:59.000Z", state: "working", detail: null },
      { at: "2026-07-23T08:39:00.003Z", state: "thinking", detail: null },
    ],
    lastActivity: currentActivity,
    recentErrors: [],
  });
  assert.deepEqual(projected.lastDeliver, message, "accepted/consumed rows are not user-visible messages");
  assert.deepEqual(projected.lastActivity, currentActivity, "status.lastActivity is the current-state authority");
  assert.equal(projected.feed.filter((item) => item.kind === "deliver").length, 1);
  assert.equal(projected.feed.some((item) => item.kind === "deliver" && !item.from && !item.target), false);

  const legacy = projectStatusTimeline({
    activityLog: [{ at: "2026-07-23T08:00:00.000Z", state: "idle" }],
    deliverLog: [{ at: "2026-07-23T08:00:01.000Z", status: "accepted" }],
  });
  assert.equal(legacy.lastActivity.state, "idle", "old status files fall back to durable history");
  assert.equal(legacy.lastDeliver, null, "status-only delivery history has no fake last message");
});

test("dashboard reminder projection treats scheduled and legacy pending records as active and terminal states separately", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-reminders-"));
  fs.chmodSync(temp, 0o700);
  onTestFinished(() => fs.rmSync(temp, { recursive: true, force: true }));
  const agentId = "cli_ReminderA1";
  fs.writeFileSync(path.join(temp, "config.json"), `${JSON.stringify({
    version: 4,
    serverId: "server-reminder-projection",
    mentionPolicy: "require",
    activeAgent: agentId,
    agents: {
      [agentId]: { runtime: "pi", model: "default", createdAt: "2026-07-24T00:00:00.000Z" },
    },
  })}\n`, { mode: 0o600 });
  const stateDir = path.join(temp, "state", "agents", agentId);
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(stateDir, "reminders.json"), JSON.stringify({ reminders: [
    { title: "一次提醒", status: "scheduled", fireAt: "2026-07-24T10:00:00.000Z" },
    { title: "重复提醒", status: "scheduled", fireAt: "2026-07-24T11:00:00.000Z", repeat: { kind: "daily" } },
    { title: "旧版等待", status: "pending", fireAt: "2026-07-24T12:00:00.000Z" },
    { title: "已触发", status: "fired", fireAt: "2026-07-24T09:00:00.000Z" },
    { title: "已取消", status: "canceled", fireAt: "2026-07-24T08:00:00.000Z" },
    { title: "已失败", status: "failed", fireAt: "2026-07-24T07:00:00.000Z" },
  ] }), { mode: 0o600 });

  const previousConfigDir = process.env.LARKIN_CONFIG_DIR;
  process.env.LARKIN_CONFIG_DIR = temp;
  try {
    const { collectStatus } = await import(`${VIEW_MODEL}?reminders=${Date.now()}`);
    const projected = (await collectStatus()).agents[0];
    assert.equal(projected.activeReminders, 3, "scheduled and legacy pending reminders remain active");
    assert.deepEqual(projected.remindersList.map(({ title, status }) => ({ title, status })), [
      { title: "一次提醒", status: "scheduled" },
      { title: "重复提醒", status: "scheduled" },
      { title: "旧版等待", status: "pending" },
      { title: "已触发", status: "fired" },
      { title: "已取消", status: "canceled" },
      { title: "已失败", status: "failed" },
    ]);
  } finally {
    if (previousConfigDir === undefined) delete process.env.LARKIN_CONFIG_DIR;
    else process.env.LARKIN_CONFIG_DIR = previousConfigDir;
  }
});

test("dashboard content fingerprint changes when runtime content changes", async () => {
  const { dashboardBuildFingerprint } = await import(LIFECYCLE);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-fingerprint-a-"));
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-fingerprint-b-"));
  try {
    const populate = (root) => {
      const dist = path.join(root, "dist");
      const assets = path.join(root, "assets");
      fs.mkdirSync(dist, { recursive: true });
      fs.mkdirSync(assets, { recursive: true });
      for (const name of ["dashboard.mjs", "dashboard-view-model.mjs", "dashboard-template.mjs", "dashboard-lifecycle.mjs", "process-state.mjs", "process-inspect.cjs", "dashboard-workspace.mjs"]) {
        fs.writeFileSync(path.join(dist, name), `${name}:one\n`);
      }
      fs.writeFileSync(path.join(assets, "larkin-mark.svg"), "asset:one\n");
      return dist;
    };
    const dist = populate(temp);
    const copyDist = populate(copy);
    const first = dashboardBuildFingerprint(temp);
    assert.equal(dashboardBuildFingerprint(copy), first, "absolute install path must not affect the content fingerprint");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(copyDist, "process-inspect.cjs"), future, future);
    assert.equal(dashboardBuildFingerprint(copy), first, "mtime-only drift must not affect the content fingerprint");
    fs.writeFileSync(path.join(copyDist, ".build.tmp"), "ignored temporary output");
    fs.writeFileSync(path.join(copyDist, "package.tgz"), "ignored archive");
    assert.equal(dashboardBuildFingerprint(copy), first, "temporary and archive artifacts are not runtime inputs");

    for (const dependency of ["process-inspect.cjs", "dashboard-workspace.mjs"]) {
      fs.writeFileSync(path.join(copyDist, dependency), `${dependency}:mutated\n`);
      assert.notEqual(dashboardBuildFingerprint(copy), first, `${dependency} is a loaded runtime dependency and must affect the fingerprint`);
      fs.writeFileSync(path.join(copyDist, dependency), `${dependency}:one\n`);
      assert.equal(dashboardBuildFingerprint(copy), first);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
    fs.rmSync(copy, { recursive: true, force: true });
  }
});

test("setup delegates dashboard lifecycle to the unified start supervisor", () => {
  const setup = fs.readFileSync(path.join(ROOT, "src/app/setup.ts"), "utf8");
  const run = fs.readFileSync(path.join(ROOT, "src/app/run.ts"), "utf8");
  assert.doesNotMatch(setup, /spawn\([^\n]*dashboard\.mjs|ensureDashboard|prepareDashboardLaunch/);
  assert.match(run, /path\.join\(HERE, "dashboard\.mjs"\)/);
  assert.match(run, /dashboard 异常退出/);
  assert.match(run, /stopDashboardWithinBound/);
  assert.match(run, /requestDashboardRecovery/);
  assert.doesNotMatch(run, /SIGUSR1/);
});

test("direct dashboard replaces an owned pre-fingerprint process and publishes the current build", async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-dashboard-rollout-"));
  const port = await freePort();
  const statusFile = path.join(temp, "dashboard-status.json");
  fs.writeFileSync(path.join(temp, "config.json"), JSON.stringify({ version: 3, serverId: "fixture", activeAgent: null, agents: {} }), { mode: 0o600 });
  const legacy = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)", "dashboard.mjs"], { stdio: "ignore" });
  let dashboard;
  try {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const { inspectProcess } = await import(pathToFileURL(path.join(ROOT, "dist/platform/process-state.mjs")).href);
    const inspected = inspectProcess(legacy.pid);
    assert.equal(inspected.ok, true, inspected.reason);
    fs.writeFileSync(statusFile, JSON.stringify({
      pid: legacy.pid,
      processStartToken: inspected.startToken,
      commandToken: "dashboard.mjs",
      startedAt: new Date().toISOString(),
      port,
      url: `http://localhost:${port}`,
    }));
    dashboard = spawn(process.execPath, [path.join(ROOT, "dist/app/dashboard.mjs"), "--port", String(port)], {
      cwd: ROOT,
      env: { ...process.env, LARKIN_CONFIG_DIR: temp },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    dashboard.stdout.on("data", (chunk) => { output += chunk; });
    dashboard.stderr.on("data", (chunk) => { output += chunk; });
    const deadline = Date.now() + 5_000;
    let record;
    while (Date.now() < deadline) {
      try { record = JSON.parse(fs.readFileSync(statusFile, "utf8")); } catch {}
      if (record?.pid === dashboard.pid && record?.buildFingerprint) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.equal(record?.pid, dashboard.pid, output);
    assert.match(record?.buildFingerprint || "", /^sha256:[a-f0-9]{64}$/);
    assert.notEqual(record.pid, legacy.pid);
    await new Promise((resolve) => legacy.exitCode === null ? legacy.once("exit", resolve) : resolve());
  } finally {
    if (legacy.exitCode === null) legacy.kill("SIGKILL");
    if (dashboard?.exitCode === null) {
      dashboard.kill("SIGINT");
      await new Promise((resolve) => dashboard.once("exit", resolve));
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
