import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { BashToolInput } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";

/**
 * pi bash 超时护栏。父会话 cap 默认 60s。
 * nested 授权 wait 由 child session 上带闭包 cap + revoked flag 的 bash execute 承担。
 * 不使用正则判断 detached：supervised spawn 在命令结束后回收整个进程组。
 */

const MAX_BASH_SECONDS = 60;

export function effectiveParentBashTimeout(): number {
  const raw = Number.parseInt(process.env.LARKIN_PI_BASH_TIMEOUT_SECONDS || "", 10);
  if (Number.isInteger(raw) && raw > 0) return Math.min(raw, MAX_BASH_SECONDS);
  return MAX_BASH_SECONDS;
}

function killProcessTree(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
  }
}

export function createSupervisedBashOperations() {
  return {
    exec: async (command: string, cwd: string, { onData, signal, timeout, env }: { onData: (chunk: Buffer | string) => void; signal?: AbortSignal; timeout?: number; env?: NodeJS.ProcessEnv }) => {
      if (signal?.aborted) throw new Error("aborted");
      const child = spawn("/bin/bash", ["-c", command], {
        cwd,
        detached: process.platform !== "win32",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const pid = child.pid;
      let timedOut = false;
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => { if (pid) killProcessTree(pid); };
      try {
        if (typeof timeout === "number" && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            if (pid) killProcessTree(pid);
          }, timeout * 1000);
        }
        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);
        if (signal) {
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
        const exitCode = await new Promise<number>((resolve, reject) => {
          child.once("error", reject);
          child.once("exit", (code) => resolve(code ?? 1));
        });
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        return { exitCode };
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (signal) signal.removeEventListener("abort", onAbort);
        if (pid) killProcessTree(pid);
      }
    },
  };
}

export function installGuardedBashTool(pi: ExtensionAPI, cap: number): void {
  const cwd = process.cwd();
  const builtin = createBashToolDefinition(cwd, { operations: createSupervisedBashOperations() as never });
  const MAX = cap;
  const authorized = MAX > effectiveParentBashTimeout();
  const guidance = authorized
    ? `This command exceeded the ${MAX}s authorized background-subagent bash limit. Pass timeout <= ${MAX}.`
    : `This command exceeded the ${MAX}s foreground hard limit. ` +
      "Long-running or deploy-style work MUST run in a background subagent instead: " +
      "call Agent({ prompt, description, run_in_background: true, max_command_wait_seconds: <61-600> }), " +
      "report the returned agent id, and end the turn.";

  pi.registerTool({
    ...builtin,
    name: "bash",
    label: "bash",
    description: builtin.description,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const requested = typeof params.timeout === "number" && params.timeout > 0 ? params.timeout : effectiveParentBashTimeout();
      if (requested > MAX) {
        throw new Error(`timeout:${requested} exceeds the ${MAX}s ${authorized ? "background-subagent bash" : "foreground hard"} limit. ${guidance}`);
      }
      const timeout = Math.min(requested, MAX);
      try {
        return await builtin.execute(toolCallId, { ...params, timeout } satisfies BashToolInput, signal, onUpdate, ctx);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/timed out after/i.test(message) || /^timeout:/.test(message)) {
          throw new Error(`${message}\n\n${guidance}`);
        }
        throw error;
      }
    },
  });
}

export default function (pi: ExtensionAPI): void {
  installGuardedBashTool(pi, effectiveParentBashTimeout());
}
