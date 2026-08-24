#!/usr/bin/env bun
// Internal setup stage: bind an existing lark-cli bot profile to its App-ID Agent.

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { isWindows } from "../platform/secure-metadata.js";
import { TargetRootLayout } from "../platform/root-layout.js";
import { planSingleRootBinding, type StoredConfig } from "./setup-binding.js";
import { configureBuiltinPiProviderModel, piAgentDirectory, type BuiltinPiProviderSetupSelection } from "../runtime/pi-provider-config.js";
import {
  applyPiProfileMigration,
  clearStalePiProfileMigrationLock,
  preparePiProfileMigration,
  releasePiProfileMigrationLock,
  rollbackPiProfileMigration,
  type PiProfileMigrationPlan,
} from "../runtime/pi-profile-migration.js";
import { discoverPiModelCatalog } from "../runtime/pi-model-catalog.js";
import { calculatePiCompactionSettings } from "../runtime/pi-compaction-recovery.js";
import { terminalSetupQuestioner, type OfficialPiAuthSelection, type SetupAgentChoice } from "./setup-agent-choice.js";
import {
  beginBuiltinPiCredentialTransaction,
  createOfficialPiAuthInteraction,
  createOfficialPiModelRuntime,
  runOfficialPiLogin,
  verifyOfficialPiProviderTurn,
} from "../runtime/pi-official-auth.js";
import * as larkinConfigImport from "../platform/config.js";
import { resolveOfficialLarkCli } from "../app/official-lark-cli.js";
import { loadValidatedBotCredential } from "./run-credential-preflight.js";

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
  piDistribution?: "external" | "builtin";
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
  selectionFile: flag("--selection-file"),
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
  const env = larkEnv();
  const official = resolveOfficialLarkCli({ env });
  const result = spawnSync(official.command, [...official.argsPrefix, ...args], { encoding: "utf8", env });
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  try {
    return { ok: result.status === 0, json: JSON.parse(stdout) as unknown, raw: stdout, err: stderr };
  } catch {
    return { ok: false, json: null, raw: stdout, err: stderr || stdout };
  }
}

function openAuthUrl(url: string): boolean {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  const result = spawnSync(command, args, { stdio: "ignore", timeout: 5_000 });
  return result.status === 0;
}

function listProfilesFromEnv(env: NodeJS.ProcessEnv): Profile[] {
  const official = resolveOfficialLarkCli({ env });
  const result = spawnSync(official.command, [...official.argsPrefix, "profile", "list"], { encoding: "utf8", env });
  try {
    const parsed = JSON.parse(result.stdout || "[]") as unknown;
    return Array.isArray(parsed) ? parsed as Profile[] : [];
  } catch {
    return [];
  }
}

function listProfiles(): Profile[] {
  const isolated = listProfilesFromEnv(larkEnv());
  const globalEnv = { ...process.env };
  delete globalEnv.LARKSUITE_CLI_CONFIG_DIR;
  const global = listProfilesFromEnv(globalEnv);
  const seen = new Set<string>();
  const merged: Profile[] = [];
  for (const profile of [...isolated, ...global]) {
    const key = `${String(profile.name || "")}\0${String(profile.appId || "")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(profile);
  }
  return merged;
}

function resolveProfile(requested: string, profiles: Profile[]): Profile | undefined {
  return profiles.find((profile) => profile.name === requested)
    || profiles.find((profile) => profile.appId === requested);
}

async function pickProfile(): Promise<Profile> {
  if (options.profile && APP_ID.test(options.profile)) {
    return { name: options.profile, appId: options.profile, active: true };
  }
  const profiles = listProfiles();
  if (options.profile) {
    const matched = resolveProfile(options.profile, profiles);
    if (matched && typeof matched.appId === "string" && APP_ID.test(matched.appId)) {
      return { name: String(matched.name || matched.appId), appId: matched.appId, active: matched.active };
    }
    die(`找不到 lark-cli profile ${options.profile}（可用名字或 App ID，不要求名字等于 App ID）`);
  }
  if (profiles.length === 0) die("lark-cli 里还没有 bot profile。请运行 larkin setup 创建或连接机器人");

  say("\n可复用的飞书（Lark）机器人（lark-cli profiles）：");
  profiles.forEach((profile, index) => say(`  [${index + 1}] ${profile.name}  appId=${profile.appId}${profile.active ? "  (当前活跃，默认)" : ""}`));
  say("  （创建新机器人请退出后运行 larkin setup）");
  const activeIndex = Math.max(0, profiles.findIndex((profile) => profile.active));
  const answer = await ask(`选择 profile（回车=${activeIndex + 1}）: `);
  const selected = answer === "" ? activeIndex : Number(answer) - 1;
  if (!(selected >= 0 && selected < profiles.length)) die("无效的 profile 选择");
  const picked = profiles[selected]!;
  if (typeof picked.appId !== "string" || !APP_ID.test(picked.appId)) {
    die(`profile ${picked.name || "?"} 没有合法 App ID`);
  }
  return picked;
}

function requireUsableBotCredential(appId: string): void {
  try {
    loadValidatedBotCredential(path.join(CFG_DIR, "bots"), appId);
  } catch {
    die(`没有可用的 bot 凭证 ${appId}（bots/${appId}.json）；未修改 Agent 配置，请先运行 larkin setup 完成扫码授权`);
  }
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

function readSetupSelection(fileArg: string | undefined): SetupAgentChoice | null {
  if (!fileArg) return null;
  const file = path.resolve(fileArg);
  if (path.dirname(file) !== path.resolve(CFG_DIR) || !/^\.setup-agent-choice-\d+-[A-Za-z0-9-]+\.json$/.test(path.basename(file))) {
    die("setup Agent 选择文件路径无效");
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (!isWindows && (stat.mode & 0o777) !== 0o600)) die("setup Agent 选择文件必须是当前用户拥有的 0600 普通文件");
  const bytes = fs.readFileSync(file, "utf8");
  fs.unlinkSync(file);
  const raw = JSON.parse(bytes) as SetupAgentChoice;
  if (!raw || !["pi", "codex", "claude"].includes(raw.runtime)) die("setup Agent 选择无效");
  return raw;
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

function catalogModelsFromError(error: unknown): string[] {
  if (!error || typeof error !== "object" || !("catalogModels" in error)) return [];
  const models = (error as { catalogModels?: unknown }).catalogModels;
  return Array.isArray(models) ? models.filter((id): id is string => typeof id === "string" && id.length > 0) : [];
}

function formatExternalPiSetupFailure(error: unknown, options: { agentExisted: boolean }): string {
  const original = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").trim();
  const alternatives = catalogModelsFromError(error);
  const parts: string[] = [];
  if (/external Pi (?:auth\.json|models\.json|settings\.json) is required|external Pi profile|external Pi auth\.json has an unsafe mode|external Pi models\.json has an unsafe mode|external Pi settings\.json has an unsafe mode/.test(original)) {
    parts.push("external-pi requires the official file-backed Pi profile containing auth.json (0600), models.json, and settings.json, normally after `pi` login and default-model selection. Environment-variable-only credentials are unsupported.");
  }
  if (original) parts.push(original);
  parts.push("Fix the official `pi` login and default model, then rerun `larkin setup --runtime external-pi`.");
  if (options.agentExisted) {
    parts.push("This Agent already exists; after a successful setup you can switch models with `larkin model <provider>/<model>`.");
  }
  if (alternatives.length) {
    parts.push(`Alternative models that report a context window: ${alternatives.join(", ")}.`);
  }
  return parts.join(" ");
}

function safeProviderFailure(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(?:401|403)\b|unauth|invalid.*(?:key|token)|credential/i.test(message)) {
    return new Error("内置 Pi provider 拒绝认证（401/403）；请重新登录或检查 credential");
  }
  if (/timeout|超时|ETIMEDOUT/i.test(message)) return new Error("内置 Pi provider readiness 超时；请检查网络和 endpoint");
  if (/ENOTFOUND|ECONN|fetch failed|network|TLS/i.test(message)) return new Error("内置 Pi provider endpoint 不可达；请检查网络、TLS 和 Base URL");
  if (/model|模型/i.test(message)) return new Error("内置 Pi provider 不接受所选模型；请检查 provider/model");
  return new Error("内置 Pi provider readiness 失败；credential/config 已回滚，请检查 provider 状态后重试");
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
  const selection = readSetupSelection(options.selectionFile);
  if (options.list) {
    printAgents(config);
    return;
  }

  say("=== larkin 多 Agent onboarding ===");
  const profile = await pickProfile();
  if (typeof profile.appId !== "string" || !APP_ID.test(profile.appId)) {
    die(`profile ${profile.name || "?"} 没有合法 App ID；未修改 Agent 配置`);
  }
  say(`使用 profile ${profile.name} → App ID ${profile.appId}`);
  requireUsableBotCredential(profile.appId);
  if (!options.profile) verifyBot(profile);

  const requestedAgent = options.agent || profile.appId;
  const prior = config.agents[profile.appId];
  const runtime = selection?.runtime || options.runtime || prior?.runtime || "pi";
  const piDistribution = runtime === "pi"
    ? (selection?.runtime === "pi" ? selection.distribution : prior?.piDistribution || "external")
    : undefined;
  validateRuntime(runtime);
  const defaultModel = larkinConfig.defaultModelFor(runtime);
  const selectedModel = selection?.runtime === "pi" && selection.distribution === "builtin" ? selection.model : undefined;
  let targetModelId = selectedModel || (prior?.runtime === runtime ? prior.model : defaultModel);
  let resolvedExternalModel: string | undefined;
  let pendingMigration: PiProfileMigrationPlan | null = null;
  let setupConfigCommitted = false;
  let providerTransaction: ReturnType<typeof beginBuiltinPiCredentialTransaction> | null = null;
  let providerPublished = false;
  const authAbort = new AbortController();
  const cancelOnSignal = (signal: NodeJS.Signals): void => {
    authAbort.abort();
    if (!setupConfigCommitted && pendingMigration) {
      try { rollbackPiProfileMigration(pendingMigration.state); } catch { /* best effort */ }
    }
    if (!providerPublished) providerTransaction?.rollback();
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  const onSigint = (): void => cancelOnSignal("SIGINT");
  const onSigterm = (): void => cancelOnSignal("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  let runtimeModels = larkinConfig.loadRuntimeModels()[runtime];
  let authQuestioner: ReturnType<typeof terminalSetupQuestioner> | null = null;
  try {
    if (runtime === "pi" && piDistribution === "external" && targetModelId === "default") {
      fs.mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
      try {
        clearStalePiProfileMigrationLock(CFG_DIR, profile.appId);
        const plan = preparePiProfileMigration(process.env, CFG_DIR, profile.appId, "external");
        pendingMigration = plan;
        applyPiProfileMigration(plan);
        const catalog = await discoverPiModelCatalog({
          cwd: CFG_DIR,
          agentDir: piAgentDirectory(CFG_DIR, profile.appId),
          env: process.env,
        });
        const effective = catalog.effectiveModel;
        const entry = effective ? catalog.models.find((model) => model.id === effective) : undefined;
        if (!effective || !entry) {
          throw new Error("Pi official default resolution returned an unavailable model");
        }
        if (!entry.contextWindow) {
          const alternatives = catalog.models
            .filter((model) => Number.isFinite(model.contextWindow) && Number(model.contextWindow) > 0)
            .map((model) => model.id);
          throw Object.assign(new Error("Pi effective model is missing a context window"), { catalogModels: alternatives });
        }
        calculatePiCompactionSettings(entry.contextWindow);
        targetModelId = effective;
        resolvedExternalModel = effective;
        runtimeModels = [{ id: effective, supportedReasoningEfforts: entry.supportedReasoningEfforts }];
      } catch (error) {
        throw new Error(formatExternalPiSetupFailure(error, { agentExisted: Boolean(prior) }));
      }
    } else if (runtime === "pi") {
      const preservedEffort = prior?.runtime === "pi" && typeof prior.effort === "string" && prior.effort.trim()
        ? [prior.effort]
        : [];
      runtimeModels = [{ id: targetModelId, supportedReasoningEfforts: preservedEffort }];
    }
    const targetModel = runtimeModels.find((model) => model.id === targetModelId);
    if (!targetModel) throw new Error(`目标模型 ${runtime}/${targetModelId} 不在 runtime 模型目录中；未修改 Agent 配置`);
    const stored = planSingleRootBinding({
      config: larkinConfig.toStored(config),
      profile,
      requestedAgent,
      runtime: selection?.runtime || options.runtime,
      ...(runtime === "pi" && piDistribution ? { piDistribution } : {}),
      ...(selectedModel || resolvedExternalModel ? { model: selectedModel || resolvedExternalModel } : {}),
      defaultModel,
      supportedReasoningEfforts: targetModel!.supportedReasoningEfforts || [],
      now: new Date().toISOString(),
    });
    const bound = stored.agents[profile.appId];

    fs.mkdirSync(CFG_DIR, { recursive: true });
    const authAlreadyCompleted = selection?.runtime === "pi" && selection.distribution === "builtin"
      && (selection as SetupAgentChoice & { authCompleted?: true }).authCompleted === true;
    const readinessAlreadyCompleted = authAlreadyCompleted
      && (selection as SetupAgentChoice & { readinessCompleted?: true }).readinessCompleted === true;
    providerTransaction = selection?.runtime === "pi" && selection.distribution === "builtin"
      && !authAlreadyCompleted ? beginBuiltinPiCredentialTransaction(CFG_DIR, profile.appId)
      : null;
    if (selection?.runtime === "pi" && selection.distribution === "builtin") {
      const official = selection.preset === "official" ? selection as OfficialPiAuthSelection : null;
      const configured = official ? null : configureBuiltinPiProviderModel(CFG_DIR, profile.appId, selection as BuiltinPiProviderSetupSelection);
      const providerId = official?.providerId || configured!.provider;
      const authType = official?.authType || "api_key";
      let piRuntime: Awaited<ReturnType<typeof createOfficialPiModelRuntime>> | null = null;
      if (!authAlreadyCompleted) {
        piRuntime = await createOfficialPiModelRuntime(CFG_DIR, profile.appId);
        authQuestioner = terminalSetupQuestioner();
        say(`正在通过捆绑官方 Pi 登录 ${providerId}（${authType}）…`);
        try {
          await runOfficialPiLogin(piRuntime, providerId, authType, createOfficialPiAuthInteraction({
            questioner: authQuestioner,
            report: (message) => say(message),
            openUrl: openAuthUrl,
            signal: authAbort.signal,
          }));
        } catch { throw new Error(`官方 Pi ${providerId} 登录失败或已取消；credential/config 未修改`); }
      }
      if (!readinessAlreadyCompleted) {
        piRuntime ??= await createOfficialPiModelRuntime(CFG_DIR, profile.appId);
        say("正在验证内置 Pi provider（受控单轮，不发送飞书（Lark）消息）…");
        try {
          if (!(process.env.LARKIN_TEST_SKIP_BUILTIN_PI_PROVIDER_TURN === "1" && process.env.LARKIN_TEST_BOT_REGISTER_MODULE)) {
            await verifyOfficialPiProviderTurn(piRuntime, selection.model, authAbort.signal);
          }
        }
        catch (error) { throw safeProviderFailure(error); }
      }
    }
    larkinConfig.commitSetupConfig(process.env, loaded.revision, stored);
    setupConfigCommitted = true;
    providerTransaction?.commit();
    providerPublished = true;
    if (pendingMigration) {
      try { releasePiProfileMigrationLock(pendingMigration.state); }
      catch { /* post-commit lock release is best-effort; do not roll back credentials */ }
      pendingMigration = null;
    }
    fabricateAttachment(layout.root, stored.serverId);
    say(`\n✓ 已写配置: ${CFG_FILE}`);
    say(`  agent=${profile.appId}  runtime=${bound.runtime}  model=${bound.model}`);
    say(`  单服务 serverId=${stored.serverId}  larkinHome=${layout.root}`);
    say("\n启动这个 Agent：");
    say("  larkin start                     # 单服务启动全部已配置 Agent");
    say(`  larkin start --agent ${profile.appId}  # 仅调试这个 Agent`);
    say("创建独立飞书（Lark）机器人 + Agent：");
    say("  larkin setup");
  } catch (error) {
    if (!setupConfigCommitted && pendingMigration) {
      try { rollbackPiProfileMigration(pendingMigration.state); } catch { /* best effort */ }
      pendingMigration = null;
    }
    providerTransaction?.rollback();
    throw error;
  } finally {
    authQuestioner?.close?.();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
  }
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => die(error instanceof Error ? error.message : String(error)));
}
