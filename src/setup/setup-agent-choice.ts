import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { StoredAgent } from "./setup-binding.js";
import {
  PI_PROVIDER_PRESETS,
  resolveBuiltinPiProviderSetupSelection,
  type BuiltinPiProviderSetupSelection,
  type PiDistribution,
} from "../runtime/pi-provider-config.js";
import type { OfficialPiAuthProvider, OfficialPiAuthStatus } from "../runtime/pi-official-auth.js";

export interface OfficialPiAuthSelection {
  distribution: "builtin";
  preset: "official";
  providerId: string;
  authType: "api_key" | "oauth";
  model: string;
}

export type SetupAgentChoice =
  | { runtime: "codex" | "claude" }
  | { runtime: "pi"; distribution: "external" }
  | ({ runtime: "pi" } & (BuiltinPiProviderSetupSelection | OfficialPiAuthSelection));

export interface SetupQuestioner {
  ask(prompt: string, signal?: AbortSignal): Promise<string>;
  secret(prompt: string, signal?: AbortSignal): Promise<string>;
  close?(): void;
}

export interface BuiltinPiChoiceServices {
  providers(): Promise<OfficialPiAuthProvider[]>;
  status(): Promise<OfficialPiAuthStatus[]>;
  logout(providerId: string): Promise<void>;
  report(message: string): void;
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

export async function collectBuiltinPiChoice(questioner: SetupQuestioner,
  services?: BuiltinPiChoiceServices): Promise<SetupAgentChoice> {
  const lines = PI_PROVIDER_PRESETS.map((preset, index) => `  ${index + 1}. ${preset.name} — ${preset.baseUrl}`).join("\n");
  const providerChoice = number(await questioner.ask(`选择模型服务 / 认证：\n${lines}\n  5. Custom OpenAI-compatible\n  6. 官方 Pi provider 登录（API Key / OAuth / subscription）\n  7. 查看或退出已有官方 Pi 认证\n> `), 1, 7);
  if (providerChoice === 7) {
    if (!services) throw new Error("当前 setup 上下文无法管理官方 Pi 认证");
    const status = await services.status();
    if (status.length === 0) services.report("尚无已配置的官方 Pi credential");
    else status.forEach((entry, index) => services.report(`  ${index + 1}. ${entry.providerName} (${entry.providerId}) — ${entry.credentialType}/${entry.source}${entry.stored ? "，已存储" : "，ambient"}`));
    const answer = (await questioner.ask("输入要 logout 的序号；直接回车返回：")).trim();
    if (answer) {
      const selected = number(answer, 0, status.length);
      await services.logout(status[selected - 1]!.providerId);
      services.report(`已退出 ${status[selected - 1]!.providerName}；未修改其他 provider`);
    }
    return collectBuiltinPiChoice(questioner, services);
  }
  if (providerChoice === 6) {
    if (!services) throw new Error("当前 setup 上下文无法读取官方 Pi auth registry");
    const providers = await services.providers();
    const methods = providers.flatMap((provider) => provider.methods.map((method) => ({ provider, method })));
    if (methods.length === 0) throw new Error("捆绑官方 Pi auth registry 没有可交互登录方式");
    const methodLines = methods.map(({ provider, method }, index) => `  ${index + 1}. ${provider.name} — ${method.name} [${method.type}]`).join("\n");
    const methodChoice = number(await questioner.ask(`选择官方 Pi 登录方式：\n${methodLines}\n> `), 1, methods.length);
    const selected = methods[methodChoice - 1]!;
    const defaultModel = selected.provider.models[0] || "";
    const model = (await questioner.ask(`模型 ID${defaultModel ? `（默认 ${defaultModel}）` : "（provider/model）"}：`)).trim() || defaultModel;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[A-Za-z0-9][A-Za-z0-9._:@+\/-]{0,255}$/.test(model)) throw new Error("模型 ID 必须是安全的 provider/model");
    if (!model.startsWith(`${selected.provider.id}/`)) throw new Error(`模型 ID 必须属于 ${selected.provider.id}`);
    return { runtime: "pi", distribution: "builtin", preset: "official", providerId: selected.provider.id,
      authType: selected.method.type, model };
  }
  const preset = providerChoice === 5 ? "custom" : PI_PROVIDER_PRESETS[providerChoice - 1].id;
  const selected = preset === "custom" ? null : PI_PROVIDER_PRESETS.find((candidate) => candidate.id === preset)!;
  const baseUrl = preset === "custom" ? await questioner.ask("Base URL（https；localhost 可用 http）：") : selected!.baseUrl;
  const model = (await questioner.ask(`模型 ID${selected ? `（默认 ${selected.defaultModel}）` : ""}：`)).trim() || selected?.defaultModel || "";
  const validated = resolveBuiltinPiProviderSetupSelection({ distribution: "builtin", preset, model, ...(baseUrl ? { baseUrl } : {}) });
  return { runtime: "pi", distribution: "builtin", preset, model: validated.model, ...(preset === "custom" ? { baseUrl: validated.baseUrl } : {}) };
}

export async function collectSetupAgentChoice(questioner: SetupQuestioner, prior?: StoredAgent,
  services?: BuiltinPiChoiceServices): Promise<SetupAgentChoice | null> {
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
  return distribution === "external" ? { runtime: "pi", distribution } : collectBuiltinPiChoice(questioner, services);
}

export async function recoverUnavailableExternalPi(
  initial: SetupAgentChoice | null,
  questioner: SetupQuestioner,
  probe: () => Promise<ExternalPiProbeResult>,
  report: (message: string) => void = () => {},
  services?: BuiltinPiChoiceServices,
): Promise<SetupAgentChoice | null> {
  let choice = initial;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (choice?.runtime !== "pi" || choice.distribution !== "external") return choice;
    const readiness = await probe();
    if (readiness.state === "ready") return choice;
    report(`外置 Pi ${readiness.state}：${readiness.reason || "prerequisite unavailable"}；${readiness.nextAction || "可切换到内置 Pi"}`);
    const action = number(await questioner.ask("外置 Pi 当前不可用：\n  1. 切换到内置 Pi（推荐）\n  2. 重新选择 Agent\n  3. 取消 setup（保留原配置）\n> "), 1, 3);
    if (action === 1) return collectBuiltinPiChoice(questioner, services);
    if (action === 3) throw new Error("setup 已取消；未修改 Agent/config");
    choice = await collectSetupAgentChoice(questioner, undefined, services);
  }
  throw new Error("外置 Pi 恢复选择已达到 3 次；未修改 Agent/config，请修复后重试");
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
            if (byte === 3) return finish(new Error("setup 已取消；未保存 API Key"));
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
