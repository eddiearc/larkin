import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import {
  cleanupStaleAgentControlSocket,
  controlSocketPath,
  createAgentControlServer,
  initializeControlAuthority,
  requestAgentUpsert,
  requestSessionReset,
} from "../../../dist/app/local-control.mjs";
import { createAgentStateStore } from "../../../dist/agent/agent-state-store.mjs";
import { inspectProcess, readProcessState } from "../../../dist/platform/process-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

async function waitForReady(child, output) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (output().includes("ready")) return;
    if (child.exitCode !== null) throw new Error(`harness exited: ${output()}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`harness readiness timeout: ${output()}`);
}

async function rawRequest(socket, payload) {
  return await new Promise((resolve, reject) => {
    const client = net.createConnection(socket);
    let input = "";
    client.setEncoding("utf8");
    client.once("error", reject);
    client.once("connect", () => client.write(`${JSON.stringify(payload)}\n`));
    client.on("data", (chunk) => { input += chunk; if (input.includes("\n")) { client.end(); resolve(JSON.parse(input)); } });
  });
}

test("local control keeps upsert ID idempotency and coalesces only concurrent reset requests", { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-control-"));
  fs.chmodSync(root, 0o700);
  const legacyResetLedger = path.join(root, "daemon-control-operations.json");
  fs.writeFileSync(legacyResetLedger, JSON.stringify({ version: 1, records: [{ operationId: "legacy-reset-id",
    agentId: "cli_newA1", operation: "session-reset", state: "terminal", response: { ok: true } }] }), { mode: 0o600 });
  const calls = path.join(root, "calls.log");
  const daemonTmp = fs.mkdtempSync("/tmp/lct-");
  fs.chmodSync(daemonTmp, 0o700);
  const child = spawn(process.execPath, [path.join(ROOT, "test/support/local-control-harness.mjs"), "app/runtime-process.mjs"], {
    cwd: ROOT, env: { ...process.env, TMPDIR: daemonTmp, LARKIN_CONFIG_DIR: root, LARKIN_CONTROL_CALLS: calls, LARKIN_CONTROL_DELAY_MS: "40" }, stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    await waitForReady(child, () => output);
    assert.equal(fs.existsSync(legacyResetLedger), false, "startup removes the valid private legacy reset ledger");
    const restartControl = async () => {
      const marker = path.join(root, "control-restarted");
      fs.rmSync(marker, { force: true });
      child.kill("SIGUSR2");
      for (let index = 0; !fs.existsSync(marker) && index < 200; index += 1) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(fs.existsSync(marker), true, output);
    };
    const initialProcessState = readProcessState(root);
    assert.equal(initialProcessState.supervisor.state, "owned", JSON.stringify(initialProcessState.supervisor));
    assert.equal(initialProcessState.daemon.state, "owned", JSON.stringify(initialProcessState.daemon));
    const authority = JSON.parse(fs.readFileSync(path.join(root, "daemon-control-auth.json"), "utf8"));
    const socket = authority.daemonSocketPath;
    assert.equal(path.dirname(authority.socketRoot), daemonTmp);
    assert.notEqual(socket, controlSocketPath(root), "client must use the authority-recorded path when TMPDIR differs");
    assert.equal(fs.lstatSync(socket).mode & 0o077, 0, "socket must not be accessible by group/other");
    assert.equal(fs.lstatSync(path.join(root, "daemon-control-auth.json")).mode & 0o077, 0, "authority must be private");
    const unauthorized = await rawRequest(socket, {
      operationId: "operation_unauth_1", agentId: "cli_newA1", authorization: "A".repeat(43),
    });
    assert.equal(unauthorized.ok, false);
    assert.match(unauthorized.error, /unauthorized/);
    const operationId = "operation_same_123";
    const [first, concurrent] = await Promise.all([
      requestAgentUpsert({ larkinHome: root, agentId: "cli_newA1", operationId }),
      requestAgentUpsert({ larkinHome: root, agentId: "cli_newA1", operationId }),
    ]);
    const replay = await requestAgentUpsert({ larkinHome: root, agentId: "cli_newA1", operationId });
    assert.deepEqual(first, concurrent);
    assert.deepEqual(first, replay);
    assert.equal(first.ok, true);
    assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), [
      `start:${operationId}:cli_newA1`, `end:${operationId}:cli_newA1`,
    ]);
    const conflictProjection = (conflictOperationId) => ({ ok: false, operationId: conflictOperationId,
      agentId: "cli_otherA1", code: "operation_conflict", error: "operationId 已绑定其他 Agent 或操作" });
    assert.deepEqual(await requestAgentUpsert({ larkinHome: root, agentId: "cli_otherA1", operationId }),
      conflictProjection(operationId), "completed successful upsert conflict remains neutral");

    const failedConflictId = "operation_failed_conflict_1";
    const failedUpsert = await requestAgentUpsert({ larkinHome: root, agentId: "cli_newA1", operationId: failedConflictId });
    assert.equal(failedUpsert.ok, false);
    assert.equal(failedUpsert.readiness.reason, "fixture readiness must not leak");
    assert.deepEqual(await requestAgentUpsert({ larkinHome: root, agentId: "cli_otherA1", operationId: failedConflictId }),
      conflictProjection(failedConflictId), "completed failed upsert conflict never leaks original readiness");

    const inFlightConflictId = "operation_inflight_conflict_1";
    const inFlightOriginal = requestAgentUpsert({ larkinHome: root, agentId: "cli_newA1", operationId: inFlightConflictId });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(await requestAgentUpsert({ larkinHome: root, agentId: "cli_otherA1", operationId: inFlightConflictId }),
      conflictProjection(inFlightConflictId), "in-flight upsert conflict uses the same exact neutral envelope");
    assert.equal((await inFlightOriginal).ok, true);
    const [differentOne, differentTwo] = await Promise.all([
      requestAgentUpsert({ larkinHome: root, agentId: "cli_newA1", operationId: "operation_different_1" }),
      requestAgentUpsert({ larkinHome: root, agentId: "cli_newA1", operationId: "operation_different_2" }),
    ]);
    assert.equal(differentOne.ok, true);
    assert.equal(differentTwo.ok, true);
    assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n").slice(-4), [
      "start:operation_different_1:cli_newA1", "end:operation_different_1:cli_newA1",
      "start:operation_different_2:cli_newA1", "end:operation_different_2:cli_newA1",
    ], "different operation IDs for one Agent must serialize");

    const invalid = await rawRequest(socket, {
      operationId: "operation_extra_1", agentId: "cli_newA1", authorization: authority.token, secret: "must-not-pass",
    });
    assert.equal(invalid.ok, false);
    assert.match(invalid.error, /未知字段/);
    assert.doesNotMatch(output, /must-not-pass/);

    const resetCalls = () => fs.readFileSync(calls, "utf8").trim().split("\n").filter((line) => line.startsWith("reset:")).length;
    const [reset, concurrentReset] = await Promise.all([
      requestSessionReset({ larkinHome: root, agentId: "cli_newA1", waitReadyMs: 10 }),
      requestSessionReset({ larkinHome: root, agentId: "cli_newA1", waitReadyMs: 250 }),
    ]);
    assert.deepEqual(concurrentReset, reset, "concurrent reset requests for one Agent share one in-flight result");
    assert.equal(reset.readyForFreshScenario, true);
    assert.equal("operationId" in reset, false);
    assert.equal(resetCalls(), 1);
    const laterReset = await requestSessionReset({ larkinHome: root, agentId: "cli_newA1", waitReadyMs: 10 });
    assert.equal(laterReset.readyForFreshScenario, true);
    assert.equal(resetCalls(), 2, "a completed invocation is not replayed and starts a new reset");
    await restartControl();
    const afterRestart = await requestSessionReset({ larkinHome: root, agentId: "cli_newA1", waitReadyMs: 10 });
    assert.equal(afterRestart.readyForFreshScenario, true);
    assert.equal(resetCalls(), 3, "reset completion is not persisted or replayed across control-server restart");
    assert.equal(fs.existsSync(legacyResetLedger), false, "reset execution never recreates the removed legacy ledger");
    const forbiddenResetId = await rawRequest(socket, { operation: "session-reset", agentId: "cli_newA1",
      authorization: authority.token, waitReadyMs: 10, operationId: "operation_reset_forbidden" });
    assert.equal(forbiddenResetId.ok, false);
    assert.equal("operationId" in forbiddenResetId, false);
    assert.match(forbiddenResetId.error, /未知字段/);
    assert.equal(resetCalls(), 3);
    const unknown = await requestSessionReset({ larkinHome: root, agentId: "cli_unknownA1", waitReadyMs: 10 });
    assert.equal(unknown.ok, false);
    assert.equal(unknown.resetCommitted, false);
    assert.equal(unknown.code, "unknown_agent");

    for (let index = 0; index < 6; index += 1) {
      const churn = await requestAgentUpsert({ larkinHome: root, agentId: "cli_newA1", operationId: `operation_churn_${index}` });
      assert.equal(churn.ok, true);
    }

    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({ version: 3, serverId: "server-control",
      activeAgent: "cli_newA1", agents: { cli_newA1: { runtime: "codex", model: "gpt-5.2" } } }), { mode: 0o600 });
    const deniedRuntimeCli = spawnSync(process.execPath, [path.join(ROOT, "dist/app/cli.mjs"), "session", "reset",
      "--agent", "cli_newA1", "--json"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_AGENT_ID: "cli_runtimeA1" },
    });
    assert.equal(deniedRuntimeCli.status, 1);
    assert.equal(JSON.parse(deniedRuntimeCli.stdout).code, "user_authority_required");
    const publicCli = spawnSync(process.execPath, [path.join(ROOT, "dist/app/cli.mjs"), "session", "reset",
      "--agent", "cli_newA1", "--json", "--wait-ready", "1"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, LARKIN_CONFIG_DIR: root },
    });
    assert.equal(publicCli.status, 0, publicCli.stderr || publicCli.stdout);
    const publicResult = JSON.parse(publicCli.stdout);
    assert.equal("operation_id" in publicResult, false);
    assert.deepEqual(publicResult, { ok: true, agent_id: "cli_newA1",
      reset_committed: true, generation_changed: true, session_changed: true, turns: 0,
      runtime_ready: true, channel_connected: true, reconnecting: false, pending_count: 0,
      ready_for_fresh_scenario: true, inbound_observed: false });

    const publicStore = createAgentStateStore(root, "cli_newA1");
    const status = publicStore.readJson("status", {});
    publicStore.writeJson("status", { ...status, reconnectingAt: new Date(Date.now() + 1_000).toISOString() });
    publicStore.appendNdjson("inbox", { message_id: "om_reconnect_refusal", content: "pending during reconnect" });
    const refused = await requestSessionReset({ larkinHome: root, agentId: "cli_newA1", waitReadyMs: 0 });
    assert.deepEqual(refused, {
      ok: false, agentId: "cli_newA1", code: "channel_reconnecting",
      error: "Agent cli_newA1 channel is reconnecting", resetCommitted: false,
      generationChanged: false, sessionChanged: false, turns: 0, runtimeReady: true,
      channelConnected: true, reconnecting: true, pendingCount: 1,
      readyForFreshScenario: false, inboundObserved: false,
    });
    const refusedCli = spawnSync(process.execPath, [path.join(ROOT, "dist/app/cli.mjs"), "session", "reset",
      "--agent", "cli_newA1", "--json", "--wait-ready", "0"], {
      cwd: ROOT, encoding: "utf8", env: { ...process.env, LARKIN_CONFIG_DIR: root },
    });
    assert.equal(refusedCli.status, 1, refusedCli.stderr || refusedCli.stdout);
    assert.deepEqual(JSON.parse(refusedCli.stdout), {
      ok: false, agent_id: "cli_newA1", reset_committed: false,
      generation_changed: false, session_changed: false, turns: 0, runtime_ready: true,
      channel_connected: true, reconnecting: true, pending_count: 1,
      ready_for_fresh_scenario: false, inbound_observed: false, code: "channel_reconnecting",
      error: "Agent cli_newA1 channel is reconnecting",
    });

    const supervisorStatus = JSON.parse(fs.readFileSync(path.join(root, "supervisor-status.json"), "utf8"));
    const daemonStatus = JSON.parse(fs.readFileSync(path.join(root, "daemon-status.json"), "utf8"));
    assert.equal(JSON.stringify(supervisorStatus).includes(authority.token), false);
    assert.equal(JSON.stringify(daemonStatus).includes(authority.token), false);
    assert.equal(String(inspectProcess(daemonStatus.pid).command || "").includes(authority.token), false,
      "authorization must not enter daemon argv");
    assert.equal(output.includes(authority.token), false, "authorization must not enter logs");

    // Replacing the per-supervisor authority invalidates replay with the prior token,
    // even while an old socket path remains reachable.
    const replacement = await import("../../../dist/app/local-control.mjs");
    replacement.initializeControlAuthority(root, {
      pid: supervisorStatus.pid, processStartToken: supervisorStatus.processStartToken,
    });
    const stale = await rawRequest(socket, {
      operationId: "operation_stale_1", agentId: "cli_newA1", authorization: authority.token,
    });
    assert.equal(stale.ok, false);
    assert.match(stale.error, /unauthorized/);
  } finally {
    if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); }
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(daemonTmp, { recursive: true, force: true });
  }
});

test("legacy reset-ledger cleanup refuses unsafe paths without unlinking or following them", async () => {
  const makeServer = (root) => createAgentControlServer({ larkinHome: root, authorityToken: "A".repeat(43), async upsert() {} });

  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-ledger-symlink-"));
  fs.chmodSync(symlinkRoot, 0o700);
  try {
    const target = path.join(symlinkRoot, "target.json");
    const ledger = path.join(symlinkRoot, "daemon-control-operations.json");
    fs.writeFileSync(target, "target-must-survive", { mode: 0o600 });
    fs.symlinkSync(target, ledger);
    await assert.rejects(makeServer(symlinkRoot).start(), /legacy daemon control operation ledger 不安全/);
    assert.equal(fs.lstatSync(ledger).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(target, "utf8"), "target-must-survive");
  } finally { fs.rmSync(symlinkRoot, { recursive: true, force: true }); }

  const directoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-ledger-directory-"));
  fs.chmodSync(directoryRoot, 0o700);
  try {
    const ledger = path.join(directoryRoot, "daemon-control-operations.json");
    fs.mkdirSync(ledger, { mode: 0o700 });
    fs.writeFileSync(path.join(ledger, "marker"), "directory-must-survive", { mode: 0o600 });
    await assert.rejects(makeServer(directoryRoot).start(), /legacy daemon control operation ledger 不安全/);
    assert.equal(fs.lstatSync(ledger).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(ledger, "marker"), "utf8"), "directory-must-survive");
  } finally { fs.rmSync(directoryRoot, { recursive: true, force: true }); }

  const publicModeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-legacy-ledger-mode-"));
  fs.chmodSync(publicModeRoot, 0o700);
  try {
    const ledger = path.join(publicModeRoot, "daemon-control-operations.json");
    fs.writeFileSync(ledger, "public-file-must-survive", { mode: 0o644 });
    fs.chmodSync(ledger, 0o644);
    await assert.rejects(makeServer(publicModeRoot).start(), /legacy daemon control operation ledger 不安全/);
    assert.equal(fs.readFileSync(ledger, "utf8"), "public-file-must-survive");
    assert.equal(fs.lstatSync(ledger).mode & 0o777, 0o644);
  } finally { fs.rmSync(publicModeRoot, { recursive: true, force: true }); }
});

test("stale socket cleanup refuses a different server even when the filesystem reuses its inode", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-control-replaced-"));
  fs.chmodSync(root, 0o700);
  const token = initializeControlAuthority(root, { pid: process.pid, processStartToken: "unit-test" });
  const authorityFile = path.join(root, "daemon-control-auth.json");
  const authority = JSON.parse(fs.readFileSync(authorityFile, "utf8"));
  const original = net.createServer();
  const listen = (server) => new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(authority.daemonSocketPath, () => { server.off("error", reject); resolve(); });
  });
  const close = (server) => new Promise((resolve) => server.close(resolve));
  let replacement;
  try {
    await listen(original);
    fs.chmodSync(authority.daemonSocketPath, 0o600);
    const originalStat = fs.lstatSync(authority.daemonSocketPath, { bigint: true });
    fs.writeFileSync(authorityFile, `${JSON.stringify({
      ...authority,
      daemon: { pid: process.pid, processStartToken: "unit-test-daemon" },
      daemonSocket: {
        device: String(originalStat.dev),
        inode: String(originalStat.ino),
        owner: String(originalStat.uid),
        changeTimeNs: String(originalStat.ctimeNs),
      },
    }, null, 2)}\n`, { mode: 0o600 });
    await close(original);
    replacement = net.createServer();
    await listen(replacement);
    fs.chmodSync(authority.daemonSocketPath, 0o600);
    assert.throws(() => cleanupStaleAgentControlSocket(root, token), /其他 server/);
    assert.equal(fs.lstatSync(authority.daemonSocketPath).isSocket(), true);
  } finally {
    if (replacement?.listening) await close(replacement);
    if (original.listening) await close(original);
    fs.rmSync(authority.socketRoot, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listen chmod failure closes the server and removes partial socket/root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-control-listen-fail-"));
  fs.chmodSync(root, 0o700);
  try {
    const preload = path.join(ROOT, "test/support/local-control-chmod-failure.cjs");
    const result = spawnSync(process.execPath, ["--preload", preload, path.join(ROOT, "test/support/local-control-listen-failure-harness.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        LARKIN_CONFIG_DIR: root,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /listen-failure-clean/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listen chmod failure preserves a replacement server at the same path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-control-listen-replaced-"));
  fs.chmodSync(root, 0o700);
  try {
    const preload = path.join(ROOT, "test/support/local-control-chmod-failure.cjs");
    const marker = path.join(root, "replacement-ready");
    const result = spawnSync(process.execPath, ["--preload", preload, path.join(ROOT, "test/support/local-control-listen-failure-harness.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        LARKIN_CONFIG_DIR: root,
        LARKIN_REPLACE_BEFORE_CHMOD: "1",
        LARKIN_REPLACEMENT_READY: marker,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /listen-failure-clean/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listen failure preserves the replacement server that occupied the same path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-control-listen-occupied-"));
  fs.chmodSync(root, 0o700);
  try {
    const preload = path.join(ROOT, "test/support/local-control-chmod-failure.cjs");
    const marker = path.join(root, "replacement-ready");
    const result = spawnSync(process.execPath, ["--preload", preload, path.join(ROOT, "test/support/local-control-listen-failure-harness.mjs")], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        LARKIN_CONFIG_DIR: root,
        LARKIN_REPLACE_BEFORE_LISTEN: "1",
        LARKIN_REPLACEMENT_READY: marker,
      },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /listen-failure-clean/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("normal supervisor and daemon close preserve replacement servers at the same paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-control-close-replaced-"));
  fs.chmodSync(root, 0o700);
  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, "test/support/local-control-replacement-close-harness.mjs"),
      "app/runtime-process.mjs",
    ], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, LARKIN_CONFIG_DIR: root },
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /replacement-close-preserved/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
