#!/usr/bin/env bun
import "../platform/check-bun-version.cjs";
import { spawn, type ChildProcess } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as larkinConfig from "../platform/config.js";
import { currentProcessMetadata } from "../platform/process-inspect.cjs";
import {
  acquireProcessLock,
  readProcessState,
  terminateOwnedProcess,
  waitForProcessExit,
} from "../platform/process-state.js";
import { hydrateRuntimeAgent, syncAgentProfile, type RuntimeAgentConfig } from "./runtime-agent-config.js";
import {
  cleanupStaleAgentControlSocket,
  createSupervisorControlServer,
  initializeControlAuthority,
  removeControlAuthority,
  requestDashboardRecovery,
} from "./local-control.js";
import { internalCommandSpec, processCommandToken } from "./internal-command.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const die = (message: string): never => { console.error(`✗ ${message}`); process.exit(1); };

export function selectedAgentIds(argv: string[], available: string[]): string[] {
  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const requested = flag("--agent");
  const requestedMany = flag("--agents");
  if (requested && requestedMany) throw new Error("--agent 与 --agents 不能同时使用");
  const names = requestedMany
    ? [...new Set(requestedMany.split(",").map((name) => name.trim()).filter(Boolean))]
    : requested ? [requested] : available;
  if (!names.length) throw new Error("--agents 至少需要一个 Agent ID");
  return names;
}

function writeSupervisorStatus(file: string, supervisor: Record<string, unknown>, children: { daemonPid?: number; dashboardPid?: number }): void {
  fs.writeFileSync(file, `${JSON.stringify({
    ...supervisor,
    ...children,
  }, null, 2)}\n`, { mode: 0o600 });
}

function childExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolve) => {
    const onExit = () => { clearTimeout(timer); resolve(true); };
    const timer = setTimeout(() => { child.off("exit", onExit); resolve(false); }, timeoutMs);
    child.once("exit", onExit);
  });
}

export async function stopDashboardWithinBound(
  child: ChildProcess,
  configDir: string,
  signal: NodeJS.Signals = "SIGTERM",
  timeoutMs = 5_000,
): Promise<"stopped" | "killed" | "unowned"> {
  if (child.exitCode !== null || child.signalCode !== null) return "stopped";
  child.kill(signal);
  if (await waitForChildExit(child, timeoutMs)) return "stopped";
  const owned = readProcessState(configDir).dashboard;
  if (owned.state !== "owned" || Number(owned.pid) !== child.pid) return "unowned";
  terminateOwnedProcess(owned, "SIGKILL");
  return await waitForChildExit(child, Math.max(250, Math.min(2_000, timeoutMs))) ? "killed" : "unowned";
}

export async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { configDir, file: configFile, config } = larkinConfig.loadConfig(process.env);
  if (!fs.existsSync(configFile)) die(`没找到配置 ${configFile}，先跑 larkin setup`);
  if (!config.serverId || !Object.keys(config.agents).length) die("配置缺少 serverId/agents，请运行 larkin setup");
  let names: string[];
  try { names = selectedAgentIds(argv, Object.keys(config.agents)); }
  catch (error) { return die((error as Error).message); }

  const before = readProcessState(configDir);
  if (before.supervisor.state === "owned") {
    if (before.dashboard.state !== "owned") {
      const response = await requestDashboardRecovery({ larkinHome: configDir });
      if (!response.ok) die(`dashboard 补拉请求失败：${response.error || "unknown error"}`);
      console.log(`✓ larkin 已由统一 supervisor 运行（pid ${before.supervisor.pid}）；已通过认证控制面请求 dashboard（${response.state || "accepted"}），不重复启动 daemon`);
    } else {
      console.log(`✓ larkin 已由统一 supervisor 运行（pid ${before.supervisor.pid}；dashboard=ready），不重复启动`);
    }
    return;
  }
  if (before.supervisor.state === "unknown") die(`supervisor PID ${before.supervisor.pid} 身份无法确认；拒绝并行启动`);
  if (before.daemon.state === "owned") die(`发现未受统一 supervisor 管理的 daemon PID ${before.daemon.pid}；请先优雅停止旧进程再运行 larkin start`);
  if (before.daemon.state === "unknown") die(`daemon PID ${before.daemon.pid} 身份无法确认；拒绝并行启动`);

  const supervisorCommandToken = processCommandToken("supervisor", "app/run.mjs");
  let launchLock!: ReturnType<typeof acquireProcessLock>;
  try { launchLock = acquireProcessLock(path.join(configDir, "supervisor-launch.lock.json"), supervisorCommandToken); }
  catch (error) {
    const observed = readProcessState(configDir).supervisor;
    if (observed.state === "owned") {
      console.log(`✓ larkin 已由统一 supervisor 运行（pid ${observed.pid}），不重复启动`);
      return;
    }
    die(`无法取得 supervisor 启动锁：${(error as Error).message}`);
  }

  const statusFile = path.join(configDir, "supervisor-status.json");
  const supervisor = {
    ...currentProcessMetadata(supervisorCommandToken), pid: process.pid,
    nonce: crypto.randomUUID(), startedAt: new Date().toISOString(),
  };
  writeSupervisorStatus(statusFile, supervisor, {});
  const supervisorStartToken = String(supervisor.processStartToken || "");
  if (!supervisorStartToken) {
    launchLock.release();
    die("无法取得 supervisor start identity");
  }
  const controlToken = initializeControlAuthority(configDir, { pid: process.pid, processStartToken: supervisorStartToken });
  let ensureDashboardHandler = (): string => "starting";
  const supervisorControl = createSupervisorControlServer({
    larkinHome: configDir,
    authorityToken: controlToken,
    ensureDashboard: () => ensureDashboardHandler(),
  });
  try { await supervisorControl.start(); }
  catch (error) {
    launchLock.release();
    try { removeControlAuthority(configDir, controlToken); } catch { /* best effort */ }
    die(`supervisor control 启动失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const agents: RuntimeAgentConfig[] = [];
  try {
    for (const name of names) {
      const stored = config.agents[name];
      if (!stored) throw new Error(`Agent ${name} 不存在`);
      const agent = hydrateRuntimeAgent(configDir, stored);
      syncAgentProfile(agent, { ...process.env, LARKIN_CONFIG_DIR: configDir });
      agents.push(agent);
    }
  } catch (error) {
    await supervisorControl.close().catch(() => {});
    try { removeControlAuthority(configDir, controlToken); } catch { /* best effort */ }
    launchLock.release();
    die(`Agent 启动校验失败：${error instanceof Error ? error.message : String(error)}`);
  }

  if (before.dashboard.state === "owned") {
    console.error(`[start] 正在把旧 dashboard PID ${before.dashboard.pid} 收归统一 supervisor…`);
    terminateOwnedProcess(before.dashboard, "SIGTERM");
    if (!await waitForProcessExit(before.dashboard)) {
      await supervisorControl.close().catch(() => {});
      try { removeControlAuthority(configDir, controlToken); } catch { /* best effort */ }
      launchLock.release();
      die("旧 dashboard 10 秒内未退出；拒绝并行启动");
    }
  } else if (before.dashboard.state === "unknown") {
    await supervisorControl.close().catch(() => {});
    try { removeControlAuthority(configDir, controlToken); } catch { /* best effort */ }
    launchLock.release();
    die(`dashboard PID ${before.dashboard.pid} 身份无法确认；拒绝替换`);
  }

  const serverId = config.serverId;
  if (!serverId) die("配置缺少 serverId");
  const runtimeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    LARKIN_HOME: configDir,
    LARKIN_CONFIG_DIR: configDir,
    LARKIN_AGENT_TRANSPORT_MODULE: path.join(HERE, "..", "agent", "agent-transport.cjs"),
    LARKIN_SERVER_ID: String(serverId),
    LARKIN_AGENTS_CONFIG: JSON.stringify(agents),
    LARKIN_CONTROL_AUTHORIZATION: controlToken,
  };
  if (argv.includes("--dry-run")) runtimeEnv.LARKIN_FEISHU_DRYRUN = "1";

  let stopping = false;
  let dashboard: ChildProcess | null = null;
  // Set when the daemon-restart path stops the dashboard on purpose (port
  // handover). Its exit is then not a crash and must not count against the
  // dashboard recovery budget nor spawn a duplicate dashboard.
  let intentionalDashboardExit: ChildProcess | null = null;
  let dashboardRestartTimer: NodeJS.Timeout | null = null;
  const dashboardCrashes: number[] = [];
  const dashboardScript = process.env.LARKIN_FEISHU_DRYRUN === "1" && process.env.LARKIN_TEST_DASHBOARD_SCRIPT
    ? path.resolve(process.env.LARKIN_TEST_DASHBOARD_SCRIPT) : path.join(HERE, "dashboard.mjs");
  const daemonSpec = argv.includes("--dry-run") && process.env.LARKIN_TEST_DAEMON_SCRIPT
    ? { command: process.execPath, args: [path.resolve(process.env.LARKIN_TEST_DAEMON_SCRIPT)] }
    : internalCommandSpec("runtime-process", [], runtimeEnv);
  let daemon!: ChildProcess;
  const daemonCrashes: number[] = [];
  let daemonRestartTimer: NodeJS.Timeout | null = null;
  let resolveDaemonFinal: ((result: { code: number | null; signal: NodeJS.Signals | null }) => void) | null = null;
  const daemonFinal = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { resolveDaemonFinal = resolve; });

  // Erlang-style supervision: the supervisor restarts the daemon with a bounded
  // recovery budget (3 restarts per 60s window, exponential backoff) instead of
  // exiting on transient failures (e.g. network/proxy ECONNRESET during Feishu
  // auth). Only when the budget is exhausted does the supervisor exit so the
  // external process manager (launchd) takes over as the final respawn layer.
  const launchDaemon = (): void => {
    daemon = spawn(daemonSpec.command, daemonSpec.args, { env: runtimeEnv, stdio: "inherit" });
    daemon.once("exit", (code, signal) => {
      if (stopping) {
        resolveDaemonFinal?.({ code, signal });
        return;
      }
      const now = Date.now();
      daemonCrashes.push(now);
      while (daemonCrashes[0] < now - 60_000) daemonCrashes.shift();
      if (daemonCrashes.length > 3) {
        console.error(`✗ daemon 60 秒内连续退出超过 3 次；统一 supervisor 退出，交由外部进程管理器重启`);
        resolveDaemonFinal?.({ code, signal });
        return;
      }
      const delay = 250 * 2 ** (daemonCrashes.length - 1);
      console.error(`[start] daemon 异常退出，${delay}ms 后重启（${daemonCrashes.length}/3）`);
      daemonRestartTimer = setTimeout(() => {
        daemonRestartTimer = null;
        if (stopping) return;
        // Keep the control authority intact: the fresh daemon extends it with its
        // own binding and replaces the stale control socket via prepareSocket.
        // Deleting it here makes the daemon's startup fail closed (secureAuthority
        // ENOENT), so every relaunch would crash and the supervisor would loop
        // forever (observed in production as daemon 异常退出 2/3 repeats).
        // Dashboard state is coupled to the daemon; restart it alongside, but let
        // the old dashboard release the dashboard port first: its intentional
        // stop is not a crash and the replacement starts from the exit handler.
        const oldDashboard = dashboard;
        if (oldDashboard && oldDashboard.exitCode === null && oldDashboard.signalCode === null) {
          intentionalDashboardExit = oldDashboard;
          dashboard = null;
          oldDashboard.kill("SIGTERM");
          // If the old dashboard ignores SIGTERM (observed in production holding
          // the dashboard port for minutes), escalate so the port is released
          // and the replacement can start. unref keeps an ignored dashboard from
          // delaying supervisor shutdown.
          const escalate = setTimeout(() => {
            if (oldDashboard.exitCode === null && oldDashboard.signalCode === null) oldDashboard.kill("SIGKILL");
          }, 5_000);
          escalate.unref?.();
          oldDashboard.once("exit", () => clearTimeout(escalate));
        } else {
          launchDashboard();
        }
        if (dashboardRestartTimer) { clearTimeout(dashboardRestartTimer); dashboardRestartTimer = null; }
        dashboardCrashes.length = 0;
        launchDaemon();
        writeSupervisorStatus(statusFile, supervisor, { daemonPid: daemon.pid });
      }, delay);
    });
  };
  launchDaemon();
  const launchDashboard = (): void => {
    const dashboardEnv = { ...process.env, LARKIN_HOME: configDir, LARKIN_CONFIG_DIR: configDir, LARKIN_DASHBOARD_SUPERVISED: "1" };
    const dashboardSpec = process.env.LARKIN_FEISHU_DRYRUN === "1" && process.env.LARKIN_TEST_DASHBOARD_SCRIPT
      ? { command: process.execPath, args: [dashboardScript] }
      : internalCommandSpec("dashboard", [], dashboardEnv);
    dashboard = spawn(dashboardSpec.command, dashboardSpec.args, {
      env: dashboardEnv,
      stdio: "inherit",
    });
    writeSupervisorStatus(statusFile, supervisor, { daemonPid: daemon.pid, dashboardPid: dashboard.pid });
    const ownedChild = dashboard;
    ownedChild.once("exit", () => {
      if (dashboard === ownedChild) dashboard = null;
      if (stopping) return;
      if (intentionalDashboardExit === ownedChild) {
        // Stopped on purpose by the daemon-restart path; bring the replacement
        // up now that the dashboard port is free.
        intentionalDashboardExit = null;
        if (!stopping && daemon.exitCode === null && dashboard === null) launchDashboard();
        return;
      }
      const now = Date.now();
      dashboardCrashes.push(now);
      while (dashboardCrashes[0] < now - 60_000) dashboardCrashes.shift();
      if (dashboardCrashes.length > 3) {
        console.error("✗ dashboard 60 秒内连续退出超过 3 次；停止重启 dashboard，daemon 保持运行");
        writeSupervisorStatus(statusFile, supervisor, { daemonPid: daemon.pid });
        return;
      }
      const delay = 250 * 2 ** (dashboardCrashes.length - 1);
      console.error(`[start] dashboard 异常退出，${delay}ms 后重启（${dashboardCrashes.length}/3）`);
      dashboardRestartTimer = setTimeout(() => {
        dashboardRestartTimer = null;
        if (!stopping && daemon.exitCode === null) launchDashboard();
      }, delay);
    });
  };
  const ensureDashboard = (): string => {
    if (stopping || daemon.exitCode !== null) return "stopping";
    if (dashboard && dashboard.exitCode === null && dashboard.signalCode === null) return "ready";
    if (dashboardRestartTimer) { clearTimeout(dashboardRestartTimer); dashboardRestartTimer = null; }
    dashboardCrashes.length = 0;
    console.error("[start] 收到 dashboard 补拉请求；已重置有界恢复预算");
    launchDashboard();
    return "started";
  };
  ensureDashboardHandler = ensureDashboard;
  launchDashboard();
  launchLock.release();
  console.error(`[start] unified supervisor pid=${process.pid} daemon=${daemon.pid} agents=${names.join(",")}`);
  console.error("[start] dashboard 已随服务启动；不会自动打开浏览器");

  const requestStop = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    if (daemonRestartTimer) { clearTimeout(daemonRestartTimer); daemonRestartTimer = null; }
    if (daemon.exitCode === null && daemon.signalCode === null) {
      daemon.kill(signal);
    } else {
      // The daemon already exited and the supervisor is inside the restart
      // backoff window; the pending timer would never fire again (stopping is
      // set), so resolve the final result now instead of awaiting forever.
      resolveDaemonFinal?.({ code: daemon.exitCode, signal: daemon.signalCode });
    }
  };
  process.once("SIGINT", () => requestStop("SIGINT"));
  process.once("SIGTERM", () => requestStop("SIGTERM"));
  const daemonResult = await daemonFinal;
  try { cleanupStaleAgentControlSocket(configDir, controlToken); }
  catch (error) {
    console.error(`✗ daemon control socket 清理失败：${error instanceof Error ? error.message : String(error)}`);
  }
  const intentional = stopping;
  stopping = true;
  if (dashboardRestartTimer) { clearTimeout(dashboardRestartTimer); dashboardRestartTimer = null; }
  const finalDashboard = dashboard as ChildProcess | null;
  if (finalDashboard) {
    const timeoutMs = Math.max(100, Number(process.env.LARKIN_DASHBOARD_STOP_TIMEOUT_MS || 5_000) || 5_000);
    const result = await stopDashboardWithinBound(finalDashboard, configDir, "SIGTERM", timeoutMs).catch(() => "unowned" as const);
    if (result === "killed") console.error("[start] dashboard 未在期限内退出，已在 ownership 校验后 SIGKILL");
    if (result === "unowned") console.error("✗ dashboard 未在期限内退出且 ownership 无法确认；supervisor fail-safe 退出");
  }
  try {
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8")) as { pid?: number };
    if (status.pid === process.pid) fs.unlinkSync(statusFile);
  } catch { /* best effort */ }
  await supervisorControl.close().catch(() => {});
  try { removeControlAuthority(configDir, controlToken); } catch { /* best effort */ }
  if (!intentional) {
    console.error(`✗ daemon 异常退出（${daemonResult.code ?? daemonResult.signal}）；统一 supervisor 退出，交由外部进程管理器重启`);
    process.exitCode = daemonResult.code && daemonResult.code !== 0 ? daemonResult.code : 1;
  } else {
    process.exitCode = daemonResult.signal === "SIGINT" ? 130 : daemonResult.signal === "SIGTERM" ? 143 : daemonResult.code ?? 0;
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}
