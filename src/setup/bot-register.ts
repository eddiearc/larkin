#!/usr/bin/env bun
// Internal setup stage: browser-select a bot, verify credentials, publish them, then bind its App-ID Agent.

import { spawnSync as systemSpawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { registerApp as channelRegisterApp } from "@larksuite/channel";
import { internalCommandSpec } from "../app/internal-command.js";
import * as larkinConfig from "../platform/config.js";
import { hydrateRuntimeAgent, syncAgentProfile } from "../app/runtime-agent-config.js";
import { managedLarkCliEnv } from "../app/agent-lark-cli-workspace.js";
import { resolveOfficialLarkCli } from "../app/official-lark-cli.js";
import { collectSetupAgentChoice, recoverUnavailableExternalPi, terminalSetupQuestioner } from "./setup-agent-choice.js";
import { probeNativeRuntimeReadiness } from "../runtime/runtime-readiness.js";
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
process.on("exit", () => {
  if (!temporaryAgentChoiceFile) return;
  try { fs.unlinkSync(temporaryAgentChoiceFile); } catch { /* consumed or best effort */ }
});
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
const BOT_VERIFY_BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000, 15_000] as const;

function botVerificationRetryable(result: { status: number | null; stdout?: unknown; stderr?: unknown }): boolean {
  const text = `${typeof result.stdout === "string" ? result.stdout : ""}\n${typeof result.stderr === "string" ? result.stderr : ""}`;
  return /\binvalid_client\b|specified app does not exist|EAI_AGAIN|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|temporary network|too many requests|\b(?:429|502|503|504)\b/i.test(text);
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
say(`[setup 3/5] 正在按 App ID ${id} 刷新凭证并配置 Agent`);

const tenant = userInfo?.tenant_brand === "lark" ? "lark" : "feishu";
const botFile = path.join(botsDir, `${id}.json`);
const prior: StoredCredential = (() => {
  try { return JSON.parse(fs.readFileSync(botFile, "utf8")) as StoredCredential; }
  catch { return {}; }
})();

if (!flag("--runtime") && (!testFixture || process.env.LARKIN_TEST_ENABLE_AGENT_CHOICE === "1")) {
  const existing = larkinConfig.loadConfig(process.env).config.agents[id];
  const questioner = terminalSetupQuestioner();
  try {
    const requested = await collectSetupAgentChoice(questioner, existing);
    const choice = await recoverUnavailableExternalPi(requested, questioner, () => probeNativeRuntimeReadiness({
      runtime: "pi", agentId: id, cwd: path.join(CFG_DIR, "agents", id), env: process.env,
    }), (message) => say(`! ${message}`));
    if (choice) {
      temporaryAgentChoiceFile = path.join(CFG_DIR, `.setup-agent-choice-${process.pid}-${Date.now()}.json`);
      fs.writeFileSync(temporaryAgentChoiceFile, `${JSON.stringify(choice)}\n`, { mode: 0o600, flag: "wx" });
    }
  } finally { questioner.close?.(); }
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
if (temporaryAgentChoiceFile) bindArgs.push("--selection-file", temporaryAgentChoiceFile);
const bindSpec = internalCommandSpec("setup-bind", bindArgs, process.env);
const bind = spawnSync(bindSpec.command, bindSpec.args, { env: process.env, stdio: "inherit" });
if (bind.status !== 0) {
  die("新 bot 凭证已发布但 Agent 绑定失败；权威凭证状态已保留，请重跑 larkin setup 并在网页中重新选择机器人");
}
try {
  const loaded = larkinConfig.loadConfig(process.env);
  const stored = loaded.config.agents[targetAgent];
  if (!stored) throw new Error(`Agent ${targetAgent} 不存在于 canonical config`);
  const agent = hydrateRuntimeAgent(loaded.configDir, stored);
  synchronizeAgentProfile(agent, { ...process.env, LARKIN_CONFIG_DIR: loaded.configDir }, { forceRebind: true });
  const cliEnv = managedLarkCliEnv(agent, process.env);
  const official = resolveOfficialCli({ env: cliEnv });
  let verified = false;
  for (let index = 0; index <= BOT_VERIFY_BACKOFF_MS.length; index += 1) {
    const result = spawnSync(official.command, [...official.argsPrefix, "im", "+chat-list", "--as", "bot"], { encoding: "utf8", env: cliEnv });
    let envelope: { ok?: unknown; identity?: unknown } | undefined;
    try { envelope = JSON.parse(result.stdout || "") as { ok?: unknown; identity?: unknown }; } catch { /* fail closed below */ }
    if (result.status === 0 && envelope?.ok === true && envelope.identity === "bot") { verified = true; break; }
    if (!botVerificationRetryable(result) || index === BOT_VERIFY_BACKOFF_MS.length) break;
    const delay = BOT_VERIFY_BACKOFF_MS[index];
    say(`! 新应用 Bot identity 尚未就绪，${delay}ms 后重试 ${index + 2}/${BOT_VERIFY_BACKOFF_MS.length + 1}`);
    await wait(delay);
  }
  if (!verified) throw new Error("Bot identity verification failed");
} catch (error) {
  void error;
  die("Agent lark-channel binding/凭证校验失败；权威 bot 凭证已保留，请重跑 larkin setup");
}
say("✓ 官方 lark-channel workspace 已绑定（identity=bot-only），Bot 凭证校验通过");
say(`\n[setup 4/5] ✓ Agent ${id} 已配置`);
if (resultFile) {
  try { fs.writeFileSync(resultFile, `${JSON.stringify({ agentId: id })}\n`, { mode: 0o600, flag: "wx" }); }
  catch { die("Agent 绑定与新 bot 凭证已保留，但 setup 结果写入失败；请重跑 larkin setup 并在网页中重新选择机器人"); }
}
}

if (path.resolve(process.argv[1] || "") === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error: unknown) => die(errorMessage(error)));
}
