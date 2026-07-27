#!/usr/bin/env bun
// Internal setup stage: browser-select a bot, verify credentials, publish them, then bind its App-ID Agent.

import { spawnSync as systemSpawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerApp as channelRegisterApp } from "@larksuite/channel";
import { internalCommandSpec } from "../app/internal-command.js";
import * as larkinConfig from "../platform/config.js";
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
  addons: { scopes: { tenant: string[] }; events: { items: { tenant: string[] } }; callbacks: { items: string[] } };
  onQRCodeReady(info: { url: string; expireIn: number }): void;
  onStatusChange(info: { status: string; interval?: number }): void;
}) => Promise<RegistrationResult>;

const testFixture = process.env.LARKIN_TEST_BOT_REGISTER_MODULE
  ? await import(pathToFileURL(path.resolve(process.env.LARKIN_TEST_BOT_REGISTER_MODULE)).href) as {
    registerApp?: RegisterApp;
    qrcode?: { generate(text: string, options: { small: boolean }, callback: (code: string) => void): void };
    spawnSync?: typeof systemSpawnSync;
  }
  : null;
const registerApp: RegisterApp = testFixture?.registerApp ?? channelRegisterApp as unknown as RegisterApp;
const qrcode = testFixture?.qrcode ?? qrcodePackage;
const spawnSync = testFixture?.spawnSync ?? systemSpawnSync;
const CFG_DIR = larkinConfig.resolveConfigDir(process.env);
let temporaryLarkConfigDir: string | null = null;

process.on("exit", () => {
  if (!temporaryLarkConfigDir) return;
  try { fs.rmSync(temporaryLarkConfigDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

function createTemporaryLarkProfileDir(): void {
  temporaryLarkConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "larkin-setup-profile-"));
  fs.chmodSync(temporaryLarkConfigDir, 0o700);
}

const larkEnv = (): NodeJS.ProcessEnv => {
  const env = { ...process.env };
  for (const key of ["HERMES_HOME", "OPENCLAW_HOME", "OPENCLAW_CLI"]) delete env[key];
  for (const key of Object.keys(env)) {
    if (key === "LARK_CHANNEL" || key.startsWith("LARK_CHANNEL_")) delete env[key];
  }
  if (temporaryLarkConfigDir) env.LARKSUITE_CLI_CONFIG_DIR = temporaryLarkConfigDir;
  return env;
};
const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : undefined;
};
const has = (name: string): boolean => argv.includes(name);
const say = (...args: unknown[]): void => console.error(...args);
const die = (message: string): never => {
  console.error(`✗ ${message}`);
  process.exit(1);
};
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const APP_ID = /^cli_[A-Za-z0-9]+$/;
// A freshly created Feishu App can remain invisible to credential validation for
// more than a few seconds. Keep setup bounded, but cover a realistic propagation
// window so users do not have to restart the browser flow manually.
const PROFILE_SYNC_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

interface ProfileSyncFailure {
  kind: "invalid_client" | "temporary_network" | "agent_context" | "unknown";
  retryable: boolean;
  label: string;
}

function parseJsonEnvelope(value: unknown): { subtype?: unknown; code?: unknown } | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as { error?: { subtype?: unknown; code?: unknown } };
    return parsed?.error || null;
  } catch { return null; }
}

function classifyProfileSyncFailure(result: { status: number | null; stdout?: unknown; stderr?: unknown }): ProfileSyncFailure {
  const envelopes = [parseJsonEnvelope(result.stderr), parseJsonEnvelope(result.stdout)].filter(Boolean) as Array<{ subtype?: unknown; code?: unknown }>;
  const subtype = envelopes.map((item) => item.subtype).find((value) => typeof value === "string");
  const code = envelopes.map((item) => item.code).find((value) => typeof value === "number");
  const text = `${typeof result.stderr === "string" ? result.stderr : ""}\n${typeof result.stdout === "string" ? result.stdout : ""}`;
  if (subtype === "invalid_client" || code === 20048 || /\binvalid_client\b|specified app does not exist/i.test(text)) {
    return { kind: "invalid_client", retryable: true, label: "invalid_client（飞书可能仍在同步新应用）" };
  }
  if (/EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|temporary network|too many requests|\b(?:429|502|503|504)\b/i.test(text)) {
    return { kind: "temporary_network", retryable: true, label: "temporary_network（临时网络或网关错误）" };
  }
  if (subtype === "not_configured" && /Agent context|HERMES_HOME|OPENCLAW_HOME|config init is refused/i.test(text)) {
    return { kind: "agent_context", retryable: false, label: "agent_context（临时 profile 仍被识别为 Agent 环境）" };
  }
  return { kind: "unknown", retryable: false, label: `unknown（lark-cli exit=${result.status ?? "signal"}）` };
}

const wait = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function syncTemporaryProfile(id: string, secret: string, tenant: string): Promise<{ attempts: number; failure: ProfileSyncFailure | null }> {
  const attempts = PROFILE_SYNC_BACKOFF_MS.length + 1;
  for (let index = 0; index < attempts; index += 1) {
    const sync = spawnSync("lark-cli", ["config", "init", "--app-id", id, "--app-secret-stdin", "--brand", tenant, "--name", id], {
      input: secret,
      encoding: "utf8",
      env: larkEnv(),
    });
    if (sync.status === 0) return { attempts: index + 1, failure: null };
    const failure = classifyProfileSyncFailure(sync);
    if (!failure.retryable || index === attempts - 1) return { attempts: index + 1, failure };
    const delay = PROFILE_SYNC_BACKOFF_MS[index];
    say(`! 临时 profile 尚未就绪（${failure.label}），${delay}ms 后重试 ${index + 2}/${attempts}`);
    await wait(delay);
  }
  return { attempts, failure: { kind: "unknown", retryable: false, label: "unknown（未执行 profile 验证）" } };
}

function ensureSecureBotsDir(): string {
  fs.mkdirSync(CFG_DIR, { recursive: true, mode: 0o700 });
  const directory = path.join(CFG_DIR, "bots");
  try { fs.mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error; }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())
      || (stat.mode & 0o777) !== 0o700) {
    die("bots 凭证目录必须是当前用户拥有、非 symlink、权限精确 0700 的真实目录；未写入新凭证");
  }
  return directory;
}

function openBrowser(url: string): boolean {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  return spawnSync(command, args, { stdio: "ignore" }).status === 0;
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
const resultFileArg = flag("--result-file") || null;
const resultFile = resultFileArg ? path.resolve(resultFileArg) : null;
if (resultFile && (path.dirname(resultFile) !== path.resolve(CFG_DIR) || !/^\.setup-result-\d+\.json$/.test(path.basename(resultFile)))) {
  die("--result-file 必须是配置根目录内的 .setup-result-<pid>.json");
}
if (argv.some((arg) => arg === "--app-id" || arg.startsWith("--app-id="))) {
  die("不支持 --app-id；机器人必须在飞书网页中选择");
}
if (!autoSelect) die("setup 注册阶段必须由交互式选择流程启动");
say("[setup 1/5] 在网页选择已有机器人或创建新机器人");

const TENANT_SCOPES = [
  "im:message",
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message.group_msg",
  "im:chat:readonly",
  "im:chat:create",
  "im:chat:update",
  "im:chat.members:read",
  "im:chat.members:write_only",
  "im:resource",
  "application:application:self_manage",
  "contact:user.employee_id:readonly",
];
const TENANT_EVENTS = ["im.message.receive_v1", "im.message.message_read_v1"];
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
    say(`\n打开以下链接（或扫码），${Math.round(expireIn / 60)} 分钟内有效：\n\n  ${url}\n\n[setup 2/5] 等待飞书网页完成授权并回传凭证…`);
    say(openBrowser(url) ? "[setup] 已在默认浏览器打开授权页" : "[setup] 未能自动打开浏览器，请手动打开上面的链接");
  },
  onStatusChange: ({ status, interval }) => {
    if (status === "domain_switched") say("[setup] 已切换到 Lark 域名");
    if (status === "slow_down") say(`[setup] 飞书要求降低轮询频率，${interval || "稍后"}秒后继续`);
    if (status === "polling" && ++pollingCount % 12 === 0) say(`[setup] 仍在等待飞书回传凭证（约 ${pollingCount / 12} 分钟）…`);
  },
}).catch(() => die("网页授权失败；未执行凭证同步、文件写入或 Agent 绑定，请重试 setup"));

const { client_id: rawId, client_secret: rawSecret, user_info: userInfo } = result || {};
if (typeof rawId !== "string" || !APP_ID.test(rawId)) die("授权返回的 App ID 格式非法；未执行凭证同步、文件写入或 Agent 绑定");
if (typeof rawSecret !== "string" || rawSecret.length === 0) die("授权完成但未取得有效凭证；未执行凭证同步、文件写入或 Agent 绑定");
const id = rawId as string;
const secret = rawSecret as string;
const botsDir = ensureSecureBotsDir();
createTemporaryLarkProfileDir();
say(`[setup 3/5] 正在按 App ID ${id} 刷新凭证并配置 Agent`);

const tenant = userInfo?.tenant_brand === "lark" ? "lark" : "feishu";
const botFile = path.join(botsDir, `${id}.json`);
const prior: StoredCredential = (() => {
  try { return JSON.parse(fs.readFileSync(botFile, "utf8")) as StoredCredential; }
  catch { return {}; }
})();

const sync = await syncTemporaryProfile(id, secret, tenant);
if (sync.failure) die(`临时 lark-cli 验证 profile 创建失败（${sync.failure.label}，已尝试 ${sync.attempts} 次）；未写入本地 bot 凭证或 Agent binding，请重试 setup`);
say(`✓ 临时 lark-cli profile ${id} 已创建`);

const verify = spawnSync("lark-cli", ["--profile", id, "im", "+chat-list", "--as", "bot"], { encoding: "utf8", env: larkEnv() });
let verified: { ok?: unknown; identity?: unknown } | undefined;
try { verified = JSON.parse(verify.stdout || "") as { ok?: unknown; identity?: unknown }; } catch { /* fail closed below */ }
if (verify.status !== 0 || verified?.ok !== true || verified.identity !== "bot") {
  die(`临时 lark-cli profile ${id} 的 bot 凭证校验失败；未写入本地 bot 凭证或 Agent binding，请重试 setup`);
}
say("✓ 凭证校验通过（identity=bot）");

const stagedBotFile = path.join(botsDir, `.${id}.${process.pid}.tmp`);
try {
  fs.writeFileSync(stagedBotFile, `${JSON.stringify({
    appId: id,
    appSecret: secret,
    tenant,
    ownerOpenId: userInfo?.open_id || prior.ownerOpenId || null,
    createdAt: prior.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    capabilities: { cardActionCallback: { status: "requested-unverified", requestedAt: new Date().toISOString() } },
  }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  fs.renameSync(stagedBotFile, botFile);
} catch (error) {
  try { fs.unlinkSync(stagedBotFile); } catch { /* best effort */ }
  die(`bot 凭证原子写入失败：${errorMessage(error)}`);
}
say(`✓ 凭证已写入 ${botFile}（0600，Secret 不回显）`);
say("! card.action.trigger 已请求但尚未证明生效；启动后运行 Agent CLI 的 interaction callback-probe，发送并点击验证卡，状态变为 verified-effective 后才能创建业务交互卡片。");

const targetAgent = flag("--agent") || id;
const bindArgs = ["--profile", id, "--yes", "--agent", targetAgent];
const runtime = flag("--runtime");
if (runtime) bindArgs.push("--runtime", runtime);
const bindSpec = internalCommandSpec("setup-bind", bindArgs, larkEnv());
const bind = spawnSync(bindSpec.command, bindSpec.args, { env: larkEnv(), stdio: "inherit" });
if (bind.status !== 0) {
  die("新 bot 凭证已发布但 Agent 绑定失败；权威凭证状态已保留，请重跑 larkin setup 并在网页中重新选择机器人");
}
say(`\n[setup 4/5] ✓ Agent ${id} 已配置`);
if (resultFile) {
  try { fs.writeFileSync(resultFile, `${JSON.stringify({ agentId: id })}\n`, { mode: 0o600, flag: "wx" }); }
  catch { die("Agent 绑定与新 bot 凭证已保留，但 setup 结果写入失败；请重跑 larkin setup 并在网页中重新选择机器人"); }
}
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => die(errorMessage(error)));
}
