import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { StoredAgent } from "./setup-binding.js";
import { RUNTIME_OPTIONS, toUserRuntime, type RuntimeOption } from "../runtime/user-runtime.js";
import { resolveRuntimeExecutable, runtimeInstallNextAction } from "../runtime/runtime-readiness.js";

export type SetupAgentChoice = { runtime: RuntimeOption };

export interface SetupQuestioner {
  ask(prompt: string, signal?: AbortSignal): Promise<string>;
  secret(prompt: string, signal?: AbortSignal): Promise<string>;
  close?(): void;
}

export interface RuntimeInstallStatus {
  runtime: RuntimeOption;
  installed: boolean;
  reason?: string;
  nextAction?: string;
}

function runtimeCommand(runtime: RuntimeOption, env: NodeJS.ProcessEnv): string {
  if (runtime === "pi") return env.LARKIN_PI_COMMAND || "pi";
  if (runtime === "codex") return env.LARKIN_CODEX_COMMAND || "codex";
  return env.LARKIN_CLAUDE_COMMAND || "claude";
}

export function listRuntimeInstallStatuses(env: NodeJS.ProcessEnv = process.env): RuntimeInstallStatus[] {
  return RUNTIME_OPTIONS.map((runtime) => {
    if (resolveRuntimeExecutable(runtimeCommand(runtime, env), env)) return { runtime, installed: true };
    return {
      runtime,
      installed: false,
      reason: `${runtime} is not installed`,
      nextAction: runtimeInstallNextAction(runtime),
    };
  });
}

export function missingRuntimeInstallMessage(runtime: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (runtime !== "pi" && runtime !== "codex" && runtime !== "claude") return null;
  const status = listRuntimeInstallStatuses(env).find((entry) => entry.runtime === runtime);
  if (!status || status.installed) return null;
  return `${status.reason}；${status.nextAction}`;
}

const RUNTIME_LABELS: Record<RuntimeOption, string> = {
  pi: "pi（本机官方 pi CLI）",
  codex: "Codex",
  claude: "Claude Code",
};

function number(value: string, fallback: number, max: number): number {
  const parsed = value.trim() ? Number(value.trim()) : fallback;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`请选择 1-${max}`);
  return parsed;
}

function formatRuntimeMenu(statuses: readonly RuntimeInstallStatus[]): string {
  const lines = statuses.map((status, index) => {
    const mark = status.installed ? "installed" : "not installed";
    return `  ${index + 1}. ${RUNTIME_LABELS[status.runtime]} [${mark}]`;
  });
  return `选择 Agent：\n${lines.join("\n")}\n> `;
}

export async function collectSetupAgentChoice(
  questioner: SetupQuestioner,
  prior?: StoredAgent,
  statuses: readonly RuntimeInstallStatus[] = listRuntimeInstallStatuses(),
): Promise<SetupAgentChoice | null> {
  if (prior) {
    const keep = (await questioner.ask(`已有 Agent：${toUserRuntime(prior.runtime)}/${prior.model}。直接回车保留；输入 c 才修改：`)).trim().toLowerCase();
    if (!keep) return null;
    if (keep !== "c") throw new Error("请输入 c 修改，或直接回车保留现有配置");
  }
  const runtimeChoice = number(await questioner.ask(formatRuntimeMenu(statuses)), 1, statuses.length);
  const selected = statuses[runtimeChoice - 1]!;
  if (!selected.installed) {
    throw new Error(`${selected.reason}；${selected.nextAction}`);
  }
  return { runtime: selected.runtime };
}

export function terminalSetupQuestioner(): SetupQuestioner {
  let rl: ReturnType<typeof createInterface> | null = null;
  let lines: AsyncIterator<string> | null = null;
  const ensureInput = (): AsyncIterator<string> => {
    if (!rl) {
      rl = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
      lines = rl[Symbol.asyncIterator]();
    }
    return lines!;
  };
  const close = (): void => { rl?.close(); rl = null; lines = null; };
  const nextLine = async (prompt: string, signal?: AbortSignal): Promise<string> => {
    if (signal?.aborted) throw new Error("setup auth prompt 已取消");
    const inputLines = ensureInput();
    stdout.write(prompt);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      if (!signal) return;
      onAbort = () => { close(); reject(new Error("setup auth prompt 已取消")); };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    let next: IteratorResult<string>;
    try { next = await Promise.race([inputLines.next(), aborted]); }
    finally { if (signal && onAbort) signal.removeEventListener("abort", onAbort); }
    if (next.done) throw new Error("setup 输入已结束；未保存配置");
    return next.value;
  };
  return {
    ask: nextLine,
    secret: async (prompt, signal) => {
      if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
        return nextLine(prompt, signal);
      }
      close();
      stdout.write(prompt);
      const wasRaw = stdin.isRaw;
      stdin.setRawMode(true);
      stdin.resume();
      return await new Promise<string>((resolve, reject) => {
        let value = "";
        const finish = (error?: Error): void => {
          stdin.off("data", onData);
          signal?.removeEventListener("abort", onAbort);
          stdin.setRawMode(Boolean(wasRaw));
          stdin.pause();
          stdout.write("\n");
          if (error) reject(error); else resolve(value);
        };
        const onData = (chunk: Buffer): void => {
          for (const byte of chunk) {
            if (byte === 3) return finish(new Error("setup 已取消；未保存输入"));
            if (byte === 10 || byte === 13) return finish();
            if (byte === 8 || byte === 127) { value = value.slice(0, -1); continue; }
            if (byte >= 32 && byte <= 126) value += String.fromCharCode(byte);
          }
        };
        const onAbort = (): void => finish(new Error("setup auth prompt 已取消"));
        if (signal?.aborted) return onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        stdin.on("data", onData);
      });
    },
    close,
  };
}
