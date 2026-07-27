import { spawnSync } from "node:child_process";
import path from "node:path";

interface ProcessInspection {
  ok: boolean;
  dead?: boolean;
  reason?: string;
  command?: string;
  startToken?: string;
}

function validPid(pid: unknown): number | null {
  const value = Number(pid);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function pidAlive(pid: unknown, kill: typeof process.kill = process.kill): boolean {
  const value = validPid(pid);
  if (!value) return false;
  try { kill(value, 0); return true; }
  catch (error) {
    // POSIX reserves ESRCH for a missing process. EPERM means the process may
    // be alive but is not inspectable by this user and therefore must fail closed.
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function inspectUnix(pid: number): ProcessInspection {
  const env = { ...process.env, LC_ALL: "C", LANG: "C" };
  const state = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "stat="], { encoding: "utf8", env });
  const started = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "lstart="], { encoding: "utf8", env });
  const command = spawnSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8", env });
  if (state.status === 0 && /^Z/.test(String(state.stdout || "").trim())) return { ok: false, dead: true, reason: "process exited" };
  // The process can disappear between the initial kill(0) probe and ps. Re-checking here
  // distinguishes a normal exit race from an inspection failure that must remain fail-closed.
  if ((state.status !== 0 || started.status !== 0 || command.status !== 0) && !pidAlive(pid)) {
    return { ok: false, dead: true, reason: "process exited" };
  }
  if (started.status !== 0 || command.status !== 0) return { ok: false, reason: "ps failed" };
  const startedText = String(started.stdout || "").trim();
  const commandText = String(command.stdout || "").trim();
  if (!startedText || !commandText) return { ok: false, reason: "ps metadata incomplete" };
  // `ps lstart` omits a timezone. Parsing it into an ISO timestamp makes the
  // same process look different when two Bun processes have different TZ
  // state (notably a Bun test parent and a normal Bun child). The value is an
  // opaque identity token, so preserve the stable kernel-provided text.
  return { ok: true, command: commandText, startToken: startedText };
}

function inspectWindows(pid: number): ProcessInspection {
  const script = `$p=Get-CimInstance Win32_Process -Filter \"ProcessId=${pid}\"; if($null -eq $p){exit 3}; [pscustomobject]@{CommandLine=$p.CommandLine;CreationDate=$p.CreationDate.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  if (result.status !== 0) return { ok: false, reason: "CIM failed" };
  try {
    const parsed = JSON.parse(String(result.stdout || "")) as { CommandLine?: string; CreationDate?: string };
    if (!parsed.CommandLine || !parsed.CreationDate) return { ok: false, reason: "CIM metadata incomplete" };
    return { ok: true, command: parsed.CommandLine, startToken: new Date(parsed.CreationDate).toISOString() };
  } catch { return { ok: false, reason: "CIM output invalid" }; }
}

function inspectProcess(pid: unknown): ProcessInspection {
  const value = validPid(pid);
  if (!value) return { ok: false, reason: "invalid pid" };
  if (!pidAlive(value)) return { ok: false, dead: true, reason: "process not alive" };
  return process.platform === "win32" ? inspectWindows(value) : inspectUnix(value);
}

function currentProcessMetadata(commandToken: string): { pid: number; processStartToken: string; commandToken: string } {
  const inspected = inspectProcess(process.pid);
  if (!inspected.ok || !inspected.command || !inspected.startToken) {
    throw new Error(`无法读取当前进程身份：${inspected.reason || "metadata incomplete"}`);
  }
  let effectiveToken = commandToken;
  if (!inspected.command.includes(commandToken)) {
    const bunToken = path.basename(process.execPath);
    if (process.env.LARKIN_BUN_TEST_RUNNER === "1" && inspected.command.includes(bunToken)) effectiveToken = bunToken;
    else throw new Error(`当前进程命令不含身份标记 ${commandToken}`);
  }
  return { pid: process.pid, processStartToken: inspected.startToken, commandToken: effectiveToken };
}

export = { validPid, pidAlive, inspectProcess, currentProcessMetadata };
