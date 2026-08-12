#!/usr/bin/env bun
import "../platform/check-bun-version.cjs";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";
import * as larkinConfig from "../platform/config.js";
import { PI_PROVIDER_PRESETS } from "../runtime/pi-provider-config.js";
const PI_PROVIDER_IDS = PI_PROVIDER_PRESETS.map((p) => p.id).join(" | ") + " | custom";
import { acquireProcessLock, readProcessState } from "../platform/process-state.js";
import { requestAgentUpsert } from "./local-control.js";
import { openOwnedDashboardWhenReady } from "./setup-dashboard.js";
import { probeNativeRuntimeReadiness } from "../runtime/runtime-readiness.js";
import { internalCommandSpec, processCommandToken, type InternalMode } from "./internal-command.js";
import {
  ensureOfficialLarkCliForSetup,
} from "./official-lark-cli.js";

const CFG_DIR = process.env.LARKIN_CONFIG_DIR || path.join(os.homedir(), ".larkin");
const argv = process.argv.slice(2);
const has = (name: string): boolean => argv.includes(name);
const flag = (name: string): string | undefined => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : undefined; };
const say = (...args: unknown[]): void => console.log(...args);
const die = (message: string): never => { console.error(`✗ ${message}`); process.exit(1); };

if (argv.some((arg) => arg === "--app-id" || arg.startsWith("--app-id="))) {
  die("setup 不支持 --app-id；请运行 larkin setup 并在飞书网页中选择机器人");
}
if (argv.some((arg) => arg === "--no-dashboard" || arg.startsWith("--no-dashboard="))) {
  die("--no-dashboard 已移除；dashboard 由 larkin start 统一管理");
}
if (has("--start") && has("--no-start")) die("--start 与 --no-start 不能同时使用");
if (has("--comment-subscription")) {
  die("--comment-subscription 已移除：评论订阅默认 application（平台验证的应用级订阅），不需要该 flag");
}

// 默认应用级评论订阅：平台验证的应用订阅让该应用可见文档的全部评论进入 Agent Inbox。
const commentSubscription = "application";
const OPT = { runtime: flag("--runtime") || null, commentSubscription, start: true, help: has("--help") || has("-h"), nonInteractive: !Boolean(process.stdin.isTTY) };

// runtime 枚举归一：builtin-pi（默认）/ external-pi / codex / claude → 内部 (runtime, distribution)
const RUNTIME_ENUM = ["builtin-pi", "external-pi", "codex", "claude"] as const;
type RuntimeEnum = (typeof RUNTIME_ENUM)[number];
function normalizeRuntime(value: string | null): { runtime: "pi" | "codex" | "claude"; distribution?: "builtin" | "external" } {
  const chosen: RuntimeEnum = (value || "builtin-pi") as RuntimeEnum;
  if (!RUNTIME_ENUM.includes(chosen)) {
    die(`未知 runtime \`${value}\`；可选：${RUNTIME_ENUM.join(" | ")}`);
  }
  if (chosen === "builtin-pi") return { runtime: "pi", distribution: "builtin" };
  if (chosen === "external-pi") return { runtime: "pi", distribution: "external" };
  return { runtime: chosen };
}
const normalizedRuntime = normalizeRuntime(OPT.runtime);
// 参数化路径：显式 --runtime、无 TTY（Agent 驱动）、或任何 provider 参数。
// 交互终端且未指定任何参数时，不传 --runtime 给 bot-register，由其交互选择流程接管。
const parameterized = Boolean(OPT.runtime) || OPT.nonInteractive
  || ["--provider", "--api-key", "--base-url"].some((name) => has(name));
// builtin-pi 前置校验：授权前就 fast-fail（避免用户白授权后才发现缺 key）；--help 永远跳过
if (!OPT.help && parameterized && normalizedRuntime.distribution === "builtin") {
  const p = flag("--provider");
  const b = flag("--base-url");
  const k = flag("--api-key");
  if (!p && !b) die(`builtin-pi 需要 --provider <id>（${PI_PROVIDER_IDS}）或 --base-url；或 --runtime external-pi 用已有 pi`);
  if (!k) die("builtin-pi 需要 --api-key；或 --runtime external-pi 用已有登录");
}
if (!OPT.help && normalizedRuntime.distribution === "external" && (flag("--provider") || flag("--api-key") || flag("--base-url"))) {
  die("external-pi 使用已有 pi 环境，不接受 --provider/--api-key/--base-url");
}
if (OPT.help) {
  say(`larkin setup — Create or connect a Feishu bot, then configure and attach its Agent

Usage:
  larkin setup                         Select a bot in the browser and run setup（默认：内置 Pi + 配置完成即热挂载）
  larkin setup --provider <id> --api-key <key>   指定内置 Pi provider（无需交互）

Options:
  --runtime <runtime>                   Agent runtime 枚举：builtin-pi（默认，内置 Pi）| external-pi | codex | claude
  --provider <id>                       内置 Pi provider：deepseek | kimi | minimax | zhipu | openai |
                                          anthropic | gemini | groq | cerebras | xai | fireworks |
                                          together | mistral | openrouter | kimi-coding | qwen-cn | custom
  --api-key <key>                       API key（内置 Pi 必填）
  --base-url <url>                      custom 端点（provider=custom 时必填；也可覆盖 preset 默认端点）
  --model <id>                          模型 ID；默认取 provider 预设。不同 runtime 的模型可用
                                          \`larkin model\` 查看 / 切换

setup handles browser authorization, permission grants, credential storage, Agent configuration,
and target-only hot attach. Each Agent is identified by its bot App ID: selecting the same bot reuses
its existing Agent, memory, and state; creating a new bot creates a new Agent.

If larkin is running, only the selected Agent is added or updated. Otherwise setup starts the same
daemon + dashboard supervisor used by larkin start.

Interactive terminals without flags keep the guided flow (browser bot selection + runtime choice).
Non-interactive (Agent-driven) runs default to builtin-pi and require --provider/--api-key (or
--runtime external-pi to reuse an existing pi login).`);
  process.exit(0);
}

function runForeground(mode: InternalMode, args: string[]): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const childSpec = internalCommandSpec(mode, args);
    const child = spawn(childSpec.command, childSpec.args, { env: process.env, stdio: "inherit" });
    const forward = (signal: NodeJS.Signals) => { if (child.exitCode === null && child.signalCode === null) child.kill(signal); };
    const onInt = () => forward("SIGINT");
    const onTerm = () => forward("SIGTERM");
    process.on("SIGINT", onInt); process.on("SIGTERM", onTerm);
    const cleanup = () => { process.off("SIGINT", onInt); process.off("SIGTERM", onTerm); };
    child.once("error", (error) => { cleanup(); reject(error); });
    child.once("exit", (code, signal) => { cleanup(); resolve({ code, signal }); });
  });
}

async function openOwnedDashboard(): Promise<void> {
  const result = await openOwnedDashboardWhenReady(CFG_DIR);
  if (result.readiness.state !== "owned" || !result.readiness.url) {
    say("! dashboard 尚未在等待期限内就绪；稍后可运行 larkin status 查看 URL");
    return;
  }
  say(`✓ dashboard：${result.readiness.url}`);
  if (!result.opened) say(`! 未能自动打开浏览器，请手动打开 ${result.readiness.url}`);
}

export async function main(): Promise<void> {
  const mutationLock = acquireProcessLock(path.join(CFG_DIR, "setup.lock.json"), processCommandToken("setup", "app/setup.mjs"));
  const releaseMutationLock = mutationLock.release;
  process.on("exit", releaseMutationLock);
  const official = await ensureOfficialLarkCliForSetup({
    env: process.env,
    interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    async confirmInstall(command) {
      say("[setup 0/5] Larkin 需要未修改的官方 lark-cli 作为 Feishu 命令下游。");
      say(`将执行：${command}`);
      const input = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await input.question("是否安装？[y/N] ")).trim().toLowerCase();
      input.close();
      return answer === "y" || answer === "yes";
    },
  }).catch((error) => die(error instanceof Error ? error.message : String(error)));
  say(`[setup 0/5] ✓ 官方 lark-cli ${official.command.version}: ${official.command.command}${official.installed ? "（刚刚安装）" : ""}`);
  say("\nAgent 与飞书机器人按 App ID 一一对应：");
  say("  • 网页选择同一个机器人 → 热更新该 Agent，不重启其他 Agent");
  say("  • 网页创建新机器人 → 热挂载新 Agent，状态彼此独立\n");
  fs.mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
  const resultFile = path.join(CFG_DIR, `.setup-result-${process.pid}.json`);
  const registerArgs = ["--auto", "--result-file", resultFile];
  if (parameterized) {
    registerArgs.push("--runtime", normalizedRuntime.runtime);
    if (normalizedRuntime.distribution) registerArgs.push("--pi-distribution", normalizedRuntime.distribution);
  }
  registerArgs.push("--comment-subscription", OPT.commentSubscription);
  for (const name of ["--provider", "--api-key", "--base-url", "--model"] as const) {
    const value = flag(name);
    if (value) registerArgs.push(name, value);
  }
  const result = await runForeground("bot-register", registerArgs);
  if (result.code !== 0) die("机器人授权或 Agent 配置未完成");

  let agentId: string | undefined;
  try { ({ agentId } = JSON.parse(fs.readFileSync(resultFile, "utf8")) as { agentId?: string }); }
  finally { try { fs.unlinkSync(resultFile); } catch { /* best effort */ } }
  if (!agentId) die("setup 完成但没有取得 Agent ID");
  const selectedAgentId = agentId as string;
  const { config: configured } = larkinConfig.loadConfig(process.env);
  const configuredAgent = configured.agents[selectedAgentId];
  if (!configuredAgent) die(`setup 完成但 Agent ${selectedAgentId} 配置不可读`);
  if (!(["codex", "claude", "pi"] as const).includes(configuredAgent.runtime as "codex" | "claude" | "pi")) die(`Runtime ${configuredAgent.runtime} 不受支持`);
  // 非交互（Agent 驱动）时跳过 RPC probe：无 TTY 环境无法进行 pi RPC，探测留到 daemon 启动；
  // 其余真实阻塞（缺 runtime 可执行文件 / 缺 key / 缺 lark-cli）一律 fast-fail 并给出 agent 可读的修复提示。
  if (!OPT.nonInteractive) {
    const runtimeReadiness = await probeNativeRuntimeReadiness({ runtime: configuredAgent.runtime as "codex" | "claude" | "pi",
      agentId: selectedAgentId, cwd: configuredAgent.workspaceDir,
      env: { ...process.env, LARKIN_CONFIG_DIR: CFG_DIR,
        ...(configuredAgent.piDistribution ? { LARKIN_PI_DISTRIBUTION: configuredAgent.piDistribution } : {}) } });
    if (runtimeReadiness.state !== "ready") {
      die(`Runtime ${configuredAgent.runtime} ${runtimeReadiness.state}：${runtimeReadiness.reason || "prerequisite unavailable"}；${runtimeReadiness.nextAction || "修复后重试"}`);
    }
  }
  if (!OPT.start) {
    say(`\n[setup 5/5] ✓ 配置完成。运行 larkin start 启动。`);
    releaseMutationLock();
    return;
  }

  const state = readProcessState(CFG_DIR);
  if (state.daemon.state === "unknown" || state.supervisor.state === "unknown") {
    throw new Error("现有 Larkin 进程身份无法确认；拒绝热挂载或并行启动");
  }
  if (state.daemon.state === "owned") {
    say(`\n[setup 5/5] 正在向 daemon PID ${state.daemon.pid} 热挂载 Agent ${agentId}…`);
    const response = await requestAgentUpsert({ larkinHome: CFG_DIR, agentId: selectedAgentId });
    if (!response.ok) die(`Agent ${agentId} 热挂载失败：${response.error || "unknown error"}`);
    releaseMutationLock();
    say(`[setup 5/5] ✓ Agent ${agentId} 已热挂载/更新；其他 Agent、session、连接和任务未重启`);
    await openOwnedDashboard();
    return;
  }
  say(`\n[setup 5/5] 正在通过统一 supervisor 启动 daemon + dashboard（Agent ${agentId}）…`);
  releaseMutationLock();
  void openOwnedDashboard().catch((error) => say(`! dashboard 自动打开失败：${error instanceof Error ? error.message : String(error)}`));
  const started = await runForeground("run", []);
  if (started.code !== 0 && started.signal !== "SIGINT" && started.signal !== "SIGTERM") {
    die(`Larkin 启动失败（exit=${started.code ?? started.signal}），请运行 larkin status 查看详情`);
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(`✗ ${error instanceof Error ? error.message : String(error)}`); process.exit(1); });
}
