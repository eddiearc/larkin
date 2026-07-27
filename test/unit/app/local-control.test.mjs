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
  initializeControlAuthority,
  requestAgentUpsert,
} from "../../../dist/app/local-control.mjs";
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

test("local control socket is user-only, agent-id-only, and operation-id idempotent", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-control-"));
  fs.chmodSync(root, 0o700);
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
    assert.match(invalid.error, /只允许 operationId\/agentId\/authorization/);
    assert.doesNotMatch(output, /must-not-pass/);

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
