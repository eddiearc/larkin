import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { StoredAgent } from "./setup-binding.js";
import {
  PI_PROVIDER_PRESETS,
  validateBuiltinPiProviderSelection,
  type BuiltinPiProviderSelection,
  type PiDistribution,
} from "../runtime/pi-provider-config.js";

export type SetupAgentChoice =
  | { runtime: "codex" | "claude" }
  | { runtime: "pi"; distribution: "external" }
  | ({ runtime: "pi" } & BuiltinPiProviderSelection);

export interface SetupQuestioner {
  ask(prompt: string): Promise<string>;
  secret(prompt: string): Promise<string>;
  close?(): void;
}

export interface ExternalPiProbeResult {
  state: "missing" | "unauthenticated" | "unavailable" | "incompatible" | "ready";
  reason?: string;
  nextAction?: string;
}

function number(value: string, fallback: number, max: number): number {
  const parsed = value.trim() ? Number(value.trim()) : fallback;
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > max) throw new Error(`请选择 1-${max}`);
  return parsed;
}

export async function collectBuiltinPiChoice(questioner: SetupQuestioner): Promise<SetupAgentChoice> {
  const lines = PI_PROVIDER_PRESETS.map((preset, index) => `  ${index + 1}. ${preset.name} — ${preset.baseUrl}`).join("\n");
  const providerChoice = number(await questioner.ask(`选择模型服务：\n${lines}\n  5. Custom OpenAI-compatible\n> `), 1, 5);
  const preset = providerChoice === 5 ? "custom" : PI_PROVIDER_PRESETS[providerChoice - 1].id;
  const selected = preset === "custom" ? null : PI_PROVIDER_PRESETS.find((candidate) => candidate.id === preset)!;
  const baseUrl = preset === "custom" ? await questioner.ask("Base URL（https；localhost 可用 http）：") : selected!.baseUrl;
  const model = (await questioner.ask(`模型 ID${selected ? `（默认 ${selected.defaultModel}）` : ""}：`)).trim() || selected?.defaultModel || "";
  const apiKey = await questioner.secret("API Key（不会回显）：");
  const validated = validateBuiltinPiProviderSelection({ distribution: "builtin", preset, apiKey, model, ...(baseUrl ? { baseUrl } : {}) });
  return { runtime: "pi", distribution: "builtin", preset, apiKey: validated.apiKey, model: validated.model, ...(preset === "custom" ? { baseUrl: validated.baseUrl } : {}) };
}

export async function collectSetupAgentChoice(questioner: SetupQuestioner, prior?: StoredAgent): Promise<SetupAgentChoice | null> {
  if (prior) {
    const keep = (await questioner.ask(`已有 Agent：${prior.runtime}/${prior.model}。直接回车保留；输入 c 才修改：`)).trim().toLowerCase();
    if (!keep) return null;
    if (keep !== "c") throw new Error("请输入 c 修改，或直接回车保留现有配置");
  }
  const runtimeChoice = number(await questioner.ask("选择 Agent：\n  1. Pi（推荐）\n  2. Codex\n  3. Claude Code\n> "), 1, 3);
  if (runtimeChoice === 2) return { runtime: "codex" };
  if (runtimeChoice === 3) return { runtime: "claude" };
  const sourceChoice = number(await questioner.ask("选择 Pi：\n  1. 外置 Pi（使用本机官方 pi）\n  2. 内置 Pi（无需安装 Agent CLI，推荐）\n> "), 2, 2);
  const distribution: PiDistribution = sourceChoice === 1 ? "external" : "builtin";
  return distribution === "external" ? { runtime: "pi", distribution } : collectBuiltinPiChoice(questioner);
}

export async function recoverUnavailableExternalPi(
  initial: SetupAgentChoice | null,
  questioner: SetupQuestioner,
  probe: () => Promise<ExternalPiProbeResult>,
  report: (message: string) => void = () => {},
): Promise<SetupAgentChoice | null> {
  let choice = initial;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (choice?.runtime !== "pi" || choice.distribution !== "external") return choice;
    const readiness = await probe();
    if (readiness.state === "ready") return choice;
    report(`外置 Pi ${readiness.state}：${readiness.reason || "prerequisite unavailable"}；${readiness.nextAction || "可切换到内置 Pi"}`);
    const action = number(await questioner.ask("外置 Pi 当前不可用：\n  1. 切换到内置 Pi（推荐）\n  2. 重新选择 Agent\n  3. 取消 setup（保留原配置）\n> "), 1, 3);
    if (action === 1) return collectBuiltinPiChoice(questioner);
    if (action === 3) throw new Error("setup 已取消；未修改 Agent/config");
    choice = await collectSetupAgentChoice(questioner);
  }
  throw new Error("外置 Pi 恢复选择已达到 3 次；未修改 Agent/config，请修复后重试");
}

export function terminalSetupQuestioner(): SetupQuestioner {
  let rl: ReturnType<typeof createInterface> | null = createInterface({ input: stdin, output: stdout, terminal: Boolean(stdin.isTTY) });
  const lines = rl[Symbol.asyncIterator]();
  const close = (): void => { rl?.close(); rl = null; };
  const nextLine = async (prompt: string): Promise<string> => {
    if (!rl) throw new Error("setup input 已关闭");
    stdout.write(prompt);
    const next = await lines.next();
    if (next.done) throw new Error("setup 输入已结束；未保存配置");
    return next.value;
  };
  return {
    ask: nextLine,
    secret: async (prompt) => {
      if (!stdin.isTTY || typeof stdin.setRawMode !== "function") {
        try { return await nextLine(prompt); }
        finally { close(); }
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
          stdin.setRawMode(Boolean(wasRaw));
          stdin.pause();
          stdout.write("\n");
          if (error) reject(error); else resolve(value);
        };
        const onData = (chunk: Buffer): void => {
          for (const byte of chunk) {
            if (byte === 3) return finish(new Error("setup 已取消；未保存 API Key"));
            if (byte === 10 || byte === 13) return finish();
            if (byte === 8 || byte === 127) { value = value.slice(0, -1); continue; }
            if (byte >= 32 && byte <= 126) value += String.fromCharCode(byte);
          }
        };
        stdin.on("data", onData);
      });
    },
    close,
  };
}
