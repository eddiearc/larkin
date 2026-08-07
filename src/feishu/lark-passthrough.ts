// larkin 顶级 lark-cli 命令组直通决策（larkin im … == lark-cli im …）：封装转发不改写语义，
// 唯一硬边界是身份/凭证（Owner 定，2026-07-17，见 coding-context larkin.cli-prompt-alignment plan）。
// 能力边界交给飞书权限体系（bot scope、群成员身份、文档协作者），壳不做命令级裁剪；
// 不可逆操作靠版本化 Runtime standing prompt 的行为约定治理。

import { resolveRuntimeAuthority } from "../platform/config.js";

export const PASSTHROUGH_USAGE = "用法：larkin <lark-cli 命令组…> [--agent <App ID>]，如 larkin im +chat-list --json（语法与 lark-cli 一致）";

export interface PassthroughDecision {
  ok: boolean;
  reason?: string;
  argv?: string[];
  explicitAgent?: string | null;
}

const IDENTITY = "身份边界";

export function assessPassthrough(
  argv: readonly string[],
  runtimeEnv: Readonly<Record<string, string | undefined>> = {},
): PassthroughDecision {
  const rest = [...argv];
  let runtimeAgentId: string | null;
  try { runtimeAgentId = resolveRuntimeAuthority(runtimeEnv); }
  catch (error) { return { ok: false, reason: `${IDENTITY}：${error instanceof Error ? error.message : String(error)}` }; }
  let explicitAgent: string | null = null;
  const agentFlags = rest.reduce<number[]>((indexes, argument, index) => {
    if (argument === "--agent") indexes.push(index);
    return indexes;
  }, []);
  if (agentFlags.length > 1) {
    return { ok: false, reason: `--agent 只能指定一次。${PASSTHROUGH_USAGE}` };
  }
  const agentFlag = agentFlags[0] ?? -1;
  if (agentFlag >= 0) {
    if (runtimeAgentId) {
      return { ok: false, reason: `${IDENTITY}：当前 Agent 的机器人身份已由 Runtime authority marker 锁定，不允许使用 --agent 选择身份。` };
    }
    if (!rest[agentFlag + 1]) return { ok: false, reason: `--agent 需要 App ID。${PASSTHROUGH_USAGE}` };
    explicitAgent = rest[agentFlag + 1];
    rest.splice(agentFlag, 2);
  }
  if (!rest.length) return { ok: false, reason: `缺少 lark-cli 参数。${PASSTHROUGH_USAGE}` };
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if ((argument === "--as" && rest[index + 1] === "user") || argument === "--as=user") {
      return { ok: false, reason: `${IDENTITY}：larkin agent 只能以自己的机器人身份调用 lark-cli，不允许 --as user。` };
    }
    if (argument === "--profile" || argument.startsWith("--profile=")) {
      return { ok: false, reason: `${IDENTITY}：profile 由 larkin 按当前 agent 锁定，不接受手动指定；换 agent 用 --agent <App ID>。` };
    }
    if (argument === "--config-dir" || argument.startsWith("--config-dir=")) {
      return { ok: false, reason: `${IDENTITY}：lark-cli 配置目录由 larkin 锁定，不接受覆盖。` };
    }
  }
  const subcommand = rest.find((argument) => !argument.startsWith("-"));
  // lark-cli 的 CLI 管理族操作共享凭证库与安装本体，属身份基础设施，不是飞书能力。
  if (subcommand && ["auth", "config", "profile", "update"].includes(subcommand)) {
    return { ok: false, reason: `${IDENTITY}：lark-cli 凭证与配置管理（${subcommand}）不走 larkin；机器人凭证由 larkin setup 负责。` };
  }
  // event 会用同一 bot 凭证另开长连接，可能抢走 Runtime Host 的事件流（Owner 定，2026-07-17）。
  if (subcommand === "event") {
    return { ok: false, reason: "运行时保护：lark-cli event 会与 Runtime Host 争抢同一机器人的事件流；实时消息请用 inbox check（canonical Inbox）。" };
  }
  // 纯用户身份域：机器人没有邮箱/考勤/OKR 实体，直通必失败（Owner 定，2026-07-17）。
  if (subcommand && ["mail", "attendance", "okr"].includes(subcommand)) {
    return { ok: false, reason: `能力边界：${subcommand} 是用户身份域，机器人身份没有对应实体，larkin 不转发。` };
  }
  return { ok: true, argv: applyArgvTweaks(rest), explicitAgent };
}

// 参数微调层（Owner 定）：按「<组> <子命令>」注册 argv 变换；默认空 = 保持飞书原生形态。
// 例：ARGV_TWEAKS["im send"] = (argv) => […]。微调只做形态映射，不注入语义。
export type ArgvTweak = (argv: string[]) => string[];
export const ARGV_TWEAKS: Record<string, ArgvTweak> = {};

export function applyArgvTweaks(argv: string[]): string[] {
  const key = argv.filter((argument) => !argument.startsWith("-")).slice(0, 2).join(" ");
  const tweak = ARGV_TWEAKS[key];
  return tweak ? tweak([...argv]) : argv;
}
