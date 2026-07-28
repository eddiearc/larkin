#!/usr/bin/env bun
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { hydrateRuntimeAgent, syncAgentProfile } from "../../dist/app/runtime-agent-config.mjs";
import { createHostShell } from "../../dist/feishu/host-shell.mjs";
import { loadConfig, toStored } from "../../dist/platform/config.mjs";
import { currentProcessMetadata, readProcessState } from "../../dist/platform/process-state.mjs";
import { loadValidatedBotCredential } from "../../dist/setup/run-credential-preflight.mjs";

export const HOLD_HOST_COMMAND_TOKEN = "app/runtime-process.mjs";
const LAUNCHD_LABEL = "com.eddiearc.larkin";
const LAUNCHD_PROGRAM_ARGUMENTS = ["/opt/homebrew/bin/larkin", "start"];
const TEMP_ROOT_PREFIX = "larkin-runtime-interface-v2-hold-";
const READY_BASENAME = "runtime-interface-v2-hold-host-ready.json";

function required(env, name) {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function assertOwnedDirectory(directory, label, exactMode = 0o700) {
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o777) !== exactMode) {
    throw new Error(`${label} must be an owned non-symlink directory with mode ${exactMode.toString(8)}`);
  }
  return fs.realpathSync(directory);
}

function writePrivateJson(file, value) {
  const fd = fs.openSync(file, "wx", 0o600);
  try {
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function assertExplicitGate(env) {
  if (env.LARKIN_RUN_RUNTIME_AGENT_INTERFACE_V2_HOLD_HOST !== "1"
      || env.LARKIN_LIVE_HOLD_HOST_ALLOW_REAL_CHANNEL !== "1") {
    throw new Error("hold-host is disabled; both explicit live channel gates must equal 1");
  }
  if (env.LARKIN_FEISHU_DRYRUN === "1" || env.LARKIN_FEISHU_EVENT_CMD
      || env.LARKIN_FEISHU_EVENT_FILE || env.LARKIN_TEST_CHANNEL_MODULE) {
    throw new Error("hold-host requires the real Feishu channel and rejects test event/channel injection");
  }
  if (env.LARKIN_INTERNAL_DISPATCH === "1" || env.LARKIN_STANDALONE === "1") {
    throw new Error("hold-host command identity requires the source driver invocation");
  }
}

function assertLaunchdRecoveryAndBootout(home) {
  if (process.platform !== "darwin" || typeof process.getuid !== "function") {
    throw new Error("hold-host requires the audited macOS launchd recovery path");
  }
  const plist = path.join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`);
  const stat = fs.lstatSync(plist);
  if (!stat.isFile() || stat.isSymbolicLink()
      || stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0) {
    throw new Error("launchd recovery plist is missing or unsafe");
  }
  const parsed = spawnSync("plutil", ["-convert", "json", "-o", "-", plist], { encoding: "utf8" });
  if (parsed.error || parsed.status !== 0) throw new Error("launchd recovery plist cannot be audited");
  let payload;
  try { payload = JSON.parse(parsed.stdout); }
  catch { throw new Error("launchd recovery plist is not parseable"); }
  if (payload.Label !== LAUNCHD_LABEL
      || JSON.stringify(payload.ProgramArguments) !== JSON.stringify(LAUNCHD_PROGRAM_ARGUMENTS)
      || payload.KeepAlive !== true || payload.RunAtLoad !== true) {
    throw new Error("launchd recovery identity does not match the audited Larkin service");
  }
  const printed = spawnSync("launchctl", ["print", `gui/${process.getuid()}/${LAUNCHD_LABEL}`], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  if (printed.error || printed.signal) throw new Error("launchd service state cannot be proved");
  if (printed.status === 0) throw new Error("global Larkin launchd service is still loaded; bootout must be completed by the operator");
  if (!/could not find service|service[^\n]*not found/i.test(`${printed.stdout}\n${printed.stderr}`)) {
    throw new Error("launchd service absence cannot be proved");
  }
}

function assertNoGlobalHost(sourceRoot) {
  for (const [role, record] of Object.entries(readProcessState(sourceRoot))) {
    if (record.state !== "dead") {
      throw new Error(`global ${role} is ${record.state}; refuse a second Host connection`);
    }
  }
  const listed = spawnSync("ps", ["-axo", "pid=,command="], {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  if (listed.error || listed.status !== 0) throw new Error("process command identity cannot be proved");
  const candidates = String(listed.stdout || "").split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!match || Number(match[1]) === process.pid) return [];
    const command = match[2];
    const larkinHost = /(?:^|\s)\S*\/larkin\s+(?:start|__internal\s+(?:run|runtime-process))\b/.test(command)
      || /(?:^|\s)\S*\/(?:bun|node)(?:\s+--\S+)*\s+(?:run\s+)?\S*(?:dist\/)?app\/(?:run|runtime-process)\.mjs(?:\s|$)/.test(command);
    return larkinHost ? [Number(match[1])] : [];
  });
  if (candidates.length) throw new Error(`possible Larkin Host process remains (pid ${candidates.join(",")})`);
}

function resolveSafeRoots(env) {
  const home = os.homedir();
  const sourceInput = required(env, "LARKIN_LIVE_SOURCE_CONFIG_DIR");
  const targetInput = required(env, "LARKIN_LIVE_CONFIG_DIR");
  if (!path.isAbsolute(sourceInput) || !path.isAbsolute(targetInput)) throw new Error("source and isolated roots must be absolute");
  const sourceRoot = assertOwnedDirectory(sourceInput, "source root");
  const expectedSource = fs.realpathSync(path.join(home, ".larkin"));
  if (sourceRoot !== expectedSource) throw new Error("source root must be the audited global ~/.larkin root");
  const targetRoot = assertOwnedDirectory(targetInput, "isolated root");
  const tempRoot = fs.realpathSync(os.tmpdir());
  if (path.dirname(targetRoot) !== tempRoot || !path.basename(targetRoot).startsWith(TEMP_ROOT_PREFIX)) {
    throw new Error(`isolated root must be a direct ${TEMP_ROOT_PREFIX}* child of the system temp directory`);
  }
  if (targetRoot === sourceRoot || fs.readdirSync(targetRoot).length !== 0) {
    throw new Error("isolated root must be distinct and empty");
  }
  const readyFile = path.join(targetRoot, READY_BASENAME);
  if (path.dirname(readyFile) !== targetRoot || fs.existsSync(readyFile)) throw new Error("ready path is unsafe");
  return { home, sourceRoot, targetRoot, readyFile };
}

function stageSingleAgentRoot(sourceRoot, targetRoot, agentId, env) {
  const source = loadConfig({ ...env, LARKIN_CONFIG_DIR: sourceRoot });
  const sourceAgent = source.config.agents[agentId];
  if (!sourceAgent) throw new Error("selected Agent is not present in the audited source config");
  const stored = toStored(source.config).agents[agentId];
  const isolatedConfig = {
    version: 4,
    serverId: `live-hold-${crypto.randomUUID()}`,
    mentionPolicy: source.config.mentionPolicy,
    activeAgent: agentId,
    agents: { [agentId]: stored },
  };
  writePrivateJson(path.join(targetRoot, "config.json"), isolatedConfig);
  const sourceBots = path.join(sourceRoot, "bots");
  const credential = loadValidatedBotCredential(sourceBots, agentId);
  const targetBots = path.join(targetRoot, "bots");
  fs.mkdirSync(targetBots, { mode: 0o700 });
  writePrivateJson(path.join(targetBots, `${agentId}.json`), credential);

  const isolated = loadConfig({ ...env, LARKIN_CONFIG_DIR: targetRoot });
  const isolatedAgentIds = Object.keys(isolated.config.agents);
  if (isolatedAgentIds.length !== 1 || isolatedAgentIds[0] !== agentId || isolated.config.activeAgent !== agentId) {
    throw new Error("isolated config is not an exact single-Agent config");
  }
  const runtimeAgent = hydrateRuntimeAgent(targetRoot, isolated.config.agents[agentId]);
  syncAgentProfile(runtimeAgent, { ...env, LARKIN_CONFIG_DIR: targetRoot, LARKIN_AGENT_ID: agentId });
  return { isolated, runtimeAgent };
}

export function createDeferredRuntimeHost() {
  return Object.freeze({
    async start(configs) {
      if (!Array.isArray(configs) || configs.length !== 1) throw new Error("hold RuntimeHost requires exactly one Agent");
    },
    async deliver(_agentId, envelope) {
      void envelope;
      return {
        status: "deferred",
        deliveryId: `hold_${crypto.randomUUID()}`,
        reason: "live hold-host leaves the message in the canonical Inbox for explicit check/poll",
      };
    },
    async stop() {},
    async shutdown() {},
    subscribe() { return () => {}; },
    isBusy() { return false; },
  });
}

function refuseAncillaryLarkCli(_command, _args, _options, callback) {
  const error = Object.assign(new Error("hold-host blocks ancillary lark-cli calls"), { code: "LARKIN_HOLD_HOST" });
  queueMicrotask(() => callback(error, "", "hold-host blocked"));
  return undefined;
}

async function waitForConnected(statusFile, startedMs, stopped, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stoppedCode = await Promise.race([
      stopped.then((code) => ({ stopped: true, code })),
      new Promise((resolve) => setTimeout(() => resolve({ stopped: false }), 200)),
    ]);
    if (stoppedCode.stopped) throw new Error(`hold-host stopped before ready (exit=${stoppedCode.code})`);
    try {
      const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
      const connectedMs = Date.parse(String(status.connectedAt || ""));
      if (status.connectedVia === "channel" && Number.isFinite(connectedMs) && connectedMs >= startedMs) {
        return status.connectedAt;
      }
    } catch (error) {
      if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
  }
  throw new Error("real Feishu channel did not become ready within 30 seconds");
}

export async function main(env = process.env) {
  assertExplicitGate(env);
  currentProcessMetadata(path.basename(fileURLToPath(import.meta.url)));
  const identity = currentProcessMetadata(HOLD_HOST_COMMAND_TOKEN);
  const agentId = required(env, "LARKIN_LIVE_AGENT_ID");
  if (!/^cli_[A-Za-z0-9]+$/.test(agentId)) throw new Error("LARKIN_LIVE_AGENT_ID must be an exact Agent App ID");
  const { home, sourceRoot, targetRoot, readyFile } = resolveSafeRoots(env);
  assertLaunchdRecoveryAndBootout(home);
  assertNoGlobalHost(sourceRoot);

  const { isolated, runtimeAgent } = stageSingleAgentRoot(sourceRoot, targetRoot, agentId, env);
  const hostEnv = {
    ...env,
    LARKIN_HOME: targetRoot,
    LARKIN_CONFIG_DIR: targetRoot,
    LARKIN_AGENT_ID: agentId,
    LARKIN_SERVER_ID: isolated.config.serverId,
    LARKIN_AGENTS_CONFIG: JSON.stringify([runtimeAgent]),
    LARKSUITE_CLI_CONFIG_DIR: runtimeAgent.larkConfigDir,
    LARKIN_INBOUND_DROUGHT_SEC: "0",
  };
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  const host = createHostShell({
    env: hostEnv,
    runtimeHost: createDeferredRuntimeHost(),
    eventSourceStartDelayMs: 0,
    execFileImpl: refuseAncillaryLarkCli,
    onOrderedShutdownComplete(exitCode) { resolveStopped(exitCode); },
  });
  const startedMs = Date.now();
  await host.start();
  let connectedAt;
  try {
    connectedAt = await waitForConnected(path.join(runtimeAgent.stateDir, "status.json"), startedMs, stopped);
  } catch (error) {
    await host.shutdown("hold-host readiness failed").catch(() => {});
    throw error;
  }
  writePrivateJson(readyFile, {
    version: 1,
    ready: true,
    pid: identity.pid,
    processStartToken: identity.processStartToken,
    commandToken: identity.commandToken,
    connectedAt,
    agentCount: 1,
    runtimeDelivery: "always-deferred",
  });
  process.stderr.write(`[live-hold-host] ready; isolated root=${targetRoot}; Runtime delivery=always-deferred\n`);
  const exitCode = await stopped;
  try { fs.unlinkSync(readyFile); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  process.exitCode = exitCode;
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    process.stderr.write(`[live-hold-host] refused: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
