#!/usr/bin/env bun
// Internal setup stage: bind an existing lark-cli bot profile to its App-ID Agent.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { TargetRootLayout } from "../platform/root-layout.js";
import { planSingleRootBinding, type StoredConfig } from "./setup-binding.js";
import { discoverPiModelCatalog } from "../runtime/pi-model-catalog.js";
import * as larkinConfigImport from "../platform/config.js";

interface RuntimeModel {
  id: string;
  supportedReasoningEfforts?: string[];
}

interface Profile {
  name: string;
  appId: string;
  active?: boolean;
  [key: string]: unknown;
}

interface HydratedAgent {
  feishuProfile: string;
  runtime: string;
  model: string;
  [key: string]: unknown;
}

interface HydratedConfig {
  serverId: string | null;
  activeAgent: string | null;
  agents: Record<string, HydratedAgent>;
  [key: string]: unknown;
}

interface ConfigModule {
  resolveConfigDir(env: NodeJS.ProcessEnv): string;
  resolveLarkConfigDir(env: NodeJS.ProcessEnv, configDir: string): string;
  loadConfig(env: NodeJS.ProcessEnv, options: { mint: () => string }): { revision: string; config: HydratedConfig };
  loadRuntimeModels(): Record<string, RuntimeModel[]>;
  defaultModelFor(runtime: string): string;
  toStored(config: HydratedConfig): StoredConfig;
  commitSetupConfig(env: NodeJS.ProcessEnv, expectedRevision: string, config: StoredConfig): { revision: string; config: HydratedConfig };
}

const larkinConfig = larkinConfigImport as unknown as ConfigModule;

interface LarkJsonResult {
  ok: boolean;
  json: unknown;
  raw: string;
  err: string;
}

interface BotVerification {
  ok?: boolean;
  identity?: string;
  data?: { chats?: unknown[] };
}

const layout = TargetRootLayout.fromConfigDir(larkinConfig.resolveConfigDir(process.env));
const CFG_DIR = layout.root;
const CFG_FILE = layout.configFile;
const APP_ID = /^cli_[A-Za-z0-9]+$/;
const LARK_CFG_DIR = larkinConfig.resolveLarkConfigDir(process.env, CFG_DIR);
fs.mkdirSync(LARK_CFG_DIR, { recursive: true, mode: 0o700 });
const larkEnv = (): NodeJS.ProcessEnv => ({ ...process.env, LARKSUITE_CLI_CONFIG_DIR: LARK_CFG_DIR });

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(name);
const options = {
  agent: flag("--agent"),
  profile: flag("--profile"),
  runtime: flag("--runtime"),
  yes: has("--yes"),
  list: has("--list"),
  help: has("--help") || has("-h"),
};
const nonInteractive = options.yes || Boolean(options.profile);

const say = (...args: unknown[]): void => console.log(...args);
const die = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};

async function ask(question: string): Promise<string> {
  if (nonInteractive) return "";
  const input = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => input.question(question, (answer) => {
    input.close();
    resolve(answer.trim());
  }));
}

function larkJson(args: string[]): LarkJsonResult {
  const result = spawnSync("lark-cli", args, { encoding: "utf8", env: larkEnv() });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  try {
    return { ok: result.status === 0, json: JSON.parse(stdout) as unknown, raw: stdout, err: stderr };
  } catch {
    return { ok: false, json: null, raw: stdout, err: stderr || stdout };
  }
}

function listProfiles(): Profile[] {
  const result = larkJson(["profile", "list"]);
  if (!result.ok || !Array.isArray(result.json)) {
    die("读取 lark-cli profile 失败；未修改 Agent 配置，请检查隔离 profile 后重试 setup");
  }
  return result.json as Profile[];
}

async function pickProfile(): Promise<Profile> {
  const profiles = listProfiles();
  if (options.profile) {
    const found = profiles.find((profile) => profile.name === options.profile || profile.appId === options.profile);
    if (!found) die(`profile ${options.profile} 不存在（可用: ${profiles.map((profile) => profile.name).join(", ") || "无"}）`);
    return found!;
  }
  if (profiles.length === 0) die("lark-cli 里还没有 bot profile。请运行 larkin setup 创建或连接机器人");

  say("\n可复用的飞书机器人（lark-cli profiles）：");
  profiles.forEach((profile, index) => say(`  [${index + 1}] ${profile.name}  appId=${profile.appId}${profile.active ? "  (当前活跃，默认)" : ""}`));
  say("  （创建新机器人请退出后运行 larkin setup）");
  const activeIndex = Math.max(0, profiles.findIndex((profile) => profile.active));
  const answer = await ask(`选择 profile（回车=${activeIndex + 1}）: `);
  const selected = answer === "" ? activeIndex : Number(answer) - 1;
  if (!(selected >= 0 && selected < profiles.length)) die("无效的 profile 选择");
  return profiles[selected]!;
}

function verifyBot(profile: Profile): unknown[] {
  const result = larkJson(["--profile", profile.name, "im", "+chat-list", "--as", "bot", "--json"]);
  const response = result.json as BotVerification | null;
  if (!result.ok || !response || !response.ok) die("bot 校验失败；未修改 Agent 配置，请检查 profile 凭证后重试 setup");
  const verified = response!;
  if (verified.identity !== "bot") die(`profile ${profile.name} 未返回 bot identity；未修改 Agent 配置，请重试 setup`);
  say(`\n✓ profile 校验：${profile.name}  appId=${profile.appId}  identity=bot`);
  return verified.data?.chats || [];
}

function validateRuntime(runtime: string): void {
  const catalog = larkinConfig.loadRuntimeModels();
  if (!catalog[runtime]) die(`"${runtime}" 不是合法 runtime。合法值: ${Object.keys(catalog).join(", ")}`);
}

function loadConfig(): { revision: string; config: HydratedConfig } {
  return larkinConfig.loadConfig(process.env, { mint: () => crypto.randomUUID() });
}

function fabricateAttachment(root: string, serverId: string): void {
  const directory = path.join(root, "computer", "servers", serverId);
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "runner.state.json");
  if (fs.existsSync(file)) return;
  const attachment = {
    kind: "computer-attachment",
    serverId,
    serverSlug: "feishu",
    serverMachineId: crypto.randomUUID(),
    machineId: crypto.randomUUID(),
    apiKey: `sk_computer_local_${crypto.randomBytes(16).toString("hex")}`,
    serverUrl: "http://127.0.0.1:8787",
    attachedAt: new Date().toISOString(),
  };
  fs.writeFileSync(file, JSON.stringify(attachment, null, 2), { mode: 0o600 });
}

function printAgents(config: HydratedConfig): void {
  const names = Object.keys(config.agents);
  if (!names.length) {
    say("尚未配置 Agent。");
    return;
  }
  say("已配置 Agents：");
  for (const name of names) {
    const agent = config.agents[name];
    say(`  ${name === config.activeAgent ? "*" : " "} ${name}: profile=${agent.feishuProfile} runtime=${agent.runtime} model=${agent.model}`);
  }
}

export async function main(): Promise<void> {
  if (has("--model")) {
    die("setup 不支持配置 model；请用 larkin model <id> 单独切换（bun run model -- <id>，带合法值校验）");
  }
  if (options.help) {
    say(`larkin setup（内部绑定阶段）

用法:
  larkin setup --profile <已有profile> [参数]

参数（都可省略；单 bot 单 agent 场景零参数即可）:
  --agent <App ID>     必须与所选 profile 的 App ID 一致；缺省自动使用该 App ID
  --profile <name>     复用已有 lark-cli profile（可用 profile 名或 appId；缺省交互选择）
  --runtime <runtime>  pi / codex / claude；缺省沿用已有 agent 的 runtime，全新 agent 默认 pi
  --yes                非交互接受默认项
  --list               查看已经配置的 Agent
  --help               显示帮助

普通用户请直接运行 larkin setup；该内部阶段只负责绑定已取得的凭证。
模型不在 setup 配置：沿用已有值（换 runtime 时重置为该 runtime 默认），切换用 larkin model <id>。`);
    return;
  }
  const loaded = loadConfig();
  const config = loaded.config;
  if (options.list) {
    printAgents(config);
    return;
  }

  say("=== larkin 多 Agent onboarding ===");
  const profile = await pickProfile();
  if (typeof profile?.appId !== "string" || !APP_ID.test(profile.appId) || profile.name !== profile.appId) {
    die("profile name 与合法 App ID 必须完全一致；未修改 Agent 配置，请重新运行 larkin setup 刷新 profile");
  }
  verifyBot(profile);

  const requestedAgent = options.agent || profile.appId;
  const prior = config.agents[profile.appId];
  const runtime = options.runtime || prior?.runtime || "pi";
  validateRuntime(runtime);
  const defaultModel = larkinConfig.defaultModelFor(runtime);
  const targetModelId = prior?.runtime === runtime ? prior.model : defaultModel;
  let runtimeModels = larkinConfig.loadRuntimeModels()[runtime];
  if (runtime === "pi") {
    const piCatalog = await discoverPiModelCatalog({
      cwd: layout.workspaceDir(profile.appId),
      ...(process.env.PI_CODING_AGENT_DIR ? { agentDir: process.env.PI_CODING_AGENT_DIR } : {}),
    });
    const effective = piCatalog.models.find((model) => model.id === piCatalog.effectiveModel);
    runtimeModels = [{ id: "default", supportedReasoningEfforts: effective?.supportedReasoningEfforts || [] }, ...piCatalog.models];
  }
  const targetModel = runtimeModels.find((model) => model.id === targetModelId);
  if (!targetModel) die(`目标模型 ${runtime}/${targetModelId} 不在 runtime 模型目录中；未修改 Agent 配置`);
  const stored = planSingleRootBinding({
    config: larkinConfig.toStored(config),
    profile,
    requestedAgent,
    runtime: options.runtime,
    defaultModel,
    supportedReasoningEfforts: targetModel!.supportedReasoningEfforts || [],
    now: new Date().toISOString(),
  });
  const bound = stored.agents[profile.appId];

  fs.mkdirSync(CFG_DIR, { recursive: true });
  larkinConfig.commitSetupConfig(process.env, loaded.revision, stored);
  fabricateAttachment(layout.root, stored.serverId);

  say(`\n✓ 已写配置: ${CFG_FILE}`);
  say(`  agent=${profile.appId}  runtime=${bound.runtime}  model=${bound.model}`);
  say(`  单服务 serverId=${stored.serverId}  larkinHome=${layout.root}`);
  say("\n启动这个 Agent：");
  say("  larkin start                     # 单服务启动全部已配置 Agent");
  say(`  larkin start --agent ${profile.appId}  # 仅调试这个 Agent`);
  say("创建独立飞书机器人 + Agent：");
  say("  larkin setup");
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => die(error instanceof Error ? error.message : String(error)));
}
