import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "bun:test";
import { fileURLToPath } from "node:url";
import { requestAgentUpsert } from "../../../dist/app/local-control.mjs";
import { readProcessState } from "../../../dist/platform/process-state.mjs";
import { loadConfig, runtimeConfigSignature } from "../../../dist/platform/config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const AGENTS = ["cli_restartA1", "cli_restartB2", "cli_restartC3"];
const HOT_AGENT = "cli_restartD4";

function writePrivate(file, value) {
  fs.writeFileSync(file, `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function waitUntil(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

function configFor(agentIds) {
  return {
    version: 3,
    serverId: "00000000-0000-0000-0000-000000000145",
    activeAgent: agentIds[0],
    agents: Object.fromEntries(agentIds.map((agentId) => [agentId, { runtime: "codex", model: "gpt-5.5" }])),
  };
}

function readOnlyProfile(root, agentId) {
  const stateDir = path.join(root, "state", "agents", agentId);
  for (const directory of [path.join(stateDir, "lark-cli-config"), path.join(stateDir, "lark-cli-config", "lark-channel"),
    path.join(stateDir, "lark-channel-source"), path.join(stateDir, "runtime-bin")]) fs.chmodSync(directory, 0o500);
  for (const file of [path.join(stateDir, "lark-cli-config", "lark-channel", "config.json"),
    path.join(stateDir, "lark-channel-source", "config.json")]) fs.chmodSync(file, 0o400);
  fs.chmodSync(path.join(stateDir, "runtime-bin", "larkin"), 0o500);
}

function writableProfile(root, agentId) {
  const stateDir = path.join(root, "state", "agents", agentId);
  for (const directory of [path.join(stateDir, "lark-cli-config"), path.join(stateDir, "lark-cli-config", "lark-channel"),
    path.join(stateDir, "lark-channel-source"), path.join(stateDir, "runtime-bin")]) fs.chmodSync(directory, 0o700);
  for (const file of [path.join(stateDir, "lark-cli-config", "lark-channel", "config.json"),
    path.join(stateDir, "lark-channel-source", "config.json")]) fs.chmodSync(file, 0o600);
  fs.chmodSync(path.join(stateDir, "runtime-bin", "larkin"), 0o700);
}

test("selector hot attach survives restart with read-only valid profiles", { timeout: 30_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-hot-attach-restart-"));
  fs.chmodSync(root, 0o700);
  const binDir = path.join(root, "bin");
  const cliPackage = path.join(binDir, "node_modules", "@larksuite", "cli");
  fs.mkdirSync(path.join(cliPackage, "scripts"), { recursive: true, mode: 0o700 });
  writePrivate(path.join(cliPackage, "package.json"), {
    name: "@larksuite/cli", version: "1.0.80", bin: { "lark-cli": "scripts/run.mjs" },
  });
  const cliScript = path.join(cliPackage, "scripts", "run.mjs");
  fs.writeFileSync(cliScript, `#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") { console.log("1.0.80"); process.exit(0); }
if (args[0] === "config" && args[1] === "bind" && args[2] === "--help") { console.log("--source lark-channel --identity bot-only"); process.exit(0); }
if (args[0] === "config" && args[1] === "bind") {
  const source = JSON.parse(fs.readFileSync(process.env.LARK_CHANNEL_CONFIG, "utf8"));
  const appId = source.accounts.app.id;
  const directory = path.join(process.env.LARKSUITE_CLI_CONFIG_DIR, "lark-channel");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({ apps: [{ appId, name: appId, appSecret: { source: "keychain", id: \`appsecret:\${appId}\` }, defaultAs: "bot", strictMode: "bot", users: [] }] }) + "\\n", { mode: 0o600 });
  process.exit(0);
}
process.exit(0);
`, { mode: 0o700 });
  fs.symlinkSync(cliScript, path.join(binDir, "lark-cli"));

  writePrivate(path.join(root, "config.json"), configFor(AGENTS));
  const botsDir = path.join(root, "bots");
  fs.mkdirSync(botsDir, { mode: 0o700 });
  for (const agentId of [...AGENTS, HOT_AGENT]) writePrivate(path.join(botsDir, `${agentId}.json`), {
    appId: agentId, appSecret: "fixture-secret", tenant: "feishu",
  });

  const env = {
    ...process.env,
    LARKIN_CONFIG_DIR: root,
    LARKIN_INTERNAL_DISPATCH: "0",
    LARKIN_BUN_TEST_RUNNER: "1",
    LARKIN_FEISHU_DRYRUN: "1",
    LARKIN_TEST_DAEMON_SCRIPT: path.join(ROOT, "test/support/supervisor-hot-attach-daemon.mjs"),
    LARKIN_TEST_DASHBOARD_SCRIPT: path.join(ROOT, "test/support/dashboard-stable.mjs"),
    PATH: `${binDir}${path.delimiter}${process.env.PATH || ""}`,
  };
  const supervisor = spawn(process.execPath, [path.join(ROOT, "dist/app/run.mjs"), "--agents", AGENTS.join(","), "--dry-run"], {
    cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
  });
  let secondSupervisor = null;
  let output = "";
  supervisor.stdout.on("data", (chunk) => { output += chunk; });
  supervisor.stderr.on("data", (chunk) => { output += chunk; });

  try {
    const initial = await waitUntil(() => {
      const state = readProcessState(root);
      return state.daemon.state === "owned" && state.daemon.agents?.length === 3 ? state : null;
    });
    assert.ok(initial, `initial daemon did not own three Agents\n${output}`);

    // Simulate setup's durable config commit before its supported daemon upsert.
    writePrivate(path.join(root, "config.json"), configFor([...AGENTS, HOT_AGENT]));
    const attached = await requestAgentUpsert({ larkinHome: root, agentId: HOT_AGENT });
    assert.equal(attached.ok, true, JSON.stringify(attached));
    const hotAttached = await waitUntil(() => {
      const state = readProcessState(root).daemon;
      return state.state === "owned" && state.agents?.length === 4 ? state : null;
    });
    assert.ok(hotAttached, `hot attach did not update daemon ownership\n${output}`);
    assert.deepEqual(hotAttached.agents, [...AGENTS, HOT_AGENT]);

    const profileFiles = [...AGENTS, HOT_AGENT].flatMap((agentId) => {
      const stateDir = path.join(root, "state", "agents", agentId);
      return [path.join(stateDir, "lark-cli-config", "lark-channel", "config.json"),
        path.join(stateDir, "lark-channel-source", "config.json"), path.join(stateDir, "runtime-bin", "larkin")];
    });
    const profileMtimes = new Map(profileFiles.map((file) => [file, fs.statSync(file).mtimeNs]));
    for (const agentId of [...AGENTS, HOT_AGENT]) readOnlyProfile(root, agentId);
    const oldDaemonPid = Number(hotAttached.pid);
    process.kill(oldDaemonPid, "SIGKILL");
    const restarted = await waitUntil(() => {
      const state = readProcessState(root);
      return state.supervisor.state === "owned" && state.daemon.state === "owned"
        && Number(state.daemon.pid) !== oldDaemonPid ? state : null;
    }, 10_000);
    assert.ok(restarted, `supervisor did not restart daemon\n${output}`);
    assert.deepEqual(restarted.daemon.agents, [...AGENTS, HOT_AGENT]);
    assert.deepEqual(restarted.daemon.connectedAgents, [...AGENTS, HOT_AGENT]);
    for (const [file, mtime] of profileMtimes) assert.equal(fs.statSync(file).mtimeNs, mtime, `restart rewrote ${file}`);

    // Historical apply state is deliberately present, but must not expand a
    // later explicit selector. Membership additions belong to the supervisor
    // lifetime, not to the durable freshness projection.
    supervisor.kill("SIGTERM");
    await waitUntil(() => supervisor.exitCode !== null || supervisor.signalCode !== null, 3_000);
    const loaded = loadConfig(env);
    const historicalAgents = Object.fromEntries(Object.keys(loaded.config.agents).map((agentId) => {
      const signature = runtimeConfigSignature(loaded.config, agentId);
      return [agentId, { persistedSignature: signature, appliedSignature: signature }];
    }));
    writePrivate(path.join(root, "config-apply-state.json"), {
      version: 1, persistedRevision: "historical", agents: historicalAgents,
    });
    secondSupervisor = spawn(process.execPath, [path.join(ROOT, "dist/app/run.mjs"), "--agent", AGENTS[0], "--dry-run"], {
      cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"],
    });
    secondSupervisor.stdout.on("data", (chunk) => { output += chunk; });
    secondSupervisor.stderr.on("data", (chunk) => { output += chunk; });
    const selected = await waitUntil(() => {
      const state = readProcessState(root);
      return state.daemon.state === "owned" && state.daemon.agents?.length === 1 ? state : null;
    });
    assert.ok(selected, `explicit selector included historical Agents\n${output}`);
    assert.deepEqual(selected.daemon.agents, [AGENTS[0]]);
    const selectedDaemonPid = Number(selected.daemon.pid);
    process.kill(selectedDaemonPid, "SIGKILL");
    const selectedRestarted = await waitUntil(() => {
      const state = readProcessState(root);
      return state.daemon.state === "owned" && Number(state.daemon.pid) !== selectedDaemonPid ? state : null;
    }, 10_000);
    assert.ok(selectedRestarted, `selected supervisor did not restart daemon\n${output}`);
    assert.deepEqual(selectedRestarted.daemon.agents, [AGENTS[0]]);
  } finally {
    for (const agentId of [...AGENTS, HOT_AGENT]) {
      try { writableProfile(root, agentId); } catch { /* profile may not have been created */ }
    }
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGTERM");
    await waitUntil(() => supervisor.exitCode !== null || supervisor.signalCode !== null, 3_000);
    if (supervisor.exitCode === null && supervisor.signalCode === null) supervisor.kill("SIGKILL");
    if (secondSupervisor && secondSupervisor.exitCode === null && secondSupervisor.signalCode === null) secondSupervisor.kill("SIGTERM");
    if (secondSupervisor) {
      await waitUntil(() => secondSupervisor.exitCode !== null || secondSupervisor.signalCode !== null, 3_000);
      if (secondSupervisor.exitCode === null && secondSupervisor.signalCode === null) secondSupervisor.kill("SIGKILL");
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
