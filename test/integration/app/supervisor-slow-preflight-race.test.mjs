import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "bun:test";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { requestAgentUpsert } from "../../../dist/app/local-control.mjs";
import { readProcessState } from "../../../dist/platform/process-state.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ENABLED = process.env.LARKIN_RUN_REAL_PROCESS_TEST === "1";

async function waitUntil(predicate, timeoutMs, intervalMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

async function waitExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error("child exit timeout")), timeoutMs)),
  ]);
}

test.skipIf(!ENABLED)("duplicate start during slow preflight uses authenticated control without SIGUSR1 inspector race", {
  timeout: 25_000,
}, async () => {
  const root = fs.mkdtempSync("/tmp/larkin-slow-race-");
  fs.chmodSync(root, 0o700);
  const agentId = "cli_slowRaceA1";
  const addedAgentId = "cli_slowRaceB2";
  const binDir = path.join(root, "bin");
  const botsDir = path.join(root, "bots");
  fs.mkdirSync(binDir, { mode: 0o700 });
  fs.mkdirSync(botsDir, { mode: 0o700 });
  fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
    version: 3, serverId: "server-slow-race", activeAgent: agentId,
    agents: { [agentId]: { runtime: "codex", model: "gpt-test" } },
  }), { mode: 0o600 });
  fs.writeFileSync(path.join(botsDir, `${agentId}.json`), JSON.stringify({
    appId: agentId, appSecret: "fixture-secret", tenant: "feishu",
  }), { mode: 0o600 });
  const longTmp = path.join(root, "tmp-" + "x".repeat(180));
  fs.mkdirSync(longTmp, { mode: 0o700 });
  const calls = path.join(root, "lark-calls.log");
  fs.writeFileSync(path.join(binDir, "lark-cli"), `#!/usr/bin/env bun
const fs = require("node:fs"), args = process.argv.slice(2);
if (args[0] === "config" && args[1] === "init") {
  fs.appendFileSync(process.env.SLOW_RACE_CALLS, "init\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 800);
  process.exit(0);
}
if (args.includes("+chat-list")) console.log(JSON.stringify({ok:true,identity:"bot",data:{chats:[]}}));
`, { mode: 0o755 });
  const fakeCodex = path.join(binDir, "fake-codex");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env bun
const readline=require("node:readline");readline.createInterface({input:process.stdin}).on("line",line=>{const r=JSON.parse(line);if(r.id==null)return;const result=r.method==="thread/start"?{thread:{id:"slow-race-session"}}:{};process.stdout.write(JSON.stringify({jsonrpc:"2.0",id:r.id,result})+"\\n")});
`, { mode: 0o755 });
  const fakeChannel = path.join(root, "fake-channel.mjs");
  fs.writeFileSync(fakeChannel, `export function createLarkChannel(options) {
  return {
    botIdentity: { openId: "ou_" + options.appId, name: options.appId },
    rawClient: { async request() { return { bot: { open_id: "ou_" + options.appId, app_name: options.appId } }; } },
    dispatcher: { register() {} }, on() {}, async connect() {}, async disconnect() {},
  };
}
`);
  const env = {
    ...process.env, TMPDIR: longTmp, LARKIN_CONFIG_DIR: root, LARKIN_FEISHU_DRYRUN: "1",
    LARKIN_TEST_CHANNEL_MODULE: fakeChannel,
    LARKIN_CODEX_COMMAND: fakeCodex, SLOW_RACE_CALLS: calls,
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
  };
  const args = [path.join(ROOT, "dist/app/run.mjs"), "--dry-run"];
  const first = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let firstOutput = "";
  first.stdout.on("data", (chunk) => { firstOutput += chunk; });
  first.stderr.on("data", (chunk) => { firstOutput += chunk; });
  let duplicate;
  let controlRoot;
  try {
    const published = await waitUntil(() => {
      const state = readProcessState(root);
      return state.supervisor.state === "owned" && state.dashboard.state !== "owned" ? state : null;
    }, 3_000, 2);
    assert.ok(published, firstOutput);
    duplicate = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
    let duplicateOutput = "";
    duplicate.stdout.on("data", (chunk) => { duplicateOutput += chunk; });
    duplicate.stderr.on("data", (chunk) => { duplicateOutput += chunk; });
    await waitExit(duplicate, 10_000);
    assert.equal(duplicate.exitCode, 0, duplicateOutput);
    assert.match(duplicateOutput, /认证控制面请求 dashboard|dashboard=ready/);
    const ready = await waitUntil(() => {
      const state = readProcessState(root);
      return state.daemon.state === "owned" && state.dashboard.state === "owned" ? state : null;
    }, 10_000);
    assert.ok(ready, firstOutput + duplicateOutput);
    assert.equal(fs.readFileSync(calls, "utf8").trim().split("\n").length, 1, "duplicate start must not run a second preflight/daemon");
    assert.doesNotMatch(firstOutput + duplicateOutput, /Debugger listening|127\.0\.0\.1:9229/);
    const authority = JSON.parse(fs.readFileSync(path.join(root, "daemon-control-auth.json"), "utf8"));
    controlRoot = authority.socketRoot;
    assert.equal(authority.socketRoot.startsWith("/tmp/lk-"), true, "overlong TMPDIR must fall back to the bounded /tmp base");
    assert.ok(Buffer.byteLength(authority.supervisorSocketPath) <= 103);
    assert.ok(Buffer.byteLength(authority.daemonSocketPath) <= 103);
    assert.equal(fs.readdirSync(longTmp).some((name) => name.startsWith("lk-")), false, "long TMPDIR must contain no partial/truncated socket root");
    assert.ok(await waitUntil(() => /bot 身份就绪\(channel\)/.test(firstOutput), 5_000), firstOutput);

    fs.writeFileSync(path.join(root, "config.json"), JSON.stringify({
      version: 3, serverId: "server-slow-race", activeAgent: agentId,
      agents: {
        [agentId]: { runtime: "codex", model: "gpt-test" },
        [addedAgentId]: { runtime: "codex", model: "gpt-test" },
      },
    }), { mode: 0o600 });
    fs.writeFileSync(path.join(botsDir, `${addedAgentId}.json`), JSON.stringify({
      appId: addedAgentId, appSecret: "fixture-secret-added", tenant: "feishu",
    }), { mode: 0o600 });
    const upsert = await requestAgentUpsert({ larkinHome: root, agentId: addedAgentId, operationId: "operation_long_tmp_hot_1" });
    assert.equal(upsert.ok, true, upsert.error);
    const attached = await waitUntil(() => {
      const state = readProcessState(root).daemon;
      return state.state === "owned" && state.agents?.includes(addedAgentId) ? state : null;
    }, 5_000);
    assert.ok(attached, firstOutput);
  } finally {
    if (duplicate && duplicate.exitCode === null && duplicate.signalCode === null) duplicate.kill("SIGKILL");
    if (first.exitCode === null && first.signalCode === null) {
      first.kill("SIGTERM");
      await waitExit(first, 5_000).catch(() => first.kill("SIGKILL"));
    }
    if (controlRoot) assert.equal(fs.existsSync(controlRoot), false);
    assert.equal(fs.readdirSync(longTmp).some((name) => name.startsWith("lk-")), false);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
