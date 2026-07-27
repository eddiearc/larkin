import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readProcessState } from "../../../dist/platform/process-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENABLED = process.env.LARKIN_RUN_REAL_PROCESS_TEST === "1";

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

test.skipIf(!ENABLED)("daemon crash bounds shutdown when dashboard refuses SIGTERM and uses owned SIGKILL", {
  timeout: 20_000,
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-supervisor-bound-"));
  fs.chmodSync(root, 0o700);
  const agentId = "cli_boundA1";
  const binDir = path.join(root, "bin");
  const botsDir = path.join(root, "bots");
  fs.mkdirSync(binDir, { mode: 0o700 });
  fs.mkdirSync(botsDir, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), `${JSON.stringify({
    version: 3, serverId: crypto.randomUUID(), activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "gpt-5.5" } },
  }, null, 2)}\n`, { mode: 0o600 });
  fs.writeFileSync(path.join(botsDir, `${agentId}.json`), JSON.stringify({
    appId: agentId, appSecret: "fixture-secret", tenant: "feishu",
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(binDir, "lark-cli"), `#!/usr/bin/env bun
if (process.argv.includes("+chat-list")) console.log(JSON.stringify({ok:true,identity:"bot",data:{chats:[]}}));
`, { mode: 0o755 });
  const eventFile = path.join(root, "events.ndjson");
  fs.writeFileSync(eventFile, "");
  const child = spawn(process.execPath, [path.join(ROOT, "dist/app/run.mjs"), "--dry-run"], {
    cwd: ROOT,
    env: {
      ...process.env, LARKIN_CONFIG_DIR: root, LARKIN_FEISHU_DRYRUN: "1", LARKIN_FEISHU_EVENT_FILE: eventFile,
      LARKIN_TEST_DASHBOARD_SCRIPT: path.join(ROOT, "test/support/dashboard-refuse-shutdown.mjs"),
      LARKIN_DASHBOARD_STOP_TIMEOUT_MS: "150", PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  try {
    const running = await waitUntil(() => {
      const state = readProcessState(root);
      return state.daemon.state === "owned" && state.dashboard.state === "owned" ? state : null;
    }, 8_000);
    assert.ok(running, output);
    const dashboardPid = Number(running.dashboard.pid);
    const authority = JSON.parse(fs.readFileSync(path.join(root, "daemon-control-auth.json"), "utf8"));
    assert.equal(fs.lstatSync(authority.daemonSocketPath).isSocket(), true);
    assert.equal(fs.lstatSync(authority.supervisorSocketPath).isSocket(), true);
    const startedAt = Date.now();
    process.kill(Number(running.daemon.pid), "SIGKILL");
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 3_000);
    assert.notEqual(child.exitCode, null, output);
    assert.ok(Date.now() - startedAt < 3_000, `supervisor exceeded bounded dashboard shutdown\n${output}`);
    assert.throws(() => process.kill(dashboardPid, 0));
    assert.match(output, /ownership 校验后 SIGKILL/);
    assert.equal(fs.existsSync(authority.daemonSocketPath), false, "supervisor must remove SIGKILL-stale daemon socket");
    assert.equal(fs.existsSync(authority.supervisorSocketPath), false, "supervisor socket must close during final teardown");
    assert.equal(fs.existsSync(authority.socketRoot), false, "empty private control root must be removed");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
