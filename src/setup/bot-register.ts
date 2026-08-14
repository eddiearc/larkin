#!/usr/bin/env bun
// Internal setup stage: browser-select a bot, verify credentials, publish them, then bind its App-ID Agent.

import { spawn as systemSpawn, spawnSync as systemSpawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerApp as channelRegisterApp } from "@larksuite/channel";
import { isWindows, secureWindowsDirectoryAcl } from "../platform/secure-metadata.js";
import { internalCommandSpec } from "../app/internal-command.js";
import * as larkinConfig from "../platform/config.js";
import { createAgentStateStore } from "../agent/agent-state-store.js";
import { hydrateRuntimeAgent, syncAgentProfile, syncAgentProfileAsync } from "../app/runtime-agent-config.js";
import { managedLarkCliEnv } from "../app/agent-lark-cli-workspace.js";
import { resolveOfficialLarkCli, type OfficialLarkCliCommand } from "../app/official-lark-cli.js";
import { collectSetupAgentChoice, recoverUnavailableExternalPi, terminalSetupQuestioner } from "./setup-agent-choice.js";
import { probeNativeRuntimeReadiness } from "../runtime/runtime-readiness.js";
import { configureBuiltinPiProviderModel, stageBuiltinPiProvider, validatePiBaseUrl, listProviderModels, PI_PROVIDER_PRESETS,
  type BuiltinPiProviderSetupSelection, type PiProviderPresetId } from "../runtime/pi-provider-config.js";
import {
  beginBuiltinPiCredentialTransaction,
  createOfficialPiCredentialRuntime,
  createOfficialPiAuthInteraction,
  createOfficialPiModelRuntime,
  createOfficialPiLogoutRuntime,
  createOfficialPiRegistryRuntime,
  listOfficialPiAuthProviders,
  logoutOfficialPiProvider,
  officialPiAuthStatus,
  runOfficialPiLogin,
  verifyOfficialPiProviderTurn,
} from "../runtime/pi-official-auth.js";
import type { OfficialPiAuthSelection, SetupAgentChoice } from "./setup-agent-choice.js";
import {
  documentCommentSubscriptionCapability,
  markDocumentCommentSubscriptionVerified,
  type DocumentCommentSubscriptionCapability,
  type DocumentCommentSubscriptionDimension,
} from "../platform/callback-capability.js";
// qrcode-terminal does not publish TypeScript declarations.
// @ts-expect-error bundled CommonJS dependency
import qrcodePackage from "qrcode-terminal";

interface RegistrationResult {
  client_id?: unknown;
  client_secret?: unknown;
  user_info?: { tenant_brand?: unknown; open_id?: unknown };
}

interface StoredCredential {
  ownerOpenId?: unknown;
  createdAt?: unknown;
  [key: string]: unknown;
}

type RegisterApp = (options: {
  source: string;
  addons: {
    scopes: { tenant: string[] };
    events: { items: { tenant: string[] } };
    callbacks: { items: string[] };
  };
  onQRCodeReady(info: { url: string; expireIn: number }): void;
  onStatusChange(info: { status: string; interval?: number }): void;
}) => Promise<RegistrationResult>;

const testFixture = process.env.LARKIN_TEST_BOT_REGISTER_MODULE
  ? await import(pathToFileURL(path.resolve(process.env.LARKIN_TEST_BOT_REGISTER_MODULE)).href) as {
    registerApp?: RegisterApp;
    qrcode?: { generate(text: string, options: { small: boolean }, callback: (code: string) => void): void };
    spawnSync?: typeof systemSpawnSync;
    syncAgentProfile?: typeof syncAgentProfile;
    resolveOfficialLarkCli?: typeof resolveOfficialLarkCli;
    wait?: (milliseconds: number) => Promise<void>;
  }
  : null;
const registerApp: RegisterApp = testFixture?.registerApp ?? channelRegisterApp as unknown as RegisterApp;
const qrcode = testFixture?.qrcode ?? qrcodePackage;
const spawnSync = testFixture?.spawnSync ?? systemSpawnSync;
const synchronizeAgentProfile = testFixture?.syncAgentProfile ?? syncAgentProfile;
const resolveOfficialCli = testFixture?.resolveOfficialLarkCli ?? resolveOfficialLarkCli;
const wait = testFixture?.wait ?? ((milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
const CFG_DIR = larkinConfig.resolveConfigDir(process.env);
let temporaryAgentChoiceFile: string | null = null;
let pendingPiAuthTransaction: ReturnType<typeof beginBuiltinPiCredentialTransaction> | null = null;
let pendingBindChild: ChildProcess | null = null;
let pendingChildSettled: Promise<void> | null = null;
let settlePendingChild: (() => void) | null = null;
let requestedShutdown: "SIGINT" | "SIGTERM" | null = null;
const shutdownController = new AbortController();
let resolvedSetupOfficialCli: OfficialLarkCliCommand | null = null;

function trackPendingChild(child: ChildProcess | null): void {
  if (child) {
    pendingBindChild = child;
    pendingChildSettled = new Promise<void>((resolve) => { settlePendingChild = resolve; });
    return;
  }
  pendingBindChild = null;
  settlePendingChild?.();
  settlePendingChild = null;
  pendingChildSettled = null;
}

process.on("exit", () => {
  pendingPiAuthTransaction?.rollback();
  if (!temporaryAgentChoiceFile) return;
  try { fs.unlinkSync(temporaryAgentChoiceFile); } catch { /* consumed or best effort */ }
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (requestedShutdown) return;
    requestedShutdown = signal;
    const settling = pendingChildSettled;
    shutdownController.abort(new Error(`setup interrupted by ${signal}`));
    void (settling ?? Promise.resolve()).finally(() => {
      pendingPiAuthTransaction?.rollback();
      pendingPiAuthTransaction = null;
      process.exit(signal === "SIGINT" ? 130 : 143);
    });
  });
}
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(name);
const say = (...args: unknown[]): void => console.error(...args);
const die = (message: string): never => {
  if (requestedShutdown) throw new Error(`setup shutdown pending (${requestedShutdown})`);
  console.error(`✗ ${message}`);
  process.exit(1);
};
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const APP_ID = /^cli_[A-Za-z0-9]+$/;
const BOT_VERIFY_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;
const testChildTimeout = process.env.LARKIN_TEST_BOT_REGISTER_MODULE ? Number(process.env.LARKIN_TEST_CHILD_TIMEOUT_MS) : NaN;
const testChildMaxOutput = process.env.LARKIN_TEST_BOT_REGISTER_MODULE ? Number(process.env.LARKIN_TEST_CHILD_MAX_OUTPUT_BYTES) : NaN;
const CHILD_TIMEOUT_MS = Number.isFinite(testChildTimeout) && testChildTimeout >= 50 ? testChildTimeout : 60_000;
const CHILD_MAX_OUTPUT_BYTES = Number.isFinite(testChildMaxOutput) && testChildMaxOutput >= 256 ? testChildMaxOutput : 64 * 1024;

function officialCliForProfile(env: NodeJS.ProcessEnv): OfficialLarkCliCommand {
  if (resolvedSetupOfficialCli) return resolvedSetupOfficialCli;
  if (pendingPiAuthTransaction) throw new Error("official lark-cli must be resolved before the Pi credential transaction starts");
  resolvedSetupOfficialCli = resolveOfficialCli({ env });
  return resolvedSetupOfficialCli;
}

function subscriptionStatus(payload: unknown): boolean | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;
  const data = root.data && typeof root.data === "object" && !Array.isArray(root.data) ? root.data as Record<string, unknown> : null;
  const nested = data?.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data as Record<string, unknown> : null;
  if (root.ok !== true) return null;
  const value = data?.is_subscribe ?? nested?.is_subscribe;
  return typeof value === "boolean" ? value : null;
}

type AsyncCliProcess = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<{
  status: number | null; stdout: string; stderr: string;
}>;

export async function reconcileDocumentCommentSubscription(input: {
  mode: "preserve" | "none" | DocumentCommentSubscriptionDimension;
  command: string;
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
  runProcessImpl?: AsyncCliProcess;
  isShutdownAborted?: () => boolean;
}): Promise<{ changed: boolean; subscribed: boolean; dimension: DocumentCommentSubscriptionDimension | null }> {
  if (input.mode === "preserve") return { changed: false, subscribed: false, dimension: null };
  const run = input.runProcessImpl ?? ((command, args, env) => runBoundedCliProcess(
    command, args, env, "Document comment subscription operation",
  ));
  const eventType = "drive.notice.comment_add_v1";
  const dimension = "application";
  const identity = "bot";
  const isShutdownAborted = input.isShutdownAborted ?? (() => shutdownController.signal.aborted);
  const readStatus = async (): Promise<boolean | null> => {
    try {
      const status = await run(input.command, [
        ...input.argsPrefix,
        "drive", "user", "subscription_status",
        "--params", JSON.stringify({ event_type: eventType }),
        "--as", identity,
        "--json",
      ], input.env);
      let payload: unknown = null;
      try { payload = JSON.parse(String(status.stdout || "null")) as unknown; } catch { /* fail closed */ }
      return status.status === 0 ? subscriptionStatus(payload) : null;
    } catch { return null; }
  };
  const expected = input.mode !== "none";
  const before = await readStatus();
  if (before === null) throw new Error(`document comment ${dimension} subscription preflight status was unreadable; no write attempted`);
  if (before === expected) return { changed: false, subscribed: expected, dimension };
  const subscribeArgs = ["drive", "user", "subscription", "--data", JSON.stringify({ event_type: eventType }), "--as", identity, "--json"];
  const removeArgs = ["drive", "user", "remove_subscription", "--event-type", eventType, "--as", identity, "--json"];
  const mutationArgs = expected ? subscribeArgs : removeArgs;
  try { await run(input.command, [...input.argsPrefix, ...mutationArgs], input.env); }
  catch {
    if (isShutdownAborted()) {
      throw new Error(`document comment ${dimension} subscription mutation was interrupted by shutdown; external state is uncertain`);
    }
  }
  if (isShutdownAborted()) {
    throw new Error(`document comment ${dimension} subscription mutation was interrupted by shutdown; external state is uncertain`);
  }
  const after = await readStatus();
  if (after === expected) return { changed: true, subscribed: expected, dimension };
  if (!expected) {
    if (after === true) {
      throw new Error(`document comment ${dimension} subscription removal failed; platform status verified unchanged`);
    }
    if (isShutdownAborted()) {
      throw new Error(`document comment ${dimension} subscription post-mutation status was interrupted by shutdown; external state is uncertain`);
    }
    throw new Error(`document comment ${dimension} subscription removal external state is uncertain`);
  }
  if (after === false) {
    throw new Error(`document comment ${dimension} subscription activation failed; platform status verified unchanged`);
  }
  if (isShutdownAborted()) {
    throw new Error(`document comment ${dimension} subscription post-mutation status was interrupted by shutdown; external state is uncertain`);
  }
  try { await run(input.command, [...input.argsPrefix, ...removeArgs], input.env); }
  catch { /* A rejected rollback is still ambiguous; final status remains authoritative. */ }
  if (isShutdownAborted()) {
    throw new Error(`document comment ${dimension} subscription rollback was interrupted by shutdown; external state is uncertain`);
  }
  const rolledBack = await readStatus();
  if (rolledBack === false) {
    throw new Error(`document comment ${dimension} subscription write was not verified; rollback was verified`);
  }
  if (rolledBack === true) {
    throw new Error(`document comment ${dimension} subscription write was not verified; rollback failed and platform status verified the subscription remains active; run larkin setup --comment-subscription none to remove it`);
  }
  throw new Error(`document comment ${dimension} subscription write was not verified; rollback status is uncertain`);
}

export async function applyDocumentCommentSubscription(input: {
  mode: "preserve" | "none" | "application";
  command: string;
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
  runProcessImpl?: AsyncCliProcess;
  isShutdownAborted?: () => boolean;
  markVerified(): void;
}): Promise<{ changed: boolean; subscribed: boolean; dimension: DocumentCommentSubscriptionDimension | null }> {
  const reconciled = await reconcileDocumentCommentSubscription(input);
  if (!reconciled.subscribed) return reconciled;
  try {
    input.markVerified();
    return reconciled;
  } catch {
    if (!reconciled.changed) {
      throw new Error("document comment local verified-state persistence failed; pre-existing external subscription was left unchanged");
    }
    try {
      await reconcileDocumentCommentSubscription({ ...input, mode: "none" });
    } catch (error) {
      if (errorMessage(error).includes("removal failed; platform status verified unchanged")) {
        throw new Error("document comment local verified-state persistence failed; external subscription rollback failed and platform status verified the subscription remains active; run larkin setup --comment-subscription none to remove it");
      }
      throw new Error("document comment local verified-state persistence failed; external subscription rollback status is uncertain");
    }
    throw new Error("document comment local verified-state persistence failed; external subscription rollback was verified");
  }
}

function botVerificationRetryable(result: { status: number | null; stdout?: unknown; stderr?: unknown }): boolean {
  const text = `${typeof result.stdout === "string" ? result.stdout : ""}\n${typeof result.stderr === "string" ? result.stderr : ""}`;
  return /\binvalid_client\b|specified app does not exist|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|temporary network|too many requests|\b(?:429|502|503|504)\b/i.test(text);
}

function ensureSecureBotsDir(): string {
  fs.mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
  const directory = path.join(CFG_DIR, "bots");
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; }
  if (isWindows) {
    // Windows 无 POSIX 权限位（mode 恒 0o666）：改用 icacls 收紧 CFG_DIR 与 bots 目录
    // 的 ACL 为「当前用户 + SYSTEM」并回读校验，fail-closed。
    secureWindowsDirectoryAcl(CFG_DIR, { label: "Larkin 配置目录" });
    secureWindowsDirectoryAcl(directory, { label: "bots 凭证目录" });
    return directory;
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o777) !== 0o700) {
    die("bots 凭证目录必须是当前用户拥有、非 symlink、权限精确 0700 的真实目录；未写入新凭证");
  }
  return directory;
}

function openBrowser(url: string): boolean {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = systemSpawn(command, args, { stdio: "ignore", shell: false });
    child.once("error", () => say(`[setup] 浏览器启动失败，请手动打开完整地址：${url}`));
    child.unref?.();
    return true;
  } catch {
    say(`[setup] 浏览器启动失败，请手动打开完整地址：${url}`);
    return false;
  }
}

async function runBindProcess(command: string, args: readonly string[]): Promise<number | null> {
  if (testFixture?.spawnSync && !pendingPiAuthTransaction) {
    return spawnSync(command, [...args], { env: process.env, stdio: "inherit" }).status;
  }
  return await new Promise<number | null>((resolve, reject) => {
    const child = systemSpawn(command, [...args], { env: process.env, stdio: "inherit" });
    trackPendingChild(child);
    let killTimer: NodeJS.Timeout | null = null;
    const abort = (): void => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1_000);
      killTimer.unref?.();
    };
    if (shutdownController.signal.aborted) abort();
    else shutdownController.signal.addEventListener("abort", abort, { once: true });
    child.once("error", (error) => {
      if (killTimer) clearTimeout(killTimer);
      shutdownController.signal.removeEventListener("abort", abort);
      reject(error);
    });
    child.once("exit", (code) => {
      if (killTimer) clearTimeout(killTimer);
      shutdownController.signal.removeEventListener("abort", abort);
      resolve(code);
    });
  }).finally(() => { trackPendingChild(null); });
}

async function runBoundedCliProcess(command: string, args: readonly string[], env: NodeJS.ProcessEnv, label: string): Promise<{
  status: number | null; stdout: string; stderr: string;
}> {
  if (testFixture?.spawnSync && !pendingPiAuthTransaction && process.env.LARKIN_TEST_ASYNC_IDENTITY !== "1") {
    const result = spawnSync(command, [...args], { encoding: "utf8", env });
    return { status: result.status, stdout: result.stdout || "", stderr: result.stderr || "" };
  }
  return await new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = systemSpawn(command, [...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    trackPendingChild(child);
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let failure: Error | null = null;
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;
    const terminate = (error: Error): void => {
      if (failure) return;
      failure = error;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 1_000);
      killTimer.unref?.();
    };
    const collect = (target: "stdout" | "stderr", chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > CHILD_MAX_OUTPUT_BYTES) { terminate(new Error(`${label} output exceeded the bounded limit`)); return; }
      if (target === "stdout") stdout += chunk.toString("utf8"); else stderr += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => collect("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => collect("stderr", chunk));
    const timeout = setTimeout(() => terminate(new Error(`${label} timed out`)), CHILD_TIMEOUT_MS);
    timeout.unref?.();
    const abort = (): void => terminate(new Error(`${label} cancelled`));
    if (shutdownController.signal.aborted) abort();
    else shutdownController.signal.addEventListener("abort", abort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      shutdownController.signal.removeEventListener("abort", abort);
    };
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("exit", (status) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (failure) { reject(failure); return; }
      resolve({ status, stdout, stderr });
    });
  }).finally(() => { trackPendingChild(null); });
}

async function runIdentityProcess(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<{
  status: number | null; stdout: string; stderr: string;
}> {
  return runBoundedCliProcess(command, args, env, "Bot identity verification");
}

/**
 * 官方 lark-cli 的 `api` 透传只映射响应的 data 字段，而 /open-apis/bot/v3/info 的
 * bot 对象在顶层（{code, msg, bot}），无法经 lark-cli 读取。这里直接用刚发布的
 * bot 凭证做一次受限的 HTTP 获取，用于 setup 完成即写入 bot-identity（不依赖首次连接）。
 */
interface BotInfoPayload { open_id?: string; app_name?: string; avatar_url?: string }

async function fetchBotInfoViaHttp(appId: string, tenant: "feishu" | "lark" | undefined): Promise<BotInfoPayload | null> {
  let credential: { appSecret?: unknown };
  try {
    credential = JSON.parse(fs.readFileSync(path.join(ensureSecureBotsDir(), `${appId}.json`), "utf8")) as { appSecret?: unknown };
  } catch { return null; }
  if (typeof credential.appSecret !== "string" || !credential.appSecret) return null;
  const base = tenant === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
  try {
    const tokenResponse = await fetch(`${base}/open-apis/auth/v3/tenant_access_token/internal`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ app_id: appId, app_secret: credential.appSecret }),
      signal: AbortSignal.timeout(15_000),
    });
    const tokenPayload = await tokenResponse.json() as { code?: unknown; tenant_access_token?: unknown };
    if (tokenPayload.code !== 0 || typeof tokenPayload.tenant_access_token !== "string") return null;
    const infoResponse = await fetch(`${base}/open-apis/bot/v3/info`, {
      headers: { authorization: `Bearer ${tokenPayload.tenant_access_token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const infoPayload = await infoResponse.json() as { code?: unknown; bot?: { open_id?: unknown; app_name?: unknown; avatar_url?: unknown } };
    if (infoPayload.code !== 0 || !infoPayload.bot || typeof infoPayload.bot !== "object") return null;
    return {
      open_id: typeof infoPayload.bot.open_id === "string" ? infoPayload.bot.open_id : undefined,
      app_name: typeof infoPayload.bot.app_name === "string" ? infoPayload.bot.app_name : undefined,
      avatar_url: typeof infoPayload.bot.avatar_url === "string" ? infoPayload.bot.avatar_url : undefined,
    };
  } catch { return null; }
}

/**
 * 允许被添加进群：把应用可用范围设为全员可见（更新后线上立即生效）。
 * 前提是授权确认页勾选了 admin:app.visibility；未勾选时给出可执行提示，不阻断 setup。
 */
async function ensureAppVisibleToAll(id: string, official: OfficialLarkCliCommand, cliEnv: NodeJS.ProcessEnv): Promise<boolean> {
  const result = await runBoundedCliProcess(official.command,
    [...official.argsPrefix, "api", "PATCH", `/open-apis/application/v6/applications/${id}/visibility`,
      "--as", "bot", "--data", JSON.stringify({ is_visible_to_all: true }), "--json"],
    cliEnv, "App visibility grant");
  if (result.status !== 0) return false;
  try {
    const envelope = JSON.parse(result.stdout || "") as { ok?: unknown };
    return envelope?.ok === true;
  } catch { return false; }
}

export async function main(): Promise<void> {
if (has("--help") || has("-h")) {
  say(`setup 内部机器人注册阶段

用法:
  bun bot-register.mjs --auto

完成后自动：按返回 appId 判定新旧 → 同步并校验 lark-cli bot 凭证 →
  原子写 bots/<appId>.json（0600）→ 绑定 Agent。`);
  process.exit(0);
}

const autoSelect = has("--auto");
const commentSubscription = flag("--comment-subscription") || "preserve";
if (has("--comment-subscription") && commentSubscription === "preserve") die("--comment-subscription 缺少参数值");
if (!["preserve", "none", "application"].includes(commentSubscription)) {
  die("--comment-subscription 只支持 none 或 application");
}
const resultFileArg = flag("--result-file") || null;
const resultFile = resultFileArg ? path.resolve(resultFileArg) : null;
if (resultFile && (path.dirname(resultFile) !== path.resolve(CFG_DIR) || !/^\.setup-result-\d+\.json$/.test(path.basename(resultFile)))) {
  die("--result-file 必须是配置根目录内的 .setup-result-<pid>.json");
}
if (argv.some((arg) => arg === "--app-id" || arg.startsWith("--app-id="))) {
  die("不支持 --app-id；机器人必须在飞书（Lark）网页中选择");
}
if (!autoSelect) die("setup 注册阶段必须由交互式选择流程启动");
say("[setup 1/5] 在网页选择已有机器人或创建新机器人");
if (commentSubscription === "application") {
  say(`! 已显式选择 ${commentSubscription} 维度评论订阅：一旦平台状态验证为已订阅，Bot 可见文档中实际送达的每条支持评论都会进入 Inbox 并唤醒 Agent，不要求 @Bot。`);
  say("! setup 将通过官方 lark-cli 的结构化 API 请求创建该订阅，并以只读 subscription_status 二次核验；不会从意图或事件配置推断订阅已生效。");
} else if (commentSubscription === "none") {
  say("! 已显式选择 none：setup 将取消 application/Bot 维度的评论订阅，并用 subscription_status 核验；之后仅 @Bot 评论进入 Inbox。");
}

const TENANT_SCOPES = [
  "im:message",
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message.group_msg",
  "im:message:send_as_bot",
  "im:chat:readonly",
  "im:chat:create",
  "im:chat:update",
  "im:chat.group_info:readonly",
  "im:chat.members:read",
  "im:chat.members:write_only",
  "im:chat:operate_as_owner",
  "im:resource",
  "application:application:self_manage",
  "contact:user.employee_id:readonly",
  // 允许 setup 把应用可用范围设为全员可见：任何成员都能把 bot 加进自己的群（修复 230003 类场景）
  "admin:app.visibility",
  // drive.notice.comment_add_v1 and the stable comment read/reply APIs are
  // currently delivered by Feishu under the aggregate drive tenant scope.
  "drive:drive",
  "docs:document.comment:read",
  "docs:document.comment:create",
];
const TENANT_EVENTS = ["im.message.receive_v1", "im.message.message_read_v1", "drive.notice.comment_add_v1"];
let pollingCount = 0;

const result = await registerApp({
  source: "larkin",
  addons: {
    scopes: { tenant: TENANT_SCOPES },
    events: { items: { tenant: TENANT_EVENTS } },
    callbacks: { items: ["card.action.trigger"] },
  },
  onQRCodeReady: ({ url, expireIn }) => {
    qrcode.generate(url, { small: true }, (code: string) => say(code));
    say(`\n打开以下链接（或扫码），${Math.round(expireIn / 60)} 分钟内有效：\n\n  ${url}\n\n[setup 2/5] 等待飞书（Lark）网页完成授权并回传凭证…`);
    say(openBrowser(url) ? "[setup] 已在默认浏览器打开授权页" : "[setup] 未能自动打开浏览器，请手动打开上面的链接");
  },
  onStatusChange: ({ status, interval }) => {
    if (status === "domain_switched") say("[setup] 已切换到 Lark 域名");
    if (status === "slow_down") say(`[setup] 飞书（Lark）要求降低轮询频率，${interval || "稍后"}秒后继续`);
    if (status === "polling" && ++pollingCount % 12 === 0) say(`[setup] 仍在等待飞书（Lark）回传凭证（约 ${pollingCount / 12} 分钟）…`);
  },
}).catch(() => die("网页授权失败；未执行凭证同步、文件写入或 Agent 绑定，请重试 setup"));

const { client_id: rawId, client_secret: rawSecret, user_info: userInfo } = result || {};
if (typeof rawId !== "string" || !APP_ID.test(rawId)) die("授权返回的 App ID 格式非法；未执行凭证同步、文件写入或 Agent 绑定");
if (typeof rawSecret !== "string" || rawSecret.length === 0) die("授权完成但未取得有效凭证；未执行凭证同步、文件写入或 Agent 绑定");
const id = rawId as string;
const secret = rawSecret as string;
const botsDir = ensureSecureBotsDir();
say(`[setup 3/5] 正在按 App ID ${id} 刷新凭证并配置 Agent`);

const tenant = userInfo?.tenant_brand === "lark" ? "lark" : "feishu";
const botFile = path.join(botsDir, `${id}.json`);
const prior: StoredCredential = (() => {
  try { return JSON.parse(fs.readFileSync(botFile, "utf8")) as StoredCredential; }
  catch { return {}; }
})();
const requestedAt = new Date().toISOString();
const priorSubscription = documentCommentSubscriptionCapability(prior);
const documentCommentSubscription: DocumentCommentSubscriptionCapability = commentSubscription === "application"
  ? { mode: "none", status: "requested-unverified", source: "setup-opt-in", dimension: commentSubscription, requestedAt }
  : commentSubscription === "none" || !priorSubscription
    ? { mode: "none", status: "safe-default", source: "setup-default", updatedAt: requestedAt }
    : priorSubscription;

if (!flag("--runtime") && (!testFixture || process.env.LARKIN_TEST_ENABLE_AGENT_CHOICE === "1")) {
  const existing = larkinConfig.loadConfig(process.env).config.agents[id];
  // The official resolver performs a synchronous login-shell probe. Resolve it
  // exactly once before the credential heartbeat lock becomes active.
  resolvedSetupOfficialCli = resolveOfficialCli({ env: process.env });
  const questioner = terminalSetupQuestioner();
  // One setup-owned transaction starts before status/logout and remains active
  // through selection, login, bind, readiness, and the final setup commit.
  pendingPiAuthTransaction = beginBuiltinPiCredentialTransaction(CFG_DIR, id);
  const authServices = {
    providers: async () => listOfficialPiAuthProviders(await createOfficialPiRegistryRuntime()),
    status: async () => officialPiAuthStatus(await createOfficialPiCredentialRuntime(CFG_DIR, id)),
    logout: async (providerId: string) => logoutOfficialPiProvider(await createOfficialPiLogoutRuntime(CFG_DIR, id), providerId),
    report: (message: string) => say(message),
  };
  try {
    const requested = await collectSetupAgentChoice(questioner, existing, authServices);
    const choice = await recoverUnavailableExternalPi(requested, questioner, () => probeNativeRuntimeReadiness({
      runtime: "pi", agentId: id, cwd: path.join(CFG_DIR, "agents", id), env: process.env,
    }), (message) => say(`! ${message}`), authServices);
    if (choice) {
      let serializedChoice: SetupAgentChoice & { authCompleted?: true; readinessCompleted?: true } = choice;
      if (choice.runtime === "pi" && choice.distribution === "builtin") {
        const official = choice.preset === "official" ? choice as OfficialPiAuthSelection : null;
        const configured = official ? null : configureBuiltinPiProviderModel(CFG_DIR, id, choice as BuiltinPiProviderSetupSelection);
        const providerId = official?.providerId || configured!.provider;
        const authType = official?.authType || "api_key";
        let piRuntime: Awaited<ReturnType<typeof createOfficialPiModelRuntime>>;
        try {
          say(`正在通过捆绑官方 Pi 登录 ${providerId}（${authType}）…`);
          piRuntime = await createOfficialPiModelRuntime(CFG_DIR, id);
          await runOfficialPiLogin(piRuntime, providerId, authType,
            createOfficialPiAuthInteraction({ questioner, report: (message) => say(message), openUrl: openBrowser }));
        } catch {
          pendingPiAuthTransaction.rollback();
          pendingPiAuthTransaction = null;
          throw new Error(`官方 Pi ${providerId} 登录失败或已取消；credential/config 未修改`);
        }
        if (process.env.LARKIN_TEST_SKIP_BUILTIN_PI_PROVIDER_TURN !== "1") {
          say("正在验证内置 Pi provider（受控单轮，不发送飞书（Lark）消息）…");
          try { await verifyOfficialPiProviderTurn(piRuntime, choice.model); }
          catch {
            pendingPiAuthTransaction.rollback();
            pendingPiAuthTransaction = null;
            throw new Error(`官方 Pi ${providerId} readiness 失败；credential/config 未修改`);
          }
        }
        serializedChoice = { ...choice, authCompleted: true, readinessCompleted: true };
      }
      temporaryAgentChoiceFile = path.join(CFG_DIR, `.setup-agent-choice-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(temporaryAgentChoiceFile, `${JSON.stringify(serializedChoice)}\n`, { mode: 0o600, flag: "wx" });
    }
  } finally { questioner.close?.(); }
}

// ── 非交互参数化内置 Pi（builtin-pi 是默认 runtime 类型）──
// --pi-distribution builtin：需 --provider <id> + --api-key <key>（或 --base-url 自定义端点）。
const piDistributionFlag = flag("--pi-distribution");
const setupProvider = flag("--provider");
const setupApiKey = flag("--api-key");
const setupBaseUrl = flag("--base-url");
const setupModel = flag("--model");
if (piDistributionFlag === "builtin") {
  if (!setupProvider && !setupBaseUrl) {
    throw new Error("builtin-pi 需要 --provider <id>（deepseek|kimi|minimax|zhipu|openai|anthropic|gemini|groq|cerebras|xai|fireworks|together|mistral|openrouter|kimi-coding|qwen-cn|custom）或 --base-url；或改用 --runtime external-pi 使用已有 pi 环境");
  }
  if (!setupApiKey) throw new Error("builtin-pi 需要 --api-key；或改用 --runtime external-pi 使用已有 pi 登录");
  const presetId = setupProvider ?? "custom";
  const presetDef = PI_PROVIDER_PRESETS.find((p) => p.id === presetId);
  if (!presetDef && !setupBaseUrl) throw new Error(`未知 provider \`${presetId}\`；可选：${PI_PROVIDER_PRESETS.map((p) => p.id).join(" | ")} | custom`);
  const raw: BuiltinPiProviderSetupSelection = {
    distribution: "builtin",
    preset: presetId as PiProviderPresetId,
    model: setupModel ?? presetDef?.defaultModel ?? "",
    ...(presetDef ? { baseUrl: presetDef.baseUrl } : setupBaseUrl ? { baseUrl: validatePiBaseUrl(setupBaseUrl) } : {}),
  };
  if (setupModel && raw.baseUrl) {
    // Owner 决策：模型名必须来自 provider 的权威可用列表，输错即报错，不做运行时猜测。
    const availableIds = await listProviderModels(raw.baseUrl, setupApiKey);
    const matched = availableIds.some((id) => id === setupModel || id.endsWith(`/${setupModel}`));
    if (!matched) {
      const preview = availableIds.slice(0, 12).join(", ") + (availableIds.length > 12 ? ", …" : "");
      throw new Error(`未知模型 ${setupModel}；provider 可用模型：[${preview || "无"}]`);
    }
  }
  stageBuiltinPiProvider(CFG_DIR, id, { ...raw, apiKey: setupApiKey });
  temporaryAgentChoiceFile = path.join(CFG_DIR, `.setup-agent-choice-${process.pid}-${Date.now()}.json`);
  fs.writeFileSync(temporaryAgentChoiceFile,
    `${JSON.stringify({ ...raw, runtime: "pi", authCompleted: true, readinessCompleted: true })}\n`, { mode: 0o600, flag: "wx" });
  say(`[setup 2/5] ✓ 内置 Pi provider 已配置（${presetId}${setupBaseUrl ? " / custom" : ""}）`);
} else if (piDistributionFlag === "external" && (setupProvider || setupApiKey || setupBaseUrl)) {
  throw new Error("external-pi 使用已有 pi 环境与登录，不接受 --provider/--api-key/--base-url");
}

const stagedBotFile = path.join(botsDir, `.${id}.${process.pid}.tmp`);
try {
  fs.writeFileSync(stagedBotFile, `${JSON.stringify({
    appId: id,
    appSecret: secret,
    tenant,
    ownerOpenId: userInfo?.open_id || prior.ownerOpenId || null,
    createdAt: prior.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    capabilities: {
      cardActionCallback: { status: "requested-unverified", requestedAt: new Date().toISOString() },
      documentCommentEvent: {
        status: "requested-unverified",
        event: "drive.notice.comment_add_v1",
        scope: "drive:drive",
        requestedAt: new Date().toISOString(),
      },
      documentCommentReply: {
        status: "requested-unverified",
        scope: "docs:document.comment:create",
        requestedAt: new Date().toISOString(),
      },
      documentCommentSubscription,
    },
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(stagedBotFile, botFile);
} catch (error) {
  try { fs.unlinkSync(stagedBotFile); } catch { /* best effort */ }
  die(`bot 凭证原子写入失败：${errorMessage(error)}`);
}
say(`✓ 凭证已写入 ${botFile}（0600，Secret 不回显）`);
say("! card.action.trigger 已请求但尚未证明生效；启动后运行 Agent CLI 的 interaction callback-probe，发送并点击验证卡，状态变为 verified-effective 后才能创建业务交互卡片。");
say("! drive.notice.comment_add_v1 + drive:drive 已请求但尚未真实验证；发布配置、授予 Bot 文档访问权并在测试文档评论中 @Bot 后，larkin agents 会显示事件是否到达及读取失败诊断。");
say("! docs:document.comment:create 已请求但尚未真实验证；它覆盖 in-thread reply 与 whole-document create_v2 fallback，真实回复成功前不声明生效。");
say(documentCommentSubscription.status === "platform-verified"
  ? `✓ 文档评论订阅已保留：${documentCommentSubscription.dimension} / platform-verified`
  : `! 文档评论订阅=${documentCommentSubscription.status}；未验证前仅 @Bot 评论进入 Inbox。`);

const targetAgent = flag("--agent") || id;
const bindArgs = ["--profile", id, "--yes", "--agent", targetAgent];
const runtime = flag("--runtime");
if (runtime) bindArgs.push("--runtime", runtime);
if (temporaryAgentChoiceFile) bindArgs.push("--selection-file", temporaryAgentChoiceFile);
const bindSpec = internalCommandSpec("setup-bind", bindArgs, process.env);
const bindStatus = await runBindProcess(bindSpec.command, bindSpec.args);
if (bindStatus !== 0) {
  pendingPiAuthTransaction?.rollback();
  pendingPiAuthTransaction = null;
  die("新 bot 凭证已发布但 Agent 绑定失败；权威凭证状态已保留，请重跑 larkin setup 并在网页中重新选择机器人");
}
try {
  const loaded = larkinConfig.loadConfig(process.env);
  const stored = loaded.config.agents[targetAgent];
  if (!stored) throw new Error(`Agent ${targetAgent} 不存在于 canonical config`);
  const agent = hydrateRuntimeAgent(loaded.configDir, stored);
  const profileEnv = { ...process.env, LARKIN_CONFIG_DIR: loaded.configDir };
  const official = officialCliForProfile(profileEnv);
  if (testFixture?.syncAgentProfile) synchronizeAgentProfile(agent, profileEnv, { forceRebind: true });
  else await syncAgentProfileAsync(agent, profileEnv, {
    forceRebind: true,
    timeoutMs: CHILD_TIMEOUT_MS,
    maxOutputBytes: CHILD_MAX_OUTPUT_BYTES,
    signal: shutdownController.signal,
    resolveOfficialCli: () => official,
    onChild(child) { trackPendingChild(child); },
  });
  const cliEnv = managedLarkCliEnv(agent, process.env);
  let verified = false;
  for (let index = 0; index <= BOT_VERIFY_BACKOFF_MS.length; index += 1) {
    const result = await runIdentityProcess(official.command, [...official.argsPrefix, "im", "+chat-list", "--as", "bot"], cliEnv);
    let envelope: { ok?: unknown; identity?: unknown } | undefined;
    try { envelope = JSON.parse(result.stdout || "") as { ok?: unknown; identity?: unknown }; } catch { /* fail closed below */ }
    if (result.status === 0 && envelope?.ok === true && envelope.identity === "bot") { verified = true; break; }
    if (!botVerificationRetryable(result) || index === BOT_VERIFY_BACKOFF_MS.length) break;
    const delay = BOT_VERIFY_BACKOFF_MS[index];
    say(`! 新应用 Bot identity 尚未就绪，${delay}ms 后重试 ${index + 2}/${BOT_VERIFY_BACKOFF_MS.length + 1}`);
    await wait(delay);
  }
  if (!verified) throw new Error("Bot identity verification failed");
  if (commentSubscription !== "preserve") {
    const reconciled = await applyDocumentCommentSubscription({
      mode: commentSubscription as "none" | DocumentCommentSubscriptionDimension,
      command: official.command,
      argsPrefix: official.argsPrefix,
      env: cliEnv,
      markVerified: () => { markDocumentCommentSubscriptionVerified(CFG_DIR, id, "application"); },
    });
    if (reconciled.subscribed && reconciled.dimension) {
      say(`✓ 文档评论订阅已由 subscription_status 验证：${reconciled.dimension}`);
    } else {
      say(`✓ ${reconciled.dimension} 维度文档评论订阅已取消并由 subscription_status 验证；仅 @Bot 评论进入 Inbox。`);
    }
  }

  // ── setup 完成即主动写入 bot 身份（不再等首次连接）──
  // 新 bot 在首次连接前，dashboard/agents 就能显示名字与头像（原：未连接过、无身份缓存）。
  try {
    const botInfo = await fetchBotInfoViaHttp(id, tenant);
    if (botInfo?.open_id) {
      const store = createAgentStateStore(CFG_DIR, id);
      store.writeJson("botIdentity", {
        open_id: botInfo.open_id,
        name: botInfo.app_name || null,
        avatar_url: botInfo.avatar_url || null,
        updated_at: new Date().toISOString(),
      });
      say(`✓ bot 身份已写入 state：${botInfo.app_name || "?"}（${botInfo.open_id}）`);
    } else {
      say("! bot 身份接口暂未返回完整信息；首次连接后会自动补写");
    }
  } catch (error) {
    say(`! bot 身份主动写入失败（首次连接后会自动补写）：${errorMessage(error)}`);
  }

  // ── 允许被添加进群：应用可用范围设为全员可见（更新后线上立即生效，best-effort）──
  try {
    if (await ensureAppVisibleToAll(id, official, cliEnv)) {
      say("✓ 应用可用范围已设为全员可见：任何成员都可以把该 bot 添加进自己的群");
    } else {
      say("! 未能自动设为全员可见（可能未确认 admin:app.visibility 权限）；如成员无法把 bot 加进群，请在开发者后台「应用发布 → 版本管理与发布」把可用范围设为全部成员，或确认权限后重跑 setup");
    }
  } catch (error) {
    say(`! 自动设置全员可见未完成（${errorMessage(error)}）；可在开发者后台配置可用范围，或确认 admin:app.visibility 后重跑 setup`);
  }
} catch (error) {
  const diagnostic = errorMessage(error);
  if (diagnostic.startsWith("document comment application subscription")
      || diagnostic.startsWith("document comment local verified-state persistence")) say(`! ${diagnostic}`);
  die("Agent lark-channel binding/凭证校验失败或评论订阅核验失败；安全本地状态与权威 bot 凭证已保留，请检查身份授权后重跑 larkin setup");
}
say("✓ 官方 lark-channel workspace 已绑定（identity=bot-only），Bot 凭证校验通过");
say(`\n[setup 4/5] ✓ Agent ${id} 已配置`);
if (resultFile) {
  try { fs.writeFileSync(resultFile, `${JSON.stringify({ agentId: id })}\n`, { mode: 0o600, flag: "wx" }); }
  catch { die("Agent 绑定与新 bot 凭证已保留，但 setup 结果写入失败；请重跑 larkin setup 并在网页中重新选择机器人"); }
}
pendingPiAuthTransaction?.commit();
pendingPiAuthTransaction = null;
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => { if (!requestedShutdown) die(errorMessage(error)); });
}
