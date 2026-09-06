import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureOwnedTree, mkdirPrivateExclusive, writePrivateExclusive } from "./pi-state-dir.js";

export const DEFAULT_BASH_WAIT_SECONDS = 30;
export const OUTPUT_TAIL_BYTES = 32 * 1024;
export const LARKIN_TMUX_COMPLETION_TYPE = "larkin-tmux-completion";

export type TmuxTaskStatus = "running" | "completed" | "failed" | "cancelled";

export interface TmuxTaskSnapshot {
  taskId: string;
  status: TmuxTaskStatus;
  exitCode: number | null;
  output: string;
  startedAt: string | null;
  endedAt: string | null;
}

export class ForeignTmuxTaskError extends Error {
  readonly taskId: string;
  constructor(taskId: string) {
    super(`tmux task ${taskId} is not owned by this Larkin instance`);
    this.name = "ForeignTmuxTaskError";
    this.taskId = taskId;
  }
}

export function tmuxAvailable(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "win32") return false;
  const result = spawnSync("tmux", ["-V"], { env: tmuxClientEnv(env), encoding: "utf8", timeout: 5_000 });
  const version = /tmux\s+(\d+)\.(\d+)/i.exec(`${result.stdout || ""} ${result.stderr || ""}`);
  return result.status === 0 && version !== null
    && (Number(version[1]) > 3 || (Number(version[1]) === 3 && Number(version[2]) >= 2));
}

function posixQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function sanitizeName(value: string, fallback: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  return cleaned || fallback;
}

function taskRoot(stateDir: string, agentId: string, instanceId: string): string {
  return path.join(stateDir, "pi-tmux", sanitizeName(agentId, "agent"), sanitizeName(instanceId, "inst"));
}

function taskDir(stateDir: string, agentId: string, instanceId: string, taskId: string): string {
  return path.join(taskRoot(stateDir, agentId, instanceId), taskId);
}

function sessionName(agentId: string, instanceId: string, taskId: string): string {
  return `lkn-${sanitizeName(agentId, "agent")}-${sanitizeName(instanceId, "inst")}-${taskId}`;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function writePrivate(file: string, body: string): void {
  fs.writeFileSync(file, body, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

function isRegularFile(file: string): boolean {
  try {
    const stat = fs.lstatSync(file);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function tailBytes(file: string, maxBytes: number): string {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = size > maxBytes ? size - maxBytes : 0;
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      return buf.toString("utf8");
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return "";
  }
}

function writeEnvScript(file: string, env: NodeJS.ProcessEnv): void {
  const lines = ["#!/bin/bash", "set -eu"];
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (value === undefined) continue;
    // 不写入继承的 tmux 会话坐标；pane 会带上本次 new-session 的值。
    if (key === "PWD" || key === "TMUX" || key === "TMUX_PANE") continue;
    lines.push(`export ${key}=${posixQuote(value)}`);
  }
  writePrivateExclusive(file, `${lines.join("\n")}\n`);
}

function tmuxClientEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next = { ...env };
  delete next.TMUX;
  delete next.TMUX_PANE;
  delete next.BASH_ENV;
  return next;
}

function tmuxHasSession(name: string, env: NodeJS.ProcessEnv): boolean {
  return spawnSync("tmux", ["has-session", "-t", `=${name}`], { env: tmuxClientEnv(env), encoding: "utf8", timeout: 5_000 }).status === 0;
}

function killSession(name: string, env: NodeJS.ProcessEnv): void {
  spawnSync("tmux", ["kill-session", "-t", `=${name}`], { env: tmuxClientEnv(env), encoding: "utf8", timeout: 5_000 });
}

function parseExitCode(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number.parseInt(raw.trim(), 10);
  return Number.isInteger(value) ? value : null;
}

type ProcessRow = { pid: number; ppid: number; pgid: number; state: string };

function processTable(): ProcessRow[] {
  const listed = spawnSync("ps", ["-ax", "-o", "pid=,ppid=,pgid=,state="], { encoding: "utf8", timeout: 5_000 });
  if (listed.status !== 0) return [];
  return listed.stdout.split("\n").flatMap((line) => {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/);
    if (!match) return [];
    return [{
      pid: Number.parseInt(match[1], 10),
      ppid: Number.parseInt(match[2], 10),
      pgid: Number.parseInt(match[3], 10),
      state: match[4],
    }];
  });
}

function liveOwnedPanePid(session: string, env: NodeJS.ProcessEnv): number | null {
  if (!tmuxHasSession(session, env)) return null;
  const listed = spawnSync("tmux", ["list-panes", "-t", `=${session}`, "-F", "#{pane_pid}"], {
    env: tmuxClientEnv(env), encoding: "utf8", timeout: 5_000,
  });
  if (listed.status !== 0) return null;
  const pid = Number.parseInt(listed.stdout.trim().split(/\s+/)[0] ?? "", 10);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try { process.kill(pid, 0); } catch { return null; }
  return pid;
}

function ownedPids(panePid: number, rows: ProcessRow[]): number[] {
  const pane = rows.find((row) => row.pid === panePid);
  const owned = new Set<number>([panePid]);
  if (pane) {
    for (const row of rows) if (row.pgid === pane.pgid) owned.add(row.pid);
  }
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (owned.has(row.ppid) && !owned.has(row.pid) && !row.state.startsWith("Z")) {
        owned.add(row.pid);
        grew = true;
      }
    }
  }
  return [...owned].filter((pid) => pid > 1 && pid !== process.pid);
}

function pidAlive(pid: number): boolean {
  const listed = spawnSync("ps", ["-p", String(pid), "-o", "stat="], { encoding: "utf8", timeout: 5_000 });
  const state = listed.stdout.trim();
  return listed.status === 0 && Boolean(state) && !state.startsWith("Z");
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pgid, signal); } catch { /* 组已不存在或不是 leader */ }
}

/** 只杀当前 pane 进程组及其子孙；不读落盘 pid。SIGKILL 覆盖 trap 忽略 TERM/HUP。 */
function terminateOwnedPane(session: string, env: NodeJS.ProcessEnv): void {
  const panePid = liveOwnedPanePid(session, env);
  const rows = processTable();
  const pane = rows.find((row) => row.pid === panePid);
  const pids = panePid ? ownedPids(panePid, rows) : [];
  if (pane) signalGroup(pane.pgid, "SIGTERM");
  killSession(session, env);
  if (pane) signalGroup(pane.pgid, "SIGKILL");
  for (const pid of pids) {
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  }
  if (tmuxHasSession(session, env)) killSession(session, env);
  if (tmuxHasSession(session, env)) throw new Error(`tmux session ${session} still present after kill`);
  const deadline = Date.now() + 250;
  while (Date.now() < deadline && pids.some(pidAlive)) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  if (pids.some(pidAlive)) throw new Error(`tmux pane descendants still present after kill`);
}

function snapshotFromDir(dir: string, taskId: string, env: NodeJS.ProcessEnv, session: string): TmuxTaskSnapshot {
  // 先探活再读终态：exit_code 在 shell 退出前落盘。先读再 has-session 会把探测窗口里写完的快命令判成 failed+null。
  const live = tmuxHasSession(session, env);
  const readExit = (): number | null => parseExitCode(readText(path.join(dir, "exit_code")));
  const cancelled = readText(path.join(dir, "cancelled")) !== null;
  let exitCode = readExit();
  if (!live && exitCode === null) exitCode = readExit();
  const startedAt = readText(path.join(dir, "started_at"))?.trim() || null;
  const endedAt = readText(path.join(dir, "ended_at"))?.trim() || null;
  const output = tailBytes(path.join(dir, "output"), OUTPUT_TAIL_BYTES);
  let status: TmuxTaskStatus;
  if (exitCode === null) {
    if (live) status = cancelled ? "cancelled" : "running";
    else status = cancelled ? "cancelled" : "failed";
  } else if (cancelled) status = "cancelled";
  else status = exitCode === 0 ? "completed" : "failed";
  return { taskId, status, exitCode, output, startedAt, endedAt };
}

export function formatTmuxTaskText(snapshot: TmuxTaskSnapshot): string {
  const exit = snapshot.exitCode === null ? "null" : String(snapshot.exitCode);
  const body = snapshot.output ? `\n${snapshot.output}` : "";
  return `taskId=${snapshot.taskId} status=${snapshot.status} exitCode=${exit}${body}`;
}

export function createLarkinTmux(input: {
  stateDir: string;
  agentId: string;
  instanceId?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const env = input.env ?? process.env;
  const agentId = input.agentId;
  const instanceId = input.instanceId || crypto.randomUUID();
  const stateDir = path.resolve(input.stateDir);
  const ownedParts = ["pi-tmux", sanitizeName(agentId, "agent"), sanitizeName(instanceId, "inst")] as const;
  const root = taskRoot(stateDir, agentId, instanceId);

  const expectedSession = (taskId: string): string => sessionName(agentId, instanceId, taskId);

  const assertPrivateScripts = (dir: string): void => {
    for (const name of ["env.sh", "command.sh", "run.sh", "meta.json"]) {
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) {
        if (name === "meta.json") throw new ForeignTmuxTaskError(path.basename(dir));
        continue;
      }
      if (!isRegularFile(file)) throw new ForeignTmuxTaskError(path.basename(dir));
    }
  };

  const requireOwned = (taskId: string): string => {
    if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new ForeignTmuxTaskError(taskId);
    let instanceRoot: string;
    try {
      instanceRoot = ensureOwnedTree(stateDir, ownedParts, false);
    } catch {
      throw new ForeignTmuxTaskError(taskId);
    }
    const dir = taskDir(stateDir, agentId, instanceId, taskId);
    try {
      const stat = fs.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory() || !isInside(instanceRoot, dir)) throw new ForeignTmuxTaskError(taskId);
    } catch (error) {
      if (error instanceof ForeignTmuxTaskError) throw error;
      throw new ForeignTmuxTaskError(taskId);
    }
    const metaFile = path.join(dir, "meta.json");
    if (!isRegularFile(metaFile)) throw new ForeignTmuxTaskError(taskId);
    let meta: { taskId?: unknown; agentId?: unknown; instanceId?: unknown; session?: unknown; cwd?: unknown };
    try {
      meta = JSON.parse(fs.readFileSync(metaFile, "utf8")) as typeof meta;
    } catch {
      throw new ForeignTmuxTaskError(taskId);
    }
    if (
      meta.taskId !== taskId
      || meta.agentId !== agentId
      || meta.instanceId !== instanceId
      || meta.session !== expectedSession(taskId)
      || typeof meta.cwd !== "string"
    ) throw new ForeignTmuxTaskError(taskId);
    try { assertPrivateScripts(dir); } catch (error) {
      if (error instanceof ForeignTmuxTaskError) throw error;
      throw new ForeignTmuxTaskError(taskId);
    }
    return dir;
  };

  const start = (command: string, cwd: string): TmuxTaskSnapshot => {
    const taskId = crypto.randomBytes(8).toString("hex");
    const parent = ensureOwnedTree(stateDir, ownedParts);
    const dir = path.join(parent, taskId);
    mkdirPrivateExclusive(dir);
    if (!tmuxAvailable(env)) throw new Error("tmux is not available");
    const session = expectedSession(taskId);
    writePrivateExclusive(path.join(dir, "meta.json"), `${JSON.stringify({
      taskId, agentId, instanceId, session, cwd,
    })}\n`);
    writeEnvScript(path.join(dir, "env.sh"), env);
    writePrivateExclusive(path.join(dir, "command.sh"), command.endsWith("\n") ? command : `${command}\n`);
    const envFile = path.join(dir, "env.sh");
    const commandFile = path.join(dir, "command.sh");
    const outputFile = path.join(dir, "output");
    const exitFile = path.join(dir, "exit_code");
    const startedFile = path.join(dir, "started_at");
    const endedFile = path.join(dir, "ended_at");
    // 包装器用 /bin/bash；用户命令另启 bash -o pipefail，保留数组 / [[ / pipefail。
    writePrivateExclusive(path.join(dir, "run.sh"), [
      "#!/bin/bash",
      `PANE_TMUX=\${TMUX-}`,
      `PANE_TMUX_PANE=\${TMUX_PANE-}`,
      `. ${posixQuote(envFile)}`,
      "set +eu",
      "unset TMUX TMUX_PANE",
      `if [ -n "$PANE_TMUX" ]; then export TMUX="$PANE_TMUX"; fi`,
      `if [ -n "$PANE_TMUX_PANE" ]; then export TMUX_PANE="$PANE_TMUX_PANE"; fi`,
      `cd ${posixQuote(cwd)} || { date -u +%Y-%m-%dT%H:%M:%SZ > ${posixQuote(endedFile)}; printf '%s\\n' 127 > ${posixQuote(exitFile)}; exit 127; }`,
      `date -u +%Y-%m-%dT%H:%M:%SZ > ${posixQuote(startedFile)}`,
      `/bin/bash -o pipefail ${posixQuote(commandFile)} > ${posixQuote(outputFile)} 2>&1`,
      `status=$?`,
      `date -u +%Y-%m-%dT%H:%M:%SZ > ${posixQuote(endedFile)}`,
      `printf '%s\\n' "$status" > ${posixQuote(exitFile)}`,
      "",
    ].join("\n"));
    const created = spawnSync("tmux", ["new-session", "-d", "-s", session, "-n", "bash", "-e", "BASH_ENV=", "/usr/bin/env", "-u", "BASH_ENV", "/bin/bash", path.join(dir, "run.sh")], {
      env: tmuxClientEnv(env),
      encoding: "utf8",
      timeout: 5_000,
    });
    if (created.status !== 0) {
      throw new Error(`tmux new-session failed: ${(created.stderr || created.stdout || "").trim() || created.status}`);
    }
    return snapshotFromDir(dir, taskId, env, session);
  };

  const peek = (taskId: string): TmuxTaskSnapshot => {
    const dir = requireOwned(taskId);
    return snapshotFromDir(dir, taskId, env, expectedSession(taskId));
  };

  const list = (): TmuxTaskSnapshot[] => {
    let instanceRoot: string;
    try {
      instanceRoot = ensureOwnedTree(stateDir, ownedParts, false);
    } catch {
      return [];
    }
    return fs.readdirSync(instanceRoot).sort().flatMap((taskId) => {
      try { return [peek(taskId)]; } catch { return []; }
    });
  };

  const wait = async (taskId: string, timeoutSeconds: number, signal?: AbortSignal): Promise<TmuxTaskSnapshot> => {
    const deadline = Date.now() + Math.max(0, timeoutSeconds) * 1000;
    while (true) {
      if (signal?.aborted) {
        kill(taskId);
        return peek(taskId);
      }
      const current = peek(taskId);
      // 会话已消失但 exit 尚未落盘时继续等到 WAIT 窗口结束，避免快命令被误判 failed。
      const flushing = current.status === "failed" && current.exitCode === null;
      if (current.status !== "running" && !flushing) return current;
      if (Date.now() >= deadline) return current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const kill = (taskId: string): TmuxTaskSnapshot => {
    const dir = requireOwned(taskId);
    const session = expectedSession(taskId);
    if (parseExitCode(readText(path.join(dir, "exit_code"))) !== null) return snapshotFromDir(dir, taskId, env, session);
    const live = tmuxHasSession(session, env) || liveOwnedPanePid(session, env) !== null;
    if (live) {
      writePrivate(path.join(dir, "cancelled"), "1\n");
      terminateOwnedPane(session, env);
      if (!readText(path.join(dir, "ended_at"))) {
        writePrivate(path.join(dir, "ended_at"), `${new Date().toISOString().slice(0, 19)}Z\n`);
      }
    }
    return snapshotFromDir(dir, taskId, env, session);
  };

  return { start, peek, list, wait, kill, root, instanceId };
}
